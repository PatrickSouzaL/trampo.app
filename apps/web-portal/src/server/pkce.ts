// PKCE S256, `state` e nonce do portal (ADR-027 D2 e D8; RFC 7636 §4.1 e §4.2). Tudo nasce e morre no servidor: o
// verifier e o `state` só saem daqui selados no cookie do fluxo, e o `authorize` só leva o challenge.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const VERIFIER_BYTES = 32;
const STATE_BYTES = 16;
const NONCE_BYTES = 16;

/** 32 bytes aleatórios em base64url: 43 caracteres *unreserved*. Novo a cada login. */
export function createVerifier(): string {
  return randomBytes(VERIFIER_BYTES).toString("base64url");
}

/** 16 bytes em base64url (22 caracteres), conferido no retorno. */
export function createState(): string {
  return randomBytes(STATE_BYTES).toString("base64url");
}

/** `base64url(SHA-256(verifier))`, o único método (nunca `plain`). */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Nonce da CSP, novo a cada pedido. */
export function createNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64");
}

/** Igualdade em tempo constante: compara os SHA-256, que têm sempre o mesmo tamanho (o `timingSafeEqual` exige). */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}
