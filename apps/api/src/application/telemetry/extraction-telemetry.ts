// Telemetria da Camada 3 e da análise (ADR-010 D5 e D6; ADR-017 D5). A trilha do router (só enums, ADR-009 D3)
// e o evento `analysis` do AnalyzeJob são as fontes de métrica. Funções puras: montam o evento e o traduzem no
// catálogo de métricas, sem estado e sem I/O. Não há caminho para `facts`, `model`, nota ou veredito: só enums e
// números são copiados. Do `sanitization`, só os três contadores do g3/g4 (ADR-022 D10).
import type { Platform } from "@trampo/contracts";

import type { ExtractionOutcome } from "../llm/llm-provider-router.js";
import {
  TELEMETRY_GUARD_NORMALIZATION_MAX,
  TELEMETRY_LATENCY_MAX_MS,
  type AnalysisEvent,
  type LlmExtractionEvent,
  type TelemetryEvent,
} from "../ports/telemetry.js";

export interface ExtractionTelemetryContext {
  readonly platform: Platform;
  /** Duração da Camada 3 no relógio monotônico do `Clock`. */
  readonly latencyMs: number;
}

/** Arredonda para ms e limita a [0, TELEMETRY_LATENCY_MAX_MS]; NaN e negativos viram 0. */
export function telemetryMs(ms: number): number {
  const rounded = Math.round(ms);
  return rounded > 0 ? Math.min(rounded, TELEMETRY_LATENCY_MAX_MS) : 0;
}

/** Inteiro seguro > 0 limitado a TELEMETRY_GUARD_NORMALIZATION_MAX; o resto vira 0. */
function saturated(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, TELEMETRY_GUARD_NORMALIZATION_MAX) : 0;
}

export function llmExtractionEvent(outcome: ExtractionOutcome, context: ExtractionTelemetryContext): LlmExtractionEvent {
  return {
    kind: "llm_extraction",
    platform: context.platform,
    outcome: outcome.ok ? "ok" : outcome.reason,
    provider: outcome.ok ? outcome.provider : null,
    latencyMs: telemetryMs(context.latencyMs),
    llmCalls: outcome.trail.filter((step) => step.called).length,
    inputTokens: outcome.ok ? outcome.usage.inputTokens : 0,
    outputTokens: outcome.ok ? outcome.usage.outputTokens : 0,
    steps: outcome.trail.map((step) => ({
      provider: step.provider,
      outcome: step.outcome,
      called: step.called,
      ...(step.guardRejection === undefined ? {} : { guardRejection: step.guardRejection }),
    })),
    guardNormalizations: outcome.ok
      ? {
          offEnumItemsRemoved: saturated(outcome.sanitization.offEnumItemsRemoved),
          absentValuesNormalized: saturated(outcome.sanitization.absentValuesNormalized),
          stackOverlapsResolved: saturated(outcome.sanitization.stackOverlapsResolved),
        }
      : { offEnumItemsRemoved: 0, absentValuesNormalized: 0, stackOverlapsResolved: 0 },
  };
}

/** Rótulo `kind` do `llm_guard_normalization_total` para cada contador do evento (ADR-022 D10). */
const NORMALIZATION_KINDS = {
  offEnumItemsRemoved: "fora_do_enum",
  absentValuesNormalized: "ausencia_normalizada",
  stackOverlapsResolved: "sobreposicao_de_stack",
} as const satisfies Record<keyof LlmExtractionEvent["guardNormalizations"], string>;

/** Catálogo de métricas do ADR-010 D6. Rótulos só com cardinalidade fechada. */
export const METRIC_CATALOG = {
  llm_extraction_total: { type: "counter", labels: ["platform", "outcome", "provider"] },
  llm_extraction_latency_ms: { type: "histogram", labels: ["outcome"], buckets: [250, 500, 1_000, 2_000, 4_000, 8_000, 12_000] },
  llm_calls_per_analysis: { type: "histogram", labels: [], buckets: [0, 1, 2] },
  llm_provider_step_total: { type: "counter", labels: ["provider", "outcome", "called"] },
  llm_guard_rejection_total: { type: "counter", labels: ["provider", "rejection"] },
  llm_tokens_total: { type: "counter", labels: ["provider", "direction"] },
  // ADR-022 D10: só quando o contador do evento é > 0.
  llm_guard_normalization_total: { type: "counter", labels: ["provider", "kind"] },
  // ADR-017 D5: uma série por análise, sem nada derivado do perfil.
  analysis_total: { type: "counter", labels: ["platform", "mode", "rule", "decision_path"] },
  analysis_duration_ms: { type: "histogram", labels: ["decision_path"], buckets: [50, 250, 1_000, 2_000, 4_000, 8_000, 12_000] },
  analysis_cache_total: { type: "counter", labels: ["cache"] },
  analysis_injection_level_total: { type: "counter", labels: ["level"] },
  analysis_accept_eligible_total: { type: "counter", labels: ["eligible"] },
  analysis_warning_total: { type: "counter", labels: ["warning"] },
} as const;
export type MetricName = keyof typeof METRIC_CATALOG;

export interface MetricSample {
  readonly name: MetricName;
  readonly labels: Readonly<Record<string, string>>;
  /** Contador: incremento. Histograma: valor observado. */
  readonly value: number;
}

export function telemetryMetricSamples(event: TelemetryEvent): MetricSample[] {
  return event.kind === "analysis" ? analysisSamples(event) : extractionSamples(event);
}

function analysisSamples(event: AnalysisEvent): MetricSample[] {
  return [
    {
      name: "analysis_total",
      labels: { platform: event.platform, mode: event.mode, rule: event.rule, decision_path: event.decisionPath },
      value: 1,
    },
    { name: "analysis_duration_ms", labels: { decision_path: event.decisionPath }, value: event.durationMs },
    { name: "analysis_cache_total", labels: { cache: event.cache }, value: 1 },
    { name: "analysis_injection_level_total", labels: { level: event.injectionLevel }, value: 1 },
    { name: "analysis_accept_eligible_total", labels: { eligible: event.acceptEligible ? "sim" : "nao" }, value: 1 },
    ...event.warnings.map((warning): MetricSample => ({ name: "analysis_warning_total", labels: { warning }, value: 1 })),
  ];
}

function extractionSamples(event: LlmExtractionEvent): MetricSample[] {
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
    for (const [field, kind] of Object.entries(NORMALIZATION_KINDS)) {
      const value = event.guardNormalizations[field as keyof typeof NORMALIZATION_KINDS];
      if (value > 0) samples.push({ name: "llm_guard_normalization_total", labels: { provider: event.provider, kind }, value });
    }
  }
  return samples;
}
