// Selo AES-256-GCM dos cookies do portal (ADR-027 D4). Molde do `aead-envelope` da API (ADR-004 D5), reescrito aqui
// porque o portal não importa a API (ADR-001 §10.3). Forma: `<versão>.<kid>.<iv>.<cifrado>.<tag>` em base64url
// canônica, IV de 96 bits, tag de 128 bits e AAD por finalidade e pela origem do portal: o cookie do fluxo nunca abre
// como sessão, e o de outra origem não abre aqui. Nada daqui vai para mensagem ou log.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SealKey {
  readonly kid: string;
  readonly key: Buffer;
}

export interface SealKeyring {
  readonly active: SealKey;
  readonly byKid: ReadonlyMap<string, Buffer>;
}

export interface SealPurpose {
  readonly version: "s1" | "f1" | "r1";
  readonly label: "sessao" | "fluxo" | "rascunho";
  /** Teto do texto claro em bytes UTF-8. O excesso não é selado. */
  readonly maxPlaintextBytes: number;
}

export const SEAL_PURPOSES = Object.freeze({
  /**
   * O pior caso da sessão (access de 2.300, refresh de 512, `sid` e três inteiros) tem cerca de 2.925 bytes. Com 2.950,
   * o envelope de `kid` com 16 caracteres tem 3.994, e o par nome=valor do cookie fica abaixo de 4.096 (ADR-027 D3).
   */
  sessao: Object.freeze({ version: "s1", label: "sessao", maxPlaintextBytes: 2_950 } as const),
  fluxo: Object.freeze({ version: "f1", label: "fluxo", maxPlaintextBytes: 256 } as const),
  /**
   * O rascunho dos critérios que falharam ao gravar (ADR-028 D8): o mesmo teto da sessão. O nome do cookie tem 2
   * caracteres a mais, e o par nome=valor continua abaixo de 4.096. Rascunho maior não é guardado.
   */
  rascunho: Object.freeze({ version: "r1", label: "rascunho", maxPlaintextBytes: 2_950 } as const),
} satisfies Record<string, SealPurpose>);

export interface Sealer {
  /** `null` quando o texto passa do teto da finalidade. */
  seal(plaintext: string): string | null;
  /** `null` em qualquer desvio: forma, base64url não canônica, `kid` desconhecido, autenticação ou UTF-8. */
  open(envelope: string): string | null;
}

/** Mensagem fixa: nunca repete o valor recebido. */
export class SealKeyringError extends Error {
  constructor() {
    super("PORTAL_SEAL_KEYS ou PORTAL_SEAL_ACTIVE_KEY fora da forma (1 a 4 kid:<32 bytes em base64url>, sem repetição)");
    this.name = "SealKeyringError";
  }
}

const MAX_KEYS = 4;
const KEY_ENTRY = /^([a-z0-9]{1,16}):([\w-]{43})$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** base64url sem preenchimento, aceita só na forma canônica (a que o próprio Node emitiria). */
function decodeCanonical(text: string): Buffer | null {
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}

export function parseSealKeyring(keys: string, activeKid: string): SealKeyring {
  const entries = keys.split(",");
  if (entries.length > MAX_KEYS) throw new SealKeyringError();
  const byKid = new Map<string, Buffer>();
  const seen = new Set<string>();
  for (const entry of entries) {
    const match = KEY_ENTRY.exec(entry);
    if (match === null) throw new SealKeyringError();
    const [, kid, encoded] = match as unknown as [string, string, string];
    const key = decodeCanonical(encoded);
    if (key?.length !== 32 || byKid.has(kid) || seen.has(encoded)) throw new SealKeyringError();
    byKid.set(kid, key);
    seen.add(encoded);
  }
  const active = byKid.get(activeKid);
  if (active === undefined) throw new SealKeyringError();
  return { active: { kid: activeKid, key: active }, byKid };
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export function createSealer(keyring: SealKeyring, purpose: SealPurpose, portalOrigin: string): Sealer {
  const aad = Buffer.from(`trampo:portal.${purpose.label}:${purpose.version}:${portalOrigin}`, "utf8");
  const maxCipherChars = Math.ceil((purpose.maxPlaintextBytes * 4) / 3);
  const shape = new RegExp(`^${purpose.version}\\.([a-z0-9]{1,16})\\.([\\w-]{16})\\.([\\w-]{1,${maxCipherChars}})\\.([\\w-]{22})$`);

  return {
    seal(plaintext) {
      const bytes = Buffer.from(plaintext, "utf8");
      if (bytes.length > purpose.maxPlaintextBytes) return null;
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", keyring.active.key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return [purpose.version, keyring.active.kid, iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
    },

    open(envelope) {
      const match = shape.exec(envelope);
      if (match === null) return null;
      const [, kid, ivText, bodyText, tagText] = match as unknown as [string, string, string, string, string];
      const key = keyring.byKid.get(kid);
      const iv = decodeCanonical(ivText);
      const body = decodeCanonical(bodyText);
      const tag = decodeCanonical(tagText);
      if (key === undefined || iv === null || body === null || tag === null) return null;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(body), decipher.final()]);
        return STRICT_UTF8.decode(plain);
      } catch {
        // Autenticação que falhou ou UTF-8 inválido: o mesmo "não abre", sem detalhe.
        return null;
      }
    },
  };
}
