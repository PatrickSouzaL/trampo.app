// F1-API-06 fatia 3 (ADR-031 D1 e §3, condições 1, 3 e 14): o POST /v1/analyze grava a análise só depois de o
// `result` sair no stream, com o sujeito do preHandler dos critérios, sem `await` (o fim do stream não espera) e sem
// deixar o gravador mudar nada do que o cliente recebe. A falha da gravação vira só `analise_gravacao_falhou` no log,
// sem campo. Com as peças reais (o AnalysisRecorder, o SupabaseAnalysisLog e o cliente do PostgREST em socket real),
// nenhum canário do texto, do título ou do requestId chega ao corpo do insert.
import { request as httpRequest } from "node:http";
import { setImmediate as setImmediatePromise } from "node:timers/promises";

import { type AnalysisReport, type AnalysisStreamEvent, AnalysisStreamEventSchema, type AnalyzeJobRequestInput } from "@trampo/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AnalysisRecorder, type AnalysisLogOutcome, type AnalysisLogSubject, type AnalyzeJobInput } from "../src/application/index.js";
import { createSupabaseAnalysisLog } from "../src/infrastructure/persistence/supabase-analysis-log.js";
import { createPostgrestUserClient } from "../src/infrastructure/supabase/postgrest-user-client.js";
import { InMemoryTelemetry } from "../src/infrastructure/telemetry/in-memory-telemetry.js";
import { systemClock } from "../src/infrastructure/time/system-clock.js";
import { buildApp } from "../src/presentation/build-app.js";
import { LOG_ALLOWLIST, LOG_MESSAGES } from "../src/presentation/logging/log-policy.js";
import { ANALYZE_ROUTE, type AnalysisRouteOptions } from "../src/presentation/routes/analyze.js";
import { CLEAN_TEXT, JobHarness, REQUEST_ID, request as jobRequest } from "./application/fakes/analyze-job-harness.js";
import { FakeCriteriaRepository } from "./application/fakes/fake-criteria-repository.js";
import { TEST_AUTHORIZATION, TEST_PRINCIPAL, TEST_TOKEN, fakeVerifier } from "./auth-fakes.js";
import { criteria } from "./domain/fakes/scoring-fixtures.js";
import { startFakePostgrest, type FakePostgrest } from "./infrastructure/fakes/fake-postgrest.js";
import { fakeLimits } from "./limit-fakes.js";
import { HAPPY_PATH_TIMEOUT_MS } from "./support/socket-deadlines.js";

const PUBLISHABLE = "sb_publishable_gravacao-teste";

let app: ReturnType<typeof buildApp> | undefined;
let postgrest: FakePostgrest | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  await postgrest?.close();
  postgrest = undefined;
});

type Recorder = NonNullable<AnalysisRouteOptions["recorder"]>;

interface RecordCall {
  readonly subject: AnalysisLogSubject;
  readonly report: AnalysisReport;
}

/** Gravador falso: registra cada chamada e responde pelo comportamento dado (pode lançar, rejeitar ou travar). */
function fakeRecorder(behavior: () => Promise<AnalysisLogOutcome> = async () => "gravada") {
  const calls: RecordCall[] = [];
  const recorder: Recorder = {
    record(subject, report) {
      calls.push({ subject, report });
      return behavior();
    },
  };
  return { recorder, calls };
}

function recordApp(options: { recorder?: Recorder | null; job?: AnalysisRouteOptions["job"]; lines?: string[] } = {}) {
  const repository = new FakeCriteriaRepository();
  repository.set(TEST_PRINCIPAL.userId, criteria());
  const lines = options.lines;
  const instance = buildApp({
    accessTokenVerifier: fakeVerifier().verifier,
    limits: fakeLimits().limits,
    logger: lines === undefined ? false : { level: "trace", stream: { write: (line: string) => lines.push(line) } },
    analysis: {
      job: options.job ?? new JobHarness({ groq: null }).job,
      criteria: repository,
      ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
    },
  });
  app = instance;
  return instance;
}

function body(over: { text?: string; title?: string; requestId?: string } = {}): AnalyzeJobRequestInput {
  return {
    schemaVersion: 1,
    requestId: over.requestId ?? REQUEST_ID,
    source: { platform: "gupy", extractorVersion: "gupy-1" },
    job: { titleHint: over.title ?? "Desenvolvedor Backend Pleno", text: over.text ?? CLEAN_TEXT, clientTruncated: false },
    mode: "auto",
  };
}

const post = (instance: ReturnType<typeof buildApp>, payload: AnalyzeJobRequestInput = body()) =>
  instance.inject({
    method: "POST",
    url: "/v1/analyze",
    headers: { authorization: TEST_AUTHORIZATION, "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });

function eventsOf(raw: string): AnalysisStreamEvent[] {
  return raw
    .trim()
    .split("\n\n")
    .map((block) => AnalysisStreamEventSchema.parse(JSON.parse(block.split("\n")[1]?.slice("data: ".length) ?? "")));
}

function reportOf(raw: string): AnalysisReport {
  const terminal = eventsOf(raw).at(-1);
  if (terminal?.type !== "result") throw new Error("esperava result");
  return terminal.report;
}

const records = (lines: readonly string[]) => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const messages = (lines: readonly string[]) => records(lines).map((record) => record["msg"]);

/** Deixa as continuações do `void record(...)` rodarem. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await setImmediatePromise();
}

describe("registro (ADR-031 D1)", () => {
  test("o catálogo do log tem `analise_gravacao_falhou`", () => {
    expect(LOG_MESSAGES).toContain("analise_gravacao_falhou");
  });

  test("sem a opção `recorder`, ou com `null`: a análise segue igual e nada é gravado", async () => {
    for (const recorder of [undefined, null]) {
      const instance = recordApp(recorder === undefined ? {} : { recorder });
      const res = await post(instance);
      expect(res.statusCode).toBe(200);
      expect(reportOf(res.body).decisionPath).toBe("fallback_deterministico");
      await instance.close();
    }
    app = undefined;
  });
});

describe("grava só a análise que saiu (condições 1 e 3)", () => {
  test("depois do `result`, uma vez, com o sujeito do preHandler e o mesmo relatório do stream", async () => {
    const { recorder, calls } = fakeRecorder();
    const res = await post(recordApp({ recorder }));
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toStrictEqual({ userId: TEST_PRINCIPAL.userId, accessToken: TEST_TOKEN });
    expect(calls[0]?.report).toEqual(reportOf(res.body));
  });

  test("o terminal `error` não grava", async () => {
    const { recorder, calls } = fakeRecorder();
    const res = await post(recordApp({ recorder, job: { run: () => Promise.reject(new Error("x")) } }));
    expect(eventsOf(res.body).at(-1)?.type).toBe("error");
    await settle();
    expect(calls).toHaveLength(0);
  });

  test("o gravador que nunca responde não atrasa o fim do stream (sem `await` antes do `end`)", async () => {
    const { recorder, calls } = fakeRecorder(() => new Promise<AnalysisLogOutcome>(() => undefined));
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("o stream esperou o gravador")), 3_000));
    const res = await Promise.race([post(recordApp({ recorder })), timeout]);
    expect(res.statusCode).toBe(200);
    expect(eventsOf(res.body).at(-1)?.type).toBe("result");
    expect(calls).toHaveLength(1);
  });

  test("cliente que saiu antes do `result` (socket real): nada é gravado", async () => {
    const { recorder, calls } = fakeRecorder();
    const report = (await new JobHarness({ groq: null }).analyze(jobRequest(), criteria())).report;
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
      setImmediate(finished);
      return report;
    };
    const instance = recordApp({ recorder, job: { run } });
    await instance.listen({ host: "127.0.0.1", port: 0 });
    const address = instance.server.address();
    if (address === null || typeof address === "string") throw new Error("sem porta");
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: address.port, method: "POST", path: ANALYZE_ROUTE, headers: { authorization: TEST_AUTHORIZATION, "content-type": "application/json" } },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", () => undefined);
      setTimeout(() => reject(new Error("sem primeiro evento")), 4_000);
      req.end(JSON.stringify(body()));
    });
    // O servidor percebe o fechamento antes de a análise terminar.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await done;
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe("a falha da gravação não muda o stream e vai ao log sem campo (condições 3 e 14)", () => {
  test.each<[string, () => Promise<AnalysisLogOutcome>]>([
    ["lança de forma síncrona", () => {
      throw new Error("CANARIO-ERRO");
    }],
    ["rejeita", () => Promise.reject(new Error("CANARIO-ERRO"))],
    ["devolve lixo", async () => "CANARIO-LIXO" as AnalysisLogOutcome],
    ["devolve undefined", async () => undefined as unknown as AnalysisLogOutcome],
    ["recusada", async () => "recusada"],
    ["limite", async () => "limite"],
    ["indisponivel", async () => "indisponivel"],
  ])("gravador que %s", async (_name, behavior) => {
    const lines: string[] = [];
    const { recorder } = fakeRecorder(behavior);
    const res = await post(recordApp({ recorder, lines }));
    expect(res.statusCode).toBe(200);
    const events = eventsOf(res.body);
    expect(events.at(-1)?.type).toBe("result");
    expect(events.filter((event) => event.type !== "stage")).toHaveLength(1);
    await vi.waitFor(() => expect(messages(lines)).toContain("analise_gravacao_falhou"));
    expect(messages(lines).filter((message) => message === "analise_gravacao_falhou")).toHaveLength(1);
    const warn = records(lines).find((record) => record["msg"] === "analise_gravacao_falhou");
    for (const key of Object.keys(warn ?? {})) expect(LOG_ALLOWLIST.top).toContain(key);
    const logged = lines.join("");
    const report = reportOf(res.body);
    for (const leak of [TEST_PRINCIPAL.userId, TEST_TOKEN, report.analysisId, report.verdict, "CANARIO"]) expect(logged).not.toContain(leak);
  });

  test("gravada: nenhuma linha de log a mais", async () => {
    const lines: string[] = [];
    const { recorder } = fakeRecorder();
    await post(recordApp({ recorder, lines }));
    await settle();
    expect(messages(lines)).toEqual(["requisicao_recebida", "requisicao_concluida"]);
  });
});

describe("com as peças reais, em socket real contra o PostgREST simulado (condições 1, 2 e 14)", () => {
  const CANARY = { text: "textocanariodagravacao", title: "titulocanariogravado", requestId: "c0ffee00-1d2e-4f3a-8b4c-5d6e7f8a9b0c" } as const;

  async function realApp(lines?: string[]) {
    postgrest = await startFakePostgrest(PUBLISHABLE);
    postgrest.sessions.set(TEST_TOKEN, TEST_PRINCIPAL.userId);
    const telemetry = new InMemoryTelemetry();
    const recorder = new AnalysisRecorder({
      log: createSupabaseAnalysisLog({ client: createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: HAPPY_PATH_TIMEOUT_MS }) }),
      clock: systemClock,
      telemetry,
    });
    return { instance: recordApp({ recorder, ...(lines === undefined ? {} : { lines }) }), telemetry };
  }

  test("a linha mínima chega ao PostgREST com o id do servidor e o dono do token, sem canário", async () => {
    const { instance, telemetry } = await realApp();
    const res = await post(instance, body({ text: `${CLEAN_TEXT}\n\n${CANARY.text}`, title: `Dev ${CANARY.title}`, requestId: CANARY.requestId }));
    const report = reportOf(res.body);
    await vi.waitFor(() => expect(postgrest?.analyses).toHaveLength(1));
    const insert = postgrest?.requests.find((sent) => sent.method === "POST");
    expect(insert?.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(JSON.parse(insert?.body ?? "{}")).toStrictEqual({
      id: report.analysisId,
      user_id: TEST_PRINCIPAL.userId,
      decision_path: report.decisionPath,
      verdict: report.verdict,
      score: report.score,
    });
    expect(report.analysisId).not.toBe(CANARY.requestId);
    for (const canary of Object.values(CANARY)) expect(insert?.body).not.toContain(canary);
    await vi.waitFor(() => expect(telemetry.seriesKeys()).toContain('analysis_record_total[["outcome","gravada"]]'));
  });

  test("PostgREST fora do ar: o stream sai igual, a telemetria conta `indisponivel` e o log só tem o aviso", async () => {
    const lines: string[] = [];
    const { instance, telemetry } = await realApp(lines);
    if (postgrest !== undefined) postgrest.mode = { kind: "status", status: 503 };
    const res = await post(instance);
    expect(eventsOf(res.body).at(-1)?.type).toBe("result");
    await vi.waitFor(() => expect(messages(lines)).toContain("analise_gravacao_falhou"));
    expect(telemetry.seriesKeys()).toContain('analysis_record_total[["outcome","indisponivel"]]');
    expect(postgrest?.analyses).toHaveLength(0);
  });
});
