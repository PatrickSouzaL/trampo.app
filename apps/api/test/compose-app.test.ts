// Teste de boot do F1-API-04b (aceite do BACKLOG): a raiz de composição que o main.ts usa sobe com o ambiente
// completo, monta POST /v1/analyze e responde 401 sem token. Também prova o fluxo inteiro com as peças reais
// (JWT verificado num JWKS local, limites no Upstash simulado, critérios no PostgREST simulado com a pretensão
// cifrada) e a falha fechado do boot: sem a publishable, com chave secret ou legada, sem o anel da pretensão ou
// com o ambiente do Redis ou do JWT inválido, nada sobe. Nenhum teste toca serviço real nem Docker.
import { randomBytes } from "node:crypto";

import { AnalysisStreamEventSchema, ApiErrorSchema, type AnalysisStreamEvent } from "@trampo/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ZodError } from "zod";

import { CacheConfigError, CriteriaGuard, ProviderChainConfigError, RouterConfigError } from "../src/application/index.js";
import { NO_EXTRACTOR_PROMPT_VERSION, composeApp, type ComposedApp, type Environment } from "../src/composition/compose-app.js";
import { SalaryKeyringConfigError, createSalaryCipher, parseSalaryKeyring } from "../src/infrastructure/crypto/salary-cipher.js";
import { PostgrestClientConfigError } from "../src/infrastructure/supabase/postgrest-user-client.js";
import { systemClock } from "../src/infrastructure/time/system-clock.js";
import { CLEAN_RAW, CLEAN_TEXT, GROQ_MODEL, REQUEST_ID } from "./application/fakes/analyze-job-harness.js";
import { ScriptedExtractor } from "./application/fakes/scripted-extractor.js";
import { criteria, weighted } from "./domain/fakes/scoring-fixtures.js";
import { startFakePostgrest, type FakePostgrest } from "./infrastructure/fakes/fake-postgrest.js";
import { startFakeUpstash, type FakeUpstash } from "./infrastructure/fakes/fake-upstash.js";
import { signToken, signingKey, supabaseClaims, type SigningKey } from "./infrastructure/jwks-fixture.js";

const PUBLISHABLE = "sb_publishable_boot-teste";
const UPSTASH_TOKEN = "AXyz_token-de-boot.123";
const OWNER = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const SALARY_KEY = randomBytes(32).toString("base64url");
const PEPPER = randomBytes(32).toString("base64url");
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
    const instance = boot({ TRUST_PROXY: trustProxy });
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
  ])("%s: nada sobe e a mensagem não repete segredo", (_name, over, kind) => {
    let error: unknown;
    try {
      composeApp(environment(over), { logger: false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(kind);
    const message = String((error as Error).message);
    for (const secret of [SALARY_KEY, PEPPER, UPSTASH_TOKEN, "sb_secret_vazada-123", LEGACY_KEY_PREFIX]) expect(message).not.toContain(secret);
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
