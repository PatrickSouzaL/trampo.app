// F1-API-06 fatia 4 (ADR-031 D4 e D7): o AnalysisFeedbackService grava a avaliação do dono num prazo próprio, nunca
// rejeita, devolve só `gravada`, `negada` (análise inexistente ou de outro dono, sem distinção) ou `indisponivel`, e
// conta na telemetria só o `agreement` da avaliação gravada.
import { describe, expect, test } from "vitest";

import {
  ANALYSIS_FEEDBACK_POLICY,
  AnalysisFeedbackService,
  FEEDBACK_SAVE_OUTCOMES,
  type AnalysisFeedbackEntry,
  type AnalysisFeedbackStore,
  type AnalysisLogSubject,
  type FeedbackSaveOutcome,
  type Telemetry,
  type TelemetryEvent,
} from "../../src/application/index.js";
import { FakeClock } from "./fakes/fake-clock.js";

const SUBJECT: AnalysisLogSubject = {
  userId: "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f",
  accessToken: "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ0ZXN0ZSJ9.c2lnbmF0dXJh",
};
const ANALYSIS_ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";

interface Saved {
  readonly subject: AnalysisLogSubject;
  readonly entry: AnalysisFeedbackEntry;
  readonly signal: AbortSignal | undefined;
}

function harness(save: AnalysisFeedbackStore["save"] = async () => "gravada", telemetry?: Telemetry) {
  const calls: Saved[] = [];
  const events: TelemetryEvent[] = [];
  const clock = new FakeClock();
  const store: AnalysisFeedbackStore = {
    save(subject, entry, signal) {
      calls.push({ subject, entry, signal });
      return save(subject, entry, signal);
    },
  };
  const service = new AnalysisFeedbackService({ store, clock, telemetry: telemetry ?? { record: (event) => events.push(event) } });
  return { service, calls, events, clock };
}

describe("política (ADR-031 D4)", () => {
  test("prazo de 2.000 ms e os três resultados, congelados", () => {
    expect(ANALYSIS_FEEDBACK_POLICY).toEqual({ timeoutMs: 2_000 });
    expect(Object.isFrozen(ANALYSIS_FEEDBACK_POLICY)).toBe(true);
    expect(FEEDBACK_SAVE_OUTCOMES).toEqual(["gravada", "negada", "indisponivel"]);
    expect(Object.isFrozen(FEEDBACK_SAVE_OUTCOMES)).toBe(true);
  });
});

describe("grava a avaliação do dono", () => {
  test("só os três campos, com o dono do sujeito; a telemetria conta o agreement", async () => {
    const { service, calls, events, clock } = harness();
    const request = { agreement: "discordo", reason: "nota_alta_demais", userId: "CANARIO" } as const;
    await expect(clock.run(service.save(SUBJECT, ANALYSIS_ID, request))).resolves.toBe("gravada");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toEqual(SUBJECT);
    expect(calls[0]?.entry).toStrictEqual({ analysisId: ANALYSIS_ID, agreement: "discordo", reason: "nota_alta_demais" });
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(events).toStrictEqual([{ kind: "analysis_feedback", agreement: "discordo" }]);
  });

  test.each(["negada", "indisponivel"] as const)("%s: devolve igual, e a telemetria não conta", async (outcome) => {
    const { service, events, clock } = harness(async () => outcome);
    await expect(clock.run(service.save(SUBJECT, ANALYSIS_ID, { agreement: "concordo", reason: null }))).resolves.toBe(outcome);
    expect(events).toEqual([]);
  });
});

describe("nunca rejeita (a falha é `indisponivel`)", () => {
  test.each<[string, AnalysisFeedbackStore["save"]]>([
    ["porta que lança", () => {
      throw new Error("x");
    }],
    ["porta que rejeita", () => Promise.reject(new Error("x"))],
    ["porta que devolve lixo", async () => "ok" as unknown as FeedbackSaveOutcome],
  ])("%s", async (_name, save) => {
    const { service, clock } = harness(save);
    await expect(clock.run(service.save(SUBJECT, ANALYSIS_ID, { agreement: "concordo", reason: null }))).resolves.toBe("indisponivel");
  });

  test("porta que trava: `indisponivel` aos 2.000 ms, sem timer pendente", async () => {
    const { service, clock } = harness(() => new Promise<FeedbackSaveOutcome>(() => undefined));
    const start = clock.nowMs();
    await expect(clock.run(service.save(SUBJECT, ANALYSIS_ID, { agreement: "concordo", reason: null }))).resolves.toBe("indisponivel");
    expect(clock.nowMs() - start).toBe(ANALYSIS_FEEDBACK_POLICY.timeoutMs);
    expect(clock.pendingTimers).toBe(0);
  });

  test("telemetria que lança: a gravação continua `gravada`", async () => {
    const { service, clock } = harness(async () => "gravada", {
      record: () => {
        throw new Error("x");
      },
    });
    await expect(clock.run(service.save(SUBJECT, ANALYSIS_ID, { agreement: "concordo", reason: null }))).resolves.toBe("gravada");
  });
});
