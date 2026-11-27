// F1-API-06 fatia 4 (ADR-031 D4; condições 9, 10, 12 e 14 do [APPSEC]): POST /v1/analyses/:analysisId/feedback. O
// dono vem só do principal; o parâmetro e o corpo passam pelos schemas do contrato (400 sem tocar no banco); 413 acima
// de 256 bytes sem parse; 204 na gravação; 404 PROIBIDO igual ao da rota inexistente para a análise que não existe ou
// é de outro dono (sem oráculo); 503 para o resto, com `feedback_gravacao_indisponivel` sem campo; `no-store` sempre.
import { ANALYSIS_FEEDBACK_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import { ApiErrorSchema } from "@trampo/contracts/api";
import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { afterEach, describe, expect, test } from "vitest";

import { AnalysisFeedbackService, type AnalysisFeedbackEntry, type AnalysisLogSubject, type FeedbackSaveOutcome } from "../src/application/index.js";
import { createSupabaseAnalysisFeedbackStore } from "../src/infrastructure/persistence/supabase-analysis-feedback.js";
import { createPostgrestUserClient } from "../src/infrastructure/supabase/postgrest-user-client.js";
import { InMemoryTelemetry } from "../src/infrastructure/telemetry/in-memory-telemetry.js";
import { systemClock } from "../src/infrastructure/time/system-clock.js";
import { buildApp } from "../src/presentation/build-app.js";
import { LOG_ALLOWLIST, LOG_MESSAGES } from "../src/presentation/logging/log-policy.js";
import { createFeedbackHandler, type FeedbackRouteOptions } from "../src/presentation/routes/feedback.js";
import { TEST_AUTHORIZATION, TEST_PRINCIPAL, TEST_TOKEN, fakeVerifier } from "./auth-fakes.js";
import { startFakePostgrest, type FakePostgrest } from "./infrastructure/fakes/fake-postgrest.js";
import { type FakeBehavior, fakeLimits } from "./limit-fakes.js";
import { HAPPY_PATH_TIMEOUT_MS } from "./support/socket-deadlines.js";

const ANALYSIS_ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const URL_OF = (id: string) => `/v1/analyses/${id}/feedback`;
const VALID = { agreement: "discordo", reason: "nota_alta_demais" } as const;
const PUBLISHABLE = "sb_publishable_feedback-teste";

let app: ReturnType<typeof buildApp> | undefined;
let postgrest: FakePostgrest | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  await postgrest?.close();
  postgrest = undefined;
});

interface SaveCall {
  readonly subject: AnalysisLogSubject;
  readonly analysisId: string;
  readonly feedback: unknown;
}

function fakeService(behavior: () => Promise<FeedbackSaveOutcome> = async () => "gravada") {
  const calls: SaveCall[] = [];
  const service: FeedbackRouteOptions["service"] = {
    save(subject, analysisId, feedback) {
      calls.push({ subject, analysisId, feedback });
      return behavior();
    },
  };
  return { service, calls };
}

function feedbackApp(options: { service?: FeedbackRouteOptions["service"]; lines?: string[]; rate?: FakeBehavior; withRoute?: boolean } = {}) {
  const lines = options.lines;
  const limits = fakeLimits(options.rate === undefined ? {} : { rate: options.rate });
  const instance = buildApp({
    accessTokenVerifier: fakeVerifier().verifier,
    limits: limits.limits,
    logger: lines === undefined ? false : { level: "trace", stream: { write: (line: string) => lines.push(line) } },
    ...(options.withRoute === false ? {} : { feedback: { service: options.service ?? fakeService().service } }),
  });
  app = instance;
  return { app: instance, rate: limits.rate };
}

function post(instance: ReturnType<typeof buildApp>, url: string, payload: unknown = VALID, headers: Record<string, string> = {}) {
  return instance.inject({
    method: "POST",
    url,
    headers: { authorization: TEST_AUTHORIZATION, "content-type": "application/json", ...headers },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

const records = (lines: readonly string[]) => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const messages = (lines: readonly string[]) => records(lines).map((record) => record["msg"]);
/** O ApiError sem o id do pedido, que muda a cada resposta. */
const withoutRequestId = (body: string) => {
  const { requestId: _omit, ...rest } = ApiErrorSchema.parse(JSON.parse(body));
  return rest;
};

describe("registro (ADR-031 D4)", () => {
  test("sem a opção `feedback`: rota inexistente (404 PROIBIDO com token, 401 sem)", async () => {
    const { app } = feedbackApp({ withRoute: false });
    const res = await post(app, URL_OF(ANALYSIS_ID));
    expect(res.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("PROIBIDO");
    const anonymous = await app.inject({ method: "POST", url: URL_OF(ANALYSIS_ID), headers: { "content-type": "application/json" }, payload: "{}" });
    expect(anonymous.statusCode).toBe(401);
  });

  test("a rota declara a classe `feedback` de rate limit", async () => {
    const { app, rate } = feedbackApp();
    await post(app, URL_OF(ANALYSIS_ID));
    expect(rate.calls.map((call) => call.rateClass)).toEqual(["feedback"]);
  });

  test("o catálogo do log tem `feedback_gravacao_indisponivel`", () => {
    expect(LOG_MESSAGES).toContain("feedback_gravacao_indisponivel");
  });
});

describe("a gravação (condição 10: o dono só do principal)", () => {
  test("204 sem corpo e com no-store; o serviço recebe o sujeito verificado, o id do caminho e o corpo validado", async () => {
    const { service, calls } = fakeService();
    const { app } = feedbackApp({ service });
    const res = await post(app, URL_OF(ANALYSIS_ID));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(calls).toEqual([{ subject: { userId: TEST_PRINCIPAL.userId, accessToken: TEST_TOKEN }, analysisId: ANALYSIS_ID, feedback: VALID }]);
  });

  test("o motivo nulo é aceito", async () => {
    const { service, calls } = fakeService();
    const { app } = feedbackApp({ service });
    expect((await post(app, URL_OF(ANALYSIS_ID), { agreement: "concordo", reason: null })).statusCode).toBe(204);
    expect(calls[0]?.feedback).toEqual({ agreement: "concordo", reason: null });
  });

  test.each<[string, unknown]>([
    ["o dono no corpo", { ...VALID, user_id: "0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a" }],
    ["o id no corpo", { ...VALID, analysisId: ANALYSIS_ID }],
    ["sem agreement", { reason: null }],
    ["sem reason", { agreement: "concordo" }],
    ["agreement fora do enum", { agreement: "talvez", reason: null }],
    ["reason fora do enum", { agreement: "discordo", reason: "texto livre" }],
    ["JSON quebrado", "{"],
  ])("corpo inválido (%s): 400 PAYLOAD_INVALIDO sem tocar no serviço", async (_name, payload) => {
    const { service, calls } = fakeService();
    const { app } = feedbackApp({ service });
    const res = await post(app, URL_OF(ANALYSIS_ID), payload);
    expect(res.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("PAYLOAD_INVALIDO");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(calls).toHaveLength(0);
  });

  test.each([["não é UUID", "abc"], ["UUID curto", "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5"], ["com espaço codificado", "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d%20"]])(
    "parâmetro inválido (%s): 400 sem tocar no serviço",
    async (_name, id) => {
      const { service, calls } = fakeService();
      const { app } = feedbackApp({ service });
      const res = await post(app, URL_OF(id));
      expect(res.statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    },
  );

  test(`corpo acima de ${ANALYSIS_FEEDBACK_BODY_MAX_BYTES} bytes: 413 sem parse e sem o serviço; no teto, segue`, async () => {
    const { service, calls } = fakeService();
    const { app } = feedbackApp({ service });
    const prefix = '{"agreement":"concordo","reason":null';
    const padded = (bytes: number) => `${prefix}${" ".repeat(bytes - prefix.length - 1)}}`;
    expect(Buffer.byteLength(padded(ANALYSIS_FEEDBACK_BODY_MAX_BYTES))).toBe(ANALYSIS_FEEDBACK_BODY_MAX_BYTES);
    const over = await post(app, URL_OF(ANALYSIS_ID), padded(ANALYSIS_FEEDBACK_BODY_MAX_BYTES + 1));
    expect(over.statusCode).toBe(413);
    expect(over.headers["cache-control"]).toBe("no-store");
    expect(calls).toHaveLength(0);
    expect((await post(app, URL_OF(ANALYSIS_ID), padded(ANALYSIS_FEEDBACK_BODY_MAX_BYTES))).statusCode).toBe(204);
  });

  test("no-store também no 401 e no 429 dos hooks globais", async () => {
    const { app } = feedbackApp({ rate: { kind: "valor", value: { ok: false, reason: "limite_excedido", retryAfterSeconds: 7 } } });
    const limited = await post(app, URL_OF(ANALYSIS_ID));
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["cache-control"]).toBe("no-store");
    const anonymous = await app.inject({ method: "POST", url: URL_OF(ANALYSIS_ID), headers: { "content-type": "application/json" }, payload: "{}" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers["cache-control"]).toBe("no-store");
  });
});

describe("invariantes do handler (a segunda trava depois do hook do JWT)", () => {
  test.each<[string, Record<string, string>, boolean]>([
    ["sem principal", { authorization: TEST_AUTHORIZATION }, false],
    ["com principal e sem Authorization", {}, true],
    ["com principal e Authorization fora da forma", { authorization: "Bearer não-é-jws" }, true],
  ])("%s: 401 sem tocar no serviço", async (_name, headers, withPrincipal) => {
    const { service, calls } = fakeService();
    const bare = Fastify({ logger: false, genReqId: () => randomUUID() });
    bare.decorateRequest("principal", null);
    if (withPrincipal) {
      bare.addHook("onRequest", async (request) => {
        request.principal = TEST_PRINCIPAL;
      });
    }
    const handler = createFeedbackHandler(service);
    bare.post("/probe", async (request, reply) => handler(request, { analysisId: ANALYSIS_ID }, VALID, reply));
    const res = await bare.inject({ method: "POST", url: "/probe", headers, payload: {} });
    await bare.close();
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("sem oráculo (condição 9) e sem eco (condição 14)", () => {
  test("`negada` responde exatamente como a rota inexistente: 404 PROIBIDO", async () => {
    const { app } = feedbackApp({ service: fakeService(async () => "negada").service });
    const denied = await post(app, URL_OF(ANALYSIS_ID));
    const missing = await post(app, "/v1/analyses/nao-existe");
    expect(denied.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(withoutRequestId(denied.body)).toEqual(withoutRequestId(missing.body));
    expect(denied.headers["cache-control"]).toBe("no-store");
  });

  test.each<[string, () => Promise<FeedbackSaveOutcome>]>([
    ["indisponivel", async () => "indisponivel"],
    ["serviço que rejeita", () => Promise.reject(new Error("CANARIO-ERRO"))],
    ["serviço que lança", () => {
      throw new Error("CANARIO-ERRO");
    }],
    ["serviço que devolve lixo", async () => "CANARIO-LIXO" as FeedbackSaveOutcome],
  ])("%s: 503 SERVICO_INDISPONIVEL e só `feedback_gravacao_indisponivel` no log, sem campo", async (_name, behavior) => {
    const lines: string[] = [];
    const { app } = feedbackApp({ service: fakeService(behavior).service, lines });
    const res = await post(app, URL_OF(ANALYSIS_ID));
    expect(res.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("SERVICO_INDISPONIVEL");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(messages(lines)).toEqual(["requisicao_recebida", "feedback_gravacao_indisponivel", "requisicao_concluida"]);
    for (const record of records(lines)) for (const key of Object.keys(record)) expect(LOG_ALLOWLIST.top).toContain(key);
    for (const leak of [TEST_PRINCIPAL.userId, ANALYSIS_ID, TEST_TOKEN, "CANARIO", "nota_alta_demais"]) expect(lines.join("")).not.toContain(leak);
  });

  test("gravada: nenhuma linha de log além das do pedido", async () => {
    const lines: string[] = [];
    const { app } = feedbackApp({ lines });
    await post(app, URL_OF(ANALYSIS_ID));
    expect(messages(lines)).toEqual(["requisicao_recebida", "requisicao_concluida"]);
  });
});

describe("com as peças reais, em socket real contra o PostgREST simulado (condição 9)", () => {
  const OTHER = "0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a";
  // Montado em tempo de execução (cuidados 14 e 38).
  const OTHER_TOKEN = [TEST_TOKEN.split(".")[0], Buffer.from('{"sub":"outro"}').toString("base64url"), "c2lnbmF0dXJh"].join(".");
  const MINE = ANALYSIS_ID;
  const THEIRS = "2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e";
  const MISSING = "3d4e5f60-7182-4c9d-8e1f-2a3b4c5d6e7f";

  async function realApp() {
    postgrest = await startFakePostgrest(PUBLISHABLE);
    postgrest.sessions.set(TEST_TOKEN, TEST_PRINCIPAL.userId);
    postgrest.sessions.set(OTHER_TOKEN, OTHER);
    postgrest.analyses.push({ id: MINE, user_id: TEST_PRINCIPAL.userId }, { id: THEIRS, user_id: OTHER });
    const telemetry = new InMemoryTelemetry();
    const service = new AnalysisFeedbackService({
      store: createSupabaseAnalysisFeedbackStore({ client: createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: HAPPY_PATH_TIMEOUT_MS }) }),
      clock: systemClock,
      telemetry,
    });
    return { instance: feedbackApp({ service }).app, telemetry };
  }

  test("a própria análise: 204, uma linha do dono, e a telemetria conta só o agreement", async () => {
    const { instance, telemetry } = await realApp();
    expect((await post(instance, URL_OF(MINE))).statusCode).toBe(204);
    expect(postgrest?.feedback).toEqual([expect.objectContaining({ analysis_id: MINE, user_id: TEST_PRINCIPAL.userId, agreement: "discordo" })]);
    expect(telemetry.seriesKeys()).toEqual(['analysis_feedback_total[["agreement","discordo"]]']);
  });

  test("a análise de outro dono, com e sem avaliação, e um id inexistente: a MESMA resposta, e nada muda", async () => {
    const { instance } = await realApp();
    const without = await post(instance, URL_OF(THEIRS));
    const missing = await post(instance, URL_OF(MISSING));
    // O dono de THEIRS avalia; o intruso tenta de novo.
    const ownerApp = buildApp({
      accessTokenVerifier: fakeVerifier({ ok: true, principal: { ...TEST_PRINCIPAL, userId: OTHER }, lifetime: { issuedAt: 1, expiresAt: 901 } }).verifier,
      limits: fakeLimits().limits,
      logger: false,
      feedback: {
        service: new AnalysisFeedbackService({
          store: createSupabaseAnalysisFeedbackStore({ client: createPostgrestUserClient({ url: postgrest?.url ?? new URL("http://x"), publishableKey: PUBLISHABLE, timeoutMs: HAPPY_PATH_TIMEOUT_MS }) }),
          clock: systemClock,
          telemetry: new InMemoryTelemetry(),
        }),
      },
    });
    const byOwner = await post(ownerApp, URL_OF(THEIRS), { agreement: "concordo", reason: null }, { authorization: `Bearer ${OTHER_TOKEN}` });
    await ownerApp.close();
    expect(byOwner.statusCode).toBe(204);
    const withFeedback = await post(instance, URL_OF(THEIRS));
    for (const res of [without, missing, withFeedback]) expect(res.statusCode).toBe(404);
    expect(withoutRequestId(without.body)).toEqual(withoutRequestId(missing.body));
    expect(withoutRequestId(withFeedback.body)).toEqual(withoutRequestId(missing.body));
    expect(postgrest?.feedback).toEqual([expect.objectContaining({ analysis_id: THEIRS, user_id: OTHER, agreement: "concordo", reason: null })]);
  });
});

export type { AnalysisFeedbackEntry };
