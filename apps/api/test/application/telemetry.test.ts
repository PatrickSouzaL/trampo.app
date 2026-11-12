// F1-OBS-01 (ADR-010 D5 e D6) e F1-API-04 (ADR-017 D5): os eventos da Camada 3 e da análise só carregam
// enums e números, o schema estrito é a definição e o catálogo de métricas é fixado contra os ADRs.
import type { LlmProviderId } from "@trampo/contracts";
import type { JobFacts } from "@trampo/contracts/job-facts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import {
  AUTH_OPERATIONS,
  AUTH_RESULTS,
  AnalysisEventSchema,
  AuthEventSchema,
  LlmExtractionEventSchema,
  METRIC_CATALOG,
  TELEMETRY_GUARD_NORMALIZATION_MAX,
  TELEMETRY_LATENCY_MAX_MS,
  TELEMETRY_STEPS_MAX,
  TelemetryEventSchema,
  authEvent,
  authSessionResult,
  endSessionResult,
  llmExtractionEvent,
  telemetryMetricSamples,
  telemetryMs,
  type AnalysisEvent,
  type AuthEvent,
  type ExtractionFailureReason,
  type ExtractionOutcome,
  type LlmExtractionEvent,
  type LlmOutputRejection,
  type LlmOutputSanitization,
  type RouterTrailEntry,
} from "../../src/application/index.js";

const CANARY = "canario-texto-do-llm-q9";
/**
 * O evento nunca lê `facts` nem `model`, e do `sanitization` só os três contadores do g3/g4 (ADR-022 D10): o resto
 * carrega o canário.
 */
const FACTS = { title: CANARY, summary: CANARY } as unknown as JobFacts;
const SANITIZATION = { urlsRemoved: 1, note: CANARY } as unknown as LlmOutputSanitization;
const NO_NORMALIZATIONS = { offEnumItemsRemoved: 0, absentValuesNormalized: 0, stackOverlapsResolved: 0 };

function okOutcome(
  trail: readonly RouterTrailEntry[],
  provider: LlmProviderId = "groq",
  usage = { inputTokens: 900, outputTokens: 120 },
  sanitization: LlmOutputSanitization = SANITIZATION,
): ExtractionOutcome {
  return { ok: true, facts: FACTS, sanitization, provider, model: CANARY, usage, trail };
}

function withCounters(offEnum: unknown, absent: unknown, overlaps: unknown): LlmOutputSanitization {
  return {
    urlsRemoved: 3,
    note: CANARY,
    tags: [CANARY],
    offEnumItemsRemoved: offEnum,
    absentValuesNormalized: absent,
    stackOverlapsResolved: overlaps,
  } as unknown as LlmOutputSanitization;
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
      guardNormalizations: NO_NORMALIZATIONS,
    });
    // Sem a chave guardRejection quando a guarda não rejeitou (o schema estrito não aceita undefined solto).
    expect(Object.keys(event.steps[1] ?? {})).toEqual(["provider", "outcome", "called"]);
    expect(JSON.stringify(event)).not.toContain(CANARY);
    LlmExtractionEventSchema.parse(event);
  });

  test("falha: provedor null, tokens 0, normalizações 0 e o motivo do router", () => {
    const event = llmExtractionEvent(failure("cota_esgotada", []), { platform: "linkedin", latencyMs: 3 });
    expect(event).toMatchObject({ outcome: "cota_esgotada", provider: null, llmCalls: 0, inputTokens: 0, outputTokens: 0, steps: [] });
    expect(event.guardNormalizations).toEqual(NO_NORMALIZATIONS);
  });

  test("ok: copia só os três contadores do g3/g4, saturados em 8.192 (ADR-022 D10)", () => {
    const event = llmExtractionEvent(okOutcome([{ provider: "groq", outcome: "ok", called: true }], "groq", undefined, withCounters(2, 1, 9_000)), {
      platform: "gupy",
      latencyMs: 1,
    });
    expect(event.guardNormalizations).toEqual({
      offEnumItemsRemoved: 2,
      absentValuesNormalized: 1,
      stackOverlapsResolved: TELEMETRY_GUARD_NORMALIZATION_MAX,
    });
    expect(Object.keys(event.guardNormalizations)).toEqual(["offEnumItemsRemoved", "absentValuesNormalized", "stackOverlapsResolved"]);
    expect(JSON.stringify(event)).not.toContain(CANARY);
    expect(JSON.stringify(event)).not.toContain("urlsRemoved");
    LlmExtractionEventSchema.parse(event);
  });

  test.each([
    ["no teto", TELEMETRY_GUARD_NORMALIZATION_MAX, TELEMETRY_GUARD_NORMALIZATION_MAX],
    ["1", 1, 1],
    ["negativo", -1, 0],
    ["fracionário", 1.5, 0],
    ["NaN", Number.NaN, 0],
    ["infinito", Number.POSITIVE_INFINITY, 0],
    ["acima do inteiro seguro", Number.MAX_SAFE_INTEGER + 2, 0],
    ["texto", "3", 0],
  ])("contador %s vira %i", (_label, value, expected) => {
    const event = llmExtractionEvent(okOutcome([], "groq", undefined, withCounters(value, value, value)), { platform: "gupy", latencyMs: 1 });
    expect(event.guardNormalizations).toEqual({
      offEnumItemsRemoved: expected,
      absentValuesNormalized: expected,
      stackOverlapsResolved: expected,
    });
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
    expect(TELEMETRY_GUARD_NORMALIZATION_MAX).toBe(8_192);
    expect(TelemetryEventSchema.options).toEqual([LlmExtractionEventSchema, AnalysisEventSchema, AuthEventSchema]);
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
    ["sem guardNormalizations", (({ guardNormalizations: _omit, ...rest }) => rest)(valid)],
    ["chave extra nas normalizações", { ...valid, guardNormalizations: { ...NO_NORMALIZATIONS, urlsRemoved: 1 } }],
    ["texto nas normalizações", { ...valid, guardNormalizations: { ...NO_NORMALIZATIONS, tag: CANARY } }],
    ["normalização acima do teto", { ...valid, guardNormalizations: { ...NO_NORMALIZATIONS, stackOverlapsResolved: TELEMETRY_GUARD_NORMALIZATION_MAX + 1 } }],
    ["normalização negativa", { ...valid, guardNormalizations: { ...NO_NORMALIZATIONS, offEnumItemsRemoved: -1 } }],
    ["normalização fracionária", { ...valid, guardNormalizations: { ...NO_NORMALIZATIONS, absentValuesNormalized: 0.5 } }],
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
/** Contadores do `sanitization` como a guarda daria, e também fora da forma (o evento satura ou zera). */
const counter = fc.oneof(
  { weight: 4, arbitrary: fc.nat({ max: 20 }) },
  fc.integer({ min: 8_000, max: 20_000 }),
  fc.constantFrom(-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY),
);
const outcome = fc.oneof(
  fc
    .record({
      trail,
      provider: fc.constantFrom(...providers),
      inputTokens: fc.nat(),
      outputTokens: fc.nat(),
      counters: fc.tuple(counter, counter, counter),
    })
    .map(({ trail: t, provider, inputTokens, outputTokens, counters }) =>
      okOutcome(t, provider, { inputTokens, outputTokens }, withCounters(...counters)),
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
      llm_guard_normalization_total: { type: "counter", labels: ["provider", "kind"] },
      analysis_total: { type: "counter", labels: ["platform", "mode", "rule", "decision_path"] },
      analysis_duration_ms: { type: "histogram", labels: ["decision_path"], buckets: [50, 250, 1_000, 2_000, 4_000, 8_000, 12_000] },
      analysis_cache_total: { type: "counter", labels: ["cache"] },
      analysis_injection_level_total: { type: "counter", labels: ["level"] },
      analysis_accept_eligible_total: { type: "counter", labels: ["eligible"] },
      analysis_warning_total: { type: "counter", labels: ["warning"] },
      auth_troca_total: { type: "counter", labels: ["resultado"] },
      auth_renovacao_total: { type: "counter", labels: ["resultado"] },
      auth_logout_total: { type: "counter", labels: ["resultado"] },
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

const ANALYSIS: AnalysisEvent = {
  kind: "analysis",
  platform: "linkedin",
  mode: "auto",
  rule: "R4",
  decisionPath: "extracao_llm",
  acceptEligible: true,
  cache: "ausente",
  injectionLevel: "media",
  warnings: ["possivel_prompt_injection", "texto_truncado"],
  durationMs: 1_800,
};

describe("llm_guard_normalization_total (ADR-022 D10)", () => {
  test("um contador por tipo, só quando > 0, com o provedor que respondeu", () => {
    const event = llmExtractionEvent(
      okOutcome([{ provider: "groq", outcome: "ok", called: true }], "groq", undefined, withCounters(2, 0, 5)),
      { platform: "gupy", latencyMs: 1 },
    );
    const samples = telemetryMetricSamples(event).filter((sample) => sample.name === "llm_guard_normalization_total");
    expect(samples).toEqual([
      { name: "llm_guard_normalization_total", labels: { provider: "groq", kind: "fora_do_enum" }, value: 2 },
      { name: "llm_guard_normalization_total", labels: { provider: "groq", kind: "sobreposicao_de_stack" }, value: 5 },
    ]);
  });

  test("todos 0: nenhuma série; falha: nenhuma série", () => {
    const zero = llmExtractionEvent(okOutcome([], "groq", undefined, withCounters(0, 0, 0)), { platform: "gupy", latencyMs: 1 });
    const failed = llmExtractionEvent(failure("timeout", []), { platform: "gupy", latencyMs: 1 });
    for (const event of [zero, failed]) {
      expect(telemetryMetricSamples(event).some((sample) => sample.name === "llm_guard_normalization_total")).toBe(false);
    }
  });

  test("o rótulo kind tem cardinalidade fechada: ausência normalizada", () => {
    const event = llmExtractionEvent(okOutcome([], "cloudflare_workers_ai", undefined, withCounters(0, 7, 0)), {
      platform: "gupy",
      latencyMs: 1,
    });
    expect(telemetryMetricSamples(event).filter((sample) => sample.name === "llm_guard_normalization_total")).toEqual([
      {
        name: "llm_guard_normalization_total",
        labels: { provider: "cloudflare_workers_ai", kind: "ausencia_normalizada" },
        value: 7,
      },
    ]);
  });
});

describe("evento analysis (ADR-017 D5)", () => {
  test("válido na união e no schema próprio", () => {
    expect(TelemetryEventSchema.safeParse(ANALYSIS).success).toBe(true);
    expect(AnalysisEventSchema.safeParse({ ...ANALYSIS, durationMs: TELEMETRY_LATENCY_MAX_MS, warnings: [] }).success).toBe(true);
  });

  test.each([
    ["nota", { ...ANALYSIS, score: 80 }],
    ["veredito", { ...ANALYSIS, verdict: "recomendado" }],
    ["userId", { ...ANALYSIS, userId: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b" }],
    ["requestId", { ...ANALYSIS, requestId: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b" }],
    ["título", { ...ANALYSIS, title: CANARY }],
    ["regra fora do enum", { ...ANALYSIS, rule: "R5" }],
    ["modo fora do enum", { ...ANALYSIS, mode: CANARY }],
    ["caminho fora do enum", { ...ANALYSIS, decisionPath: CANARY }],
    ["cache fora do enum", { ...ANALYSIS, cache: "quente" }],
    ["injection fora do enum", { ...ANALYSIS, injectionLevel: "altissima" }],
    ["aviso fora do enum", { ...ANALYSIS, warnings: [CANARY] }],
    ["aviso repetido", { ...ANALYSIS, warnings: ["texto_truncado", "texto_truncado"] }],
    ["duração negativa", { ...ANALYSIS, durationMs: -1 }],
    ["duração acima do teto", { ...ANALYSIS, durationMs: TELEMETRY_LATENCY_MAX_MS + 1 }],
    ["duração fracionária", { ...ANALYSIS, durationMs: 1.5 }],
    ["acceptEligible não booleano", { ...ANALYSIS, acceptEligible: "sim" }],
    ["kind desconhecido", { ...ANALYSIS, kind: "analise" }],
  ])("recusa: %s", (_name, event) => {
    expect(TelemetryEventSchema.safeParse(event).success).toBe(false);
  });

  test("métricas: análise, duração, cache, injection, aceite e um contador por aviso", () => {
    expect(telemetryMetricSamples(ANALYSIS)).toEqual([
      { name: "analysis_total", labels: { platform: "linkedin", mode: "auto", rule: "R4", decision_path: "extracao_llm" }, value: 1 },
      { name: "analysis_duration_ms", labels: { decision_path: "extracao_llm" }, value: 1_800 },
      { name: "analysis_cache_total", labels: { cache: "ausente" }, value: 1 },
      { name: "analysis_injection_level_total", labels: { level: "media" }, value: 1 },
      { name: "analysis_accept_eligible_total", labels: { eligible: "sim" }, value: 1 },
      { name: "analysis_warning_total", labels: { warning: "possivel_prompt_injection" }, value: 1 },
      { name: "analysis_warning_total", labels: { warning: "texto_truncado" }, value: 1 },
    ]);
    expect(telemetryMetricSamples({ ...ANALYSIS, acceptEligible: false, warnings: [] }).map((s) => s.labels)).toContainEqual({ eligible: "nao" });
    expect(telemetryMetricSamples({ ...ANALYSIS, mode: "aprofundada" })[0]?.labels).toEqual({
      platform: "linkedin",
      mode: "aprofundada",
      rule: "R4",
      decision_path: "extracao_llm",
    });
  });

  test("propriedade: todo evento válido gera só rótulos do catálogo", () => {
    const event = fc.record({
      kind: fc.constant("analysis" as const),
      platform: fc.constantFrom("linkedin" as const, "gupy" as const, "generico" as const, "texto_colado" as const),
      mode: fc.constantFrom("auto" as const, "aprofundada" as const),
      rule: fc.constantFrom("R1" as const, "R2" as const, "R3" as const, "R4" as const),
      decisionPath: fc.constantFrom(
        "triagem_deterministica" as const,
        "cache_jobfacts" as const,
        "extracao_llm" as const,
        "fallback_deterministico" as const,
      ),
      acceptEligible: fc.boolean(),
      cache: fc.constantFrom(
        "nao_consultado" as const,
        "hit" as const,
        "ausente" as const,
        "corrompido" as const,
        "obsoleto" as const,
        "indisponivel" as const,
      ),
      injectionLevel: fc.constantFrom("baixa" as const, "media" as const, "alta" as const),
      warnings: fc.uniqueArray(
        fc.constantFrom(
          "possivel_prompt_injection" as const,
          "informacao_contraditoria" as const,
          "baixa_confianca_extracao" as const,
          "texto_truncado" as const,
          "analise_degradada" as const,
          "decisao_sem_ia" as const,
        ),
      ),
      durationMs: fc.integer({ min: 0, max: TELEMETRY_LATENCY_MAX_MS }),
    });
    fc.assert(
      fc.property(event, (e) => {
        TelemetryEventSchema.parse(e);
        for (const sample of telemetryMetricSamples(e)) {
          expect(Object.keys(sample.labels)).toEqual(METRIC_CATALOG[sample.name].labels);
        }
      }),
      { numRuns: 1_000 },
    );
  });
});

describe("telemetryMs", () => {
  test.each([
    [1.4, 1],
    [1.5, 2],
    [-3, 0],
    [Number.NaN, 0],
    [0, 0],
    [TELEMETRY_LATENCY_MAX_MS + 10, TELEMETRY_LATENCY_MAX_MS],
  ])("%d → %d", (input, expected) => {
    expect(telemetryMs(input)).toBe(expected);
  });
});

// F1-API-07 07i (ADR-004 D8 item 7; ADR-010 D5 e D6): o evento de autenticação só tem a operação e o resultado, de listas
// fechadas. Nenhum motivo em texto, token, envelope, código, `sub`, sessão, origem ou IP cabe nele (SR-12).
describe("evento auth (ADR-004 D8 item 7; F1-API-07 07i)", () => {
  const EVENT: AuthEvent = { kind: "auth", operation: "troca", result: "ok" };

  test("as listas são fechadas: 3 operações e 4 resultados", () => {
    expect(AUTH_OPERATIONS).toEqual(["troca", "renovacao", "logout"]);
    expect(AUTH_RESULTS).toEqual(["ok", "recusado", "indisponivel", "limitado"]);
  });

  test("válido na união e no schema próprio, com exatamente 3 chaves", () => {
    expect(AuthEventSchema.parse(EVENT)).toEqual(EVENT);
    expect(TelemetryEventSchema.parse(EVENT)).toEqual(EVENT);
    expect(Object.keys(authEvent("logout", "indisponivel")).sort()).toEqual(["kind", "operation", "result"]);
    expect(authEvent("renovacao", "limitado")).toEqual({ kind: "auth", operation: "renovacao", result: "limitado" });
  });

  test.each([
    ["userId", { userId: "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f" }],
    ["sub", { sub: "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f" }],
    ["sessionId", { sessionId: "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3" }],
    ["accessToken", { accessToken: CANARY }],
    ["refreshToken", { refreshToken: CANARY }],
    ["motivo em texto", { reason: "auth_troca_recusada" }],
    ["origem", { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }],
    ["ip", { ip: "203.0.113.7" }],
    ["e-mail", { email: "pessoa@example.com" }],
    ["reqId", { reqId: "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f" }],
    ["operação fora da lista", { operation: "signup" }],
    ["operação com o canário", { operation: CANARY }],
    ["resultado fora da lista", { result: "erro" }],
    ["resultado numérico", { result: 200 }],
    ["resultado ausente", { result: undefined }],
    ["operação ausente", { operation: undefined }],
  ])("recusa %s (strictObject e enums fechados)", (_caso, over) => {
    expect(AuthEventSchema.safeParse({ ...EVENT, ...over }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...EVENT, ...over }).success).toBe(false);
  });

  test.each([
    ["troca", "auth_troca_total"],
    ["renovacao", "auth_renovacao_total"],
    ["logout", "auth_logout_total"],
  ] as const)("métrica da %s: uma amostra por evento, no contador %s, só com o rótulo resultado", (operation, name) => {
    for (const result of AUTH_RESULTS) {
      expect(telemetryMetricSamples(authEvent(operation, result))).toEqual([{ name, labels: { resultado: result }, value: 1 }]);
    }
  });

  test("propriedade: toda operação e todo resultado dão 1 amostra do catálogo, e o evento passa no schema estrito", () => {
    fc.assert(
      fc.property(fc.constantFrom(...AUTH_OPERATIONS), fc.constantFrom(...AUTH_RESULTS), (operation, result) => {
        const event = authEvent(operation, result);
        expect(TelemetryEventSchema.safeParse(event).success).toBe(true);
        const samples = telemetryMetricSamples(event);
        expect(samples).toHaveLength(1);
        for (const sample of samples) {
          expect(Object.keys(sample.labels)).toEqual([...METRIC_CATALOG[sample.name].labels]);
          expect(AUTH_RESULTS).toContain(sample.labels["resultado"]);
          expect(sample.name).toBe(`auth_${operation}_total`);
        }
      }),
    );
  });

  test("mapa do D7 para o resultado da troca e da renovação", () => {
    const session = { schemaVersion: 1, accessToken: CANARY, refreshToken: CANARY, expiresIn: 600 } as const;
    expect(authSessionResult({ kind: "sessao", session })).toBe("ok");
    for (const reason of ["auth_troca_recusada", "auth_renovacao_recusada", "auth_envelope_invalido", "auth_sessao_idade_maxima", "auth_sessao_inativa"] as const) {
      expect(authSessionResult({ kind: "nao_autenticado", reason })).toBe("recusado");
    }
    for (const reason of ["auth_chaves_indisponiveis", "auth_provedor_indisponivel", "auth_token_fora_da_politica"] as const) {
      expect(authSessionResult({ kind: "indisponivel", reason, retryAfterSeconds: null })).toBe("indisponivel");
      expect(authSessionResult({ kind: "indisponivel", reason, retryAfterSeconds: 5 })).toBe("indisponivel");
    }
    expect(authSessionResult({ kind: "entrada_invalida" })).toBe("recusado");
  });

  test("mapa do D7 para o resultado do logout", () => {
    expect(endSessionResult({ kind: "encerrada" })).toBe("ok");
    expect(endSessionResult({ kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: null })).toBe("indisponivel");
  });
});
