// JWKS falso em 127.0.0.1 com chaves geradas no teste (ADR-013 §3, item 4): nenhum teste toca o Supabase real.
// Também assina tokens do jeito do Supabase Auth e, para os ataques, monta tokens à mão (alg none, crit).
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";

export interface JwksBehavior {
  status: number;
  /** Corpo cru; `undefined` serve `{ keys }`. */
  body?: string;
  delayMs: number;
  headers?: Record<string, string>;
}

export interface JwksServer {
  readonly issuer: string;
  readonly jwksUrl: URL;
  /** Quantas vezes o JWKS foi buscado. */
  hits: number;
  keys: JWK[];
  behavior: JwksBehavior;
  close(): Promise<void>;
}

export const JWKS_PATH = "/auth/v1/.well-known/jwks.json";

export async function startJwksServer(keys: JWK[]): Promise<JwksServer> {
  const state = { hits: 0, keys, behavior: { status: 200, delayMs: 0 } as JwksBehavior };
  const server: Server = createServer((request, response) => {
    if (request.url !== JWKS_PATH) {
      response.writeHead(404).end();
      return;
    }
    state.hits += 1;
    const { status, body, delayMs, headers } = state.behavior;
    const send = (): void => {
      if (response.destroyed) return;
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(body ?? JSON.stringify({ keys: state.keys }));
    };
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    issuer: `${origin}/auth/v1`,
    jwksUrl: new URL(`${origin}${JWKS_PATH}`),
    get hits() {
      return state.hits;
    },
    set hits(value) {
      state.hits = value;
    },
    get keys() {
      return state.keys;
    },
    set keys(value) {
      state.keys = value;
    },
    get behavior() {
      return state.behavior;
    },
    set behavior(value) {
      state.behavior = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  /** JWK público no formato que o Supabase publica (alg, use, key_ops, ext). */
  readonly jwk: JWK;
}

export async function signingKey(alg: "ES256" | "ES384" | "RS256" = "ES256"): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const kid = randomUUID();
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig", key_ops: ["verify"], ext: true };
  return { kid, privateKey, publicKey, jwk };
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export type Claims = Record<string, unknown>;

/** Claims de um access token do Supabase Auth para o `issuer` dado. */
export function supabaseClaims(issuer: string, overrides: Claims = {}): Claims {
  const now = nowSeconds();
  return {
    iss: issuer,
    aud: "authenticated",
    sub: "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f",
    role: "authenticated",
    is_anonymous: false,
    session_id: "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3",
    aal: "aal1",
    email: "canario-email@exemplo.test",
    user_metadata: { name: "Canário Nome" },
    iat: now,
    exp: now + 900,
    ...overrides,
  };
}

/** Remove as claims com valor `undefined` (para provar claim ausente). */
function compact(claims: Claims): Claims {
  return Object.fromEntries(Object.entries(claims).filter(([, value]) => value !== undefined));
}

export async function signToken(
  key: SigningKey,
  claims: Claims,
  header: Record<string, unknown> = {},
  alg: "ES256" | "ES384" | "RS256" = "ES256",
): Promise<string> {
  return new SignJWT(compact(claims))
    .setProtectedHeader({ alg, kid: key.kid, typ: "JWT", ...header })
    .sign(key.privateKey);
}

/** HS256 com um segredo arbitrário (inclusive a chave pública: ataque de confusão de chave). */
export async function signHs256(secret: Uint8Array, claims: Claims, kid: string): Promise<string> {
  return new SignJWT(compact(claims)).setProtectedHeader({ alg: "HS256", kid, typ: "JWT" }).sign(secret);
}

export const b64url = (value: string | Uint8Array): string =>
  Buffer.from(typeof value === "string" ? value : value).toString("base64url");

/** Token montado à mão: o jose não assina `alg: none` nem `crit` desconhecido. */
export async function rawToken(header: Record<string, unknown>, claims: Claims, key?: SigningKey): Promise<string> {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(compact(claims)))}`;
  if (key === undefined) return `${input}.`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(new Uint8Array(signature))}`;
}
