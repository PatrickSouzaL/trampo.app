// F1-OBS-01 (ADR-010 D6): o adapter em memória agrega pelo catálogo, descarta e conta evento inválido e
// nunca lança.
import { describe, expect, test } from "vitest";

import { llmExtractionEvent, type ExtractionOutcome, type TelemetryEvent } from "../../src/application/index.js";
import { InMemoryTelemetry } from "../../src/infrastructure/telemetry/in-memory-telemetry.js";

const failureAt = (latencyMs: number): TelemetryEvent =>
  llmExtractionEvent({ ok: false, reason: "timeout", trail: [{ provider: "groq", outcome: "timeout", called: true }] }, { platform: "gupy", latencyMs });

const okEvent = (): TelemetryEvent =>
  llmExtractionEvent(
    {
      ok: true,
      provider: "groq",
      model: "openai/gpt-oss-20b",
      usage: { inputTokens: 1_000, outputTokens: 200 },
      trail: [{ provider: "groq", outcome: "ok", called: true }],
    } as unknown as ExtractionOutcome,
    { platform: "linkedin", latencyMs: 800 },
  );

describe("InMemoryTelemetry", () => {
  test("contadores somam por série; a ordem dos rótulos na consulta não importa", () => {
    const telemetry = new InMemoryTelemetry();
    telemetry.record(okEvent());
    telemetry.record(okEvent());
    telemetry.record(failureAt(100));
    expect(telemetry.counter("llm_extraction_total", { platform: "linkedin", outcome: "ok", provider: "groq" })).toBe(2);
    expect(telemetry.counter("llm_extraction_total", { provider: "groq", outcome: "ok", platform: "linkedin" })).toBe(2);
    expect(telemetry.counter("llm_extraction_total", { platform: "gupy", outcome: "timeout", provider: "nenhum" })).toBe(1);
    expect(telemetry.counter("llm_tokens_total", { provider: "groq", direction: "input" })).toBe(2_000);
    expect(telemetry.counter("llm_tokens_total", { provider: "groq", direction: "output" })).toBe(400);
    expect(telemetry.counter("llm_provider_step_total", { provider: "groq", outcome: "timeout", called: "sim" })).toBe(1);
    expect(telemetry.counter("llm_guard_rejection_total", { provider: "groq", rejection: "json_invalido" })).toBe(0);
    expect(telemetry.droppedEvents).toBe(0);
  });

  test("histograma: contagem acumulada por limite, +Inf, soma e contagem", () => {
    const telemetry = new InMemoryTelemetry();
    for (const latency of [100, 250, 251, 12_000, 50_000]) telemetry.record(failureAt(latency));
    expect(telemetry.histogram("llm_extraction_latency_ms", { outcome: "timeout" })).toEqual({
      count: 5,
      sum: 62_601,
      // limites: 250, 500, 1.000, 2.000, 4.000, 8.000, 12.000 e +Inf
      cumulative: [2, 3, 3, 3, 3, 3, 4, 5],
    });
    expect(telemetry.histogram("llm_calls_per_analysis")).toEqual({ count: 5, sum: 5, cumulative: [0, 5, 5, 5] });
    expect(telemetry.histogram("llm_extraction_latency_ms", { outcome: "ok" })).toBeUndefined();
  });

  test("o snapshot do histograma é uma cópia", () => {
    const telemetry = new InMemoryTelemetry();
    telemetry.record(failureAt(1));
    const snapshot = telemetry.histogram("llm_calls_per_analysis");
    (snapshot?.cumulative as number[])[0] = 99;
    expect(telemetry.histogram("llm_calls_per_analysis")?.cumulative).toEqual([0, 1, 1, 1]);
  });

  test("evento inválido (chave extra com texto) é descartado e contado, sem criar série", () => {
    const telemetry = new InMemoryTelemetry();
    telemetry.record({ ...okEvent(), jobText: "texto da vaga" } as unknown as TelemetryEvent);
    telemetry.record({ ...okEvent(), platform: "indeed" } as unknown as TelemetryEvent);
    expect(telemetry.droppedEvents).toBe(2);
    expect(telemetry.seriesKeys()).toEqual([]);
  });

  test("evento hostil (getter que lança) não lança e é contado como descartado", () => {
    const telemetry = new InMemoryTelemetry();
    const hostile = Object.defineProperty({ ...okEvent() }, "platform", {
      enumerable: true,
      get: () => {
        throw new Error("boom");
      },
    });
    expect(() => telemetry.record(hostile)).not.toThrow();
    expect(telemetry.droppedEvents).toBe(1);
    expect(telemetry.seriesKeys()).toEqual([]);
  });

  test("séries só com nomes e rótulos do catálogo", () => {
    const telemetry = new InMemoryTelemetry();
    telemetry.record(okEvent());
    expect(telemetry.seriesKeys().sort()).toEqual(
      [
        'llm_extraction_total[["outcome","ok"],["platform","linkedin"],["provider","groq"]]',
        'llm_provider_step_total[["called","sim"],["outcome","ok"],["provider","groq"]]',
        'llm_tokens_total[["direction","input"],["provider","groq"]]',
        'llm_tokens_total[["direction","output"],["provider","groq"]]',
        'llm_extraction_latency_ms[["outcome","ok"]]',
        "llm_calls_per_analysis[]",
      ].sort(),
    );
  });
});
