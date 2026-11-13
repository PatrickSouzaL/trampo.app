import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { SignJWT, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAccessTokenVerifier, type AccessTokenVerifier } from "../../src/server/verifier";
import { GOTRUE_CANARIES, startFakeGotrue, type FakeGotrue } from "../support/fake-gotrue";

const PUBLISHABLE = ["sb", "publishable", "p".repeat(24)].join("_");
let fake: FakeGotrue;
let verifier: AccessTokenVerifier;
let issuer: string;
const extraServers: Server[] = [];

beforeAll(async () => {
  fake = await startFakeGotrue({ publishableKey: PUBLISHABLE });
  issuer = `${fake.url.origin}/auth/v1`;
  verifier = createAccessTokenVerifier({ issuer, jwksUrl: new URL("/auth/v1/.well-known/jwks.json", fake.url) });
});
afterAll(async () => {
  await fake.close();
  await Promise.all(extraServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1_000);
  return {
    iss: issuer,
    aud: "authenticated",
    role: "authenticated",
    sub: GOTRUE_CANARIES.userId,
    session_id: randomUUID(),
    is_anonymous: false,
    amr: [{ method: "oauth", timestamp: now }],
    email: GOTRUE_CANARIES.email,
    iat: now,
    exp: now + 900,
    ...overrides,
  };
}

/** Sobe um JWKS próprio que responde o corpo dado. */
async function jwksServer(body: string, status = 200): Promise<URL> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  extraServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/v1/.well-known/jwks.json`);
}

describe("createAccessTokenVerifier (ADR-027 D5; ADR-013 D4 e D5)", () => {
  it("aceita o access do GoTrue e devolve só userId, sessionId e expiresAt", async () => {
    const payload = claims();
    const result = await verifier.verify(await fake.sign(payload));
    expect(result).toEqual({ ok: true, userId: GOTRUE_CANARIES.userId, sessionId: payload["session_id"], expiresAt: payload["exp"] });
    expect(JSON.stringify(result)).not.toContain(GOTRUE_CANARIES.email);
  });

  it.each([
    ["amr password", { amr: [{ method: "password", timestamp: 1 }] }],
    ["amr misto oauth e password", { amr: [{ method: "oauth", timestamp: 1 }, { method: "password", timestamp: 1 }] }],
    ["amr vazio", { amr: [] }],
    ["amr na forma do RFC 8176", { amr: ["oauth"] }],
    ["amr anonymous", { amr: [{ method: "anonymous", timestamp: 1 }] }],
    ["sem amr", { amr: undefined }],
    ["sem session_id", { session_id: undefined }],
    ["session_id que não é uuid", { session_id: "x" }],
    ["aud em lista", { aud: ["authenticated"] }],
    ["aud anon", { aud: "anon" }],
    ["role anon", { role: "anon" }],
    ["is_anonymous verdadeiro", { is_anonymous: true }],
    ["sem is_anonymous", { is_anonymous: undefined }],
    ["sub que não é uuid", { sub: "abc" }],
    ["issuer de outro projeto", { iss: "https://outro.supabase.invalid/auth/v1" }],
    ["vencido", { exp: Math.floor(Date.now() / 1_000) - 60 }],
    ["sem exp", { exp: undefined }],
    ["mais velho que 900 s", { iat: Math.floor(Date.now() / 1_000) - 1_000 }],
  ])("recusa: %s", async (_caso, overrides) => {
    const payload = claims(overrides);
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete payload[key];
    expect(await verifier.verify(await fake.sign(payload))).toEqual({ ok: false, reason: "invalido" });
  });

  it("recusa o cabeçalho sem kid, o kid desconhecido e a assinatura de outra chave", async () => {
    expect(await verifier.verify(await fake.sign(claims(), { kid: "" }))).toEqual({ ok: false, reason: "invalido" });
    expect(await verifier.verify(await fake.sign(claims(), { kid: "outro" }))).toEqual({ ok: false, reason: "invalido" });
    const { privateKey } = await generateKeyPair("ES256");
    const forged = await new SignJWT(claims()).setProtectedHeader({ alg: "ES256", typ: "JWT", kid: fake.jwk.kid as string }).sign(privateKey);
    expect(await verifier.verify(forged)).toEqual({ ok: false, reason: "invalido" });
  });

  it("recusa HS256 e lixo sem consultar chave", async () => {
    const hs = await new SignJWT(claims()).setProtectedHeader({ alg: "HS256", typ: "JWT", kid: "k" }).sign(new Uint8Array(32));
    expect(await verifier.verify(hs)).toEqual({ ok: false, reason: "invalido" });
    expect(await verifier.verify("a.b.c")).toEqual({ ok: false, reason: "invalido" });
  });

  it("JWKS fora do ar, vazio, sem EC P-256 ou acima do teto: indisponível, nunca inválido (T30)", async () => {
    const token = await fake.sign(claims());
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const targets = [
      new URL(`http://127.0.0.1:${port}/auth/v1/.well-known/jwks.json`),
      await jwksServer(JSON.stringify({ keys: [] })),
      await jwksServer(JSON.stringify({ keys: [{ kty: "RSA", n: "AQAB", e: "AQAB", kid: "r" }] })),
      await jwksServer(JSON.stringify({ keys: [], pad: "p".repeat(70 * 1024) })),
      await jwksServer("", 204),
      // Nenhuma serve ao ES256: outra curva, outro algoritmo, outro uso.
      await jwksServer(
        JSON.stringify({
          keys: [
            { ...fake.jwk, kid: "c1", crv: "P-384" },
            { ...fake.jwk, kid: "c2", alg: "ES384" },
            { ...fake.jwk, kid: "c3", use: "enc" },
          ],
        }),
      ),
    ];
    for (const jwksUrl of targets) {
      const isolated = createAccessTokenVerifier({ issuer, jwksUrl, jwks: { timeoutMs: 1_000 } });
      expect(await isolated.verify(token)).toEqual({ ok: false, reason: "indisponivel" });
    }
  });

  it("a chave ES256 existe e o kid não casa: o token é que está errado", async () => {
    const isolated = createAccessTokenVerifier({ issuer, jwksUrl: await jwksServer(JSON.stringify({ keys: [{ ...fake.jwk, kid: "outra" }] })) });
    expect(await isolated.verify(await fake.sign(claims()))).toEqual({ ok: false, reason: "invalido" });
    const bare = { kty: fake.jwk.kty, crv: fake.jwk.crv, x: fake.jwk.x, y: fake.jwk.y };
    const semAlg = createAccessTokenVerifier({ issuer, jwksUrl: await jwksServer(JSON.stringify({ keys: [{ ...bare, kid: "outra" }] })) });
    expect(await semAlg.verify(await fake.sign(claims()))).toEqual({ ok: false, reason: "invalido" });
  });
});
