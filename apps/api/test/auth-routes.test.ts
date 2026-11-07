// F1-API-07 07g (ADR-004 D4, D7 e D8; §4.2 "PUBLIC_ROUTES", "CORS", "Corpo", "Limitador local", "Rotas públicas ignoram
// Authorization", "Logs amostrados", "Resposta" e "Logout"): as 3 rotas do BFF no buildApp real, com casos de uso
// falsos que devolvem cada resultado do 07f. Prova o mapa do D7 linha a linha (M-14), as listas da borda (M-15), o
// `no-store` em toda resposta e as linhas amostradas. A pilha real (GoTrue simulado, jose, AEAD, orçamento e o Redis
// simulado) está em test/compose-app.test.ts.
import { randomBytes, randomUUID } from "node:crypto";

import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import { ApiErrorSchema, type ApiErrorCode } from "@trampo/contracts/api";
import { AUTH_BODY_MAX_BYTES, type AuthSessionResponse } from "@trampo/contracts/auth";
import Fastify from "fastify";
import { afterEach, describe, expect, test } from "vitest";

import type { AuthSessionOutcome, AuthUnavailableReason } from "../src/application/auth/auth-session.js";
import type { EndSessionOutcome } from "../src/application/auth/end-session.js";
import type { Clock } from "../src/application/ports/clock.js";
import { createHmacKeyPseudonymizer } from "../src/infrastructure/crypto/hmac-key-pseudonymizer.js";
import { buildApp } from "../src/presentation/build-app.js";
import { EXTENSION_ONLY_ROUTES, ORIGIN_REQUIRED_ROUTES } from "../src/presentation/edge/cors.js";
import { createPreAuthLimiter, type PreAuthLimiter } from "../src/presentation/edge/pre-auth-limit.js";
import { createAuthLogSampler } from "../src/presentation/logging/auth-log-sampler.js";
import {
  authRoutes,
  type AuthRouteOptions,
  type AuthSessionUseCase,
  type EndSessionUseCase,
} from "../src/presentation/routes/auth.js";
import { TEST_AUTHORIZATION, TEST_TOKEN, fakeVerifier } from "./auth-fakes.js";
import { fakeLimits } from "./limit-fakes.js";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PORTAL = "https://portal.trampo.example";
const ENVELOPE = `r1.k1.${"A".repeat(16)}.${"B".repeat(40)}.${"C".repeat(22)}`;
const SESSION: AuthSessionResponse = { schemaVersion: 1, accessToken: TEST_TOKEN, refreshToken: ENVELOPE, expiresIn: 600 };
const CODE = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const BODIES = {
  exchange: { schemaVersion: 1, authCode: CODE, codeVerifier: VERIFIER },
  refresh: { schemaVersion: 1, refreshToken: ENVELOPE },
  logout: { schemaVersion: 1 },
} as const;
const CANARY_BEARER = "Bearer canario.AUTHZ.publica";

type Route = keyof typeof BODIES;
type SessionRoute = "exchange" | "refresh";
const SESSION_ROUTES: readonly SessionRoute[] = ["exchange", "refresh"];

class ManualClock implements Clock {
  now = 10 * 60_000;
  nowMs(): number {
    return this.now;
  }
  sleep(): Promise<void> {
    return Promise.resolve();
  }
}

/** Caso de uso falso: registra as entradas e devolve o resultado programado (ou rejeita). */
function scriptedSession(initial: AuthSessionOutcome = { kind: "sessao", session: SESSION }) {
  const calls: { request: unknown; origin: string }[] = [];
  const state: { outcome: AuthSessionOutcome | "rejeita" } = { outcome: initial };
  const useCase: AuthSessionUseCase = {
    async execute(input) {
      calls.push(input);
      if (state.outcome === "rejeita") throw new Error("quebrou a promessa");
      return state.outcome;
    },
  };
  return { useCase, calls, state };
}

function scriptedLogout(initial: EndSessionOutcome = { kind: "encerrada" }) {
  const calls: { accessToken: string }[] = [];
  const state: { outcome: EndSessionOutcome | "rejeita" } = { outcome: initial };
  const useCase: EndSessionUseCase = {
    async execute(input) {
      calls.push(input);
      if (state.outcome === "rejeita") throw new Error("quebrou a promessa");
      return state.outcome;
    },
  };
  return { useCase, calls, state };
}

const openLimiter: PreAuthLimiter = { check: () => ({ ok: true }) };

/** Fastify sem os hooks globais (sem CORS nem JWT), para chegar ao handler com a invariante quebrada. */
function bareApp() {
  // O id de correlação é UUID, como no buildApp: o ApiError o exige.
  const bare = Fastify({ genReqId: () => randomUUID() });
  bare.setValidatorCompiler(validatorCompiler);
  bare.setSerializerCompiler(serializerCompiler);
  bare.decorateRequest("principal", null);
  return bare;
}

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function authApp(options: { limiter?: PreAuthLimiter } = {}) {
  const clock = new ManualClock();
  const exchange = scriptedSession();
  const refresh = scriptedSession();
  const logout = scriptedLogout();
  const verifier = fakeVerifier();
  const limits = fakeLimits();
  const lines: string[] = [];
  const instance = buildApp({
    accessTokenVerifier: verifier.verifier,
    limits: limits.limits,
    corsAllowedOrigins: [EXTENSION, PORTAL],
    logger: { level: "info", stream: { write: (line) => void lines.push(line) } },
    auth: {
      exchange: exchange.useCase,
      refresh: refresh.useCase,
      logout: logout.useCase,
      preAuthLimiter: options.limiter ?? createPreAuthLimiter(clock, createHmacKeyPseudonymizer(randomBytes(32).toString("base64url"))),
      logSampler: createAuthLogSampler(clock),
    },
  });
  app = instance;
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    app: instance,
    clock,
    exchange,
    refresh,
    logout,
    verifierCalls: verifier.calls,
    redisCalls: limits.rate.calls,
    lines,
    /** As linhas do catálogo do BFF (a msg começa com `auth_`), na ordem. */
    authLines: () => records().filter((record) => String(record["msg"]).startsWith("auth_")),
    useCaseCalls: () => exchange.calls.length + refresh.calls.length + logout.calls.length,
  };
}

type Harness = ReturnType<typeof authApp>;

function send(
  h: Harness,
  route: Route,
  options: { headers?: Record<string, string>; payload?: string; method?: "POST" | "GET" | "PUT"; url?: string } = {},
) {
  const defaults: Record<string, string> = { "content-type": "application/json", origin: EXTENSION };
  if (route === "logout") defaults["authorization"] = TEST_AUTHORIZATION;
  const headers = { ...defaults, ...options.headers };
  for (const [name, value] of Object.entries(headers)) if (value === "") delete headers[name];
  return h.app.inject({
    method: options.method ?? "POST",
    url: options.url ?? `/v1/auth/${route}`,
    headers,
    payload: options.payload ?? JSON.stringify(BODIES[route]),
  });
}

function expectError(res: { statusCode: number; body: string }, status: number, code: ApiErrorCode, retryAfterSeconds: number | null = null) {
  expect(res.statusCode).toBe(status);
  const body = ApiErrorSchema.parse(JSON.parse(res.body));
  expect(body.code).toBe(code);
  expect(body.retryAfterSeconds).toBe(retryAfterSeconds);
}

describe("listas da borda (ADR-004 D8 itens 1 e 2)", () => {
  test("EXTENSION_ONLY_ROUTES são as 3 de auth, e ORIGIN_REQUIRED_ROUTES só as 2 públicas, congeladas", () => {
    expect(EXTENSION_ONLY_ROUTES).toEqual([
      { method: "POST", path: "/v1/auth/exchange" },
      { method: "POST", path: "/v1/auth/refresh" },
      { method: "POST", path: "/v1/auth/logout" },
    ]);
    expect(ORIGIN_REQUIRED_ROUTES).toEqual([
      { method: "POST", path: "/v1/auth/exchange" },
      { method: "POST", path: "/v1/auth/refresh" },
    ]);
    for (const list of [EXTENSION_ONLY_ROUTES, ORIGIN_REQUIRED_ROUTES]) {
      expect(Object.isFrozen(list)).toBe(true);
      for (const route of list) expect(Object.isFrozen(route)).toBe(true);
    }
  });
});

describe("mapa do D7 na troca e na renovação (M-14, um caso por linha)", () => {
  describe.each(SESSION_ROUTES)("%s", (route) => {
    test("sessao → 200 com exatamente as 4 chaves, no-store e o Origin repassado ao caso de uso", async () => {
      const h = authApp();
      const res = await send(h, route);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(SESSION);
      expect(Object.keys(res.json() as object).sort()).toEqual(["accessToken", "expiresIn", "refreshToken", "schemaVersion"]);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["access-control-allow-origin"]).toBe(EXTENSION);
      expect(h[route].calls).toEqual([{ request: BODIES[route], origin: EXTENSION }]);
      expect(h.authLines()).toEqual([]);
    });

    test.each([
      "auth_troca_recusada",
      "auth_renovacao_recusada",
      "auth_envelope_invalido",
      "auth_sessao_idade_maxima",
      "auth_sessao_inativa",
    ] as const)("nao_autenticado (%s) → 401 NAO_AUTENTICADO sem desafio Bearer, e o motivo só na linha amostrada", async (reason) => {
      const h = authApp();
      h[route].state.outcome = { kind: "nao_autenticado", reason };
      const res = await send(h, route);
      expectError(res, 401, "NAO_AUTENTICADO");
      expect(res.headers["www-authenticate"]).toBeUndefined();
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).not.toContain(reason);
      expect(h.authLines()).toEqual([expect.objectContaining({ level: 40, msg: reason, suprimidas: 0 })]);
    });

    test("indisponivel com retryAfterSeconds → 503 SERVICO_INDISPONIVEL com o mesmo valor no corpo e no Retry-After", async () => {
      const h = authApp();
      h[route].state.outcome = { kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: 5 };
      const res = await send(h, route);
      expectError(res, 503, "SERVICO_INDISPONIVEL", 5);
      expect(res.headers["retry-after"]).toBe("5");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(h.authLines()).toEqual([expect.objectContaining({ msg: "auth_provedor_indisponivel" })]);
    });

    test.each(["auth_chaves_indisponiveis", "auth_provedor_indisponivel"] as const)(
      "indisponivel (%s) com null → 503 sem Retry-After (o padrão dos 503 da borda)",
      async (reason) => {
        const h = authApp();
        h[route].state.outcome = { kind: "indisponivel", reason, retryAfterSeconds: null };
        const res = await send(h, route);
        expectError(res, 503, "SERVICO_INDISPONIVEL", null);
        expect(res.headers["retry-after"]).toBeUndefined();
        expect(h.authLines().map((line) => line["msg"])).toEqual([reason]);
      },
    );

    test("entrada_invalida (segunda trava depois do Zod) → 400 PAYLOAD_INVALIDO, sem linha do catálogo", async () => {
      const h = authApp();
      h[route].state.outcome = { kind: "entrada_invalida" };
      const res = await send(h, route);
      expectError(res, 400, "PAYLOAD_INVALIDO");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(h.authLines()).toEqual([]);
    });

    test("caso de uso que rejeita (quebra a promessa) → 503, nunca 500 nem 200", async () => {
      const h = authApp();
      h[route].state.outcome = "rejeita";
      const res = await send(h, route);
      expectError(res, 503, "SERVICO_INDISPONIVEL");
      expect(h.authLines().map((line) => line["msg"])).toEqual(["auth_provedor_indisponivel"]);
    });
  });

  test("renovação fora da política → 503 e também auth_renovacao_perdida (D6: o GoTrue já rotacionou)", async () => {
    const h = authApp();
    h.refresh.state.outcome = { kind: "indisponivel", reason: "auth_token_fora_da_politica", retryAfterSeconds: null };
    expectError(await send(h, "refresh"), 503, "SERVICO_INDISPONIVEL");
    expect(h.authLines().map((line) => line["msg"])).toEqual(["auth_token_fora_da_politica", "auth_renovacao_perdida"]);
  });

  test.each<AuthUnavailableReason>(["auth_chaves_indisponiveis", "auth_provedor_indisponivel"])(
    "renovação indisponível por %s não registra a renovação perdida",
    async (reason) => {
      const h = authApp();
      h.refresh.state.outcome = { kind: "indisponivel", reason, retryAfterSeconds: null };
      await send(h, "refresh");
      expect(h.authLines().map((line) => line["msg"])).toEqual([reason]);
    },
  );

  test("troca fora da política → 503 sem auth_renovacao_perdida (nada rotacionou)", async () => {
    const h = authApp();
    h.exchange.state.outcome = { kind: "indisponivel", reason: "auth_token_fora_da_politica", retryAfterSeconds: null };
    expectError(await send(h, "exchange"), 503, "SERVICO_INDISPONIVEL");
    expect(h.authLines().map((line) => line["msg"])).toEqual(["auth_token_fora_da_politica"]);
  });
});

describe("logout (ADR-004 D4: protegido, classe padrao)", () => {
  test("encerrada → 204 sem corpo, no-store; o Bearer verificado vai ao caso de uso; rate limit da classe padrao", async () => {
    const h = authApp();
    const res = await send(h, "logout");
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(h.logout.calls).toEqual([{ accessToken: TEST_TOKEN }]);
    expect(h.verifierCalls).toEqual([TEST_TOKEN]);
    expect(h.redisCalls.map((call) => call.rateClass)).toEqual(["padrao"]);
  });

  test("indisponivel com retryAfterSeconds → 503 com Retry-After; com null, sem", async () => {
    const h = authApp();
    h.logout.state.outcome = { kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: 5 };
    const limited = await send(h, "logout");
    expectError(limited, 503, "SERVICO_INDISPONIVEL", 5);
    expect(limited.headers["retry-after"]).toBe("5");
    h.logout.state.outcome = { kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: null };
    const plain = await send(h, "logout");
    expectError(plain, 503, "SERVICO_INDISPONIVEL");
    expect(plain.headers["retry-after"]).toBeUndefined();
    expect(plain.headers["cache-control"]).toBe("no-store");
    // Amostrada: a 2ª linha do mesmo motivo, no mesmo minuto, é suprimida.
    expect(h.authLines().map((line) => line["msg"])).toEqual(["auth_provedor_indisponivel"]);
  });

  test("caso de uso que rejeita → 503", async () => {
    const h = authApp();
    h.logout.state.outcome = "rejeita";
    expectError(await send(h, "logout"), 503, "SERVICO_INDISPONIVEL");
  });

  test("sem Bearer → 401 com o desafio, no-store, sem caso de uso nem Redis", async () => {
    const h = authApp();
    const res = await send(h, "logout", { headers: { authorization: "" } });
    expectError(res, 401, "NAO_AUTENTICADO");
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(h.logout.calls).toEqual([]);
    expect(h.redisCalls).toEqual([]);
  });

  test("sem Origin segue (o Bearer protege): 204", async () => {
    const h = authApp();
    expect((await send(h, "logout", { headers: { origin: "" } })).statusCode).toBe(204);
  });

  test("o limitador local não vale no logout: 40 seguidos sem 429 local", async () => {
    const h = authApp();
    for (let i = 0; i < 40; i += 1) expect((await send(h, "logout")).statusCode).toBe(204);
  });

  test("handler sem principal ou sem Bearer (quebra de invariante) → 401 sem chamar o caso de uso", async () => {
    const logout = scriptedLogout();
    const bare = bareApp();
    await bare.register(authRoutes, {
      exchange: scriptedSession().useCase,
      refresh: scriptedSession().useCase,
      logout: logout.useCase,
      preAuthLimiter: openLimiter,
      logSampler: createAuthLogSampler(new ManualClock()),
    } satisfies AuthRouteOptions);
    const res = await bare.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: TEST_AUTHORIZATION, "content-type": "application/json" },
      payload: JSON.stringify(BODIES.logout),
    });
    expectError(res, 401, "NAO_AUTENTICADO");
    expect(logout.calls).toEqual([]);
    await bare.close();
  });
});

describe("Origin e CORS (D8 item 2; M-15)", () => {
  test.each(SESSION_ROUTES)("%s sem Origin → 403 PROIBIDO com no-store, antes do limitador e do caso de uso", async (route) => {
    const counted: string[] = [];
    const h = authApp({ limiter: { check: (limitClass) => (counted.push(limitClass), { ok: true }) } });
    const res = await send(h, route, { headers: { origin: "" } });
    expectError(res, 403, "PROIBIDO");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(counted).toEqual([]);
    expect(h.useCaseCalls()).toBe(0);
  });

  test.each<Route>(["exchange", "refresh", "logout"])("origem de web em %s → 403, sem caso de uso", async (route) => {
    const h = authApp();
    const res = await send(h, route, { headers: { origin: PORTAL } });
    expectError(res, 403, "PROIBIDO");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(h.useCaseCalls()).toBe(0);
  });

  test.each<Route>(["exchange", "refresh", "logout"])("preflight de %s: a extensão passa, a origem de web leva 403", async (route) => {
    const h = authApp();
    const preflight = (origin: string) =>
      h.app.inject({
        method: "OPTIONS",
        url: `/v1/auth/${route}`,
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });
    const ok = await preflight(EXTENSION);
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(EXTENSION);
    expectError(await preflight(PORTAL), 403, "PROIBIDO");
  });

  test("a origem de web continua alcançando as outras rotas (o portal não muda)", async () => {
    const h = authApp();
    const res = await h.app.inject({ method: "GET", url: "/health", headers: { origin: PORTAL } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(PORTAL);
  });

  test("`%61uth`: o roteador decodifica e casa a rota, mas a borda recusa com e sem Origin, de qualquer origem", async () => {
    // A recusa é do CORS, antes do limitador e do corpo: o 403 do handler (segunda trava) não basta.
    const counted: string[] = [];
    const h = authApp({ limiter: { check: (limitClass) => (counted.push(limitClass), { ok: true }) } });
    for (const route of SESSION_ROUTES) {
      for (const origin of ["", EXTENSION, PORTAL]) {
        const res = await send(h, route, { url: `/v1/%61uth/${route}`, headers: { origin } });
        expectError(res, 403, "PROIBIDO");
        expect(res.headers["cache-control"]).toBe("no-store");
      }
    }
    // O logout também é só da extensão pelo padrão casado; sem Origin, o Bearer protege, como na forma crua.
    expectError(await send(h, "logout", { url: "/v1/%61uth/logout", headers: { origin: PORTAL } }), 403, "PROIBIDO");
    expectError(await send(h, "logout", { url: "/v1/%61uth/logout", headers: { origin: EXTENSION } }), 403, "PROIBIDO");
    expect(h.useCaseCalls()).toBe(0);
    expect(counted).toEqual([]);
  });

  test("barra final fica fora (rotas exatas, não por prefixo): sem Origin e de web é 401; da extensão, 403", async () => {
    const h = authApp();
    for (const route of SESSION_ROUTES) {
      const url = `/v1/auth/${route}/`;
      expectError(await send(h, route, { url, headers: { origin: "" } }), 401, "NAO_AUTENTICADO");
      expectError(await send(h, route, { url, headers: { origin: PORTAL } }), 401, "NAO_AUTENTICADO");
      expectError(await send(h, route, { url }), 403, "PROIBIDO");
    }
    expect(h.useCaseCalls()).toBe(0);
  });

  test.each(["GET", "PUT"] as const)("%s nas rotas públicas fica fora: sem Origin 401, da extensão 403", async (method) => {
    const h = authApp();
    for (const route of SESSION_ROUTES) {
      expectError(await send(h, route, { method, headers: { origin: "" } }), 401, "NAO_AUTENTICADO");
      expectError(await send(h, route, { method }), 403, "PROIBIDO");
    }
    expect(h.useCaseCalls()).toBe(0);
  });

  test("outro prefixo de /v1/auth não vira rota pública nem só da extensão", async () => {
    const h = authApp();
    expectError(await send(h, "exchange", { url: "/v1/auth/exchangex", headers: { origin: "" } }), 401, "NAO_AUTENTICADO");
    expectError(await send(h, "exchange", { url: "/v1/auth/x", headers: { origin: PORTAL } }), 401, "NAO_AUTENTICADO");
  });

  test("handler sem Origin (quebra de invariante, sem o CORS na frente) → 403 sem chamar o caso de uso", async () => {
    const exchange = scriptedSession();
    const bare = bareApp();
    await bare.register(authRoutes, {
      exchange: exchange.useCase,
      refresh: scriptedSession().useCase,
      logout: scriptedLogout().useCase,
      preAuthLimiter: openLimiter,
      logSampler: createAuthLogSampler(new ManualClock()),
    });
    const res = await bare.inject({
      method: "POST",
      url: "/v1/auth/exchange",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(BODIES.exchange),
    });
    expectError(res, 403, "PROIBIDO");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(exchange.calls).toEqual([]);
    await bare.close();
  });
});

describe("corpo (D4: até 2.048 B, strictObject)", () => {
  test.each<Route>(["exchange", "refresh", "logout"])("%s acima de 2.048 B → 413 sem parse nem caso de uso, com no-store", async (route) => {
    const h = authApp();
    const payload = JSON.stringify({ ...BODIES[route], pad: "x".repeat(AUTH_BODY_MAX_BYTES) });
    const res = await send(h, route, { payload });
    expectError(res, 413, "PAYLOAD_GRANDE_DEMAIS");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(h.useCaseCalls()).toBe(0);
  });

  test("exatamente 2.048 B passam pelo bodyLimit (e caem no Zod pela chave extra)", async () => {
    const h = authApp();
    const base = JSON.stringify({ ...BODIES.exchange, pad: "" });
    const payload = JSON.stringify({ ...BODIES.exchange, pad: "x".repeat(AUTH_BODY_MAX_BYTES - base.length) });
    expect(Buffer.byteLength(payload)).toBe(AUTH_BODY_MAX_BYTES);
    expectError(await send(h, "exchange", { payload }), 400, "PAYLOAD_INVALIDO");
  });

  test.each<Route>(["exchange", "refresh", "logout"])("%s com chave extra ou versão errada → 400, sem caso de uso", async (route) => {
    const h = authApp();
    expectError(await send(h, route, { payload: JSON.stringify({ ...BODIES[route], extra: 1 }) }), 400, "PAYLOAD_INVALIDO");
    expectError(await send(h, route, { payload: JSON.stringify({ ...BODIES[route], schemaVersion: 2 }) }), 400, "PAYLOAD_INVALIDO");
    expect(h.useCaseCalls()).toBe(0);
  });

  test.each<Route>(["exchange", "refresh", "logout"])("%s com tipo de mídia errado → 415, com no-store", async (route) => {
    const h = authApp();
    const res = await send(h, route, { headers: { "content-type": "text/plain" } });
    expectError(res, 415, "PAYLOAD_INVALIDO");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(h.useCaseCalls()).toBe(0);
  });
});

describe("limitador local pré-JWT (D8 item 4)", () => {
  test("a 11ª troca no minuto → 429 com Retry-After e no-store; a linha auth_limite_local sai 1 vez por minuto", async () => {
    const h = authApp();
    for (let i = 0; i < 10; i += 1) expect((await send(h, "exchange")).statusCode).toBe(200);
    for (let i = 0; i < 5; i += 1) {
      const res = await send(h, "exchange");
      expect(res.statusCode).toBe(429);
      const body = ApiErrorSchema.parse(res.json());
      expect(body.code).toBe("LIMITE_DE_TAXA");
      expect(res.headers["retry-after"]).toBe(String(body.retryAfterSeconds));
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect(h.exchange.calls).toHaveLength(10);
    expect(h.authLines()).toEqual([expect.objectContaining({ msg: "auth_limite_local", suprimidas: 0 })]);
    // Um minuto e meio depois, a janela andou: a próxima recusa escreve com as 4 suprimidas.
    h.clock.now += 90_000;
    for (let i = 0; i < 10; i += 1) await send(h, "exchange");
    await send(h, "exchange");
    expect(h.authLines().at(-1)).toEqual(expect.objectContaining({ msg: "auth_limite_local", suprimidas: 4 }));
  });

  test("a 31ª renovação no minuto → 429; a troca tem balde próprio", async () => {
    const h = authApp();
    for (let i = 0; i < 30; i += 1) expect((await send(h, "refresh")).statusCode).toBe(200);
    expect((await send(h, "refresh")).statusCode).toBe(429);
    expect((await send(h, "exchange")).statusCode).toBe(200);
  });

  test("0 chamadas ao rate limit do Redis e ao verificador nas rotas públicas, inclusive no 429", async () => {
    const h = authApp();
    for (let i = 0; i < 12; i += 1) await send(h, "exchange");
    for (let i = 0; i < 3; i += 1) await send(h, "refresh");
    expect(h.redisCalls).toEqual([]);
    expect(h.verifierCalls).toEqual([]);
  });
});

describe("rotas públicas ignoram Authorization (D8 item 1)", () => {
  test.each(SESSION_ROUTES)("%s com Bearer canário ou malformado responde como sem o header, e o canário não vai a log", async (route) => {
    const h = authApp();
    const plain = await send(h, route);
    const canary = await send(h, route, { headers: { authorization: CANARY_BEARER } });
    const broken = await send(h, route, { headers: { authorization: "Basic xyz" } });
    for (const res of [canary, broken]) {
      expect(res.statusCode).toBe(plain.statusCode);
      expect(res.body).toBe(plain.body);
    }
    expect(h.verifierCalls).toEqual([]);
    expect(h.redisCalls).toEqual([]);
    for (const line of h.lines) expect(line).not.toContain("canario");
  });
});

describe("logs amostrados (D8 item 7)", () => {
  test("1.000 recusas em 1 min geram 1 linha por motivo", async () => {
    const h = authApp({ limiter: openLimiter });
    h.refresh.state.outcome = { kind: "nao_autenticado", reason: "auth_envelope_invalido" };
    h.exchange.state.outcome = { kind: "nao_autenticado", reason: "auth_troca_recusada" };
    for (let i = 0; i < 500; i += 1) {
      await send(h, "refresh");
      await send(h, "exchange");
    }
    expect(h.authLines().map((line) => [line["msg"], line["suprimidas"]])).toEqual([
      ["auth_envelope_invalido", 0],
      ["auth_troca_recusada", 0],
    ]);
  });

  test("a linha só tem as chaves da allowlist: nenhum campo da requisição além do reqId e da rota", async () => {
    const h = authApp();
    h.exchange.state.outcome = { kind: "nao_autenticado", reason: "auth_troca_recusada" };
    await send(h, "exchange");
    const [line] = h.authLines();
    expect(Object.keys(line ?? {}).sort()).toEqual(["level", "msg", "reqId", "suprimidas", "time"]);
  });

  test("SR-12: código, verifier, envelope, tokens, Bearer e IP fora de toda linha nos caminhos 200, 401, 429 e 503", async () => {
    const h = authApp();
    await send(h, "exchange");
    await send(h, "refresh");
    h.refresh.state.outcome = { kind: "nao_autenticado", reason: "auth_envelope_invalido" };
    await send(h, "refresh");
    h.exchange.state.outcome = { kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: 5 };
    for (let i = 0; i < 11; i += 1) await send(h, "exchange", { headers: { authorization: CANARY_BEARER } });
    await send(h, "logout");
    expect(h.lines.length).toBeGreaterThan(0);
    for (const line of h.lines) {
      for (const secret of [CODE, VERIFIER, ENVELOPE, TEST_TOKEN, "canario", "127.0.0.1", EXTENSION]) expect(line).not.toContain(secret);
    }
  });
});
