// F1-API-04 parte 2 (ADR-017 D6, D7 e §3): POST /v1/analyze com o AnalyzeJob real (peças reais do domínio, router
// com extratores roteirizados, JobFactsCache sobre store em memória) e critérios falsos. Cobre a ordem de defesa
// na borda, o enquadramento SSE, o fim único (`result` ou `error`), o erro sem vazamento, o CORS na resposta SSE,
// o SR-12 com o log capturado e o cliente que desconecta.
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { setImmediate as setImmediatePromise } from "node:timers/promises";

import {
  type AnalysisReport,
  type AnalysisStreamEvent,
  AnalysisStreamEventSchema,
  type AnalyzeJobRequestInput,
  ApiErrorSchema,
  type UserCriteria,
} from "@trampo/contracts";
import { HTTP_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import Fastify from "fastify";
import { afterEach, describe, expect, test } from "vitest";

import type { AnalyzeJob, AnalyzeJobInput } from "../src/application/index.js";
import { DependencyContractError } from "../src/domain/index.js";
import { buildApp } from "../src/presentation/build-app.js";
import { LOG_ALLOWLIST } from "../src/presentation/logging/log-policy.js";
import { ANALYZE_ROUTE, createAnalyzeHandler, createCriteriaPreHandler } from "../src/presentation/routes/analyze.js";
import {
  CLEAN_RAW,
  CLEAN_TEXT,
  EXTRACTOR_VERSION,
  INJECTION_TEXT,
  JobHarness,
  PRESENTIAL_TEXT,
  REQUEST_ID,
  normalizer,
  request as jobRequest,
} from "./application/fakes/analyze-job-harness.js";
import type { FakeClock } from "./application/fakes/fake-clock.js";
import { FakeCriteriaRepository } from "./application/fakes/fake-criteria-repository.js";
import { TEST_AUTHORIZATION, TEST_PRINCIPAL, TEST_TOKEN, fakeVerifier } from "./auth-fakes.js";
import { ELIMINATORY, REQUIRED, criteria, stack } from "./domain/fakes/scoring-fixtures.js";
import { type FakeBehavior, fakeLimits } from "./limit-fakes.js";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const ERRO_INTERNO_MESSAGE = "Erro interno. Tente de novo em instantes.";
const OK = [{ kind: "ok", raw: CLEAN_RAW, latencyMs: 1_500 }] as const;
const REMOTE_ONLY: Partial<UserCriteria> = { workModel: { accepted: ["remoto"], importance: ELIMINATORY } };

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

type Job = Pick<AnalyzeJob, "run">;

interface AppOptions {
  readonly job?: Job;
  readonly harness?: JobHarness;
  readonly criteria?: UserCriteria | null;
  readonly repository?: FakeCriteriaRepository;
  readonly rate?: FakeBehavior;
  readonly quota?: FakeBehavior;
  readonly lines?: string[];
  /** Destino de log que lança nas linhas com estas mensagens (o log nunca derruba a análise). */
  readonly throwOn?: readonly string[];
  readonly authorization?: string;
}

function analysisApp(options: AppOptions = {}) {
  const harness = options.harness ?? new JobHarness({ groq: null });
  const repository = options.repository ?? new FakeCriteriaRepository();
  const chosen = options.criteria === undefined ? criteria() : options.criteria;
  if (chosen !== null) repository.set(TEST_PRINCIPAL.userId, chosen);
  const fakes = fakeLimits({ ...(options.rate === undefined ? {} : { rate: options.rate }), ...(options.quota === undefined ? {} : { quota: options.quota }) });
  const lines = options.lines;
  const throwOn = options.throwOn ?? [];
  const stream = {
    write: (line: string) => {
      lines?.push(line);
      if (throwOn.some((msg) => line.includes(`"msg":"${msg}"`))) throw new Error("destino de log fora do ar");
    },
  };
  const instance = buildApp({
    accessTokenVerifier: fakeVerifier().verifier,
    limits: fakes.limits,
    corsAllowedOrigins: [ORIGIN],
    logger: lines === undefined && throwOn.length === 0 ? false : { level: "trace", stream },
    analysis: { job: options.job ?? harness.job, criteria: repository },
  });
  app = instance;
  return { app: instance, harness, repository, rate: fakes.rate, quota: fakes.quota };
}

function body(over: { text?: string; title?: string | null; mode?: "auto" | "aprofundada"; requestId?: string } = {}): AnalyzeJobRequestInput {
  return {
    schemaVersion: 1,
    requestId: over.requestId ?? REQUEST_ID,
    source: { platform: "gupy", extractorVersion: "gupy-1" },
    job: { titleHint: over.title === undefined ? "Desenvolvedor Backend Pleno" : over.title, text: over.text ?? CLEAN_TEXT, clientTruncated: false },
    mode: over.mode ?? "auto",
  };
}

function post(instance: ReturnType<typeof buildApp>, payload: unknown, headers: Record<string, string> = {}) {
  return instance.inject({
    method: "POST",
    // O literal do contrato, não a constante: renomear a rota tem de quebrar o teste.
    url: "/v1/analyze",
    headers: { authorization: TEST_AUTHORIZATION, "content-type": "application/json", ...headers },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

/**
 * Parser estrito do SSE: as linhas são cortadas em CR, LF e CRLF (os três fins de linha do SSE). Cada evento tem
 * exatamente duas linhas, `event: <type>` e `data: <json>`, e o JSON passa no AnalysisStreamEventSchema.
 */
function parseSse(raw: string): AnalysisStreamEvent[] {
  expect(raw.endsWith("\n\n")).toBe(true);
  return raw
    .slice(0, -2)
    .split("\n\n")
    .map((block) => {
      const lines = block.split(/\r\n|\r|\n/);
      expect(lines).toHaveLength(2);
      const [eventLine = "", dataLine = ""] = lines;
      expect(dataLine.startsWith("data: ")).toBe(true);
      const event = AnalysisStreamEventSchema.parse(JSON.parse(dataLine.slice("data: ".length)));
      expect(eventLine).toBe(`event: ${event.type}`);
      return event;
    });
}

const stagesOf = (events: readonly AnalysisStreamEvent[]) =>
  events.flatMap((event) => (event.type === "stage" ? [event.stage] : []));

/** Exatamente um evento terminal, e ele é o último. */
function terminalOf(events: readonly AnalysisStreamEvent[]): Exclude<AnalysisStreamEvent, { type: "stage" }> {
  const terminals = events.filter((event) => event.type !== "stage");
  expect(terminals).toHaveLength(1);
  const last = events.at(-1);
  expect(last).toBe(terminals[0]);
  return last as Exclude<AnalysisStreamEvent, { type: "stage" }>;
}

function reportOf(events: readonly AnalysisStreamEvent[]): AnalysisReport {
  const terminal = terminalOf(events);
  if (terminal.type !== "result") throw new Error(`esperava result, veio ${terminal.type}`);
  return terminal.report;
}

/**
 * Anda o relógio falso enquanto o inject trabalha. O `run` do FakeClock acusa impasse se a promessa não resolve
 * num único setImmediate sem timer pendente; o inject leva vários, então o impasse aqui só quer dizer "ainda não".
 */
async function drive<T>(clock: FakeClock, work: PromiseLike<T>): Promise<T> {
  const promise = Promise.resolve(work);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      return await clock.run(promise);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("impasse")) throw error;
      await setImmediatePromise();
    }
  }
  throw new Error("o inject não terminou");
}

const records = (lines: readonly string[]) => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const messages = (lines: readonly string[]) => records(lines).map((r) => r["msg"]);

/** Um relatório válido produzido pelo AnalyzeJob real, para os jobs falsos. */
async function validReport(): Promise<AnalysisReport> {
  return (await new JobHarness({ groq: null }).analyze(jobRequest(), criteria())).report;
}

describe("registro (ADR-017 D7)", () => {
  test("sem a opção `analysis`, POST /v1/analyze é rota inexistente: 401 sem token, 404 com token", async () => {
    const bare = buildApp({ accessTokenVerifier: fakeVerifier().verifier, limits: fakeLimits().limits, logger: false });
    app = bare;
    const withToken = await post(bare, body());
    expect(withToken.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(withToken.json()).code).toBe("PROIBIDO");
    const anonymous = await bare.inject({ method: "POST", url: ANALYZE_ROUTE, headers: { "content-type": "application/json" }, payload: "{}" });
    expect(anonymous.statusCode).toBe(401);
  });

  test("com a opção: a rota declara a classe `analise` de rate limit", async () => {
    const { app, rate } = analysisApp();
    await post(app, body());
    expect(rate.calls.map((call) => call.rateClass)).toEqual(["analise"]);
  });
});

describe("stream SSE (ADR-017 D6)", () => {
  test("R4 sem adapter: 200, cabeçalhos do stream, estágios na ordem e um result de fallback", async () => {
    const { app, repository, quota } = analysisApp();
    const res = await post(app, body());
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    expect(res.headers["content-length"]).toBeUndefined();
    const events = parseSse(res.body);
    expect(stagesOf(events)).toEqual(["recebido", "normalizando", "triagem_deterministica", "consultando_cache", "pontuando"]);
    const report = reportOf(events);
    expect(report).toMatchObject({ requestId: REQUEST_ID, decisionPath: "fallback_deterministico" });
    expect(report.warnings).toContain("analise_degradada");
    expect(repository.loads).toEqual([TEST_PRINCIPAL.userId]);
    expect(repository.tokens).toEqual([TEST_TOKEN]);
    expect(quota.calls).toEqual([{ userId: TEST_PRINCIPAL.userId, requestId: REQUEST_ID }]);
  });

  test("R4 com extração: estágio extraindo_fatos e result `extracao_llm`; a segunda vem do cache", async () => {
    const harness = new JobHarness({ groq: OK });
    const { app } = analysisApp({ harness });
    const first = parseSse((await drive(harness.clock, (post(app, body())))).body);
    expect(stagesOf(first)).toEqual(["recebido", "normalizando", "triagem_deterministica", "consultando_cache", "extraindo_fatos", "pontuando"]);
    expect(reportOf(first).decisionPath).toBe("extracao_llm");
    const second = parseSse((await drive(harness.clock, (post(app, body())))).body);
    expect(reportOf(second).decisionPath).toBe("cache_jobfacts");
    expect(harness.payloads).toHaveLength(1);
  });

  test("R1: triagem determinística, sem LLM", async () => {
    const harness = new JobHarness({ groq: OK });
    const { app } = analysisApp({ harness, criteria: criteria(REMOTE_ONLY) });
    const events = parseSse((await drive(harness.clock, (post(app, body({ text: PRESENTIAL_TEXT }))))).body);
    expect(stagesOf(events)).toEqual(["recebido", "normalizando", "triagem_deterministica", "pontuando"]);
    expect(reportOf(events).decisionPath).toBe("triagem_deterministica");
    expect(harness.payloads).toEqual([]);
  });

  test("R2 em modo aprofundada: fallback, sem LLM", async () => {
    const harness = new JobHarness({ groq: OK });
    const { app } = analysisApp({ harness });
    const events = parseSse((await drive(harness.clock, (post(app, body({ text: INJECTION_TEXT, mode: "aprofundada" }))))).body);
    expect(reportOf(events)).toMatchObject({ decisionPath: "fallback_deterministico" });
    expect(harness.payloads).toEqual([]);
  });

  test("CORS e vary também valem na resposta SSE (sem hijack)", async () => {
    const { app } = analysisApp();
    const res = await post(app, body(), { origin: ORIGIN });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(String(res.headers["vary"])).toMatch(/\bOrigin\b/);
    expect(reportOf(parseSse(res.body)).decisionPath).toBe("fallback_deterministico");
  });

  test("cache_corrompido vai ao log pelo catálogo e a análise segue", async () => {
    const lines: string[] = [];
    const harness = new JobHarness({ groq: null });
    harness.store.values.set(`jobfacts:v1:${EXTRACTOR_VERSION}:${normalizer.normalize(CLEAN_TEXT).textHash}`, "{lixo");
    const { app } = analysisApp({ harness, lines });
    const events = parseSse((await post(app, body())).body);
    expect(reportOf(events).decisionPath).toBe("fallback_deterministico");
    expect(records(lines).filter((r) => r["level"] === 40)).toEqual([expect.objectContaining({ msg: "cache_corrompido" })]);
  });
});

describe("enquadramento SSE ([APPSEC] §3)", () => {
  const HOSTILE = ["\r", "\n", "\r\n", " ", " ", "\nevent: result\n", "\r\ndata: {\"type\":\"result\"}\r\n", "\n\nevent: error\ndata: x\n\n", "id: 1\nretry: 0"];

  test.each(HOSTILE.map((piece) => [JSON.stringify(piece), piece] as const))(
    "título e texto com %s não criam evento extra",
    async (_name, piece) => {
      const { app } = analysisApp();
      const title = `Desenvolvedor ${piece} Backend`;
      const text = `${CLEAN_TEXT}\n\nevent: result${piece}data: {"type":"error"}${piece}\n\nid: 7${piece}retry: 1\n${piece}fim`;
      const res = await post(app, body({ title, text }));
      expect(res.statusCode).toBe(200);
      const events = parseSse(res.body);
      expect(events).toHaveLength(6);
      expect(stagesOf(events)).toEqual(["recebido", "normalizando", "triagem_deterministica", "consultando_cache", "pontuando"]);
      reportOf(events);
    },
  );
});

describe("erro depois que o stream abre: um único `error` ERRO_INTERNO, sem vazamento", () => {
  const SECRET = "segredo-do-erro-interno-k9";
  const failures: readonly [string, (input: AnalyzeJobInput) => Promise<AnalysisReport>][] = [
    ["rejeição com Error", async (input) => {
      input.onStage("recebido", 0);
      throw new Error(SECRET);
    }],
    ["DependencyContractError", async (input) => {
      input.onStage("recebido", 0);
      throw new DependencyContractError(SECRET);
    }],
    ["RangeError", async () => {
      throw new RangeError(SECRET);
    }],
    ["valor que não é Error", async () => {
      // O teste prova que qualquer valor lançado vira ERRO_INTERNO.
      throw SECRET;
    }],
    ["lança de forma síncrona", (input) => {
      input.onStage("recebido", 0);
      throw new TypeError(SECRET);
    }],
    ["relatório fora do contrato", async () => ({ segredo: SECRET }) as unknown as AnalysisReport],
  ];

  test.each(failures)("%s", async (_name, run) => {
    const lines: string[] = [];
    const { app } = analysisApp({ job: { run }, lines });
    const res = await post(app, body());
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const terminal = terminalOf(events);
    expect(terminal).toEqual({
      type: "error",
      error: { code: "ERRO_INTERNO", message: ERRO_INTERNO_MESSAGE, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), retryAfterSeconds: null },
    });
    expect(res.body).not.toContain(SECRET);
    expect(lines.join("")).not.toContain(SECRET);
    const errors = records(lines).filter((r) => r["msg"] === "erro_interno");
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0]?.["err"] as object).sort()).toEqual(["type"]);
  });

  test("o requestId do erro é o id do servidor, o mesmo do log", async () => {
    const lines: string[] = [];
    const { app } = analysisApp({ job: { run: () => Promise.reject(new Error(SECRET)) }, lines });
    const terminal = terminalOf(parseSse((await post(app, body())).body));
    const reqIds = new Set(records(lines).map((r) => r["reqId"]));
    expect(terminal.type === "error" && reqIds.has(terminal.error.requestId)).toBe(true);
  });

  test("autovalidação do AnalyzeJob: composer que devolve relatório inválido dá error, nunca result", async () => {
    const harness = new JobHarness({
      groq: null,
      override: { composer: { compose: () => ({ segredo: SECRET }) as unknown as AnalysisReport } },
    });
    const lines: string[] = [];
    const { app } = analysisApp({ harness, lines });
    const events = parseSse((await post(app, body())).body);
    expect(terminalOf(events).type).toBe("error");
    expect(records(lines).find((r) => r["msg"] === "erro_interno")?.["err"]).toEqual({ type: "DependencyContractError" });
  });
});

describe("onStage e onAlert nunca lançam", () => {
  test("estágio fora do contrato é descartado e vai ao log; a análise termina com result", async () => {
    const report = await validReport();
    const lines: string[] = [];
    const run = async (input: AnalyzeJobInput) => {
      input.onStage("recebido", 0);
      input.onStage("normalizando", 120_001);
      input.onStage("pontuando", 5);
      return report;
    };
    const { app } = analysisApp({ job: { run }, lines });
    const events = parseSse((await post(app, body())).body);
    expect(stagesOf(events)).toEqual(["recebido", "pontuando"]);
    expect(reportOf(events)).toEqual(report);
    expect(records(lines).find((r) => r["msg"] === "erro_interno")?.["err"]).toEqual({ type: "SseEventContractError" });
  });

  test("log que lança no alerta, no estágio inválido e no erro: o stream fecha igual", async () => {
    const report = await validReport();
    const throwOn = ["cache_corrompido", "erro_interno"];
    const ok = async (input: AnalyzeJobInput) => {
      input.onAlert("cache_corrompido");
      input.onStage("recebido", -1);
      return report;
    };
    const okApp = analysisApp({ job: { run: ok }, throwOn });
    expect(reportOf(parseSse((await post(okApp.app, body())).body))).toEqual(report);
    await okApp.app.close();

    const failing = analysisApp({ job: { run: () => Promise.reject(new Error("x")) }, throwOn });
    expect(terminalOf(parseSse((await post(failing.app, body())).body)).type).toBe("error");
  });

  test("estágio chamado depois do fim é descartado: um só terminal", async () => {
    const report = await validReport();
    let late: (() => void) | undefined;
    const run = async (input: AnalyzeJobInput) => {
      late = () => input.onStage("pontuando", 1);
      return report;
    };
    const { app } = analysisApp({ job: { run } });
    const res = await post(app, body());
    late?.();
    const events = parseSse(res.body);
    expect(events).toHaveLength(1);
    expect(reportOf(events)).toEqual(report);
  });
});

describe("ordem de defesa na borda ([APPSEC] §3)", () => {
  test("sem token: 401 sem ler o corpo (JSON quebrado não vira 400) e nada mais roda", async () => {
    const { app, repository, quota, rate } = analysisApp();
    const res = await app.inject({ method: "POST", url: ANALYZE_ROUTE, headers: { "content-type": "application/json" }, payload: "{quebrado" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect([repository.loads, quota.calls, rate.calls]).toEqual([[], [], []]);
  });

  test("corpo acima de 64 KiB: 413 sem parse, sem critérios e sem cota", async () => {
    const { app, repository, quota } = analysisApp();
    const res = await post(app, `{"x":"${"a".repeat(HTTP_BODY_MAX_BYTES)}"}`);
    expect(res.statusCode).toBe(413);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("PAYLOAD_GRANDE_DEMAIS");
    expect([repository.loads, quota.calls]).toEqual([[], []]);
  });

  test("rate limit antes dos critérios: 429 LIMITE_DE_TAXA sem ler o banco", async () => {
    const { app, repository, quota } = analysisApp({ rate: { kind: "valor", value: { ok: false, reason: "limite_excedido", retryAfterSeconds: 30 } } });
    const res = await post(app, body());
    expect(res.statusCode).toBe(429);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("LIMITE_DE_TAXA");
    expect([repository.loads, quota.calls]).toEqual([[], []]);
  });

  test.each<[string, string, number]>([
    ["curto", "vaga curta", 422],
    ["só espaços", " ".repeat(500), 422],
    ["vazio", "", 422],
  ])("texto %s: 422 TEXTO_CURTO_DEMAIS, antes dos critérios e da cota", async (_name, text, status) => {
    const { app, repository, quota } = analysisApp();
    const res = await post(app, body({ text }));
    expect(res.statusCode).toBe(status);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("TEXTO_CURTO_DEMAIS");
    expect([repository.loads, quota.calls]).toEqual([[], []]);
  });

  test.each<[string, unknown]>([
    ["texto curto e outro erro juntos", { ...body({ text: "curto" }), mode: "rapido" }],
    ["texto que não é string", { ...body(), job: { ...body().job, text: 42 } }],
    ["requestId fora do padrão", body({ requestId: "nao-e-uuid" })],
    ["campo extra", { ...body(), userId: TEST_PRINCIPAL.userId }],
    ["título longo demais", body({ title: "t".repeat(1_000) })],
    ["corpo que não é objeto", ["x"]],
  ])("%s: 400 PAYLOAD_INVALIDO, antes dos critérios e da cota", async (_name, payload) => {
    const { app, repository, quota } = analysisApp();
    const res = await post(app, payload);
    expect(res.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("PAYLOAD_INVALIDO");
    expect([repository.loads, quota.calls]).toEqual([[], []]);
  });

  test("critérios não configurados: 409, e a cota não é gasta", async () => {
    const { app, repository, quota } = analysisApp({ criteria: null });
    const res = await post(app, body());
    expect(res.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("CRITERIOS_NAO_CONFIGURADOS");
    expect(repository.loads).toEqual([TEST_PRINCIPAL.userId]);
    expect(quota.calls).toEqual([]);
  });

  test("banco de critérios fora do ar: 503, cota intacta e só `criterios_indisponiveis` no log (SR-12)", async () => {
    const lines: string[] = [];
    const repository = new FakeCriteriaRepository();
    repository.unavailable = true;
    const { app, quota } = analysisApp({ repository, lines });
    const res = await post(app, body());
    expect(res.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("SERVICO_INDISPONIVEL");
    expect(quota.calls).toEqual([]);
    expect(records(lines).filter((r) => r["level"] === 40)).toEqual([expect.objectContaining({ msg: "criterios_indisponiveis" })]);
    for (const leak of [TEST_PRINCIPAL.userId, REQUEST_ID, TEST_TOKEN]) expect(lines.join("")).not.toContain(leak);
  });

  test.each<[string, () => Promise<never>]>([
    ["rejeita", () => Promise.reject(new Error("banco"))],
    ["lança", () => {
      throw new Error("banco");
    }],
  ])("porta de critérios que %s: 503 (falha fechado), cota intacta", async (_name, load) => {
    const repository = new FakeCriteriaRepository();
    repository.load = load;
    const { app, quota } = analysisApp({ repository });
    const res = await post(app, body());
    expect(res.statusCode).toBe(503);
    expect(quota.calls).toEqual([]);
  });

  test("log que lança no `criterios_indisponiveis`: ainda 503", async () => {
    const repository = new FakeCriteriaRepository();
    repository.unavailable = true;
    const { app } = analysisApp({ repository, throwOn: ["criterios_indisponiveis"] });
    expect((await post(app, body())).statusCode).toBe(503);
  });

  test("critérios antes da cota: cota esgotada responde 429 depois de ler os critérios, sem rodar a análise", async () => {
    let runs = 0;
    const { app, repository } = analysisApp({
      job: { run: () => ((runs += 1), Promise.reject(new Error("não devia rodar"))) },
      quota: { kind: "valor", value: { ok: false, reason: "esgotada", retryAfterSeconds: 3_600 } },
    });
    const res = await post(app, body());
    expect(res.statusCode).toBe(429);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("COTA_DIARIA_ESGOTADA");
    expect(repository.loads).toEqual([TEST_PRINCIPAL.userId]);
    expect(runs).toBe(0);
  });

  test("cota indisponível: 503 sem rodar a análise", async () => {
    let runs = 0;
    const { app } = analysisApp({ job: { run: () => ((runs += 1), Promise.reject(new Error("x"))) }, quota: { kind: "rejeita" } });
    expect((await post(app, body())).statusCode).toBe(503);
    expect(runs).toBe(0);
  });

  test("invariante: preHandler dos critérios sem principal responde 401 e não lê o banco", async () => {
    const repository = new FakeCriteriaRepository();
    const bare = Fastify({ logger: false, genReqId: () => randomUUID() });
    bare.decorateRequest("principal", null);
    bare.post("/probe", { preHandler: createCriteriaPreHandler(repository, new WeakMap()) }, async () => ({ ok: true }));
    const res = await bare.inject({ method: "POST", url: "/probe", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(repository.loads).toEqual([]);
    await bare.close();
  });

  test.each([
    ["sem Authorization", {}],
    ["Authorization fora da forma", { authorization: "Bearer não-é-jws" }],
  ])("invariante: preHandler dos critérios com principal mas %s responde 401 e não lê o banco (ADR-018 D6)", async (_name, headers) => {
    const repository = new FakeCriteriaRepository();
    const bare = Fastify({ logger: false, genReqId: () => randomUUID() });
    bare.decorateRequest("principal", null);
    bare.addHook("onRequest", async (request) => {
      request.principal = TEST_PRINCIPAL;
    });
    bare.post("/probe", { preHandler: createCriteriaPreHandler(repository, new WeakMap()) }, async () => ({ ok: true }));
    const res = await bare.inject({ method: "POST", url: "/probe", headers, payload: {} });
    expect(res.statusCode).toBe(401);
    expect(repository.loads).toEqual([]);
    await bare.close();
  });

  test("invariante: handler sem o preHandler dos critérios falha fechado (500 ERRO_INTERNO, sem stream)", async () => {
    let runs = 0;
    const instance = buildApp({ accessTokenVerifier: fakeVerifier().verifier, limits: fakeLimits().limits, logger: false });
    const handler = createAnalyzeHandler({ run: () => ((runs += 1), Promise.reject(new Error("x"))) }, new WeakMap());
    instance.post("/probe/sem-criterios", async (request, reply) => handler(request, jobRequest(), reply));
    app = instance;
    const res = await instance.inject({ method: "POST", url: "/probe/sem-criterios", headers: { authorization: TEST_AUTHORIZATION, "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(500);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("ERRO_INTERNO");
    expect(runs).toBe(0);
  });
});

describe("SR-12 com o stream capturado ([APPSEC] §3)", () => {
  const CANARY = {
    text: "textocanariodavaga",
    title: "titulocanario",
    tech: "Zqxcanarytech",
    city: "Cidadecanaria",
    note: "nota-canaria-do-perfil",
    token: "canario-token-a1.canario-token-b2.canario-token-c3",
  } as const;
  const profile = criteria({
    stack: stack({ mustHave: [CANARY.tech] }),
    location: { acceptedUfs: ["PE"], acceptedCities: [CANARY.city], importance: REQUIRED },
    notes: CANARY.note,
  });

  test.each<[string, () => JobHarness, string]>([
    ["fallback", () => new JobHarness({ groq: null }), CLEAN_TEXT],
    ["extração", () => new JobHarness({ groq: OK }), CLEAN_TEXT],
    ["R2", () => new JobHarness({ groq: OK }), INJECTION_TEXT],
  ])("%s: nenhum canário no log nem na telemetria; o stream não ecoa o perfil (SR-11)", async (_name, make, text) => {
    const lines: string[] = [];
    const harness = make();
    const { app } = analysisApp({ harness, criteria: profile, lines });
    const res = await drive(harness.clock,
      Promise.resolve(post(app, body({ text: `${text}\n\n${CANARY.text}`, title: `Dev ${CANARY.title}` }), { authorization: `Bearer ${CANARY.token}` })),
    );
    expect(res.statusCode).toBe(200);
    reportOf(parseSse(res.body));
    const logged = lines.join("");
    for (const canary of Object.values(CANARY)) expect(logged).not.toContain(canary);
    for (const canary of [CANARY.text, CANARY.title, CANARY.tech, CANARY.city, CANARY.note]) {
      expect(JSON.stringify(harness.telemetry.events)).not.toContain(canary);
    }
    for (const canary of [CANARY.tech, CANARY.city, CANARY.note, CANARY.token]) expect(res.body).not.toContain(canary);
    for (const record of records(lines)) {
      for (const key of Object.keys(record)) expect(LOG_ALLOWLIST.top).toContain(key);
    }
    expect(messages(lines)).toEqual(["requisicao_recebida", "requisicao_concluida"]);
  });
});

describe("cliente que desconecta (socket real)", () => {
  test("o stream para de escrever, a análise termina sem erro e o servidor segue respondendo", async () => {
    const report = await validReport();
    const lines: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const run = async (input: AnalyzeJobInput) => {
      input.onStage("recebido", 0);
      await gate;
      input.onStage("pontuando", 5);
      setImmediate(finished);
      return report;
    };
    const { app } = analysisApp({ job: { run }, lines });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("sem porta");

    const firstChunk = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: address.port, method: "POST", path: ANALYZE_ROUTE, headers: { authorization: TEST_AUTHORIZATION, "content-type": "application/json" } },
        (res) => {
          res.setEncoding("utf8");
          res.once("data", (chunk: string) => {
            resolve(chunk);
            req.destroy();
          });
        },
      );
      req.on("error", () => undefined);
      req.on("close", () => undefined);
      setTimeout(() => {
        reject(new Error("sem primeiro evento"));
      }, 4_000);
      req.end(JSON.stringify(body()));
    });
    expect(firstChunk.startsWith("event: stage\n")).toBe(true);

    // Espera o servidor perceber o fechamento antes de liberar a análise.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await done;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages(lines)).not.toContain("erro_interno");
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
  });
});
