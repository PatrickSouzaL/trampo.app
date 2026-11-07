// AEAD por finalidade (ADR-004 D5; generalização do ADR-018 D4). AES-256-GCM do node:crypto, IV de 96 bits
// aleatório por selagem e tag de 128 bits. Cada finalidade tem o próprio prefixo de versão, o próprio anel e o
// próprio prefixo de AAD, que termina em `:<versão>:` (o prefixo do envelope fica amarrado pela tag): o envelope de
// uma não abre na outra, nem com o prefixo trocado à mão. Forma `<versão>.<kid>.<iv>.<cifrado>.<tag>`, cada parte em
// base64url canônico. O `open` recusa base64url não canônica, para o envelope não ser maleável (SR-21).
//
// O anel é `<kid>:<32 bytes em base64url>,...` (de 1 a 4 chaves) mais o kid ativo. A selagem usa a ativa; a abertura
// aceita qualquer kid do anel (rotação). O kid fica em `[a-z0-9]{1,16}`, a faixa do `SealedRefreshSchema` (ADR-004
// D7) e do `check` da coluna da pretensão (ADR-018 D2). Nenhuma mensagem leva material de chave, cifrado ou texto
// claro: o erro de configuração é o da finalidade, que só cita nomes de variáveis.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const AEAD_POLICY = { keyBytes: 32, ivBytes: 12, tagBytes: 16, maxKeys: 4 } as const;

/** O kid do anel (ADR-004 D5, emenda da revisão da F1-AUTH-00). */
export const AEAD_KEY_ID_PATTERN = /^[a-z0-9]{1,16}$/;

// Prefixo de finalidade: uma letra e um dígito (`s1`, `r1`). Entra numa regex, então a forma é fechada.
const VERSION_PATTERN = /^[a-z][0-9]$/;
const ALGORITHM = "aes-256-gcm";

export interface AeadKeyring {
  readonly activeKid: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface AeadEnvelopeFormat {
  /** Prefixo da finalidade (`s1` da pretensão, `r1` do refresh). */
  readonly version: string;
  /** Início do AAD da finalidade; termina em `:<versão>:`, e o contexto (dono, origem) vem depois. */
  readonly aadPrefix: string;
  /** Faixa do cifrado em caracteres base64url, derivada do teto do texto claro da finalidade. */
  readonly ciphertextChars: { readonly min: number; readonly max: number };
}

export interface AeadEnvelope {
  /** O AAD é `aadPrefix + context`. */
  seal(plaintext: Uint8Array, context: string): string;
  /** Nunca lança: forma, kid, base64url não canônica, tag ou contexto que não conferem → `null`. */
  open(envelope: string, context: string): Buffer | null;
}

/** base64url canônico: decodificar e codificar de volta dá a mesma string (sem bits sobrando nem padding). */
export function decodeCanonical(text: string): Buffer | null {
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}

/**
 * Lê o anel do .env. Lança `invalid()` no boot (falha cedo e fechado) sem ecoar nenhum valor. Variável ausente
 * chega como `""` (quem lê o .env usa `?? ""`): anel vazio e kid vazio são recusados pelo mesmo caminho.
 */
export function parseAeadKeyring(keys: string, activeKid: string, invalid: () => Error): AeadKeyring {
  const entries = keys.split(",");
  if (entries.length > AEAD_POLICY.maxKeys) throw invalid();
  const ring = new Map<string, Buffer>();
  for (const entry of entries) {
    // Sem ":", o kid vira a chave quase inteira (42 caracteres) e não passa no padrão de kid.
    const separator = entry.indexOf(":");
    const kid = entry.slice(0, separator);
    const key = decodeCanonical(entry.slice(separator + 1));
    if (!AEAD_KEY_ID_PATTERN.test(kid) || ring.has(kid) || key?.length !== AEAD_POLICY.keyBytes) throw invalid();
    ring.set(kid, key);
  }
  if (!ring.has(activeKid)) throw invalid();
  return { activeKid, keys: ring };
}

function isCiphertextRange({ min, max }: AeadEnvelopeFormat["ciphertextChars"]): boolean {
  return Number.isSafeInteger(min) && Number.isSafeInteger(max) && min >= 1 && max >= min;
}

export function createAeadEnvelope(format: AeadEnvelopeFormat, keyring: AeadKeyring, invalid: () => Error): AeadEnvelope {
  const active = keyring.keys.get(keyring.activeKid);
  if (
    active === undefined ||
    !VERSION_PATTERN.test(format.version) ||
    !format.aadPrefix.endsWith(`:${format.version}:`) ||
    !isCiphertextRange(format.ciphertextChars)
  ) {
    throw invalid();
  }
  const { min, max } = format.ciphertextChars;
  // O padrão já limita o tamanho de cada parte antes de qualquer decodificação.
  const aad = (context: string): Buffer => Buffer.from(`${format.aadPrefix}${context}`, "utf8");
  const envelopePattern = new RegExp(`^${format.version}\\.([a-z0-9]{1,16})\\.([\\w-]{16})\\.([\\w-]{${min},${max}})\\.([\\w-]{22})$`);

  return {
    seal(plaintext, context) {
      const iv = randomBytes(AEAD_POLICY.ivBytes);
      const cipher = createCipheriv(ALGORITHM, active, iv, { authTagLength: AEAD_POLICY.tagBytes });
      cipher.setAAD(aad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [format.version, keyring.activeKid, iv, ciphertext, tag]
        .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
        .join(".");
    },

    open(envelope, context) {
      const match = envelopePattern.exec(envelope);
      if (match === null) return null;
      const [, kid = "", ivText = "", ciphertextText = "", tagText = ""] = match;
      const key = keyring.keys.get(kid);
      // 16 caracteres são exatamente 12 bytes (sem bits sobrando): o IV é sempre canônico.
      const iv = Buffer.from(ivText, "base64url");
      const ciphertext = decodeCanonical(ciphertextText);
      const tag = decodeCanonical(tagText);
      if (key === undefined || ciphertext === null || tag === null) return null;
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AEAD_POLICY.tagBytes });
        decipher.setAAD(aad(context));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        // Tag que não confere (inclusive por contexto de outra origem ou de outro dono, ou de outra finalidade).
        return null;
      }
    },
  };
}
