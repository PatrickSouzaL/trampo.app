// Cifra da pretensão salarial no app (ADR-018 D4; threat-model A1). AES-256-GCM do node:crypto, IV de 96 bits
// aleatório por cifragem e tag de 128 bits. O AAD liga o cifrado ao dono e ao campo: o cifrado de B colado na
// linha de A não abre. Cifra-se sempre, inclusive o `null`, para a coluna não revelar quem informou pretensão.
//
// Envelope `s1.<kid>.<iv>.<cifrado>.<tag>`, em base64url canônico. As chaves ficam só no .env da API (nunca no
// cofre, no git ou no banco): `CRITERIA_SALARY_KEYS=<kid>:<32 bytes em base64url>,...` e
// `CRITERIA_SALARY_ACTIVE_KEY=<kid>`. A escrita usa a ativa; a leitura aceita qualquer kid do anel (rotação).
// Nenhuma mensagem leva material de chave, cifrado ou texto claro. A cifra é o AEAD por finalidade do aead-envelope
// (F1-API-07, ADR-004 D5): o formato `s1` não mudou, e um vetor gravado antes da generalização prova isso.
import { SalaryCriterionSchema, type UserCriteria } from "@trampo/contracts";
import { z } from "zod";

import { AEAD_POLICY, createAeadEnvelope, parseAeadKeyring, type AeadKeyring } from "./aead-envelope.js";

export const SALARY_ENVELOPE_VERSION = "s1";
export const SALARY_CIPHER_POLICY = {
  keyBytes: AEAD_POLICY.keyBytes,
  ivBytes: AEAD_POLICY.ivBytes,
  tagBytes: AEAD_POLICY.tagBytes,
  maxKeys: AEAD_POLICY.maxKeys,
  /** Teto do texto claro, garantido pelo SalaryCriterionSchema (provado no teste do pior caso). */
  plaintextMaxBytes: 256,
  /** O mesmo teto do `check` da coluna `salary_ciphertext` (ADR-018 D2). */
  envelopeMaxChars: 1_024,
} as const;

// 256 bytes de texto claro dão até 342 caracteres de cifrado: o mesmo padrão do `check` da coluna.
// O AAD liga o cifrado ao dono e ao campo: `trampo:user_criteria.salary:s1:<userId>`.
const FORMAT = {
  version: SALARY_ENVELOPE_VERSION,
  aadPrefix: `trampo:user_criteria.salary:${SALARY_ENVELOPE_VERSION}:`,
  ciphertextChars: { min: 1, max: 342 },
} as const;

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

export type SalaryKeyring = AeadKeyring;

export type SalaryOpenResult = { readonly ok: true; readonly salary: SalaryValue } | { readonly ok: false };

export interface SalaryCipher {
  /** Lança `SalarySealError` se o dono ou a pretensão saírem do contrato. */
  seal(userId: string, salary: SalaryValue): string;
  /** Nunca lança: envelope malformado, kid desconhecido, tag que não confere ou texto fora do schema → `ok: false`. */
  open(userId: string, envelope: unknown): SalaryOpenResult;
}

const keyringError = (): Error => new SalaryKeyringConfigError();

/**
 * Lê o anel do .env. Lança no boot (falha cedo e fechado) sem ecoar nenhum valor. Variável ausente chega como
 * `""` (quem lê o .env usa `?? ""`): anel vazio e kid vazio são recusados pelo mesmo caminho.
 */
export function parseSalaryKeyring(keys: string, activeKid: string): SalaryKeyring {
  return parseAeadKeyring(keys, activeKid, keyringError);
}

export function createSalaryCipher(keyring: SalaryKeyring): SalaryCipher {
  const aead = createAeadEnvelope(FORMAT, keyring, keyringError);

  return {
    seal(userId, salary) {
      const owner = UserIdSchema.safeParse(userId);
      const value = SalarySchema.safeParse(salary);
      if (!owner.success || !value.success) throw new SalarySealError();
      return aead.seal(Buffer.from(JSON.stringify(value.data), "utf8"), owner.data);
    },

    open(userId, envelope) {
      // Um dono fora do formato não abre: o AAD não confere com o da cifragem, que exige UUID.
      if (typeof envelope !== "string") return { ok: false };
      const plaintext = aead.open(envelope, userId);
      if (plaintext === null) return { ok: false };
      // JSON inválido lança aqui. Um `__proto__` vira chave própria no JSON.parse, e o schema estrito a recusa.
      let decoded: unknown;
      try {
        decoded = JSON.parse(plaintext.toString("utf8"));
      } catch {
        return { ok: false };
      }
      const salary = SalarySchema.safeParse(decoded);
      return salary.success ? { ok: true, salary: salary.data } : { ok: false };
    },
  };
}
