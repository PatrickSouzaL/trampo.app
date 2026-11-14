// Teste de boot do F1-API-04b (aceite do BACKLOG): a raiz de composição que o main.ts usa sobe com o ambiente
// completo, monta POST /v1/analyze e responde 401 sem token. Também prova o fluxo inteiro com as peças reais
// (JWT verificado num JWKS local, limites no Upstash simulado, critérios no PostgREST simulado com a pretensão
// cifrada) e a falha fechado do boot: sem a publishable, com chave secret ou legada, sem o anel da pretensão ou
// com o ambiente do Redis ou do JWT inválido, nada sobe. Nenhum teste toca serviço real nem Docker.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { AnalysisStreamEventSchema, ApiErrorSchema, type AnalysisStreamEvent } from "@trampo/contracts";
import { AuthSessionResponseSchema } from "@trampo/contracts/auth";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ZodError } from "zod";

import {
  CacheConfigError,
  CriteriaGuard,
  EXTRACTION_PROMPT_VERSION,
  ProviderChainConfigError,
  RouterConfigError,
} from "../src/application/index.js";
import { NO_EXTRACTOR_PROMPT_VERSION, composeApp, type ComposedApp, type Environment } from "../src/composition/compose-app.js";
import {
  composeProductionApp,
  createProductionExtractor,
  productionLlmComposition,
  type ProductionLlmTestHooks,
} from "../src/composition/production-app.js";
import { AllowedAmrConfigError } from "../src/infrastructure/auth/allowed-amr-env.js";
import { AuthSessionConfigError } from "../src/infrastructure/auth/auth-session-env.js";
import { KeyringReuseError } from "../src/infrastructure/crypto/aead-envelope.js";
import {
  RefreshKeyringConfigError,
  createAeadRefreshSealer,
  parseRefreshKeyring,
} from "../src/infrastructure/crypto/aead-refresh-sealer.js";
import { SalaryKeyringConfigError, createSalaryCipher, parseSalaryKeyring } from "../src/infrastructure/crypto/salary-cipher.js";
import { WORKERS_AI_DEFAULT_MODEL, WorkersAiConfigError } from "../src/infrastructure/llm/cloudflare-workers-ai-extractor.js";
import { GROQ_MODEL as GROQ_ADAPTER_MODEL, GroqConfigError } from "../src/infrastructure/llm/groq-extractor.js";
import { PostgrestClientConfigError } from "../src/infrastructure/supabase/postgrest-user-client.js";
import { BehindProxyConfigError } from "../src/presentation/edge/behind-proxy-env.js";
import { InMemoryTelemetry } from "../src/infrastructure/telemetry/in-memory-telemetry.js";
import { systemClock } from "../src/infrastructure/time/system-clock.js";
import { CLEAN_RAW, CLEAN_TEXT, GROQ_MODEL, REQUEST_ID } from "./application/fakes/analyze-job-harness.js";
import { ScriptedExtractor } from "./application/fakes/scripted-extractor.js";
import { criteria, weighted } from "./domain/fakes/scoring-fixtures.js";
import { completion, startFakeGroq } from "./infrastructure/fakes/fake-groq.js";
import { startFakePostgrest, type FakePostgrest } from "./infrastructure/fakes/fake-postgrest.js";
import { startFakeUpstash, type FakeUpstash } from "./infrastructure/fakes/fake-upstash.js";
import { envelope, startFakeWorkersAi } from "./infrastructure/fakes/fake-workers-ai.js";
import { nowSeconds, signToken, signingKey, supabaseClaims, type SigningKey } from "./infrastructure/jwks-fixture.js";
import { GOTRUE_CANARIES, startFakeGotrue, type FakeGotrue } from "./support/fake-gotrue.js";
import { HAPPY_PATH_TIMEOUT_MS } from "./support/socket-deadlines.js";

const PUBLISHABLE = "sb_publishable_boot-teste";
const UPSTASH_TOKEN = "AXyz_token-de-boot.123";
const OWNER = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const SALARY_KEY = randomBytes(32).toString("base64url");
const PEPPER = randomBytes(32).toString("base64url");
const REFRESH_KEY = randomBytes(32).toString("base64url");
const LEGACY_KEY_PREFIX = "eyJhbGciOiJIUzI1NiJ9";
const SALARY = { minimum: 9_000, currency: "BRL", period: "mes", importance: weighted(3) } as const;

let postgrest: FakePostgrest;
let upstash: FakeUpstash;
let key: SigningKey;
let composed: ComposedApp | undefined;

beforeEach(async () => {
  key = await signingKey();
  postgrest = await startFakePostgrest(PUBLISHABLE);
  postgrest.jwks = [key.jwk];
  upstash = await startFakeUpstash(UPSTASH_TOKEN);
});
afterEach(async () => {
  await composed?.app.close();
  composed = undefined;
  await postgrest.close();
  await upstash.close();
});

function environment(over: Record<string, string | undefined> = {}): Environment {
  const origin = postgrest.url.origin;
  return {
    SUPABASE_URL: origin,
    SUPABASE_JWKS_URL: `${origin}/auth/v1/.well-known/jwks.json`,
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    UPSTASH_REDIS_REST_URL: upstash.url.origin,
    UPSTASH_REDIS_REST_TOKEN: UPSTASH_TOKEN,
    RATE_KEY_PEPPER: PEPPER,
    CRITERIA_SALARY_KEYS: `k1:${SALARY_KEY}`,
    CRITERIA_SALARY_ACTIVE_KEY: "k1",
    CORS_ALLOWED_ORIGINS: "",
    TRUST_PROXY: "false",
    API_BEHIND_PROXY: "false",
    AUTH_REFRESH_SEAL_KEYS: `r1k1:${REFRESH_KEY}`,
    AUTH_REFRESH_SEAL_ACTIVE_KEY: "r1k1",
    ...over,
  };
}

function boot(over: Record<string, string | undefined> = {}, options: Parameters<typeof composeApp>[1] = {}): ComposedApp {
  composed = composeApp(environment(over), { logger: false, ...options });
  return composed;
}

const body = (mode: "auto" | "aprofundada" = "auto") =>
  JSON.stringify({
    schemaVersion: 1,
    requestId: REQUEST_ID,
    source: { platform: "gupy", extractorVersion: "gupy-1" },
    job: { titleHint: "Desenvolvedor Backend Pleno", text: CLEAN_TEXT, clientTruncated: false },
    mode,
  });

const analyze = (instance: ComposedApp, headers: Record<string, string> = {}, mode: "auto" | "aprofundada" = "auto") =>
  instance.app.inject({ method: "POST", url: "/v1/analyze", headers: { "content-type": "application/json", ...headers }, payload: body(mode) });

function events(raw: string): AnalysisStreamEvent[] {
  return raw
    .trim()
    .split("\n\n")
    .map((block) => AnalysisStreamEventSchema.parse(JSON.parse(block.split("\n")[1]?.slice("data: ".length) ?? "")));
}

/** Grava a linha de um dono como o PUT /v1/criteria grava (pretensão só no cifrado) e devolve o token do OWNER. */
async function storeOwnerCriteria(owner: string = OWNER): Promise<string> {
  const value = criteria({ salary: SALARY });
  const { salary, schemaVersion, ...rest } = value;
  const cipher = createSalaryCipher(parseSalaryKeyring(`k1:${SALARY_KEY}`, "k1"));
  postgrest.rows.push({ user_id: owner, schema_version: schemaVersion, criteria: rest, salary_ciphertext: cipher.seal(owner, salary) });
  return ownerToken();
}

/** Token do OWNER, conhecido pela RLS do PostgREST simulado. */
async function ownerToken(): Promise<string> {
  const token = await signToken(key, supabaseClaims(`${postgrest.url.origin}/auth/v1`, { sub: OWNER }));
  postgrest.sessions.set(token, OWNER);
  return token;
}

function criteriaRequest(instance: ComposedApp, method: "GET" | "PUT", headers: Record<string, string> = {}, payload?: unknown) {
  return instance.app.inject({
    method,
    url: "/v1/criteria",
    headers: { ...(payload === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

describe("aceite: boot com o ambiente completo", () => {
  test("monta POST /v1/analyze e responde 401 sem token, sem tocar o banco nem o Redis", async () => {
    const instance = boot();
    const res = await analyze(instance);
    expect(res.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("NAO_AUTENTICADO");
    expect(postgrest.requests).toHaveLength(0);
    expect(upstash.requests).toHaveLength(0);
  });

  test("/health responde, e host e porta têm os padrões do .env.example", async () => {
    const instance = boot();
    expect((await instance.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect([instance.host, instance.port]).toEqual(["127.0.0.1", 3001]);
  });

  test("sem a opção logger (o main.ts), sobe com o log padrão da lista fechada", async () => {
    composed = composeApp(environment());
    expect(composed.app.log.level).toBe("info");
    expect((await composed.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  test("HOST e PORT do ambiente valem", () => {
    const instance = boot({ HOST: "0.0.0.0", PORT: "4010" });
    expect([instance.host, instance.port]).toEqual(["0.0.0.0", 4010]);
  });

  test("CORS_ALLOWED_ORIGINS do ambiente chega à borda: a origem listada é ecoada, outra é 403", async () => {
    const extension = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const instance = boot({ CORS_ALLOWED_ORIGINS: extension });
    const allowed = await analyze(instance, { origin: extension });
    expect(allowed.statusCode).toBe(401);
    expect(allowed.headers["access-control-allow-origin"]).toBe(extension);
    const denied = await analyze(instance, { origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba" });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test.each([
    ["false", "10.0.0.7"],
    ["10.0.0.0/8", "203.0.113.9"],
  ])("TRUST_PROXY=%s chega ao Fastify: o IP visto é %s", async (trustProxy, expected) => {
    const token = await signToken(key, supabaseClaims(`${postgrest.url.origin}/auth/v1`, { sub: OWNER }));
    const instance = boot({ TRUST_PROXY: trustProxy, API_BEHIND_PROXY: trustProxy === "false" ? "false" : "true" });
    instance.app.get("/probe/ip", async (request) => ({ ip: request.ip }));
    const res = await instance.app.inject({
      method: "GET",
      url: "/probe/ip",
      remoteAddress: "10.0.0.7",
      headers: { "x-forwarded-for": "203.0.113.9", authorization: `Bearer ${token}` },
    });
    expect(res.json()).toEqual({ ip: expected });
  });

  test("a versão do extrator sem LLM usa o prompt p0", () => {
    expect(NO_EXTRACTOR_PROMPT_VERSION).toBe("p0");
  });
});

describe("fluxo completo com as peças reais", () => {
  test("token verificado, limites no Redis e critérios decifrados: 200 em SSE com um result", async () => {
    const token = await storeOwnerCriteria();
    const lines: string[] = [];
    const instance = boot({}, { logger: { level: "trace", stream: { write: (line: string) => lines.push(line) } } });
    const res = await analyze(instance, { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/event-stream/);
    const terminal = events(res.body).filter((event) => event.type !== "stage");
    expect(terminal.map((event) => event.type)).toEqual(["result"]);
    // O token do usuário foi ao PostgREST com a publishable; os limites passaram pelo Upstash.
    expect(postgrest.requests).toEqual([expect.objectContaining({ apikey: PUBLISHABLE, authorization: `Bearer ${token}` })]);
    expect(upstash.requests.length).toBeGreaterThan(0);
    // SR-12 e critério 4: nada do token, da chave, do dono ou da pretensão no log.
    for (const leak of [token, PUBLISHABLE, OWNER, UPSTASH_TOKEN, SALARY_KEY, PEPPER, "9000"]) expect(lines.join("")).not.toContain(leak);
  });

  test("07i: a análise conta na telemetria dada ao boot, a mesma instância que o BFF de autenticação recebe", async () => {
    const token = await storeOwnerCriteria();
    const telemetry = new InMemoryTelemetry();
    const instance = boot({}, { telemetry });
    expect((await analyze(instance, { authorization: `Bearer ${token}` })).statusCode).toBe(200);
    expect(telemetry.seriesKeys().filter((key) => key.startsWith("analysis_total"))).toHaveLength(1);
    expect(telemetry.seriesKeys().some((key) => key.startsWith("auth_"))).toBe(false);
  });

  test("sem linha de critérios: 409 CRITERIOS_NAO_CONFIGURADOS", async () => {
    const token = await signToken(key, supabaseClaims(`${postgrest.url.origin}/auth/v1`, { sub: OWNER }));
    postgrest.sessions.set(token, OWNER);
    const res = await analyze(boot(), { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("CRITERIOS_NAO_CONFIGURADOS");
  });

  test("anel do boot sem a chave da linha (chave perdida): 503, nunca 409", async () => {
    const token = await storeOwnerCriteria();
    const res = await analyze(boot({ CRITERIA_SALARY_KEYS: `k2:${randomBytes(32).toString("base64url")}`, CRITERIA_SALARY_ACTIVE_KEY: "k2" }), {
      authorization: `Bearer ${token}`,
    });
    expect(res.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("SERVICO_INDISPONIVEL");
  });
});

// F1-API-07, commit 07d (ADR-004 D6): o `amr` vale para TODA rota protegida já existente, pelo verificador do boot.
describe("amr exigido no boot (ADR-004 D6)", () => {
  /** Token de login por senha (o que o signup da pilha local emite), conhecido pela RLS do PostgREST simulado. */
  async function passwordToken(): Promise<string> {
    await storeOwnerCriteria();
    const token = await signToken(
      key,
      supabaseClaims(`${postgrest.url.origin}/auth/v1`, { sub: OWNER, amr: [{ method: "password", timestamp: 1 }] }),
    );
    postgrest.sessions.set(token, OWNER);
    return token;
  }

  test("ambiente padrão: token de senha dá 401 em /v1/analyze e /v1/criteria, sem tocar o banco nem o Redis", async () => {
    const token = await passwordToken();
    const instance = boot();
    const auth = { authorization: `Bearer ${token}` };
    const responses = [await analyze(instance, auth), await criteriaRequest(instance, "GET", auth)];
    for (const res of responses) {
      expect(res.statusCode).toBe(401);
      expect(ApiErrorSchema.parse(res.json()).code).toBe("NAO_AUTENTICADO");
    }
    expect(postgrest.requests.filter((request) => request.url.includes("/rest/v1/"))).toHaveLength(0);
    expect(upstash.requests).toHaveLength(0);
  });

  test("AUTH_ALLOWED_AMR=oauth explícito: o mesmo 401", async () => {
    const token = await passwordToken();
    const res = await analyze(boot({ AUTH_ALLOWED_AMR: "oauth", NODE_ENV: "test" }), { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(401);
  });

  test("pilha local (NODE_ENV=test e AUTH_ALLOWED_AMR=oauth,password): o token de senha entra", async () => {
    const token = await passwordToken();
    const res = await analyze(boot({ AUTH_ALLOWED_AMR: "oauth,password", NODE_ENV: "test" }), { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(200);
  });
});

describe("rotas de critérios (F1-API-05 commit 5; ADR-021 §4)", () => {
  const OTHER_OWNER = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f";
  const restRequests = () => postgrest.requests.filter((request) => request.url.includes("/rest/v1/"));
  const capture = (lines: string[]) => ({ logger: { level: "trace" as const, stream: { write: (line: string) => lines.push(line) } } });

  test("o boot monta GET e PUT /v1/criteria: 401 com no-store sem token, sem tocar o banco nem o Redis", async () => {
    const instance = boot();
    for (const method of ["GET", "PUT"] as const) {
      const res = await criteriaRequest(instance, method, {}, method === "PUT" ? criteria() : undefined);
      expect(res.statusCode).toBe(401);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect(restRequests()).toHaveLength(0);
    expect(upstash.requests).toHaveLength(0);
  });

  test("PUT, GET e a análise passam pelo MESMO CriteriaGuard, com a pretensão só cifrada no banco", async () => {
    const seen = { load: new Set<unknown>(), save: new Set<unknown>() };
    const originalLoad = CriteriaGuard.prototype.load;
    const originalSave = CriteriaGuard.prototype.save;
    const loadSpy = vi.spyOn(CriteriaGuard.prototype, "load").mockImplementation(function (this: CriteriaGuard, ...args) {
      seen.load.add(this);
      return originalLoad.apply(this, args);
    });
    const saveSpy = vi.spyOn(CriteriaGuard.prototype, "save").mockImplementation(function (this: CriteriaGuard, ...args) {
      seen.save.add(this);
      return originalSave.apply(this, args);
    });
    try {
      const token = await ownerToken();
      const lines: string[] = [];
      const instance = boot({}, capture(lines));
      const value = criteria({ salary: SALARY });
      const auth = { authorization: `Bearer ${token}` };

      const saved = await criteriaRequest(instance, "PUT", auth, value);
      expect(saved.statusCode).toBe(204);
      expect(saved.body).toBe("");
      const [written] = restRequests();
      expect(written).toEqual(expect.objectContaining({ method: "POST", apikey: PUBLISHABLE, authorization: `Bearer ${token}` }));
      expect(written?.body).not.toContain("9000");
      expect(postgrest.rows).toEqual([expect.objectContaining({ user_id: OWNER })]);

      const read = await criteriaRequest(instance, "GET", auth);
      expect(read.statusCode).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
      expect(read.json()).toEqual(value);

      expect((await analyze(instance, auth)).statusCode).toBe(200);
      expect([loadSpy.mock.calls.length, saveSpy.mock.calls.length]).toEqual([2, 1]);
      const [guard] = [...seen.save];
      expect(guard).toBeInstanceOf(CriteriaGuard);
      expect([...seen.load]).toEqual([guard]);
      for (const leak of [token, OWNER, "9000", SALARY_KEY]) expect(lines.join("")).not.toContain(leak);
    } finally {
      loadSpy.mockRestore();
      saveSpy.mockRestore();
    }
  });

  test("GET com a linha só de outro dono: 409 CRITERIOS_NAO_CONFIGURADOS (a RLS a esconde)", async () => {
    const token = await storeOwnerCriteria(OTHER_OWNER);
    const res = await criteriaRequest(boot(), "GET", { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("CRITERIOS_NAO_CONFIGURADOS");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("GET com a chave perdida: 503, nunca 409; o PUT seguinte recupera a linha (ADR-021 D2)", async () => {
    const token = await storeOwnerCriteria();
    const instance = boot({ CRITERIA_SALARY_KEYS: `k2:${randomBytes(32).toString("base64url")}`, CRITERIA_SALARY_ACTIVE_KEY: "k2" });
    const auth = { authorization: `Bearer ${token}` };
    const lost = await criteriaRequest(instance, "GET", auth);
    expect(lost.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(lost.json()).code).toBe("SERVICO_INDISPONIVEL");
    expect((await criteriaRequest(instance, "PUT", auth, criteria({ salary: SALARY }))).statusCode).toBe(204);
    expect((await criteriaRequest(instance, "GET", auth)).json()).toEqual(criteria({ salary: SALARY }));
  });

  test("PostgREST que recusa a gravação ecoando a linha: 503 sem eco e só `criterios_gravacao_indisponivel` no log", async () => {
    const token = await ownerToken();
    postgrest.mode = { kind: "status", status: 409, body: JSON.stringify({ details: "Failing row contains (9000, nota-canaria)" }) };
    const lines: string[] = [];
    const instance = boot({}, capture(lines));
    const res = await criteriaRequest(instance, "PUT", { authorization: `Bearer ${token}` }, criteria({ salary: SALARY, notes: "nota-canaria" }));
    expect(res.statusCode).toBe(503);
    for (const leak of ["nota-canaria", "9000", "Failing"]) {
      expect(res.body).not.toContain(leak);
      expect(lines.join("")).not.toContain(leak);
    }
    const warned = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((r) => r["level"] === 40);
    expect(warned.map((r) => r["msg"])).toEqual(["criterios_gravacao_indisponivel"]);
  });
});

describe("falha fechado no boot", () => {
  test.each<[string, Record<string, string | undefined>, new (...args: never[]) => Error]>([
    ["sem SUPABASE_PUBLISHABLE_KEY", { SUPABASE_PUBLISHABLE_KEY: undefined }, PostgrestClientConfigError],
    ["com a chave secret no lugar da publishable", { SUPABASE_PUBLISHABLE_KEY: "sb_secret_vazada-123" }, PostgrestClientConfigError],
    ["com a chave legada (eyJ)", { SUPABASE_PUBLISHABLE_KEY: `${LEGACY_KEY_PREFIX}.eyJyb2xlIjoiYW5vbiJ9.assinatura` }, PostgrestClientConfigError],
    ["sem CRITERIA_SALARY_KEYS", { CRITERIA_SALARY_KEYS: undefined }, SalaryKeyringConfigError],
    ["sem CRITERIA_SALARY_ACTIVE_KEY", { CRITERIA_SALARY_ACTIVE_KEY: undefined }, SalaryKeyringConfigError],
    ["kid ativo fora do anel", { CRITERIA_SALARY_ACTIVE_KEY: "k9" }, SalaryKeyringConfigError],
    ["chave da pretensão curta", { CRITERIA_SALARY_KEYS: `k1:${randomBytes(16).toString("base64url")}` }, SalaryKeyringConfigError],
    ["sem UPSTASH_REDIS_REST_TOKEN", { UPSTASH_REDIS_REST_TOKEN: undefined }, ZodError],
    ["sem RATE_KEY_PEPPER", { RATE_KEY_PEPPER: undefined }, ZodError],
    ["sem SUPABASE_URL", { SUPABASE_URL: undefined }, ZodError],
    ["JWKS de outro projeto", { SUPABASE_JWKS_URL: "https://outro.supabase.co/auth/v1/.well-known/jwks.json" }, ZodError],
    ["TRUST_PROXY true", { TRUST_PROXY: "true" }, ZodError],
    ["AUTH_ALLOWED_AMR com senha fora de NODE_ENV=test", { AUTH_ALLOWED_AMR: "oauth,password" }, AllowedAmrConfigError],
    ["AUTH_ALLOWED_AMR com senha e NODE_ENV=production", { AUTH_ALLOWED_AMR: "password", NODE_ENV: "production" }, AllowedAmrConfigError],
    ["AUTH_ALLOWED_AMR com otp", { AUTH_ALLOWED_AMR: "oauth,otp", NODE_ENV: "test" }, AllowedAmrConfigError],
    // F1-API-07 07g (ADR-004 D5 e D8 item 4): o anel do refresh, as idades e o API_BEHIND_PROXY no boot.
    ["sem API_BEHIND_PROXY fora de NODE_ENV=test", { API_BEHIND_PROXY: undefined }, BehindProxyConfigError],
    ["sem API_BEHIND_PROXY com NODE_ENV=production", { API_BEHIND_PROXY: undefined, NODE_ENV: "production" }, BehindProxyConfigError],
    ["API_BEHIND_PROXY=true com TRUST_PROXY=false", { API_BEHIND_PROXY: "true" }, BehindProxyConfigError],
    ["API_BEHIND_PROXY=false com os saltos do proxy", { TRUST_PROXY: "10.0.0.0/8" }, BehindProxyConfigError],
    ["API_BEHIND_PROXY fora de true e false", { API_BEHIND_PROXY: "sim" }, BehindProxyConfigError],
    ["sem AUTH_REFRESH_SEAL_KEYS", { AUTH_REFRESH_SEAL_KEYS: undefined }, RefreshKeyringConfigError],
    ["sem AUTH_REFRESH_SEAL_ACTIVE_KEY", { AUTH_REFRESH_SEAL_ACTIVE_KEY: undefined }, RefreshKeyringConfigError],
    ["kid do refresh fora de [a-z0-9]{1,16}", { AUTH_REFRESH_SEAL_KEYS: `R1:${REFRESH_KEY}`, AUTH_REFRESH_SEAL_ACTIVE_KEY: "R1" }, RefreshKeyringConfigError],
    ["chave do refresh curta", { AUTH_REFRESH_SEAL_KEYS: `r1k1:${randomBytes(16).toString("base64url")}` }, RefreshKeyringConfigError],
    ["idade máxima abaixo de 3.600", { AUTH_SESSION_MAX_AGE_SECONDS: "3599" }, AuthSessionConfigError],
    // F1-API-09 (ADR-004 D5): o teto é o 86.400 do hook; o teto antigo de 7 dias também não sobe.
    ["idade máxima acima de 86.400", { AUTH_SESSION_MAX_AGE_SECONDS: "86401" }, AuthSessionConfigError],
    ["idade máxima no teto antigo de 604.800", { AUTH_SESSION_MAX_AGE_SECONDS: "604800" }, AuthSessionConfigError],
    ["inatividade acima da idade máxima", { AUTH_SESSION_MAX_AGE_SECONDS: "7200", AUTH_SESSION_IDLE_SECONDS: "7201" }, AuthSessionConfigError],
    ["a chave da pretensão repetida no anel do refresh (pendência do 07b)", { AUTH_REFRESH_SEAL_KEYS: `r1k1:${REFRESH_KEY},r2:${SALARY_KEY}` }, KeyringReuseError],
    ["a chave do refresh repetida no anel da pretensão", { CRITERIA_SALARY_KEYS: `k1:${SALARY_KEY},k2:${REFRESH_KEY}` }, KeyringReuseError],
  ])("%s: nada sobe e a mensagem não repete segredo", (_name, over, kind) => {
    let error: unknown;
    try {
      composeApp(environment(over), { logger: false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(kind);
    const message = String((error as Error).message);
    for (const secret of [SALARY_KEY, REFRESH_KEY, PEPPER, UPSTASH_TOKEN, "sb_secret_vazada-123", LEGACY_KEY_PREFIX, "r1k1", "r2", "k2"]) {
      expect(message).not.toContain(secret);
    }
  });

  test("F1-API-09: AUTH_SESSION_MAX_AGE_SECONDS=86401 não sobe, e nem o log nem a mensagem trazem o valor", async () => {
    const lines: string[] = [];
    let error: unknown;
    try {
      composeApp(environment({ AUTH_SESSION_MAX_AGE_SECONDS: "86401" }), {
        logger: { level: "trace", stream: { write: (line) => void lines.push(line) } },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AuthSessionConfigError);
    expect(String((error as Error).message)).toContain("AUTH_SESSION_MAX_AGE_SECONDS");
    expect(String((error as Error).message)).not.toContain("86401");
    for (const line of lines) expect(line).not.toContain("86401");
    // Controle: o mesmo logger, com o teto exato, sobe e escreve (o "nenhum log" acima não é um logger mudo).
    composed = composeApp(environment({ AUTH_SESSION_MAX_AGE_SECONDS: "86400" }), {
      logger: { level: "trace", stream: { write: (line) => void lines.push(line) } },
    });
    expect((await composed.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect(lines.some((line) => line.includes("requisicao_recebida"))).toBe(true);
  });
});

describe("com adapters de LLM (o F1-LLM-02 os entrega)", () => {
  const llm = (steps = [{ kind: "ok", raw: CLEAN_RAW } as const], model = GROQ_MODEL) => ({
    extractors: [new ScriptedExtractor("groq", systemClock, steps, model)],
    promptVersion: "p1",
  });

  test("análise aprofundada passa pelo router real e reserva cota no QuotaLedger do Redis", async () => {
    const token = await storeOwnerCriteria();
    const options = llm();
    const instance = boot({ LLM_PROVIDER_CHAIN: "groq" }, { llm: options });
    const res = await analyze(instance, { authorization: `Bearer ${token}` }, "aprofundada");
    expect(res.statusCode).toBe(200);
    const [result] = events(res.body).filter((event) => event.type === "result");
    expect(result?.type === "result" && result.report.decisionPath).toBe("extracao_llm");
    expect(options.extractors[0]?.calls).toHaveLength(1);
    // O ledger (chaves de provedor) e o cache (jobfacts) usaram o mesmo Upstash.
    const sent = JSON.stringify(upstash.requests.map((request) => request.commands));
    expect(sent).toContain("groq");
    expect(sent).toContain("jobfacts:");
    // O modelo do adapter vale para o cache: a gravação (SET NX, sem bloquear a resposta) acontece logo depois.
    const written = (): boolean =>
      upstash.requests.some((request) => JSON.stringify(request.commands).startsWith('[["SET","jobfacts:'));
    for (let tries = 0; tries < 50 && !written(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(written()).toBe(true);
  });

  test.each<[string, Record<string, string | undefined>, ReturnType<typeof llm>, new (...args: never[]) => Error]>([
    ["cadeia com provedor sem adapter", { LLM_PROVIDER_CHAIN: "groq,cloudflare_workers_ai" }, llm(), RouterConfigError],
    ["cadeia com o Ollama (só dev)", { LLM_PROVIDER_CHAIN: "ollama" }, llm(), ProviderChainConfigError],
    ["sem LLM_PROVIDER_CHAIN", { LLM_PROVIDER_CHAIN: undefined }, llm(), ProviderChainConfigError],
    ["versão de prompt fora do padrão", { LLM_PROVIDER_CHAIN: "groq" }, { ...llm(), promptVersion: "P 1" }, CacheConfigError],
  ])("%s: o boot falha", (_name, over, options, kind) => {
    expect(() => composeApp(environment(over), { logger: false, llm: options })).toThrow(kind);
  });
});

describe("composição de produção: a cadeia de LLM do ambiente (Trilha L1; ADR-022 D8, ADR-020 D8)", () => {
  const GROQ_KEY = `gsk_CANARIO_GROQ_${"a".repeat(24)}`;
  const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";
  const CF_TOKEN = `CANARIO_CF_${"b".repeat(40)}`;
  const BAD_KEY = `CANARIO_${"c".repeat(30)}`;
  const SECRETS = [GROQ_KEY, CF_TOKEN, BAD_KEY, SALARY_KEY, PEPPER, UPSTASH_TOKEN];
  const llmEnv = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    LLM_PROVIDER_CHAIN: "groq,cloudflare_workers_ai",
    GROQ_API_KEY: GROQ_KEY,
    CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT,
    CLOUDFLARE_API_TOKEN: CF_TOKEN,
    CLOUDFLARE_WORKERS_AI_MODEL: "",
    ...over,
  });
  const caught = (run: () => unknown): Error => {
    try {
      run();
    } catch (error) {
      return error as Error;
    }
    throw new Error("esperava falha no boot");
  };

  test("a cadeia completa: Groq e Workers AI na ordem da LLM_PROVIDER_CHAIN, com o prompt do código (p3)", () => {
    const llm = productionLlmComposition(llmEnv());
    expect(llm.extractors.map(({ provider, model }) => [provider, model])).toEqual([
      ["groq", GROQ_ADAPTER_MODEL],
      ["cloudflare_workers_ai", WORKERS_AI_DEFAULT_MODEL],
    ]);
    expect(llm.promptVersion).toBe(EXTRACTION_PROMPT_VERSION);
    expect(EXTRACTION_PROMPT_VERSION).toBe("p3");
    // Nenhuma credencial aparece no objeto montado (só no closure de cada adapter).
    for (const secret of [GROQ_KEY, CF_TOKEN]) expect(JSON.stringify(llm)).not.toContain(secret);
  });

  test("a ordem segue a cadeia, e a credencial de provedor fora dela não é exigida", () => {
    const inverted = productionLlmComposition(llmEnv({ LLM_PROVIDER_CHAIN: " cloudflare_workers_ai , groq " }));
    expect(inverted.extractors.map(({ provider }) => provider)).toEqual(["cloudflare_workers_ai", "groq"]);
    const groqOnly = productionLlmComposition(llmEnv({ LLM_PROVIDER_CHAIN: "groq", CLOUDFLARE_API_TOKEN: undefined }));
    expect(groqOnly.extractors.map(({ provider }) => provider)).toEqual(["groq"]);
    const workersOnly = productionLlmComposition(llmEnv({ LLM_PROVIDER_CHAIN: "cloudflare_workers_ai", GROQ_API_KEY: undefined }));
    expect(workersOnly.extractors.map(({ provider }) => provider)).toEqual(["cloudflare_workers_ai"]);
  });

  test("CLOUDFLARE_WORKERS_AI_MODEL: ausente ou vazia dá o modelo medido no S-1; outra forma válida vale", () => {
    const model = (value: string | undefined): string | undefined =>
      productionLlmComposition(llmEnv({ CLOUDFLARE_WORKERS_AI_MODEL: value })).extractors[1]?.model;
    expect(model(undefined)).toBe(WORKERS_AI_DEFAULT_MODEL);
    expect(model("")).toBe(WORKERS_AI_DEFAULT_MODEL);
    expect(model("@cf/meta/llama-3.1-8b-instruct")).toBe("@cf/meta/llama-3.1-8b-instruct");
  });

  test.each<[string, Record<string, string | undefined>, new (...args: never[]) => Error, string | null]>([
    ["sem LLM_PROVIDER_CHAIN", { LLM_PROVIDER_CHAIN: undefined }, ProviderChainConfigError, null],
    ["cadeia vazia", { LLM_PROVIDER_CHAIN: "" }, ProviderChainConfigError, null],
    ["cadeia com o Ollama (só dev)", { LLM_PROVIDER_CHAIN: "groq,ollama" }, ProviderChainConfigError, null],
    ["cadeia com o Gemini (HITL-012)", { LLM_PROVIDER_CHAIN: "google_ai_studio" }, ProviderChainConfigError, null],
    ["cadeia com provedor repetido", { LLM_PROVIDER_CHAIN: "groq,groq" }, ProviderChainConfigError, null],
    ["sem GROQ_API_KEY", { GROQ_API_KEY: undefined }, GroqConfigError, "GROQ_API_KEY"],
    ["GROQ_API_KEY vazia", { GROQ_API_KEY: "" }, GroqConfigError, "GROQ_API_KEY"],
    ["GROQ_API_KEY fora da forma (sem gsk_)", { GROQ_API_KEY: BAD_KEY }, GroqConfigError, "GROQ_API_KEY"],
    ["sem CLOUDFLARE_ACCOUNT_ID", { CLOUDFLARE_ACCOUNT_ID: undefined }, WorkersAiConfigError, "CLOUDFLARE_ACCOUNT_ID"],
    ["sem CLOUDFLARE_API_TOKEN", { CLOUDFLARE_API_TOKEN: undefined }, WorkersAiConfigError, "CLOUDFLARE_API_TOKEN"],
    ["modelo da Workers AI fora da forma", { CLOUDFLARE_WORKERS_AI_MODEL: "@cf/../x" }, WorkersAiConfigError, "CLOUDFLARE_WORKERS_AI_MODEL"],
  ])("%s: o boot de produção falha fechado, sem repetir segredo", (_name, over, kind, variable) => {
    const error = caught(() => composeProductionApp(environment(llmEnv(over)), { logger: false }));
    expect(error).toBeInstanceOf(kind);
    if (variable !== null) expect((error as GroqConfigError | WorkersAiConfigError).variable).toBe(variable);
    // A cadeia é recusada pela validação dela, não só pelo segundo cadeado (createProductionExtractor).
    else expect(error.message).toContain("LLM_PROVIDER_CHAIN");
    for (const secret of SECRETS) expect(String(error.message)).not.toContain(secret);
  });

  test("o boot de produção exige a cadeia: o mesmo ambiente sem as variáveis de LLM não sobe", () => {
    // O composeApp sem a opção subiria só determinístico; o composeProductionApp, não.
    expect(() => composeProductionApp(environment(), { logger: false })).toThrow(ProviderChainConfigError);
  });

  test.each(["ollama", "google_ai_studio"] as const)("%s não tem adapter de produção (segundo cadeado depois da cadeia)", (provider) => {
    expect(() => createProductionExtractor(provider, llmEnv())).toThrow(ProviderChainConfigError);
  });

  test("o main.ts sobe pela composição de produção, sem ganchos de teste (T28)", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("composeProductionApp(process.env);");
    expect(main).not.toContain("composeApp(");
    expect(main).not.toContain("baseUrl");
  });

  describe("de ponta a ponta, com o Groq e a Workers AI simulados em socket real", () => {
    const servers = async () => {
      const groq = await startFakeGroq();
      const workers = await startFakeWorkersAi();
      const hooks: ProductionLlmTestHooks = { baseUrls: { groq: groq.url, cloudflare_workers_ai: workers.url } };
      return { groq, workers, hooks, close: () => Promise.all([groq.close(), workers.close()]) };
    };
    const bootProduction = (hooks: ProductionLlmTestHooks): ComposedApp => {
      composed = composeProductionApp(environment(llmEnv()), { logger: false }, hooks);
      return composed;
    };
    const reportOf = (raw: string) => {
      const [result] = events(raw).filter((event) => event.type === "result");
      if (result?.type !== "result") throw new Error("sem evento result");
      return result.report;
    };
    const redisCommands = (): string => JSON.stringify(upstash.requests.map((request) => request.commands));

    test("Groq responde: a análise sai da extração do Groq, a chave só no Authorization, e a Workers AI não é chamada", async () => {
      const fake = await servers();
      try {
        fake.groq.mode = { kind: "responde", body: completion(CLEAN_RAW) };
        const token = await storeOwnerCriteria();
        const res = await analyze(bootProduction(fake.hooks), { authorization: `Bearer ${token}` }, "aprofundada");
        expect(res.statusCode).toBe(200);
        expect(reportOf(res.body).decisionPath).toBe("extracao_llm");
        expect(fake.groq.requests).toHaveLength(1);
        expect(fake.groq.requests[0]?.headers.authorization).toBe(`Bearer ${GROQ_KEY}`);
        expect(JSON.parse(fake.groq.requests[0]?.body ?? "{}")).toMatchObject({ model: GROQ_ADAPTER_MODEL });
        expect(fake.workers.requests).toHaveLength(0);
        // O ledger reservou no Groq; nenhuma credencial de LLM foi ao Redis.
        expect(redisCommands()).toContain("groq");
        for (const secret of [GROQ_KEY, CF_TOKEN]) expect(redisCommands()).not.toContain(secret);
      } finally {
        await fake.close();
      }
    });

    test("Groq em 429: troca imediata para a Workers AI, que responde (fallback da cadeia)", async () => {
      const fake = await servers();
      try {
        fake.groq.mode = { kind: "responde", status: 429, body: "{}", headers: { "retry-after": "30" } };
        fake.workers.mode = { kind: "responde", body: envelope(CLEAN_RAW) };
        const token = await storeOwnerCriteria();
        const res = await analyze(bootProduction(fake.hooks), { authorization: `Bearer ${token}` }, "aprofundada");
        expect(res.statusCode).toBe(200);
        expect(reportOf(res.body).decisionPath).toBe("extracao_llm");
        expect(fake.groq.requests).toHaveLength(1);
        expect(fake.workers.requests).toHaveLength(1);
        expect(fake.workers.requests[0]?.headers.authorization).toBe(`Bearer ${CF_TOKEN}`);
        // O 429 grava o bloqueio compartilhado do Groq (ADR-022 D7.3), sem esperar a resposta.
        for (let tries = 0; tries < 50 && !redisCommands().includes("llm:block:groq"); tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(redisCommands()).toContain("llm:block:groq");
      } finally {
        await fake.close();
      }
    });

    test("os dois provedores recusam: a análise cai no determinístico (ADR-001 C5), sem erro para o usuário", async () => {
      const fake = await servers();
      try {
        fake.groq.mode = { kind: "responde", status: 400, body: "{}" };
        fake.workers.mode = { kind: "responde", status: 400, body: "{}" };
        const token = await storeOwnerCriteria();
        const res = await analyze(bootProduction(fake.hooks), { authorization: `Bearer ${token}` }, "aprofundada");
        expect(res.statusCode).toBe(200);
        expect(reportOf(res.body).decisionPath).toBe("fallback_deterministico");
        expect(fake.groq.requests).toHaveLength(1);
        expect(fake.workers.requests).toHaveLength(1);
      } finally {
        await fake.close();
      }
    });
  });
});

describe("BFF de autenticação no boot (F1-API-07 07g; ADR-004 D4 a D8)", () => {
  const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const CODE = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
  const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const SID = "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3";
  let gotrue: FakeGotrue;
  /** Access tokens assinados que o GoTrue simulado vai emitir, em ordem; vazio, um com as claims padrão. */
  const tokenQueue: string[] = [];
  let defaultToken = "";

  beforeEach(async () => {
    tokenQueue.length = 0;
    gotrue = await startFakeGotrue(PUBLISHABLE, {
      accessToken: () => tokenQueue.shift() ?? defaultToken,
      jwks: () => ({ keys: [key.jwk] }),
    });
    defaultToken = await signToken(key, supabaseClaims(`${gotrue.url.origin}/auth/v1`));
  });
  afterEach(async () => {
    await gotrue.close();
  });

  function bootAuth(over: Record<string, string | undefined> = {}, lines?: string[], telemetry?: InMemoryTelemetry): ComposedApp {
    const origin = gotrue.url.origin;
    return boot(
      {
        SUPABASE_URL: origin,
        SUPABASE_JWKS_URL: `${origin}/auth/v1/.well-known/jwks.json`,
        CORS_ALLOWED_ORIGINS: EXTENSION,
        ...over,
      },
      {
        ...(lines === undefined ? {} : { logger: { level: "info", stream: { write: (line) => void lines.push(line) } } }),
        ...(telemetry === undefined ? {} : { telemetry }),
      },
    );
  }

  const post = (instance: ComposedApp, route: "exchange" | "refresh" | "logout", payload: unknown, headers: Record<string, string> = {}) =>
    instance.app.inject({
      method: "POST",
      url: `/v1/auth/${route}`,
      headers: { "content-type": "application/json", origin: EXTENSION, ...headers },
      payload: JSON.stringify(payload),
    });
  const exchangeBody = (code = CODE) => ({ schemaVersion: 1, authCode: code, codeVerifier: VERIFIER });
  const tokenCalls = () => gotrue.requests.filter((request) => request.url.startsWith("/auth/v1/token"));
  /** O anel do boot (o mesmo do `environment()`), para forjar envelopes genuínos com idades escolhidas. */
  const bootSealer = () => createAeadRefreshSealer(parseRefreshKeyring(`r1k1:${REFRESH_KEY}`, "r1k1"));
  function sealedEnvelope(sst: number, iat: number): string {
    const sealed = bootSealer().seal({ rt: "rt-de-teste", sid: SID, sst, iat }, EXTENSION);
    if (!sealed.ok) throw new Error("envelope de teste fora da política");
    return sealed.envelope;
  }

  test("troca → renovação → logout pelas peças reais; o Redis só é tocado no logout, depois do JWT", async () => {
    const instance = bootAuth();
    gotrue.addFlow(CODE, VERIFIER);
    const exchanged = await post(instance, "exchange", exchangeBody());
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.headers["cache-control"]).toBe("no-store");
    const session = AuthSessionResponseSchema.parse(exchanged.json());
    expect(Object.keys(exchanged.json() as object).sort()).toEqual(["accessToken", "expiresIn", "refreshToken", "schemaVersion"]);
    // SR-22: os canários da resposta do GoTrue não saem.
    for (const canary of [GOTRUE_CANARIES.providerToken, GOTRUE_CANARIES.providerRefreshToken, GOTRUE_CANARIES.userId]) {
      expect(exchanged.body).not.toContain(canary);
    }

    const refreshed = await post(instance, "refresh", { schemaVersion: 1, refreshToken: session.refreshToken });
    expect(refreshed.statusCode).toBe(200);
    const renewed = AuthSessionResponseSchema.parse(refreshed.json());
    expect(renewed.refreshToken).not.toBe(session.refreshToken);
    expect(tokenCalls().map((request) => request.url)).toEqual([
      "/auth/v1/token?grant_type=pkce",
      "/auth/v1/token?grant_type=refresh_token",
    ]);
    // 0 comandos no Redis simulado antes do JWT: as duas públicas não tocam o Redis.
    expect(upstash.requests).toHaveLength(0);

    const ended = await post(instance, "logout", { schemaVersion: 1 }, { authorization: `Bearer ${renewed.accessToken}` });
    expect(ended.statusCode).toBe(204);
    expect(ended.headers["cache-control"]).toBe("no-store");
    expect(gotrue.requests.at(-1)?.url).toBe("/auth/v1/logout?scope=global");
    expect(gotrue.requests.at(-1)?.headers.authorization).toBe(`Bearer ${renewed.accessToken}`);
    // O logout é protegido: o rate limit da classe padrao conta no Redis depois do JWT.
    expect(upstash.requests.length).toBeGreaterThan(0);
  });

  test("07i: as 3 rotas contam na telemetria do processo, só com a operação e o resultado", async () => {
    const telemetry = new InMemoryTelemetry();
    const instance = bootAuth({}, undefined, telemetry);
    gotrue.addFlow(CODE, VERIFIER);
    const session = AuthSessionResponseSchema.parse((await post(instance, "exchange", exchangeBody())).json());
    // O código já foi usado: o GoTrue recusa, e a troca conta como recusada.
    expect((await post(instance, "exchange", exchangeBody())).statusCode).toBe(401);
    const renewed = AuthSessionResponseSchema.parse((await post(instance, "refresh", { schemaVersion: 1, refreshToken: session.refreshToken })).json());
    const forged = `r1.r1k1.${"A".repeat(16)}.${"B".repeat(40)}.${"C".repeat(22)}`;
    expect((await post(instance, "refresh", { schemaVersion: 1, refreshToken: forged })).statusCode).toBe(401);
    expect((await post(instance, "logout", { schemaVersion: 1 }, { authorization: `Bearer ${renewed.accessToken}` })).statusCode).toBe(204);
    gotrue.mode = { kind: "responde", status: 500, body: "{}" };
    expect((await post(instance, "logout", { schemaVersion: 1 }, { authorization: `Bearer ${renewed.accessToken}` })).statusCode).toBe(503);

    expect(telemetry.counter("auth_troca_total", { resultado: "ok" })).toBe(1);
    expect(telemetry.counter("auth_troca_total", { resultado: "recusado" })).toBe(1);
    expect(telemetry.counter("auth_renovacao_total", { resultado: "ok" })).toBe(1);
    expect(telemetry.counter("auth_renovacao_total", { resultado: "recusado" })).toBe(1);
    expect(telemetry.counter("auth_logout_total", { resultado: "ok" })).toBe(1);
    expect(telemetry.counter("auth_logout_total", { resultado: "indisponivel" })).toBe(1);
    expect(telemetry.droppedEvents).toBe(0);
    const series = telemetry.seriesKeys();
    expect(series).toHaveLength(6);
    for (const key of series) {
      expect(key.startsWith("auth_")).toBe(true);
      for (const secret of [CODE, VERIFIER, session.accessToken, session.refreshToken, renewed.refreshToken, GOTRUE_CANARIES.userId, EXTENSION, SID]) {
        expect(key).not.toContain(secret);
      }
    }
  });

  test("07j: o boot usa o teto de rajada: a 16ª chamada seguida ao /token leva 503 com Retry-After, sem chegar ao GoTrue", async () => {
    const instance = bootAuth();
    // Envelope genuíno que o GoTrue não conhece: cada renovação vai ao /token e volta 401.
    const refreshToken = sealedEnvelope(nowSeconds() - 60, nowSeconds() - 60);
    for (let i = 0; i < 15; i += 1) expect((await post(instance, "refresh", { schemaVersion: 1, refreshToken })).statusCode).toBe(401);
    const denied = await post(instance, "refresh", { schemaVersion: 1, refreshToken });
    expect(denied.statusCode).toBe(503);
    const retryAfter = ApiErrorSchema.parse(denied.json()).retryAfterSeconds;
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(4);
    expect(denied.headers["retry-after"]).toBe(String(retryAfter));
    expect(tokenCalls()).toHaveLength(15);
  });

  test("0 comandos no Redis com códigos falsos, envelopes forjados e o 429 do limitador local", async () => {
    const instance = bootAuth();
    for (let i = 0; i < 10; i += 1) expect((await post(instance, "exchange", exchangeBody())).statusCode).toBe(401);
    expect((await post(instance, "exchange", exchangeBody())).statusCode).toBe(429);
    const forged = `r1.r1k1.${"A".repeat(16)}.${"B".repeat(40)}.${"C".repeat(22)}`;
    for (let i = 0; i < 5; i += 1) {
      expect((await post(instance, "refresh", { schemaVersion: 1, refreshToken: forged })).statusCode).toBe(401);
    }
    expect(upstash.requests).toHaveLength(0);
    // Os forjados não chegaram ao GoTrue: só as 10 trocas recusadas.
    expect(tokenCalls()).toHaveLength(10);
  });

  test("as idades do ambiente chegam à renovação: inatividade e idade máxima dão 401 sem rede", async () => {
    const instance = bootAuth({ AUTH_SESSION_MAX_AGE_SECONDS: "3600", AUTH_SESSION_IDLE_SECONDS: "900" });
    const now = nowSeconds();
    for (const refreshToken of [sealedEnvelope(now - 1_000, now - 905), sealedEnvelope(now - 3_605, now - 60)]) {
      const res = await post(instance, "refresh", { schemaVersion: 1, refreshToken });
      expect(res.statusCode).toBe(401);
      expect(ApiErrorSchema.parse(res.json()).code).toBe("NAO_AUTENTICADO");
    }
    expect(gotrue.requests).toHaveLength(0);
    // Dentro das idades, o envelope genuíno chega ao GoTrue (que não conhece o refresh: 401 depois de 1 chamada).
    expect((await post(instance, "refresh", { schemaVersion: 1, refreshToken: sealedEnvelope(now - 1_000, now - 60) })).statusCode).toBe(401);
    expect(tokenCalls()).toHaveLength(1);
  });

  test("um só GotrueEgress por processo: 3 trocas e 1 renovação em voo enchem o bulkhead das duas rotas (503, retryAfterSeconds 5)", async () => {
    const instance = bootAuth();
    const refreshToken = sealedEnvelope(nowSeconds() - 60, nowSeconds() - 60);
    gotrue.mode = { kind: "lento", delayMs: 1_500 };
    const codes = ["a1b2c3d4-0001", "a1b2c3d4-0002", "a1b2c3d4-0003", "a1b2c3d4-0004"];
    for (const code of codes) gotrue.addFlow(code, VERIFIER);
    const waitTokenCalls = async (n: number): Promise<void> => {
      const deadline = Date.now() + HAPPY_PATH_TIMEOUT_MS;
      while (tokenCalls().length < n && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(tokenCalls()).toHaveLength(n);
    };
    const expectBusy = (res: Awaited<ReturnType<typeof post>>): void => {
      expect(res.statusCode).toBe(503);
      expect(ApiErrorSchema.parse(res.json()).retryAfterSeconds).toBe(5);
      expect(res.headers["retry-after"]).toBe("5");
    };
    const trocas = codes.slice(0, 3).map((code) => post(instance, "exchange", exchangeBody(code)));
    await waitTokenCalls(3);
    // A 4ª troca para no teto dela (A-03), e a vaga que sobra é da renovação.
    expectBusy(await post(instance, "exchange", exchangeBody(codes[3] ?? "")));
    const renovacao = post(instance, "refresh", { schemaVersion: 1, refreshToken });
    await waitTokenCalls(4);
    // A rota da renovação vê as trocas da outra rota: o bulkhead é um só.
    expectBusy(await post(instance, "refresh", { schemaVersion: 1, refreshToken }));
    expect(tokenCalls()).toHaveLength(4);
    await Promise.all([...trocas, renovacao]);
  });

  test("com TRUST_PROXY e API_BEHIND_PROXY=true, dois X-Forwarded-For do proxy caem em baldes distintos", async () => {
    const instance = bootAuth({ TRUST_PROXY: "127.0.0.1", API_BEHIND_PROXY: "true" });
    // Corpo fora do contrato: o limitador conta antes do Zod, e nada chega ao GoTrue nem ao orçamento de saída.
    for (const client of ["198.51.100.1", "198.51.100.2"]) {
      for (let i = 0; i < 10; i += 1) {
        expect((await post(instance, "exchange", { schemaVersion: 1 }, { "x-forwarded-for": client })).statusCode).toBe(400);
      }
      expect((await post(instance, "exchange", { schemaVersion: 1 }, { "x-forwarded-for": client })).statusCode).toBe(429);
    }
    expect(gotrue.requests).toHaveLength(0);
  });

  test("API_BEHIND_PROXY vazio com NODE_ENV=test sobe (a pilha de teste não exige a variável)", async () => {
    const instance = bootAuth({ API_BEHIND_PROXY: undefined, NODE_ENV: "test" });
    expect((await instance.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  test("SR-12 com as peças reais: nada de código, verifier, tokens, envelope, canários do GoTrue ou IP nos caminhos 200, 401, 429 e 503", async () => {
    const lines: string[] = [];
    const instance = bootAuth({}, lines);
    gotrue.addFlow(CODE, VERIFIER);
    const ok = AuthSessionResponseSchema.parse((await post(instance, "exchange", exchangeBody())).json());
    const refreshed = AuthSessionResponseSchema.parse(
      (await post(instance, "refresh", { schemaVersion: 1, refreshToken: ok.refreshToken })).json(),
    );
    // 401: o refresh antigo já rotacionou, e o GoTrue o recusa.
    expect((await post(instance, "refresh", { schemaVersion: 1, refreshToken: ok.refreshToken })).statusCode).toBe(401);
    // 503: o GoTrue responde 500 (não recebeu).
    gotrue.mode = { kind: "responde", status: 500, body: "{}" };
    expect((await post(instance, "exchange", exchangeBody("ffffffff-0000"))).statusCode).toBe(503);
    gotrue.mode = { kind: "normal" };
    // 429: o limitador local da troca (já foram 2 trocas no minuto).
    let limited = 0;
    for (let i = 0; i < 9; i += 1) limited += (await post(instance, "exchange", exchangeBody())).statusCode === 429 ? 1 : 0;
    expect(limited).toBeGreaterThan(0);
    const messages = lines.map((line) => String((JSON.parse(line) as Record<string, unknown>)["msg"]));
    expect(messages).toEqual(expect.arrayContaining(["auth_renovacao_recusada", "auth_provedor_indisponivel", "auth_limite_local"]));
    const secrets = [
      CODE,
      VERIFIER,
      ok.accessToken,
      ok.refreshToken,
      refreshed.accessToken,
      refreshed.refreshToken,
      ...gotrue.activeRefreshTokens,
      GOTRUE_CANARIES.email,
      GOTRUE_CANARIES.providerToken,
      GOTRUE_CANARIES.providerRefreshToken,
      GOTRUE_CANARIES.userId,
      "127.0.0.1",
      EXTENSION,
      REFRESH_KEY,
    ];
    for (const line of lines) for (const secret of secrets) expect(line).not.toContain(secret);
  });
});
