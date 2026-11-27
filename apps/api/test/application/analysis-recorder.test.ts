// F1-API-06 fatia 3 (ADR-031 D1 e D7; condições 1 a 3 e 14 do [APPSEC]): o AnalysisRecorder grava a linha mínima da
// análise que já saiu, com o id do servidor, num prazo próprio de 2.000 ms, nunca rejeita e conta o resultado na
// telemetria só pelo `outcome`. A porta que lança, rejeita, trava ou devolve lixo vira `indisponivel`.
import type { AnalysisReport } from "@trampo/contracts";
import { ANALYSES_DAILY_ROW_CAP } from "@trampo/contracts/limits";
import { beforeAll, describe, expect, test } from "vitest";

import {
  ANALYSIS_LOG_OUTCOMES,
  ANALYSIS_RECORDER_POLICY,
  AnalysisRecorder,
  DAILY_QUOTA_POLICY,
  type AnalysisLog,
  type AnalysisLogEntry,
  type AnalysisLogOutcome,
  type AnalysisLogSubject,
  type Telemetry,
  type TelemetryEvent,
} from "../../src/application/index.js";
import { criteria } from "../domain/fakes/scoring-fixtures.js";
import { JobHarness, request as jobRequest } from "./fakes/analyze-job-harness.js";
import { FakeClock } from "./fakes/fake-clock.js";

const SUBJECT: AnalysisLogSubject = {
  userId: "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f",
  accessToken: "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ0ZXN0ZSJ9.c2lnbmF0dXJh",
};

let report: AnalysisReport;
beforeAll(async () => {
  report = (await new JobHarness({ groq: null }).analyze(jobRequest(), criteria())).report;
});

interface Appended {
  readonly subject: AnalysisLogSubject;
  readonly entry: AnalysisLogEntry;
  readonly signal: AbortSignal | undefined;
}

function harness(append: AnalysisLog["append"] = async () => "gravada", telemetry?: Telemetry) {
  const calls: Appended[] = [];
  const events: TelemetryEvent[] = [];
  const clock = new FakeClock();
  const log: AnalysisLog = {
    append(subject, entry, signal) {
      calls.push({ subject, entry, signal });
      return append(subject, entry, signal);
    },
  };
  const recorder = new AnalysisRecorder({ log, clock, telemetry: telemetry ?? { record: (event) => events.push(event) } });
  return { recorder, calls, events, clock };
}

describe("política (ADR-031 D1 e D2)", () => {
  test("o prazo do gravador é de 2.000 ms, congelado", () => {
    expect(ANALYSIS_RECORDER_POLICY).toEqual({ timeoutMs: 2_000 });
    expect(Object.isFrozen(ANALYSIS_RECORDER_POLICY)).toBe(true);
  });

  test("os quatro resultados da gravação, congelados", () => {
    expect(ANALYSIS_LOG_OUTCOMES).toEqual(["gravada", "recusada", "limite", "indisponivel"]);
    expect(Object.isFrozen(ANALYSIS_LOG_OUTCOMES)).toBe(true);
  });

  test("o teto do banco fica em pelo menos o dobro da cota diária (o dia de Brasília permite 2 × 50 em 24 h)", () => {
    expect(ANALYSES_DAILY_ROW_CAP).toBeGreaterThanOrEqual(2 * DAILY_QUOTA_POLICY.analysesPerDay);
  });
});

describe("a linha mínima (condições 1 e 2)", () => {
  test("só o id do servidor, o caminho, o veredito e a nota, com o dono do sujeito", async () => {
    const { recorder, calls, clock } = harness();
    await expect(clock.run(recorder.record(SUBJECT, report))).resolves.toBe("gravada");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.subject).toEqual(SUBJECT);
    expect(call?.entry).toStrictEqual({
      analysisId: report.analysisId,
      decisionPath: report.decisionPath,
      verdict: report.verdict,
      score: report.score,
    });
    // O id é o do servidor, nunca o requestId do cliente.
    expect(call?.entry.analysisId).not.toBe(report.requestId);
    const sent = JSON.stringify(call?.entry);
    for (const leak of [report.requestId, report.summary, report.createdAt, report.platform]) expect(sent).not.toContain(leak);
  });

  test("a porta recebe um signal, que fica abortado depois da resposta", async () => {
    const { recorder, calls, clock } = harness();
    await clock.run(recorder.record(SUBJECT, report));
    expect(calls[0]?.signal?.aborted).toBe(true);
  });
});

describe("o resultado vai à telemetria só pelo `outcome` (D7; condição 14)", () => {
  test.each(["gravada", "recusada", "limite", "indisponivel"] as const)("%s", async (outcome) => {
    const { recorder, events, clock } = harness(async () => outcome);
    await expect(clock.run(recorder.record(SUBJECT, report))).resolves.toBe(outcome);
    expect(events).toStrictEqual([{ kind: "analysis_record", outcome }]);
    const counted = JSON.stringify(events);
    for (const leak of [SUBJECT.userId, report.analysisId, report.verdict]) expect(counted).not.toContain(leak);
  });
});

describe("nunca rejeita, e a falha vira `indisponivel` (condição 3)", () => {
  test.each<[string, AnalysisLog["append"]]>([
    ["porta que lança de forma síncrona", () => {
      throw new Error("x");
    }],
    ["porta que rejeita", () => Promise.reject(new Error("x"))],
    ["porta que devolve lixo (texto fora da lista)", async () => "ok" as unknown as AnalysisLogOutcome],
    ["porta que devolve undefined", async () => undefined as unknown as AnalysisLogOutcome],
    ["porta que devolve um objeto", async () => ({ outcome: "gravada" }) as unknown as AnalysisLogOutcome],
  ])("%s", async (_name, append) => {
    const { recorder, events, clock } = harness(append);
    await expect(clock.run(recorder.record(SUBJECT, report))).resolves.toBe("indisponivel");
    expect(events).toStrictEqual([{ kind: "analysis_record", outcome: "indisponivel" }]);
  });

  test("porta que trava: `indisponivel` aos 2.000 ms do relógio, com o signal abortado", async () => {
    const { recorder, events, calls, clock } = harness(() => new Promise<AnalysisLogOutcome>(() => undefined));
    const start = clock.nowMs();
    await expect(clock.run(recorder.record(SUBJECT, report))).resolves.toBe("indisponivel");
    expect(clock.nowMs() - start).toBe(ANALYSIS_RECORDER_POLICY.timeoutMs);
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(events).toStrictEqual([{ kind: "analysis_record", outcome: "indisponivel" }]);
    expect(clock.pendingTimers).toBe(0);
  });

  test("porta que responde antes do prazo: nenhum timer fica pendente", async () => {
    const { recorder, clock } = harness();
    await clock.run(recorder.record(SUBJECT, report));
    expect(clock.pendingTimers).toBe(0);
  });

  test("telemetria que lança: o resultado volta igual", async () => {
    const { recorder, clock } = harness(async () => "limite", {
      record: () => {
        throw new Error("telemetria fora do ar");
      },
    });
    await expect(clock.run(recorder.record(SUBJECT, report))).resolves.toBe("limite");
  });

  test("relatório hostil (um campo que lança ao ser lido): `indisponivel`, sem chamar a porta", async () => {
    const hostile = new Proxy(report, {
      get(target, key, receiver) {
        if (key === "verdict") throw new Error("hostil");
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const { recorder, calls, events, clock } = harness();
    await expect(clock.run(recorder.record(SUBJECT, hostile))).resolves.toBe("indisponivel");
    expect(calls).toHaveLength(0);
    expect(events).toStrictEqual([{ kind: "analysis_record", outcome: "indisponivel" }]);
  });
});
