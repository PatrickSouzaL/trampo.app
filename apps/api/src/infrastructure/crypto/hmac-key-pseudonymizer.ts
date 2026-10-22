// Pseudônimo das chaves do Redis (ADR-014 D7; threat-model T23 item 6, SR-17). IP e `sub` nunca entram em
// claro numa chave: `HMAC-SHA256(pepper, "<domínio>:<valor>")` truncado em 32 hex (128 bits). Sem o pepper,
// nem o espaço IPv4 inteiro (2^32) se reverte por força bruta. Os domínios separam `sub` de `ip`.
import { createHmac } from "node:crypto";

export type PseudonymDomain = "sub" | "ip";

/** 32 hex = 128 bits: sem colisão prática entre usuários e curto o bastante para a chave. */
export const PSEUDONYM_HEX_CHARS = 32;

/**
 * base64url de pelo menos 32 bytes: 43 caracteres decodificam em 32 bytes ou mais, então o padrão basta.
 * Uma frase digitada à mão não passa (espaço, acento e pontuação ficam fora do alfabeto).
 */
export const RATE_KEY_PEPPER_PATTERN = /^[A-Za-z0-9_-]{43,512}$/;

export class PepperConfigError extends Error {
  constructor() {
    super("RATE_KEY_PEPPER precisa ser base64url de pelo menos 32 bytes");
    this.name = "PepperConfigError";
  }
}

export interface KeyPseudonymizer {
  pseudonym(domain: PseudonymDomain, value: string): string;
}

/** Lança no boot se o pepper não serve (falha cedo e fechado). O pepper nunca aparece na mensagem. */
export function createHmacKeyPseudonymizer(pepper: string): KeyPseudonymizer {
  if (!RATE_KEY_PEPPER_PATTERN.test(pepper)) throw new PepperConfigError();
  const key = Buffer.from(pepper, "base64url");
  return {
    pseudonym: (domain, value) =>
      createHmac("sha256", key).update(`${domain}:${value}`, "utf8").digest("hex").slice(0, PSEUDONYM_HEX_CHARS),
  };
}
