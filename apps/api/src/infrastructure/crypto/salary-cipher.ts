// Cifra da pretensão salarial no app (ADR-018 D4; threat-model A1). AES-256-GCM do node:crypto, IV de 96 bits
// aleatório por cifragem e tag de 128 bits. O AAD liga o cifrado ao dono e ao campo: o cifrado de B colado na
// linha de A não abre. Cifra-se sempre, inclusive o `null`, para a coluna não revelar quem informou pretensão.
//
// Envelope `s1.<kid>.<iv>.<cifrado>.<tag>`, em base64url canônico. As chaves ficam só no .env da API (nunca no
// cofre, no git ou no banco): `CRITERIA_SALARY_KEYS=<kid>:<32 bytes em base64url>,...` e
// `CRITERIA_SALARY_ACTIVE_KEY=<kid>`. A escrita usa a ativa; a leitura aceita qualquer kid do anel (rotação).
// Nenhuma mensagem leva material de chave, cifrado ou texto claro.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { SalaryCriterionSchema, type UserCriteria } from "@trampo/contracts";
import { z } from "zod";

export const SALARY_ENVELOPE_VERSION = "s1";
export const SALARY_CIPHER_POLICY = {
  keyBytes: 32,
  ivBytes: 12,
  tagBytes: 16,
  maxKeys: 4,
  /** Teto do texto claro, garantido pelo SalaryCriterionSchema (provado no teste do pior caso). */
  plaintextMaxBytes: 256,
  /** O mesmo teto do `check` da coluna `salary_ciphertext` (ADR-018 D2). */
  envelopeMaxChars: 1_024,
} as const;

const KID = /^[a-z0-9]{1,16}$/;
const ENVELOPE = /^s1\.([a-z0-9]{1,16})\.([\w-]{16})\.([\w-]{1,342})\.([\w-]{22})$/;
const ALGORITHM = "aes-256-gcm";

/** A pretensão do contrato, ou `null` quando o usuário não informou. */
export type SalaryValue = UserCriteria["salary"];

const SalarySchema = SalaryCriterionSchema.nullable();
const UserIdSchema = z.uuid();

export class SalaryKeyringConfigError extends Error {
  constructor() {
    super("CRITERIA_SALARY_KEYS e CRITERIA_SALARY_ACTIVE_KEY precisam de 1 a 4 chaves <kid>:<32 bytes em base64url> e um kid ativo do anel");
    this.name = "SalaryKeyringConfigError";
  }
}

/** Erro de programação no caminho de escrita (dono ou pretensão fora do contrato). Mensagem fixa. */
export class SalarySealError extends Error {
  constructor() {
    super("pretensão ou dono fora do contrato na cifragem");
    this.name = "SalarySealError";
  }
}

export interface SalaryKeyring {
  readonly activeKid: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export type SalaryOpenResult = { readonly ok: true; readonly salary: SalaryValue } | { readonly ok: false };

export interface SalaryCipher {
  /** Lança `SalarySealError` se o dono ou a pretensão saírem do contrato. */
  seal(userId: string, salary: SalaryValue): string;
  /** Nunca lança: envelope malformado, kid desconhecido, tag que não confere ou texto fora do schema → `ok: false`. */
  open(userId: string, envelope: unknown): SalaryOpenResult;
}

/** base64url canônico: decodificar e codificar de volta dá a mesma string (sem bits sobrando nem padding). */
function decodeCanonical(text: string): Buffer | null {
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}

/**
 * Lê o anel do .env. Lança no boot (falha cedo e fechado) sem ecoar nenhum valor. Variável ausente chega como
 * `""` (quem lê o .env usa `?? ""`): anel vazio e kid vazio são recusados pelo mesmo caminho.
 */
export function parseSalaryKeyring(keys: string, activeKid: string): SalaryKeyring {
  const entries = keys.split(",");
  if (entries.length > SALARY_CIPHER_POLICY.maxKeys) throw new SalaryKeyringConfigError();
  const ring = new Map<string, Buffer>();
  for (const entry of entries) {
    // Sem ":", o kid vira a chave quase inteira (42 caracteres) e não passa no padrão de kid.
    const separator = entry.indexOf(":");
    const kid = entry.slice(0, separator);
    const key = decodeCanonical(entry.slice(separator + 1));
    if (!KID.test(kid) || ring.has(kid) || key?.length !== SALARY_CIPHER_POLICY.keyBytes) {
      throw new SalaryKeyringConfigError();
    }
    ring.set(kid, key);
  }
  if (!ring.has(activeKid)) throw new SalaryKeyringConfigError();
  return { activeKid, keys: ring };
}

function aad(userId: string): Buffer {
  return Buffer.from(`trampo:user_criteria.salary:${SALARY_ENVELOPE_VERSION}:${userId}`, "utf8");
}

export function createSalaryCipher(keyring: SalaryKeyring): SalaryCipher {
  const active = keyring.keys.get(keyring.activeKid);
  if (active === undefined) throw new SalaryKeyringConfigError();

  return {
    seal(userId, salary) {
      const owner = UserIdSchema.safeParse(userId);
      const value = SalarySchema.safeParse(salary);
      if (!owner.success || !value.success) throw new SalarySealError();
      const plaintext = Buffer.from(JSON.stringify(value.data), "utf8");
      const iv = randomBytes(SALARY_CIPHER_POLICY.ivBytes);
      const cipher = createCipheriv(ALGORITHM, active, iv, { authTagLength: SALARY_CIPHER_POLICY.tagBytes });
      cipher.setAAD(aad(owner.data));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [SALARY_ENVELOPE_VERSION, keyring.activeKid, iv, ciphertext, tag]
        .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
        .join(".");
    },

    open(userId, envelope) {
      // O padrão já limita o tamanho (bem abaixo do teto da coluna). Um dono fora do formato não abre: o AAD
      // não confere com o da cifragem, que exige UUID.
      if (typeof envelope !== "string") return { ok: false };
      const match = ENVELOPE.exec(envelope);
      if (match === null) return { ok: false };
      const [, kid = "", ivText = "", ciphertextText = "", tagText = ""] = match;
      const key = keyring.keys.get(kid);
      // 16 caracteres são exatamente 12 bytes (sem bits sobrando): o IV é sempre canônico.
      const iv = Buffer.from(ivText, "base64url");
      const ciphertext = decodeCanonical(ciphertextText);
      const tag = decodeCanonical(tagText);
      if (key === undefined || ciphertext === null || tag === null) return { ok: false };
      // Tag que não confere e JSON inválido lançam aqui. Um `__proto__` vira chave própria no JSON.parse, e o
      // schema estrito a recusa.
      let decoded: unknown;
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: SALARY_CIPHER_POLICY.tagBytes });
        decipher.setAAD(aad(userId));
        decipher.setAuthTag(tag);
        decoded = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
      } catch {
        return { ok: false };
      }
      const salary = SalarySchema.safeParse(decoded);
      return salary.success ? { ok: true, salary: salary.data } : { ok: false };
    },
  };
}
