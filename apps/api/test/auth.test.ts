// F1-API-02 (SR-05; ADR-013 D2, D3 e D7): o hook de autenticação no onRequest. Verificador falso para a forma
// do header, a ordem dos hooks e as rotas públicas; e o adapter real (jose + JWKS local) de ponta a ponta.
import { Readable } from "node:stream";

import { ApiErrorSchema } from "@trampo/contracts/api";
import { ACCESS_TOKEN_MAX_CHARS, HTTP_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

import type { AccessTokenVerifier } from "../src/application/ports/access-token-verifier.js";
import { createJoseAccessTokenVerifier } from "../src/infrastructure/auth/jose-access-token-verifier.js";
import { buildApp, type BuildAppOptions } from "../src/presentation/build-app.js";
import { PUBLIC_ROUTES, bearerToken } from "../src/presentation/edge/auth.js";
import { TEST_LIFETIME, TEST_PRINCIPAL, TEST_TOKEN, fakeVerifier } from "./auth-fakes.js";
import { openLimits } from "./limit-fakes.js";
import { signToken, signingKey, startJwksServer, supabaseClaims, type JwksServer, type SigningKey } from "./infrastructure/jwks-fixture.js";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** App com uma rota protegida que devolve o principal e contadores de parser e handler. */
function authApp(verifier: AccessTokenVerifier, options: Partial<BuildAppOptions> = {}) {
  const counts = { parser: 0, handler: 0 };
  const instance = buildApp({ limits: openLimits, logger: false, accessTokenVerifier: verifier, corsAllowedOrigins: [EXTENSION], ...options });
  const defaultJson = instance.getDefaultJsonParser("error", "error");
  instance.removeContentTypeParser("application/json");
  instance.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    counts.parser += 1;
    defaultJson(request, typeof body === "string" ? body : body.toString("utf8"), done);
  });
  instance.post("/probe/eu", { schema: { body: z.strictObject({ texto: z.string() }) } }, async (request) => {
    counts.handler += 1;
    return { principal: request.principal };
  });
  instance.get("/probe/eu", async (request) => {
    counts.handler += 1;
    return { principal: request.principal };
  });
  app = instance;
  return { app: instance, counts };
}

function expectApiError(body: string, code: string) {
  const parsed = ApiErrorSchema.parse(JSON.parse(body));
  expect(parsed.code).toBe(code);
  return parsed;
}

describe("forma do header (ADR-013 D3): recusa sem chamar o verificador", () => {
  test.each<[string, Record<string, string>]>([
    ["sem Authorization", {}],
    ["esquema Basic", { authorization: `Basic ${TEST_TOKEN}` }],
    ["prefixo antes do esquema", { authorization: `XBearer ${TEST_TOKEN}` }],
    ["outro esquema seguido de Bearer", { authorization: `Token Bearer ${TEST_TOKEN}` }],
    ["Bearer sem token", { authorization: "Bearer" }],
    ["Bearer com espaço e sem token", { authorization: "Bearer " }],
    ["dois espaços", { authorization: `Bearer  ${TEST_TOKEN}` }],
    ["dois tokens", { authorization: `Bearer ${TEST_TOKEN} ${TEST_TOKEN}` }],
    ["token em duas partes", { authorization: "Bearer abc.def" }],
    ["token em quatro partes", { authorization: "Bearer a.b.c.d" }],
    ["parte vazia", { authorization: "Bearer abc..def" }],
    ["caractere fora do base64url", { authorization: "Bearer ab+c.def.ghi" }],
    ["padding de base64", { authorization: "Bearer abc=.def.ghi" }],
    ["quebra de linha no fim", { authorization: `Bearer ${TEST_TOKEN}\t` }],
    ["token grande demais", { authorization: `Bearer ${"a".repeat(ACCESS_TOKEN_MAX_CHARS)}.b.c` }],
  ])("%s: 401 NAO_AUTENTICADO com WWW-Authenticate", async (_label, headers) => {
    const { verifier, calls } = fakeVerifier();
    const { app, counts } = authApp(verifier);
    const res = await app.inject({ method: "GET", url: "/probe/eu", headers });
    expect(res.statusCode).toBe(401);
    expectApiError(res.body, "NAO_AUTENTICADO");
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(calls).toEqual([]);
    expect(counts.handler).toBe(0);
  });

  test("bearerToken: esquema sem diferenciar caixa e teto exato do token", () => {
    expect(bearerToken(`bearer ${TEST_TOKEN}`)).toBe(TEST_TOKEN);
    expect(bearerToken(`BEARER ${TEST_TOKEN}`)).toBe(TEST_TOKEN);
    const atLimit = `${"a".repeat(ACCESS_TOKEN_MAX_CHARS - 4)}.b.c`;
    expect(atLimit).toHaveLength(ACCESS_TOKEN_MAX_CHARS);
    expect(bearerToken(`Bearer ${atLimit}`)).toBe(atLimit);
    expect(bearerToken(`Bearer a${atLimit}`)).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  test("regex linear: header patológico de 8 KiB resolve em menos de 50 ms", () => {
    const evil = `Bearer ${"a.".repeat(ACCESS_TOKEN_MAX_CHARS / 2 - 1)}`;
    const started = performance.now();
    expect(bearerToken(evil)).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("resultado do verificador", () => {
  test("válido: o handler recebe o principal e o verificador recebe só o token", async () => {
    const { verifier, calls } = fakeVerifier();
    const { app } = authApp(verifier);
    const res = await app.inject({ method: "GET", url: "/probe/eu", headers: { authorization: `bearer ${TEST_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ principal: TEST_PRINCIPAL });
    expect(calls).toEqual([TEST_TOKEN]);
  });

  test("token_invalido: 401 com WWW-Authenticate, sem dizer o motivo", async () => {
    const { app, counts } = authApp(fakeVerifier({ ok: false, reason: "token_invalido" }).verifier);
    const res = await app.inject({ method: "GET", url: "/probe/eu", headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    expect(res.statusCode).toBe(401);
    const body = expectApiError(res.body, "NAO_AUTENTICADO");
    expect(body.message).toBe("Sessão expirada. Entre de novo para continuar.");
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(counts.handler).toBe(0);
  });

  test("chaves_indisponiveis: 503 SERVICO_INDISPONIVEL (T30), não 401", async () => {
    const { app, counts } = authApp(fakeVerifier({ ok: false, reason: "chaves_indisponiveis" }).verifier);
    const res = await app.inject({ method: "GET", url: "/probe/eu", headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    expect(res.statusCode).toBe(503);
    expectApiError(res.body, "SERVICO_INDISPONIVEL");
    expect(res.headers["www-authenticate"]).toBeUndefined();
    expect(counts.handler).toBe(0);
  });

  test("verificador com defeito que lança: 500 e o handler não roda (falha fechado)", async () => {
    const broken: AccessTokenVerifier = {
      verify: async () => {
        throw new Error("defeito");
      },
      keysReady: async () => true,
    };
    const { app, counts } = authApp(broken);
    const res = await app.inject({ method: "GET", url: "/probe/eu", headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    expect(res.statusCode).toBe(500);
    expectApiError(res.body, "ERRO_INTERNO");
    expect(counts.handler).toBe(0);
  });
});

describe("rotas públicas e ordem dos hooks (ADR-013 D2)", () => {
  test("lista pública fechada: GET /health e as duas rotas públicas do BFF (ADR-004 D8 item 1); o logout fica fora", () => {
    expect([...PUBLIC_ROUTES]).toEqual(["GET /health", "POST /v1/auth/exchange", "POST /v1/auth/refresh"]);
  });

  test("GET /health responde sem token e sem chamar o verificador", async () => {
    const { verifier, calls } = fakeVerifier();
    const { app } = authApp(verifier);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([]);
  });

  test("outros métodos em /health exigem token", async () => {
    const { app } = authApp(fakeVerifier().verifier);
    for (const method of ["HEAD", "DELETE"] as const) {
      expect((await app.inject({ method, url: "/health" })).statusCode).toBe(401);
    }
    // POST passa antes pelo tipo de mídia (mais barato); com JSON, chega ao JWT.
    const post = await app.inject({ method: "POST", url: "/health", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(post.statusCode).toBe(401);
  });

  test("rota inexistente sem token: 401, não 404 (anti-enumeração); com token: 404", async () => {
    const { app } = authApp(fakeVerifier().verifier);
    const anonymous = await app.inject({ method: "GET", url: "/v1/admin/usuarios" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.body).not.toContain("/v1/admin");
    const authenticated = await app.inject({ method: "GET", url: "/v1/admin/usuarios", headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    expect(authenticated.statusCode).toBe(404);
  });

  test("CORS antes do JWT: origem fora da lista dá 403 sem chamar o verificador", async () => {
    const { verifier, calls } = fakeVerifier();
    const { app } = authApp(verifier);
    const res = await app.inject({ method: "GET", url: "/probe/eu", headers: { origin: "https://evil.example", authorization: `Bearer ${TEST_TOKEN}` } });
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  test("preflight respondido pelo CORS, sem token e sem chamar o verificador", async () => {
    const { verifier, calls } = fakeVerifier();
    const { app } = authApp(verifier);
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/analyze",
      headers: { origin: EXTENSION, "access-control-request-method": "POST", "access-control-request-headers": "authorization" },
    });
    expect(res.statusCode).toBe(204);
    expect(calls).toEqual([]);
  });

  test("401 de origem permitida traz Access-Control-Allow-Origin (a extensão lê o ApiError)", async () => {
    const { app } = authApp(fakeVerifier().verifier);
    // Na rota da extensão (ADR-021 D8.3); sem a opção `analysis` ela não existe, e o JWT vem antes do 404.
    const res = await app.inject({ method: "POST", url: "/v1/analyze", headers: { origin: EXTENSION, "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBe(EXTENSION);
  });

  test("tipo de mídia antes do JWT: 415 sem chamar o verificador", async () => {
    const { verifier, calls } = fakeVerifier();
    const { app } = authApp(verifier);
    const res = await app.inject({ method: "POST", url: "/probe/eu", headers: { "content-type": "text/plain" }, payload: "x" });
    expect(res.statusCode).toBe(415);
    expect(calls).toEqual([]);
  });

  test("JWT antes do corpo: 64 KiB + 1 sem token dá 401 sem parse (Content-Length e streaming)", async () => {
    const { app, counts } = authApp(fakeVerifier({ ok: false, reason: "token_invalido" }).verifier);
    const big = `{"texto":"${"a".repeat(HTTP_BODY_MAX_BYTES)}"}`;
    const declared = await app.inject({ method: "POST", url: "/probe/eu", headers: { "content-type": "application/json" }, payload: big });
    const streamed = await app.inject({
      method: "POST",
      url: "/probe/eu",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked", authorization: `Bearer ${TEST_TOKEN}` },
      payload: Readable.from([big]),
    });
    expect([declared.statusCode, streamed.statusCode]).toEqual([401, 401]);
    expect(counts).toEqual({ parser: 0, handler: 0 });
  });
});

describe("SR-12: nenhum token, claim ou motivo no log", () => {
  test("canário de token e de sub fora de todas as linhas, inclusive no 503", async () => {
    const lines: string[] = [];
    const token = "eyJjYW5hcmlvIjoiaGVhZGVyIn0.eyJjYW5hcmlvIjoic3ViIn0.canario-assinatura";
    for (const result of [
      { ok: true, principal: { userId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", sessionId: null }, lifetime: TEST_LIFETIME },
      { ok: false, reason: "token_invalido" },
      { ok: false, reason: "chaves_indisponiveis" },
    ] as const) {
      app = buildApp({ limits: openLimits, accessTokenVerifier: fakeVerifier(result).verifier, logger: { level: "trace", stream: { write: (l) => void lines.push(l) } } });
      app.get("/probe/eu", async () => ({ ok: true }));
      await app.inject({ method: "GET", url: "/probe/eu", headers: { authorization: `Bearer ${token}` } });
      await app.close();
      app = undefined;
    }
    const output = lines.join("");
    expect(lines.length).toBeGreaterThan(5);
    for (const leak of ["canario", "eyJ", "aaaaaaaa-bbbb", "Bearer", "authorization", "token_invalido", "chaves_indisponiveis"]) {
      expect(output).not.toContain(leak);
    }
    const warnings = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r["level"] === 40);
    expect(warnings).toEqual([expect.objectContaining({ msg: "autenticacao_indisponivel" })]);
  });
});

describe("ponta a ponta: buildApp com o adapter jose e um JWKS local", () => {
  let server: JwksServer;
  let key: SigningKey;
  beforeAll(async () => {
    key = await signingKey();
    server = await startJwksServer([key.jwk]);
  });
  afterAll(async () => {
    await server.close();
  });

  const realApp = () =>
    authApp(createJoseAccessTokenVerifier({ issuer: server.issuer, jwksUrl: server.jwksUrl, allowedAmr: ["oauth"] })).app;

  test("token válido: 200 com userId = sub", async () => {
    const token = await signToken(key, supabaseClaims(server.issuer));
    const res = await realApp().inject({ method: "GET", url: "/probe/eu", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      principal: { userId: "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f", sessionId: "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3" },
    });
  });

  test("anônimo: 401", async () => {
    const token = await signToken(key, supabaseClaims(server.issuer, { is_anonymous: true }));
    const res = await realApp().inject({ method: "GET", url: "/probe/eu", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  // ADR-004 D6 (F1-API-07 07d): login por e-mail ou telefone não entra em rota protegida; 401, não 503 (na API, o
  // `amr` é do usuário, não desvio de configuração).
  test.each(["password", "otp"])("amr %s: 401 NAO_AUTENTICADO com WWW-Authenticate", async (method) => {
    const token = await signToken(key, supabaseClaims(server.issuer, { amr: [{ method, timestamp: 1 }] }));
    const res = await realApp().inject({ method: "GET", url: "/probe/eu", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    expectApiError(res.body, "NAO_AUTENTICADO");
    expect(res.headers["www-authenticate"]).toBe("Bearer");
  });

  test("JWKS vazio: 503", async () => {
    server.keys = [];
    const token = await signToken(key, supabaseClaims(server.issuer));
    const res = await realApp().inject({ method: "GET", url: "/probe/eu", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(503);
    server.keys = [key.jwk];
  });
});
