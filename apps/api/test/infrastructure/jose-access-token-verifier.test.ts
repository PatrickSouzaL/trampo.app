// F1-API-02 (SR-05; ADR-013): o adapter jose contra um JWKS local falso. Cada recusa do §3 da auditoria tem um
// teste; `alg none` e HS256 provam também que não houve busca no JWKS. Nenhuma chamada ao Supabase real.
// F1-API-07, commit 07d (ADR-004 D6): o `amr` exigido (M-17) e a pré-checagem `keysReady()` sem token (P15).
import { exportSPKI } from "jose";
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { AccessTokenVerifier } from "../../src/application/ports/access-token-verifier.js";
import type { AmrMethod } from "../../src/infrastructure/auth/allowed-amr-env.js";
import {
  JWKS_TIMINGS,
  JWT_POLICY,
  createJoseAccessTokenVerifier,
  hasSigningKey,
  type JwksTimings,
} from "../../src/infrastructure/auth/jose-access-token-verifier.js";
import {
  nowSeconds,
  rawToken,
  signHs256,
  signToken,
  signingKey,
  startJwksServer,
  supabaseClaims,
  type Claims,
  type JwksServer,
  type SigningKey,
} from "./jwks-fixture.js";

const INVALID = { ok: false, reason: "token_invalido" } as const;
const UNAVAILABLE = { ok: false, reason: "chaves_indisponiveis" } as const;

let keyA: SigningKey;
let keyB: SigningKey;
let rogue: SigningKey;
let server: JwksServer;

beforeAll(async () => {
  [keyA, keyB, rogue] = await Promise.all([signingKey(), signingKey(), signingKey()]);
  server = await startJwksServer([keyA.jwk]);
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.keys = [keyA.jwk];
  server.behavior = { status: 200, delayMs: 0 };
  server.hits = 0;
});

const OAUTH_ONLY: readonly [AmrMethod, ...AmrMethod[]] = ["oauth"];

/** Verificador novo (cache vazio) apontando para o JWKS falso. Por padrão, só `amr` oauth, como em produção. */
function verifier(jwks: Partial<JwksTimings> = {}, allowedAmr = OAUTH_ONLY): AccessTokenVerifier {
  return createJoseAccessTokenVerifier({ issuer: server.issuer, jwksUrl: server.jwksUrl, allowedAmr, jwks });
}

const claims = (overrides: Claims = {}): Claims => supabaseClaims(server.issuer, overrides);

describe("token válido do Supabase", () => {
  test("aceita e devolve só userId e sessionId, mais iat e exp no lifetime (nenhuma outra claim sai do adapter)", async () => {
    const now = nowSeconds();
    const result = await verifier().verify(await signToken(keyA, claims({ iat: now - 30, exp: now + 870 })));
    expect(result).toEqual({
      ok: true,
      principal: { userId: "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f", sessionId: "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3" },
      lifetime: { issuedAt: now - 30, expiresAt: now + 870 },
    });
    expect(JSON.stringify(result)).not.toContain("canario");
  });

  test("sem session_id: sessionId null", async () => {
    const result = await verifier().verify(await signToken(keyA, claims({ session_id: undefined })));
    expect(result).toEqual({
      ok: true,
      principal: { userId: "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f", sessionId: null },
      lifetime: { issuedAt: expect.any(Number), expiresAt: expect.any(Number) },
    });
  });

  test("expirado há 5 s (dentro da tolerância de 10 s): aceito", async () => {
    const now = nowSeconds();
    const result = await verifier().verify(await signToken(keyA, claims({ iat: now - 120, exp: now - 5 })));
    expect(result.ok).toBe(true);
  });

  test("iat 5 s no futuro (relógio do Supabase adiantado, dentro da tolerância): aceito", async () => {
    const now = nowSeconds();
    expect((await verifier().verify(await signToken(keyA, claims({ iat: now + 5 })))).ok).toBe(true);
  });
});

describe("SR-05: algoritmo recusado ANTES de buscar o JWKS", () => {
  test("alg none (sem assinatura e com assinatura qualquer)", async () => {
    const v = verifier();
    const unsigned = await rawToken({ alg: "none", typ: "JWT", kid: keyA.kid }, claims());
    expect(await v.verify(unsigned)).toEqual(INVALID);
    expect(await v.verify(`${unsigned}AAAA`)).toEqual(INVALID);
    expect(await v.verify(await rawToken({ alg: "NONE", typ: "JWT", kid: keyA.kid }, claims()))).toEqual(INVALID);
    expect(server.hits).toBe(0);
  });

  test("HS256 com segredo qualquer", async () => {
    const token = await signHs256(new TextEncoder().encode("segredo-legado-do-supabase-32-bytes!!"), claims(), keyA.kid);
    expect(await verifier().verify(token)).toEqual(INVALID);
    expect(server.hits).toBe(0);
  });

  test("HS256 com a chave PÚBLICA como segredo (confusão de chave: JWK e PEM)", async () => {
    const v = verifier();
    const asJwk = new TextEncoder().encode(JSON.stringify(keyA.jwk));
    const asPem = new TextEncoder().encode(await exportSPKI(keyA.publicKey));
    expect(await v.verify(await signHs256(asJwk, claims(), keyA.kid))).toEqual(INVALID);
    expect(await v.verify(await signHs256(asPem, claims(), keyA.kid))).toEqual(INVALID);
    expect(server.hits).toBe(0);
  });

  test.each(["ES384", "RS256"] as const)("%s (algoritmo fora da lista, mesmo com a chave publicada)", async (alg) => {
    const other = await signingKey(alg);
    server.keys = [keyA.jwk, other.jwk];
    expect(await verifier().verify(await signToken(other, claims(), {}, alg))).toEqual(INVALID);
    expect(server.hits).toBe(0);
  });
});

describe("SR-05: chave e assinatura", () => {
  test("sem kid ou com kid vazio: recusado sem buscar o JWKS", async () => {
    const v = verifier();
    expect(await v.verify(await signToken(keyA, claims(), { kid: undefined }))).toEqual(INVALID);
    expect(await v.verify(await signToken(keyA, claims(), { kid: "" }))).toEqual(INVALID);
    expect(server.hits).toBe(0);
  });

  test("kid desconhecido: 401 (token_invalido), não 503", async () => {
    const token = await signToken(rogue, claims());
    expect(await verifier().verify(token)).toEqual(INVALID);
  });

  test("outra chave assinando com o kid de uma chave publicada: assinatura recusada", async () => {
    expect(await verifier().verify(await signToken(rogue, claims(), { kid: keyA.kid }))).toEqual(INVALID);
  });

  test("assinatura adulterada e payload trocado depois de assinar", async () => {
    const v = verifier();
    const token = await signToken(keyA, claims());
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify(claims({ sub: "11111111-2222-4333-8444-555555555555" }))).toString("base64url");
    expect(await v.verify(`${header}.${forged}.${signature}`)).toEqual(INVALID);
    expect(await v.verify(`${token.slice(0, -4)}AAAA`)).toEqual(INVALID);
  });

  test("crit com extensão desconhecida: recusado", async () => {
    const token = await rawToken({ alg: "ES256", typ: "JWT", kid: keyA.kid, crit: ["x-trampo"], "x-trampo": 1 }, claims(), keyA);
    expect(await verifier().verify(token)).toEqual(INVALID);
  });

  test.each([
    ["typ errado", { typ: "at+jwt" }],
    ["typ ausente", { typ: undefined }],
  ])("%s: recusado", async (_label, header) => {
    expect(await verifier().verify(await signToken(keyA, claims(), header))).toEqual(INVALID);
  });
});

describe("SR-05: claims", () => {
  const now = nowSeconds();
  test.each<[string, Claims]>([
    ["sem exp", { exp: undefined }],
    ["sem iat", { iat: undefined }],
    ["expirado além da tolerância (15 s)", { iat: now - 120, exp: now - 15 }],
    ["iat 60 s no futuro", { iat: now + 60, exp: now + 960 }],
    ["mais velho que 900 s, mesmo com exp distante", { iat: now - 1_000, exp: now + 3_600 }],
    ["sem iss", { iss: undefined }],
    ["iss de outro projeto", { iss: "https://outro-projeto.supabase.co/auth/v1" }],
    ["iss com barra final", { iss: "ISSUER/" }],
    ["sem aud", { aud: undefined }],
    ["aud errado", { aud: "anon" }],
    ["aud em array que contém authenticated", { aud: ["authenticated", "outro"] }],
    ["aud em array só com authenticated", { aud: ["authenticated"] }],
    ["sem role", { role: undefined }],
    ["role anon", { role: "anon" }],
    ["role service_role", { role: "service_role" }],
    ["role com caixa diferente", { role: "Authenticated" }],
    ["anônimo (is_anonymous true)", { is_anonymous: true }],
    ["is_anonymous ausente (falha fechado)", { is_anonymous: undefined }],
    ["is_anonymous como texto", { is_anonymous: "false" }],
    ["sem sub", { sub: undefined }],
    ["sub fora de UUID", { sub: "admin" }],
    ["session_id fora de UUID", { session_id: "sessao-1" }],
  ])("%s: recusado", async (_label, overrides) => {
    const patch = overrides["iss"] === "ISSUER/" ? { ...overrides, iss: `${server.issuer}/` } : overrides;
    expect(await verifier().verify(await signToken(keyA, claims(patch)))).toEqual(INVALID);
  });
});

describe("amr exigido (ADR-004 D6, emenda ao ADR-013 D4; M-17)", () => {
  const at = nowSeconds();
  const entry = (method: unknown, extra: Claims = {}): Claims => ({ method, timestamp: at, ...extra });

  test.each<[string, unknown]>([
    ["oauth", [entry("oauth")]],
    ["oauth repetido (duas entradas do mesmo método)", [entry("oauth"), entry("oauth")]],
    ["oauth com provider e campos extras do GoTrue", [entry("oauth", { provider: "github", extra: 1 })]],
  ])("%s: aceito", async (_label, amr) => {
    expect((await verifier().verify(await signToken(keyA, claims({ amr })))).ok).toBe(true);
  });

  test.each<[string, unknown]>([
    ["password", [entry("password")]],
    ["otp", [entry("otp")]],
    ["magiclink", [entry("magiclink")]],
    ["anonymous", [entry("anonymous")]],
    ["sso/saml", [entry("sso/saml")]],
    ["totp", [entry("totp")]],
    ["oauth com caixa diferente", [entry("OAuth")]],
    ["oauth misturado com password (todo método precisa estar na lista)", [entry("oauth"), entry("password")]],
    ["password antes de oauth", [entry("password"), entry("oauth")]],
    ["lista vazia", []],
    ["amr ausente (falha fechado)", undefined],
    ["amr null", null],
    ["amr como texto", "oauth"],
    ["amr como objeto solto", entry("oauth")],
    ["forma do RFC 8176 (lista de strings), até o P9", ["oauth"]],
    ["entrada sem method", [{ timestamp: at }]],
    ["method numérico", [entry(1)]],
    ["entrada nula", [null]],
  ])("%s: recusado como token_invalido (401, sem motivo novo)", async (_label, amr) => {
    expect(await verifier().verify(await signToken(keyA, claims({ amr })))).toEqual(INVALID);
  });

  test("a lista vem da configuração: password só passa quando listado (pilha local)", async () => {
    const password = await signToken(keyA, claims({ amr: [entry("password")] }));
    const mixed = await signToken(keyA, claims({ amr: [entry("oauth"), entry("password")] }));
    const oauth = await signToken(keyA, claims());
    const both = verifier({}, ["oauth", "password"]);
    expect((await both.verify(password)).ok).toBe(true);
    expect((await both.verify(mixed)).ok).toBe(true);
    expect((await both.verify(oauth)).ok).toBe(true);
    const passwordOnly = verifier({}, ["password"]);
    expect((await passwordOnly.verify(password)).ok).toBe(true);
    expect(await passwordOnly.verify(oauth)).toEqual(INVALID);
  });

  test("o amr não sai do adapter", async () => {
    const result = await verifier().verify(await signToken(keyA, claims({ amr: [entry("oauth", { provider: "canario-provider" })] })));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/amr|oauth|canario/);
  });
});

describe("SR-05: JWKS indisponível ou vazio falha fechado (503, nunca 200)", () => {
  test.each<[string, () => void]>([
    ["JWKS vazio (projeto ainda no segredo HS256)", () => (server.keys = [])],
    ["JWKS só com RSA", () => (server.keys = [{ kty: "RSA", n: "AQAB", e: "AQAB", kid: "rsa-1", alg: "RS256" }])],
    ["status 500", () => (server.behavior = { status: 500, delayMs: 0, body: "{}" })],
    ["status 204 (sem corpo)", () => (server.behavior = { status: 204, delayMs: 0, body: "" })],
    ["200 com corpo vazio", () => (server.behavior = { status: 200, delayMs: 0, body: "" })],
    ["JSON inválido", () => (server.behavior = { status: 200, delayMs: 0, body: "{keys:" })],
    ["JSON sem keys", () => (server.behavior = { status: 200, delayMs: 0, body: '{"chaves":[]}' })],
    ["redirecionamento", () => (server.behavior = { status: 302, delayMs: 0, body: "", headers: { location: "https://exemplo.test/jwks" } })],
  ])("%s", async (_label, arrange) => {
    arrange();
    expect(await verifier().verify(await signToken(keyA, claims()))).toEqual(UNAVAILABLE);
  });

  test("resposta lenta além do timeout", async () => {
    server.behavior = { status: 200, delayMs: 1_000 };
    const started = performance.now();
    expect(await verifier({ timeoutMs: 100 }).verify(await signToken(keyA, claims()))).toEqual(UNAVAILABLE);
    expect(performance.now() - started).toBeLessThan(900);
  });

  test("resposta maior que o teto de bytes (lida em partes, sem confiar no Content-Length)", async () => {
    server.behavior = { status: 200, delayMs: 0, body: JSON.stringify({ keys: [keyA.jwk], pad: "x".repeat(4_096) }) };
    expect(await verifier({ maxBytes: 1_024 }).verify(await signToken(keyA, claims()))).toEqual(UNAVAILABLE);
    // O mesmo corpo dentro do teto passa: o que recusa é o tamanho.
    expect((await verifier({ maxBytes: 8_192 }).verify(await signToken(keyA, claims()))).ok).toBe(true);
  });

  test("servidor fora do ar (porta fechada)", async () => {
    const dead = await startJwksServer([keyA.jwk]);
    const url = dead.jwksUrl;
    await dead.close();
    const v = createJoseAccessTokenVerifier({ issuer: server.issuer, jwksUrl: url, allowedAmr: OAUTH_ONLY });
    expect(await v.verify(await signToken(keyA, claims()))).toEqual(UNAVAILABLE);
  });

  test("cache expirado e JWKS fora do ar: 503 mesmo com a chave antiga na memória (não 401)", async () => {
    const v = verifier({ cacheMaxAgeMs: 50, cooldownMs: 0 });
    expect((await v.verify(await signToken(keyA, claims()))).ok).toBe(true);
    server.behavior = { status: 500, delayMs: 0, body: "{}" };
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await v.verify(await signToken(keyA, claims()))).toEqual(UNAVAILABLE);
    expect(await v.verify(await signToken(rogue, claims()))).toEqual(UNAVAILABLE);
  });

  test("JWKS volta ao normal: o mesmo verificador aceita de novo (sem estado preso)", async () => {
    const v = verifier({ cooldownMs: 0 });
    server.behavior = { status: 500, delayMs: 0, body: "{}" };
    expect(await v.verify(await signToken(keyA, claims()))).toEqual(UNAVAILABLE);
    server.behavior = { status: 200, delayMs: 0 };
    expect((await v.verify(await signToken(keyA, claims()))).ok).toBe(true);
  });
});

describe("cache e rotação do JWKS", () => {
  test("cache: dez verificações, uma busca", async () => {
    const v = verifier();
    for (let i = 0; i < 10; i += 1) expect((await v.verify(await signToken(keyA, claims()))).ok).toBe(true);
    expect(server.hits).toBe(1);
  });

  test("verificações simultâneas no cache frio: uma busca só", async () => {
    const v = verifier();
    const token = await signToken(keyA, claims());
    const results = await Promise.all(Array.from({ length: 20 }, () => v.verify(token)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(server.hits).toBe(1);
  });

  test("inundação de kid desconhecido dentro do cooldown não vira inundação no Supabase", async () => {
    const v = verifier();
    expect((await v.verify(await signToken(keyA, claims()))).ok).toBe(true);
    for (let i = 0; i < 20; i += 1) {
      expect(await v.verify(await signToken(rogue, claims(), { kid: `aleatorio-${i}` }))).toEqual(INVALID);
    }
    expect(server.hits).toBe(1);
  });

  test("rotação: kid novo publicado depois do cache é aceito com UMA nova busca", async () => {
    const v = verifier({ cooldownMs: 50 });
    expect((await v.verify(await signToken(keyA, claims()))).ok).toBe(true);
    server.keys = [keyA.jwk, keyB.jwk];
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await v.verify(await signToken(keyB, claims()))).ok).toBe(true);
    expect(server.hits).toBe(2);
    // A chave anterior (previously used) continua aceita.
    expect((await v.verify(await signToken(keyA, claims()))).ok).toBe(true);
  });

  test("chave revogada some do JWKS: depois do cache, o token dela é recusado", async () => {
    const v = verifier({ cacheMaxAgeMs: 50, cooldownMs: 0 });
    expect((await v.verify(await signToken(keyA, claims()))).ok).toBe(true);
    server.keys = [keyB.jwk];
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await v.verify(await signToken(keyA, claims()))).toEqual(INVALID);
  });
});

describe("keysReady(): pré-checagem das chaves sem token (ADR-004 D6, P15)", () => {
  test("JWKS com chave ES256: true, com uma busca", async () => {
    expect(await verifier().keysReady()).toBe(true);
    expect(server.hits).toBe(1);
  });

  test.each<[string, () => void]>([
    ["JWKS vazio (projeto ainda no segredo HS256)", () => (server.keys = [])],
    ["JWKS só com RSA", () => (server.keys = [{ kty: "RSA", n: "AQAB", e: "AQAB", kid: "rsa-1", alg: "RS256" }])],
    ["status 500", () => (server.behavior = { status: 500, delayMs: 0, body: "{}" })],
    ["200 com corpo vazio", () => (server.behavior = { status: 200, delayMs: 0, body: "" })],
    ["JSON inválido", () => (server.behavior = { status: 200, delayMs: 0, body: "{keys:" })],
    ["JSON sem keys", () => (server.behavior = { status: 200, delayMs: 0, body: '{"chaves":[]}' })],
    ["redirecionamento", () => (server.behavior = { status: 302, delayMs: 0, body: "", headers: { location: "https://exemplo.test/jwks" } })],
  ])("%s: false, sem lançar", async (_label, arrange) => {
    arrange();
    await expect(verifier().keysReady()).resolves.toBe(false);
  });

  test("resposta lenta além do timeout: false dentro do prazo", async () => {
    server.behavior = { status: 200, delayMs: 1_000 };
    const started = performance.now();
    await expect(verifier({ timeoutMs: 100 }).keysReady()).resolves.toBe(false);
    expect(performance.now() - started).toBeLessThan(900);
  });

  test("resposta acima do teto de bytes: false", async () => {
    server.behavior = { status: 200, delayMs: 0, body: JSON.stringify({ keys: [keyA.jwk], pad: "x".repeat(4_096) }) };
    await expect(verifier({ maxBytes: 1_024 }).keysReady()).resolves.toBe(false);
  });

  test("servidor fora do ar (porta fechada): false", async () => {
    const dead = await startJwksServer([keyA.jwk]);
    const url = dead.jwksUrl;
    await dead.close();
    const v = createJoseAccessTokenVerifier({ issuer: server.issuer, jwksUrl: url, allowedAmr: OAUTH_ONLY });
    await expect(v.keysReady()).resolves.toBe(false);
  });

  test("cache fresco: responde sem nova busca, e o verify usa o MESMO cache", async () => {
    const v = verifier();
    expect(await v.keysReady()).toBe(true);
    expect(await v.keysReady()).toBe(true);
    expect((await v.verify(await signToken(keyA, claims()))).ok).toBe(true);
    expect(server.hits).toBe(1);
  });

  test("quem decide a nova busca é a validade do cache, não o cooldown", async () => {
    // Cooldown zerado e cache de 10 min: a segunda pré-checagem não busca de novo (cada exchange não vira uma busca).
    const v = verifier({ cooldownMs: 0 });
    expect(await v.keysReady()).toBe(true);
    expect(await v.keysReady()).toBe(true);
    expect(server.hits).toBe(1);
  });

  test("depois de um verify, keysReady não busca de novo", async () => {
    const v = verifier();
    expect((await v.verify(await signToken(keyA, claims()))).ok).toBe(true);
    expect(await v.keysReady()).toBe(true);
    expect(server.hits).toBe(1);
  });

  test("cache fresco sem chave ES256: false sem nova busca (o cooldown do jose segura a inundação)", async () => {
    server.keys = [];
    const v = verifier();
    for (let i = 0; i < 5; i += 1) expect(await v.keysReady()).toBe(false);
    expect(server.hits).toBe(1);
  });

  test("pré-checagens simultâneas no cache frio: uma busca só", async () => {
    const v = verifier();
    const results = await Promise.all(Array.from({ length: 20 }, () => v.keysReady()));
    expect(results.every(Boolean)).toBe(true);
    expect(server.hits).toBe(1);
  });

  test("cache vencido e JWKS fora do ar: false mesmo com a chave antiga na memória", async () => {
    const v = verifier({ cacheMaxAgeMs: 50, cooldownMs: 0 });
    expect(await v.keysReady()).toBe(true);
    server.behavior = { status: 500, delayMs: 0, body: "{}" };
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await v.keysReady()).toBe(false);
    expect(server.hits).toBe(2);
  });

  test("cache vencido: busca de novo e acompanha o JWKS (chave publicada depois)", async () => {
    server.keys = [];
    const v = verifier({ cacheMaxAgeMs: 50, cooldownMs: 0 });
    expect(await v.keysReady()).toBe(false);
    server.keys = [keyA.jwk];
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await v.keysReady()).toBe(true);
    expect(server.hits).toBe(2);
  });

  test("JWKS volta ao normal: o mesmo verificador responde true (sem estado preso)", async () => {
    const v = verifier({ cooldownMs: 0 });
    server.behavior = { status: 500, delayMs: 0, body: "{}" };
    expect(await v.keysReady()).toBe(false);
    server.behavior = { status: 200, delayMs: 0 };
    expect(await v.keysReady()).toBe(true);
  });
});

describe("política travada", () => {
  test("parâmetros do ADR-013 D4 e D5", () => {
    expect(JWT_POLICY).toEqual({
      algorithm: "ES256",
      type: "JWT",
      audience: "authenticated",
      role: "authenticated",
      clockToleranceSeconds: 10,
      maxTokenAgeSeconds: 900,
    });
    expect(JWKS_TIMINGS).toEqual({ timeoutMs: 3_000, cacheMaxAgeMs: 600_000, cooldownMs: 30_000, maxBytes: 65_536 });
  });

  test.each<[string, Parameters<typeof hasSigningKey>[0], boolean]>([
    ["JWKS ainda não carregado", undefined, false],
    ["vazio", { keys: [] }, false],
    ["EC P-256 com alg ES256 e use sig", { keys: [{ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" }] }, true],
    ["EC P-256 sem alg nem use", { keys: [{ kty: "EC", crv: "P-256" }] }, true],
    ["EC P-384", { keys: [{ kty: "EC", crv: "P-384" }] }, false],
    ["EC P-256 marcada para outro algoritmo", { keys: [{ kty: "EC", crv: "P-256", alg: "ECDH-ES" }] }, false],
    ["EC P-256 de cifragem", { keys: [{ kty: "EC", crv: "P-256", use: "enc" }] }, false],
    ["RSA", { keys: [{ kty: "RSA" }] }, false],
    ["RSA com crv P-256 (forma incoerente)", { keys: [{ kty: "RSA", crv: "P-256" }] }, false],
    ["oct (segredo simétrico)", { keys: [{ kty: "oct" }] }, false],
  ])("hasSigningKey: %s → %s", (_label, jwks, expected) => {
    expect(hasSigningKey(jwks)).toBe(expected);
  });
});

describe("propriedade: o verificador nunca rejeita e nunca aceita lixo", () => {
  let v: AccessTokenVerifier;
  beforeAll(() => {
    v = createJoseAccessTokenVerifier({
      issuer: "http://127.0.0.1:1/auth/v1",
      jwksUrl: new URL("http://127.0.0.1:1/x"),
      allowedAmr: OAUTH_ONLY,
    });
  });

  test("entrada arbitrária e tokens com forma de JWT: sempre { ok: false }", async () => {
    const segment = fc.string({ unit: fc.constantFrom(..."ABCabc012-_".split("")), maxLength: 40 });
    const token = fc.oneof(
      fc.string({ maxLength: 200 }),
      fc.tuple(segment, segment, segment).map((parts) => parts.join(".")),
      fc.json().map((json) => `${Buffer.from(json).toString("base64url")}.e30.AAAA`),
    );
    await fc.assert(
      fc.asyncProperty(token, async (input) => {
        const result = await v.verify(input);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  test("keysReady com o JWKS inalcançável: sempre resolve false, nunca rejeita", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => v.keysReady()));
    expect(results).toEqual(Array.from({ length: 5 }, () => ({ status: "fulfilled", value: false })));
  });
});
