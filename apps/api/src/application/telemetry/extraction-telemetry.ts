// Telemetria da Camada 3 (ADR-010 D5 e D6). A trilha do router (só enums, ADR-009 D3) é a primeira fonte
// de métrica. Funções puras: montam o evento e o traduzem no catálogo de métricas, sem estado e sem I/O.
// Não há caminho para `facts`, `sanitization` ou `model`: só enums e números são copiados.
import type { Platform } from "@trampo/contracts";

import type { ExtractionOutcome } from "../llm/llm-provider-router.js";
import { TELEMETRY_LATENCY_MAX_MS, type LlmExtractionEvent, type TelemetryEvent } from "../ports/telemetry.js";

export interface ExtractionTelemetryContext {
  readonly platform: Platform;
  /** Duração da Camada 3 no relógio monotônico do `Clock`. */
  readonly latencyMs: number;
}

/** Arredonda para ms e limita a [0, TELEMETRY_LATENCY_MAX_MS]; NaN e negativos viram 0. */
function latency(ms: number): number {
  const rounded = Math.round(ms);
  return rounded > 0 ? Math.min(rounded, TELEMETRY_LATENCY_MAX_MS) : 0;
}

export function llmExtractionEvent(outcome: ExtractionOutcome, context: ExtractionTelemetryContext): LlmExtractionEvent {
  return {
    kind: "llm_extraction",
    platform: context.platform,
    outcome: outcome.ok ? "ok" : outcome.reason,
    provider: outcome.ok ? outcome.provider : null,
    latencyMs: latency(context.latencyMs),
    llmCalls: outcome.trail.filter((step) => step.called).length,
    inputTokens: outcome.ok ? outcome.usage.inputTokens : 0,
    outputTokens: outcome.ok ? outcome.usage.outputTokens : 0,
    steps: outcome.trail.map((step) => ({
      provider: step.provider,
      outcome: step.outcome,
      called: step.called,
      ...(step.guardRejection === undefined ? {} : { guardRejection: step.guardRejection }),
    })),
  };
}

/** Catálogo de métricas do ADR-010 D6. Rótulos só com cardinalidade fechada. */
export const METRIC_CATALOG = {
  llm_extraction_total: { type: "counter", labels: ["platform", "outcome", "provider"] },
  llm_extraction_latency_ms: { type: "histogram", labels: ["outcome"], buckets: [250, 500, 1_000, 2_000, 4_000, 8_000, 12_000] },
  llm_calls_per_analysis: { type: "histogram", labels: [], buckets: [0, 1, 2] },
  llm_provider_step_total: { type: "counter", labels: ["provider", "outcome", "called"] },
  llm_guard_rejection_total: { type: "counter", labels: ["provider", "rejection"] },
  llm_tokens_total: { type: "counter", labels: ["provider", "direction"] },
} as const;
export type MetricName = keyof typeof METRIC_CATALOG;

export interface MetricSample {
  readonly name: MetricName;
  readonly labels: Readonly<Record<string, string>>;
  /** Contador: incremento. Histograma: valor observado. */
  readonly value: number;
}

export function telemetryMetricSamples(event: TelemetryEvent): MetricSample[] {
  const samples: MetricSample[] = [
    { name: "llm_extraction_total", labels: { platform: event.platform, outcome: event.outcome, provider: event.provider ?? "nenhum" }, value: 1 },
    { name: "llm_extraction_latency_ms", labels: { outcome: event.outcome }, value: event.latencyMs },
    { name: "llm_calls_per_analysis", labels: {}, value: event.llmCalls },
  ];
  for (const step of event.steps) {
    samples.push({
      name: "llm_provider_step_total",
      labels: { provider: step.provider, outcome: step.outcome, called: step.called ? "sim" : "nao" },
      value: 1,
    });
    if (step.guardRejection !== undefined) {
      samples.push({ name: "llm_guard_rejection_total", labels: { provider: step.provider, rejection: step.guardRejection }, value: 1 });
    }
  }
  if (event.provider !== null) {
    samples.push(
      { name: "llm_tokens_total", labels: { provider: event.provider, direction: "input" }, value: event.inputTokens },
      { name: "llm_tokens_total", labels: { provider: event.provider, direction: "output" }, value: event.outputTokens },
    );
  }
  return samples;
}
