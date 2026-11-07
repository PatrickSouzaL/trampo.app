// PKCE S256 do login (ADR-004 D2 e D3 passo 3; RFC 7636 §4.1 e §4.2). O verifier e o `state` nascem
// e vivem só na memória do Service Worker (D9): nada daqui vai a storage, ao painel nem a log.

/** O que o módulo usa do `crypto` do navegador; injetável para os testes. */
export interface PkceCrypto {
  getRandomValues(bytes: Uint8Array): Uint8Array;
  readonly subtle?: Pick<SubtleCrypto, "digest"> | undefined;
}

export interface PkcePair {
  /** 32 bytes aleatórios em base64url: 43 caracteres *unreserved* (RFC 7636 §4.1). */
  readonly verifier: string;
  /** `base64url(SHA-256(verifier))`, o único método aceito (S256). */
  readonly challenge: string;
}

const VERIFIER_BYTES = 32;
const STATE_BYTES = 16;

/** base64url sem preenchimento (RFC 4648 §5), como o RFC 7636 exige. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomBytes(source: PkceCrypto, length: number): Uint8Array {
  return source.getRandomValues(new Uint8Array(length));
}

/**
 * Challenge S256 do verifier. Sem `crypto.subtle`, lança: o login falha fechado e nunca cai para
 * `plain` (ADR-004 D2; RFC 7636 §7.2).
 */
export async function s256Challenge(verifier: string, source: PkceCrypto = crypto): Promise<string> {
  if (source.subtle === undefined) throw new Error("crypto.subtle indisponível: sem S256, o login não abre");
  const digest = await source.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Par novo a cada login: o verifier nunca é reaproveitado entre fluxos (D2, um fluxo por vez). */
export async function createPkcePair(source: PkceCrypto = crypto): Promise<PkcePair> {
  const verifier = base64url(randomBytes(source, VERIFIER_BYTES));
  return { verifier, challenge: await s256Challenge(verifier, source) };
}

/** `state` de 16 bytes em base64url (22 caracteres), conferido sempre no retorno (D3 passo 7). */
export function createState(source: PkceCrypto = crypto): string {
  return base64url(randomBytes(source, STATE_BYTES));
}
