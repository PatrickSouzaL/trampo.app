// F1-OBS-01 (ADR-010 D5 e D6): o evento da Camada 3 só carrega enums e números, o schema estrito é a
// definição e o catálogo de métricas é fixado contra o ADR.
import type { LlmProviderId } from "@trampo/contracts";
import type { JobFacts } from "@trampo/contracts/job-facts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import {
  LlmExtractionEventSchema,
  METRIC_CATALOG,
  TELEMETRY_LATENCY_MAX_MS,
  TELEMETRY_STEPS_MAX,
  TelemetryEventSchema,
  llmExtractionEvent,
  telemetryMetricSamples,
  type ExtractionFailureReason,
  type ExtractionOutcome,
  type LlmExtractionEvent,
  type LlmOutputRejection,
  type LlmOutputSanitization,
  type RouterTrailEntry,
} from "../../src/application/index.js";

const CANARY = "canario-texto-do-llm-q9";
/** O evento nunca lê `facts`, `sanitization` nem `model`: os três carregam o canário. */
const FACTS = { title: CANARY, summary: CANARY } as unknown as JobFacts;
const SANITIZATION = { urlsRemoved: 1, note: CANARY } as unknown as LlmOutputSanitization;

function okOutcome(trail: readonly RouterTrailEntry[], provider: LlmProviderId = "groq", usage = { inputTokens: 900, outputTokens: 120 }): ExtractionOutcome {
  return { ok: true, facts: FACTS, sanitization: SANITIZATION, provider, model: CANARY, usage, trail };
}

function failure(reason: ExtractionFailureReason, trail: readonly RouterTrailEntry[]): ExtractionOutcome {
  return { ok: false, reason, trail };
}

describe("llmExtractionEvent", () => {
  test("ok: copia provedor, tokens, trilha e conta só as chamadas feitas", () => {
    const event = llmExtractionEvent(
      okOutcome([
        { provider: "groq", outcome: "saida_invalida", called: true, guardRejection: "schema_invalido" },
        { provider: "cloudflare_workers_ai", outcome: "circuito_aberto", called: false },
        { provider: "groq", outcome: "ok", called: true },
      ]),
      { platform: "gupy", latencyMs: 1_234.4 },
    );
    expect(event).toEqual({
      kind: "llm_extraction",
      platform: "gupy",
      outcome: "ok",
      provider: "groq",
      latencyMs: 1_234,
      llmCalls: 2,
      inputTokens: 900,
      outputTokens: 120,
      steps: [
        { provider: "groq", outcome: "saida_invalida", called: true, guardRejection: "schema_invalido" },
        { provider: "cloudflare_workers_ai", outcome: "circuito_aberto", called: false },
        { provider: "groq", outcome: "ok", called: true },
      ],
    });
    // Sem a chave guardRejection quando a guarda não rejeitou (o schema estrito não aceita undefined solto).
    expect(Object.keys(event.steps[1] ?? {})).toEqual(["provider", "outcome", "called"]);
    expect(JSON.stringify(event)).not.toContain(CANARY);
    LlmExtractionEventSchema.parse(event);
  });

  test("falha: provedor null, tokens 0 e o motivo do router", () => {
    const event = llmExtractionEvent(failure("cota_esgotada", []), { platform: "linkedin", latencyMs: 3 });
    expect(event).toMatchObject({ outcome: "cota_esgotada", provider: null, llmCalls: 0, inputTokens: 0, outputTokens: 0, steps: [] });
  });

  test("latência: arredonda e limita a [0, TELEMETRY_LATENCY_MAX_MS]; NaN e negativos viram 0", () => {
    const at = (latencyMs: number) => llmExtractionEvent(failure("timeout", []), { platform: "generico", latencyMs }).latencyMs;
    expect(at(0.4)).toBe(0);
    expect(at(0.5)).toBe(1);
    // -0.4 arredonda para -0: o evento grava 0, não -0.
    expect(Object.is(at(-0.4), 0)).toBe(true);
    expect(at(-5)).toBe(0);
    expect(at(Number.NaN)).toBe(0);
    expect(at(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(at(TELEMETRY_LATENCY_MAX_MS)).toBe(TELEMETRY_LATENCY_MAX_MS);
    expect(at(TELEMETRY_LATENCY_MAX_MS + 1)).toBe(TELEMETRY_LATENCY_MAX_MS);
    expect(at(Number.POSITIVE_INFINITY)).toBe(TELEMETRY_LATENCY_MAX_MS);
  });
});

describe("TelemetryEventSchema (estrito)", () => {
  const valid: LlmExtractionEvent = llmExtractionEvent(okOutcome([{ provider: "groq", outcome: "ok", called: true }]), { platform: "gupy", latencyMs: 10 });

  test("constantes do ADR-010 D5", () => {
    expect(TELEMETRY_LATENCY_MAX_MS).toBe(120_000);
    expect(TELEMETRY_STEPS_MAX).toBe(6);
    expect(TelemetryEventSchema).toBe(LlmExtractionEventSchema);
  });

  test.each([
    ["chave extra no evento", { ...valid, jobText: CANARY }],
    ["chave extra no passo", { ...valid, steps: [{ provider: "groq", outcome: "ok", called: true, raw: CANARY }] }],
    ["userId", { ...valid, userId: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b" }],
    ["plataforma fora do enum", { ...valid, platform: "indeed" }],
    ["motivo fora do enum", { ...valid, outcome: CANARY }],
    ["rejeição fora do enum", { ...valid, steps: [{ provider: "groq", outcome: "saida_invalida", called: true, guardRejection: CANARY }] }],
    ["latência negativa", { ...valid, latencyMs: -1 }],
    ["latência acima do teto", { ...valid, latencyMs: TELEMETRY_LATENCY_MAX_MS + 1 }],
    ["latência fracionária", { ...valid, latencyMs: 1.5 }],
    ["3 chamadas", { ...valid, llmCalls: 3 }],
    ["tokens negativos", { ...valid, inputTokens: -1 }],
    ["7 passos", { ...valid, steps: Array.from({ length: TELEMETRY_STEPS_MAX + 1 }, () => ({ provider: "groq", outcome: "timeout", called: false })) }],
  ])("recusa: %s", (_name, event) => {
    expect(TelemetryEventSchema.safeParse(event).success).toBe(false);
  });

  test("aceita os limites", () => {
    const steps = Array.from({ length: TELEMETRY_STEPS_MAX }, () => ({ provider: "ollama" as const, outcome: "timeout" as const, called: false }));
    expect(TelemetryEventSchema.safeParse({ ...valid, latencyMs: TELEMETRY_LATENCY_MAX_MS, llmCalls: 2, steps }).success).toBe(true);
  });
});

const providers: readonly LlmProviderId[] = ["groq", "cloudflare_workers_ai", "google_ai_studio", "ollama"];
const reasons: readonly ExtractionFailureReason[] = ["timeout", "limite_de_taxa", "saida_invalida", "erro_provedor", "circuito_aberto", "cota_esgotada"];
const rejections: readonly LlmOutputRejection[] = ["resposta_grande_demais", "json_invalido", "poluicao_de_prototipo", "schema_invalido"];
const trailEntry = fc.record(
  {
    provider: fc.constantFrom(...providers),
    outcome: fc.constantFrom<"ok" | ExtractionFailureReason>("ok", ...reasons),
    called: fc.boolean(),
    guardRejection: fc.constantFrom(...rejections),
  },
  { requiredKeys: ["provider", "outcome", "called"] },
);
/** Trilhas que o router pode produzir: até 6 passos e no máximo 2 chamadas (ADR-009, provado lá). */
const trail = fc.array(trailEntry, { maxLength: TELEMETRY_STEPS_MAX }).filter((t) => t.filter((s) => s.called).length <= 2);
const outcome = fc.oneof(
  fc.record({ trail, provider: fc.constantFrom(...providers), inputTokens: fc.nat(), outputTokens: fc.nat() }).map(
    ({ trail: t, provider, inputTokens, outputTokens }) => okOutcome(t, provider, { inputTokens, outputTokens }),
  ),
  fc.record({ trail, reason: fc.constantFrom(...reasons) }).map(({ trail: t, reason }) => failure(reason, t)),
);

describe("propriedade: qualquer resultado do router vira um evento válido e sem texto", () => {
  test("passa no schema estrito, não contém o canário e as métricas só usam rótulos do catálogo", () => {
    fc.assert(
      fc.property(outcome, fc.constantFrom("linkedin", "gupy", "generico", "texto_colado" as const), fc.double(), (o, platform, latencyMs) => {
        const event = llmExtractionEvent(o, { platform, latencyMs });
        TelemetryEventSchema.parse(event);
        expect(JSON.stringify(event)).not.toContain(CANARY);
        for (const sample of telemetryMetricSamples(event)) {
          expect(Object.keys(sample.labels)).toEqual(METRIC_CATALOG[sample.name].labels);
          expect(Number.isFinite(sample.value) && sample.value >= 0).toBe(true);
        }
      }),
      { numRuns: 1_000 },
    );
  });
});

describe("catálogo de métricas (ADR-010 D6)", () => {
  test("o catálogo é o do ADR", () => {
    expect(METRIC_CATALOG).toEqual({
      llm_extraction_total: { type: "counter", labels: ["platform", "outcome", "provider"] },
      llm_extraction_latency_ms: { type: "histogram", labels: ["outcome"], buckets: [250, 500, 1_000, 2_000, 4_000, 8_000, 12_000] },
      llm_calls_per_analysis: { type: "histogram", labels: [], buckets: [0, 1, 2] },
      llm_provider_step_total: { type: "counter", labels: ["provider", "outcome", "called"] },
      llm_guard_rejection_total: { type: "counter", labels: ["provider", "rejection"] },
      llm_tokens_total: { type: "counter", labels: ["provider", "direction"] },
    });
  });

  test("ok: extração, latência, chamadas, passos, rejeição da guarda e tokens", () => {
    const event = llmExtractionEvent(
      okOutcome(
        [
          { provider: "groq", outcome: "saida_invalida", called: true, guardRejection: "json_invalido" },
          { provider: "cloudflare_workers_ai", outcome: "ok", called: true },
        ],
        "cloudflare_workers_ai",
      ),
      { platform: "linkedin", latencyMs: 4_100 },
    );
    expect(telemetryMetricSamples(event)).toEqual([
      { name: "llm_extraction_total", labels: { platform: "linkedin", outcome: "ok", provider: "cloudflare_workers_ai" }, value: 1 },
      { name: "llm_extraction_latency_ms", labels: { outcome: "ok" }, value: 4_100 },
      { name: "llm_calls_per_analysis", labels: {}, value: 2 },
      { name: "llm_provider_step_total", labels: { provider: "groq", outcome: "saida_invalida", called: "sim" }, value: 1 },
      { name: "llm_guard_rejection_total", labels: { provider: "groq", rejection: "json_invalido" }, value: 1 },
      { name: "llm_provider_step_total", labels: { provider: "cloudflare_workers_ai", outcome: "ok", called: "sim" }, value: 1 },
      { name: "llm_tokens_total", labels: { provider: "cloudflare_workers_ai", direction: "input" }, value: 900 },
      { name: "llm_tokens_total", labels: { provider: "cloudflare_workers_ai", direction: "output" }, value: 120 },
    ]);
  });

  test("falha: provedor 'nenhum', passo pulado com called 'nao' e sem tokens", () => {
    const event = llmExtractionEvent(failure("circuito_aberto", [{ provider: "groq", outcome: "circuito_aberto", called: false }]), {
      platform: "texto_colado",
      latencyMs: 2,
    });
    expect(telemetryMetricSamples(event)).toEqual([
      { name: "llm_extraction_total", labels: { platform: "texto_colado", outcome: "circuito_aberto", provider: "nenhum" }, value: 1 },
      { name: "llm_extraction_latency_ms", labels: { outcome: "circuito_aberto" }, value: 2 },
      { name: "llm_calls_per_analysis", labels: {}, value: 0 },
      { name: "llm_provider_step_total", labels: { provider: "groq", outcome: "circuito_aberto", called: "nao" }, value: 1 },
    ]);
  });
});
