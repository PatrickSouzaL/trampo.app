// F1-API-05 commit 5 (ADR-021 D2, D4, D8.1, D9 e D10): GET e PUT /v1/criteria com o CriteriaGuard real em volta
// do repositório falso. Cobre o registro pela opção `criteria`, a ordem de defesa (401 sem ler o corpo, 413 sem
// parse, rate limit antes do corpo, 400 sem gravar), os três desfechos do GET, o 204 sem corpo e o 503 sem eco do
// PUT, o `Cache-Control: no-store` em toda resposta, o SR-12 com o log capturado e o CORS herdado do commit 4.
// O fluxo com as peças reais (JWT, PostgREST simulado e cifra) está no teste de boot do composeApp.
import { randomUUID } from "node:crypto";

import { ApiErrorSchema, type UserCriteria, UserCriteriaSchema } from "@trampo/contracts";
import { CRITERIA_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import Fastify from "fastify";
import { afterEach, describe, expect, test } from "vitest";

import { CriteriaGuard } from "../src/application/index.js";
import type { CriteriaRepository } from "../src/application/ports/criteria-repository.js";
import { systemClock } from "../src/infrastructure/time/system-clock.js";
import { buildApp } from "../src/presentation/build-app.js";
import { LOG_ALLOWLIST } from "../src/presentation/logging/log-policy.js";
import {
  CRITERIA_ROUTE,
  createGetCriteriaHandler,
  createPutCriteriaHandler,
} from "../src/presentation/routes/criteria.js";
import { FakeCriteriaRepository } from "./application/fakes/fake-criteria-repository.js";
import { TEST_AUTHORIZATION, TEST_PRINCIPAL, TEST_TOKEN, fakeVerifier } from "./auth-fakes.js";
import { REQUIRED, criteria, stack, weighted } from "./domain/fakes/scoring-fixtures.js";
import { type FakeBehavior, fakeLimits } from "./limit-fakes.js";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PORTAL = "https://portal.trampo.example";
const OTHER_OWNER = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f";
const LIMITED = { kind: "valor", value: { ok: false, reason: "limite_excedido", retryAfterSeconds: 30 } } as const;

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface AppOptions {
  /** O que vai na opção `criteria`. Padrão: o CriteriaGuard real em volta do `fake`. */
  readonly repository?: CriteriaRepository;
  readonly fake?: FakeCriteriaRepository;
  readonly rate?: FakeBehavior;
  readonly lines?: string[];
  /** Destino de log que lança nas linhas com estas mensagens (o log nunca derruba a resposta). */
  readonly throwOn?: readonly string[];
}

/** App com a opção `criteria` e um contador do parser JSON, para provar o que roda antes do corpo. */
function criteriaApp(options: AppOptions = {}) {
  const fake = options.fake ?? new FakeCriteriaRepository();
  const fakes = fakeLimits(options.rate === undefined ? {} : { rate: options.rate });
  const throwOn = options.throwOn ?? [];
  const stream = {
    write: (line: string) => {
      options.lines?.push(line);
      if (throwOn.some((msg) => line.includes(`"msg":"${msg}"`))) throw new Error("destino de log fora do ar");
    },
  };
  const counts = { parser: 0 };
  const instance = buildApp({
    accessTokenVerifier: fakeVerifier().verifier,
    limits: fakes.limits,
    corsAllowedOrigins: [EXTENSION, PORTAL],
    logger: options.lines === undefined && throwOn.length === 0 ? false : { level: "trace", stream },
    criteria: { repository: options.repository ?? new CriteriaGuard(fake, systemClock) },
  });
  const defaultJson = instance.getDefaultJsonParser("error", "error");
  instance.removeContentTypeParser("application/json");
  instance.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    counts.parser += 1;
    defaultJson(request, typeof body === "string" ? body : body.toString("utf8"), done);
  });
  app = instance;
  return { app: instance, fake, rate: fakes.rate, quota: fakes.quota, counts };
}

// O literal do contrato, não a constante: renomear a rota tem de quebrar o teste.
const URL_PATH = "/v1/criteria";

function get(instance: ReturnType<typeof buildApp>, headers: Record<string, string> = {}, url = URL_PATH) {
  return instance.inject({ method: "GET", url, headers: { authorization: TEST_AUTHORIZATION, ...headers } });
}

function put(instance: ReturnType<typeof buildApp>, payload: unknown, headers: Record<string, string> = {}) {
  return instance.inject({
    method: "PUT",
    url: URL_PATH,
    headers: { authorization: TEST_AUTHORIZATION, "content-type": "application/json", ...headers },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

const records = (lines: readonly string[]) => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const warnings = (lines: readonly string[]) => records(lines).filter((r) => r["level"] === 40).map((r) => r["msg"]);

/** O corpo de erro é exatamente o ApiError do catálogo: nenhuma chave a mais, nenhuma issue do Zod. */
function expectApiError(res: { statusCode: number; json: () => unknown }, status: number, code: string) {
  expect(res.statusCode).toBe(status);
  const parsed = ApiErrorSchema.parse(res.json());
  expect(parsed.code).toBe(code);
  expect(Object.keys(res.json() as object).sort()).toEqual(["code", "message", "requestId", "retryAfterSeconds"]);
}

/** Perfil com espaços nas pontas: o que a porta recebe é o valor reparseado, aparado. */
const profile = (): UserCriteria =>
  criteria({
    salary: { minimum: 9_000, currency: "BRL", period: "mes", importance: weighted(3) },
    location: { acceptedUfs: ["PE"], acceptedCities: ["Recife"], importance: REQUIRED },
    stack: stack({ mustHave: ["TypeScript"] }),
    notes: "Prefiro times pequenos.",
  });

describe("registro (ADR-021 §4)", () => {
  test("sem a opção `criteria`, GET e PUT são rotas inexistentes: 404 PROIBIDO com token, 401 sem", async () => {
    const bare = buildApp({ accessTokenVerifier: fakeVerifier().verifier, limits: fakeLimits().limits, logger: false });
    app = bare;
    expectApiError(await get(bare), 404, "PROIBIDO");
    expectApiError(await put(bare, profile()), 404, "PROIBIDO");
    expect((await bare.inject({ method: "GET", url: URL_PATH })).statusCode).toBe(401);
  });

  test("a constante da rota é o literal do contrato", () => {
    expect(CRITERIA_ROUTE).toBe("/v1/criteria");
  });

  test("GET na classe `padrao`, PUT na `criterios`, e nenhuma das duas gasta cota diária", async () => {
    const { app, rate, quota } = criteriaApp();
    await put(app, profile());
    await get(app);
    expect(rate.calls.map((call) => call.rateClass)).toEqual(["criterios", "padrao"]);
    expect(quota.calls).toEqual([]);
  });

  test("o rate limit recebe o dono do principal", async () => {
    const { app, rate } = criteriaApp();
    await get(app);
    expect(rate.calls[0]?.subject.userId).toBe(TEST_PRINCIPAL.userId);
  });
});

describe("ordem de defesa (ADR-021 D8.1; [APPSEC] critério 8)", () => {
  test.each(["GET", "PUT"] as const)("%s sem token: 401 sem ler o corpo, o Redis nem o banco", async (method) => {
    const { app, fake, rate, counts } = criteriaApp();
    const res = await app.inject({ method, url: URL_PATH, headers: { "content-type": "application/json" }, payload: "{quebrado" });
    expectApiError(res, 401, "NAO_AUTENTICADO");
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect([fake.loads, fake.saves, rate.calls, counts.parser]).toEqual([[], [], [], 0]);
  });

  test("17 KiB: 413 PAYLOAD_GRANDE_DEMAIS sem parse (JSON quebrado não vira 400) e nada gravado", async () => {
    const { app, fake, counts } = criteriaApp();
    const res = await put(app, `{quebrado${"a".repeat(17 * 1_024)}`);
    expectApiError(res, 413, "PAYLOAD_GRANDE_DEMAIS");
    expect([fake.saves, counts.parser]).toEqual([[], 0]);
  });

  test("o bodyLimit é o da rota (16 KiB), no byte exato: 16.384 grava, 16.385 é 413", async () => {
    const { app, fake } = criteriaApp();
    const json = JSON.stringify(profile());
    const exact = json + " ".repeat(CRITERIA_BODY_MAX_BYTES - Buffer.byteLength(json));
    expect(Buffer.byteLength(exact)).toBe(16_384);
    expect((await put(app, exact)).statusCode).toBe(204);
    expectApiError(await put(app, `${exact} `), 413, "PAYLOAD_GRANDE_DEMAIS");
    expect(fake.saves).toHaveLength(1);
  });

  test("rate limit antes do corpo: 429 com JSON quebrado, sem parse e sem gravar", async () => {
    const { app, fake, counts } = criteriaApp({ rate: LIMITED });
    const res = await put(app, "{quebrado");
    expectApiError(res, 429, "LIMITE_DE_TAXA");
    expect(res.headers["retry-after"]).toBe("30");
    expect([fake.saves, counts.parser]).toEqual([[], 0]);
  });

  test("rate limit no GET: 429 sem ler o banco", async () => {
    const { app, fake } = criteriaApp({ rate: LIMITED });
    expectApiError(await get(app), 429, "LIMITE_DE_TAXA");
    expect(fake.loads).toEqual([]);
  });

  test("Redis do rate limit fora do ar: 503 sem gravar", async () => {
    const { app, fake } = criteriaApp({ rate: { kind: "rejeita" } });
    expectApiError(await put(app, profile()), 503, "SERVICO_INDISPONIVEL");
    expect(fake.saves).toEqual([]);
  });

  test("tipo de mídia errado: 415 sem parse e sem gravar", async () => {
    const { app, fake, counts } = criteriaApp();
    const res = await put(app, JSON.stringify(profile()), { "content-type": "text/plain" });
    expect(res.statusCode).toBe(415);
    expect([fake.saves, counts.parser]).toEqual([[], 0]);
  });

  test.each<[string, unknown]>([
    ["userId no corpo", { ...profile(), userId: OTHER_OWNER }],
    ["user_id no corpo", { ...profile(), user_id: OTHER_OWNER }],
    ["chave a mais aninhada", { ...profile(), stack: { ...profile().stack, owner: OTHER_OWNER } }],
    ["schemaVersion 2", { ...profile(), schemaVersion: 2 }],
    ["chave ausente", (({ notes: _notes, ...rest }) => rest)(profile())],
    ["pretensão negativa", { ...profile(), salary: { ...profile().salary, minimum: -1 } }],
    ["corpo que não é objeto", ["x"]],
    ["nulo", null],
    ["JSON quebrado", "{quebrado"],
  ])("%s: 400 PAYLOAD_INVALIDO, sem as issues do Zod e nada gravado", async (_name, payload) => {
    const { app, fake } = criteriaApp();
    const res = await put(app, payload);
    expectApiError(res, 400, "PAYLOAD_INVALIDO");
    expect(res.body).not.toContain(OTHER_OWNER);
    expect(fake.saves).toEqual([]);
  });

  test("perfil acima do teto de bytes do contrato (12 KiB) e abaixo dos 16 KiB da rota: 400, nada gravado", async () => {
    const { app, fake } = criteriaApp();
    // 60 tags de 40 letras de 4 bytes e notas de 4 bytes: acima dos 12 KiB do contrato, só o teto recusa.
    const astral = (codePoint: number): string => String.fromCodePoint(codePoint);
    const tags = Array.from({ length: 60 }, (_, i) => astral(0x20000 + i) + astral(0x1d400 + (i % 52)).repeat(39));
    const payload = {
      ...profile(),
      stack: stack({ mustHave: tags.slice(0, 15), niceToHave: tags.slice(15, 45), dealBreakers: tags.slice(45) }),
      notes: Array.from({ length: 50 }, () => astral(0x20500).repeat(9)).join("\n"),
    };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(12_288);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(CRITERIA_BODY_MAX_BYTES);
    expect(UserCriteriaSchema.safeParse(payload).error?.issues.map((issue) => issue.message)).toEqual(["criterios_grandes_demais"]);
    expectApiError(await put(app, payload), 400, "PAYLOAD_INVALIDO");
    expect(fake.saves).toEqual([]);
  });
});

describe("GET /v1/criteria (ADR-021 D2)", () => {
  test("200 com no-store, JSON e o corpo igual ao gravado pelo PUT", async () => {
    const { app } = criteriaApp();
    expect((await put(app, profile())).statusCode).toBe(204);
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.json()).toEqual(profile());
    expect(UserCriteriaSchema.parse(res.json())).toEqual(profile());
  });

  test("o dono vem só do principal, e o token é o bearer verificado: a query string é ignorada", async () => {
    const { app, fake } = criteriaApp();
    fake.set(OTHER_OWNER, profile());
    const res = await get(app, {}, `${URL_PATH}?userId=${OTHER_OWNER}&user_id=${OTHER_OWNER}`);
    expectApiError(res, 409, "CRITERIOS_NAO_CONFIGURADOS");
    expect(fake.loads).toEqual([TEST_PRINCIPAL.userId]);
    expect(fake.tokens).toEqual([TEST_TOKEN]);
  });

  test("linha de outro dono: 409 CRITERIOS_NAO_CONFIGURADOS com no-store", async () => {
    const { app, fake } = criteriaApp();
    fake.set(OTHER_OWNER, profile());
    const res = await get(app);
    expectApiError(res, 409, "CRITERIOS_NAO_CONFIGURADOS");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("banco fora do ar (ou chave perdida): 503 com no-store e só `criterios_indisponiveis` no log", async () => {
    const lines: string[] = [];
    const fake = new FakeCriteriaRepository().set(TEST_PRINCIPAL.userId, profile());
    fake.unavailable = true;
    const { app } = criteriaApp({ fake, lines });
    const res = await get(app);
    expectApiError(res, 503, "SERVICO_INDISPONIVEL");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(warnings(lines)).toEqual(["criterios_indisponiveis"]);
  });

  test.each<[string, () => Promise<never>]>([
    ["rejeita", () => Promise.reject(new Error("banco"))],
    ["lança", () => {
      throw new Error("banco");
    }],
  ])("porta sem guarda que %s: 503 (falha fechado)", async (_name, load) => {
    const fake = new FakeCriteriaRepository();
    fake.load = load;
    const { app } = criteriaApp({ repository: fake });
    expectApiError(await get(app), 503, "SERVICO_INDISPONIVEL");
  });

  test("log que lança no `criterios_indisponiveis`: ainda 503", async () => {
    const fake = new FakeCriteriaRepository();
    fake.unavailable = true;
    const { app } = criteriaApp({ fake, throwOn: ["criterios_indisponiveis"] });
    expectApiError(await get(app), 503, "SERVICO_INDISPONIVEL");
  });

  test("saída validada pelo serializerCompiler: critérios fora do contrato viram 500 ERRO_INTERNO, sem eco", async () => {
    const lines: string[] = [];
    const canary = "nota-canaria-de-saida";
    const fake = new FakeCriteriaRepository();
    fake.load = () => Promise.resolve({ found: true, criteria: { ...profile(), notes: canary, userId: OTHER_OWNER } as UserCriteria });
    const { app } = criteriaApp({ repository: fake, lines });
    const res = await get(app);
    expectApiError(res, 500, "ERRO_INTERNO");
    expect(res.headers["cache-control"]).toBe("no-store");
    for (const leak of [canary, OTHER_OWNER]) {
      expect(res.body).not.toContain(leak);
      expect(lines.join("")).not.toContain(leak);
    }
    expect(records(lines).filter((r) => r["msg"] === "erro_interno")).toHaveLength(1);
  });
});

describe("PUT /v1/criteria (ADR-021 D2 e D6)", () => {
  test("204 sem corpo, com no-store; a porta recebe o dono do principal, o token verificado e o valor reparseado", async () => {
    const { app, fake } = criteriaApp();
    const sent = { ...profile(), notes: "  Prefiro times pequenos.  " };
    const res = await put(app, sent);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(res.headers["content-type"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(fake.saves).toEqual([{ userId: TEST_PRINCIPAL.userId, criteria: profile() }]);
    expect(fake.tokens).toEqual([TEST_TOKEN]);
  });

  test("repetir o mesmo corpo é idempotente: o GET lê o mesmo documento", async () => {
    const { app } = criteriaApp();
    expect((await put(app, profile())).statusCode).toBe(204);
    expect((await put(app, profile())).statusCode).toBe(204);
    expect((await get(app)).json()).toEqual(profile());
  });

  test("banco fora do ar: 503 sem eco, com no-store e só `criterios_gravacao_indisponivel` no log", async () => {
    const lines: string[] = [];
    const fake = new FakeCriteriaRepository();
    fake.unavailable = true;
    const { app } = criteriaApp({ fake, lines });
    const res = await put(app, { ...profile(), notes: "nota-canaria-503" });
    expectApiError(res, 503, "SERVICO_INDISPONIVEL");
    expect(res.headers["cache-control"]).toBe("no-store");
    for (const leak of ["nota-canaria-503", "9000", "Recife", "TypeScript"]) expect(res.body).not.toContain(leak);
    expect(warnings(lines)).toEqual(["criterios_gravacao_indisponivel"]);
    expect(records(lines).find((r) => r["msg"] === "criterios_gravacao_indisponivel")).toEqual({
      level: 40,
      time: expect.any(Number),
      msg: "criterios_gravacao_indisponivel",
      reqId: expect.any(String),
    });
  });

  test.each<[string, () => Promise<never>]>([
    ["rejeita", () => Promise.reject(new Error("banco"))],
    ["lança", () => {
      throw new Error("banco");
    }],
  ])("porta sem guarda que %s: 503 (falha fechado)", async (_name, save) => {
    const fake = new FakeCriteriaRepository();
    fake.save = save;
    const { app } = criteriaApp({ repository: fake });
    expectApiError(await put(app, profile()), 503, "SERVICO_INDISPONIVEL");
  });

  test("porta que devolve forma errada: o guarda a recusa, 503", async () => {
    const fake = new FakeCriteriaRepository();
    fake.save = () => Promise.resolve({ saved: "sim" } as never);
    const { app } = criteriaApp({ fake });
    expectApiError(await put(app, profile()), 503, "SERVICO_INDISPONIVEL");
  });

  test("log que lança no `criterios_gravacao_indisponivel`: ainda 503", async () => {
    const fake = new FakeCriteriaRepository();
    fake.unavailable = true;
    const { app } = criteriaApp({ fake, throwOn: ["criterios_gravacao_indisponivel"] });
    expectApiError(await put(app, profile()), 503, "SERVICO_INDISPONIVEL");
  });
});

describe("Cache-Control: no-store em sucesso e em erro (ADR-021 D2)", () => {
  test.each<[string, AppOptions, (instance: ReturnType<typeof buildApp>) => ReturnType<typeof get>, number]>([
    ["GET 401", {}, (i) => i.inject({ method: "GET", url: URL_PATH }), 401],
    ["PUT 401", {}, (i) => i.inject({ method: "PUT", url: URL_PATH, headers: { "content-type": "application/json" }, payload: "{}" }), 401],
    ["GET 403 da extensão", {}, (i) => get(i, { origin: EXTENSION }), 403],
    ["PUT 413", {}, (i) => put(i, "x".repeat(CRITERIA_BODY_MAX_BYTES + 1)), 413],
    ["PUT 415", {}, (i) => put(i, "{}", { "content-type": "text/plain" }), 415],
    ["PUT 429", { rate: LIMITED }, (i) => put(i, profile()), 429],
    ["GET 429", { rate: LIMITED }, (i) => get(i), 429],
    ["PUT 400", {}, (i) => put(i, { ...profile(), userId: OTHER_OWNER }), 400],
  ])("%s", async (_name, options, send, status) => {
    const { app } = criteriaApp(options);
    const res = await send(app);
    expect(res.statusCode).toBe(status);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("a regra é da rota: /health não ganha no-store", async () => {
    const { app } = criteriaApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["cache-control"]).toBeUndefined();
  });
});

describe("CORS herdado do commit 4 (ADR-021 D8.3; [APPSEC] critério 5)", () => {
  test.each(["GET", "PUT"] as const)("origem da extensão: 403 no %s real e no preflight, sem ler o banco", async (method) => {
    const { app, fake, rate, counts } = criteriaApp();
    const real = await app.inject({
      method,
      url: URL_PATH,
      headers: { origin: EXTENSION, authorization: TEST_AUTHORIZATION, "content-type": "application/json" },
      ...(method === "PUT" ? { payload: JSON.stringify(profile()) } : {}),
    });
    expectApiError(real, 403, "PROIBIDO");
    expect(real.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await app.inject({
      method: "OPTIONS",
      url: URL_PATH,
      headers: { origin: EXTENSION, "access-control-request-method": method },
    });
    expect(preflight.statusCode).toBe(403);
    expect([fake.loads, fake.saves, rate.calls, counts.parser]).toEqual([[], [], [], 0]);
  });

  test("origem do portal: PUT e GET chegam ao handler, com a origem ecoada", async () => {
    const { app } = criteriaApp();
    const saved = await put(app, profile(), { origin: PORTAL });
    expect(saved.statusCode).toBe(204);
    expect(saved.headers["access-control-allow-origin"]).toBe(PORTAL);
    const read = await get(app, { origin: PORTAL });
    expect(read.statusCode).toBe(200);
    expect(read.headers["access-control-allow-origin"]).toBe(PORTAL);
  });
});

describe("SR-12 com o log capturado ([APPSEC] critério 7)", () => {
  const CANARY = {
    note: "nota-canaria-do-perfil",
    city: "Cidadecanaria",
    tech: "Zqxcanarytech",
    salary: "31415",
    token: "canario-token-a1.canario-token-b2.canario-token-c3",
  } as const;
  const canaryProfile = (): UserCriteria =>
    criteria({
      salary: { minimum: Number(CANARY.salary), currency: "BRL", period: "mes", importance: weighted(3) },
      location: { acceptedUfs: ["PE"], acceptedCities: [CANARY.city], importance: REQUIRED },
      stack: stack({ mustHave: [CANARY.tech] }),
      notes: CANARY.note,
    });
  const auth = { authorization: `Bearer ${CANARY.token}` };

  test.each<[string, AppOptions & { readonly unavailable?: boolean }, (instance: ReturnType<typeof buildApp>) => ReturnType<typeof get>, number]>([
    ["200", {}, (i) => get(i, auth), 200],
    ["204", {}, (i) => put(i, canaryProfile(), auth), 204],
    ["400", {}, (i) => put(i, { ...canaryProfile(), userId: OTHER_OWNER }, auth), 400],
    ["413", {}, (i) => put(i, `${JSON.stringify(canaryProfile())}${" ".repeat(CRITERIA_BODY_MAX_BYTES)}`, auth), 413],
    ["429", { rate: LIMITED }, (i) => put(i, canaryProfile(), auth), 429],
    ["503 do PUT", { unavailable: true }, (i) => put(i, canaryProfile(), auth), 503],
    ["503 do GET", { unavailable: true }, (i) => get(i, auth), 503],
  ])("%s: nenhum canário no log, e só chaves da lista fechada", async (_name, options, send, status) => {
    const lines: string[] = [];
    const fake = new FakeCriteriaRepository().set(TEST_PRINCIPAL.userId, canaryProfile());
    fake.unavailable = options.unavailable === true;
    const { app } = criteriaApp({ ...options, fake, lines });
    const res = await send(app);
    expect(res.statusCode).toBe(status);
    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join("");
    for (const canary of [...Object.values(CANARY), TEST_PRINCIPAL.userId, OTHER_OWNER]) expect(logged).not.toContain(canary);
    for (const record of records(lines)) {
      for (const key of Object.keys(record)) expect(LOG_ALLOWLIST.top).toContain(key);
    }
    // O corpo só ecoa critérios no GET 200; nenhum erro devolve valor do perfil nem o token.
    if (status !== 200) for (const canary of Object.values(CANARY)) expect(res.body).not.toContain(canary);
    else expect(res.body).not.toContain(CANARY.token);
  });

  test("o log de resposta leva a rota da lista fechada", async () => {
    const lines: string[] = [];
    const { app } = criteriaApp({ lines });
    await put(app, profile());
    const received = records(lines).find((r) => r["msg"] === "requisicao_recebida");
    expect(received?.["req"]).toEqual({ id: expect.any(String), method: "PUT", route: "/v1/criteria" });
    const completed = records(lines).find((r) => r["msg"] === "requisicao_concluida");
    expect(completed?.["res"]).toEqual({ statusCode: 204 });
  });
});

describe("invariantes dos handlers", () => {
  function probe(options: { principal: boolean; headers?: Record<string, string> }) {
    const fake = new FakeCriteriaRepository();
    const bare = Fastify({ logger: false, genReqId: () => randomUUID() });
    bare.decorateRequest("principal", null);
    if (options.principal) {
      bare.addHook("onRequest", async (request) => {
        request.principal = TEST_PRINCIPAL;
      });
    }
    const getHandler = createGetCriteriaHandler(fake);
    const putHandler = createPutCriteriaHandler(fake);
    bare.get("/probe", async (request, reply) => getHandler(request, reply));
    bare.put("/probe", async (request, reply) => putHandler(request, profile(), reply));
    const send = (method: "GET" | "PUT") => bare.inject({ method, url: "/probe", headers: options.headers ?? {}, ...(method === "PUT" ? { payload: {} } : {}) });
    return { fake, bare, send };
  }

  test.each<[string, { principal: boolean; headers?: Record<string, string> }]>([
    ["sem principal", { principal: false, headers: { authorization: TEST_AUTHORIZATION } }],
    ["com principal mas sem Authorization", { principal: true }],
    ["com principal e Authorization fora da forma", { principal: true, headers: { authorization: "Bearer não-é-jws" } }],
  ])("%s: 401 e o banco não é tocado", async (_name, options) => {
    const { fake, bare, send } = probe(options);
    for (const method of ["GET", "PUT"] as const) {
      const res = await send(method);
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
    }
    expect([fake.loads, fake.saves]).toEqual([[], []]);
    await bare.close();
  });
});
