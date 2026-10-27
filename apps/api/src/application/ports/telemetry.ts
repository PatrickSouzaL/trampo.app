// Porta de telemetria (ADR-001 §5.9; ADR-010 D5 e D6). Eventos só com enums e números: nenhum texto livre,
// nenhum dado de perfil, nenhum id de usuário e nenhum reqId (métrica é agregado, não rastro). O schema
// estrito é a definição; o adapter valida cada evento com ele e descarta o que não casar.
import { AnalysisWarningSchema, DecisionPathSchema, LlmProviderIdSchema, PlatformSchema } from "@trampo/contracts";
import { uniqueArray } from "@trampo/contracts/primitives";
import { z } from "zod";

import type { AnalysisMode, InjectionLevel, PreFilterRule } from "../../domain/index.js";
import type { CacheMissReason } from "../cache/job-facts-cache.js";
import type { ExtractionFailureReason, RouterTrailEntry } from "../llm/llm-provider-router.js";
import type { LlmOutputRejection, LlmOutputSanitization } from "../llm/llm-output-guard.js";

/** Limite da latência registrada: 10× o prazo da análise (ADR-009 D4). Acima disso é erro de medida. */
export const TELEMETRY_LATENCY_MAX_MS = 120_000;
/** Teto de passos da trilha: até 3 provedores (dev) com um retry cada. */
export const TELEMETRY_STEPS_MAX = 6;
/**
 * Saturação dos contadores do g3/g4 na cópia (ADR-022 D10). O teto de 8 KiB da guarda já limita a contagem real
 * abaixo disso.
 */
export const TELEMETRY_GUARD_NORMALIZATION_MAX = 8_192;

const ExtractionFailureReasonSchema = z.enum([
  "timeout",
  "limite_de_taxa",
  "saida_invalida",
  "erro_provedor",
  "circuito_aberto",
  "cota_esgotada",
]);
const ExtractionOutcomeSchema = z.union([z.literal("ok"), ExtractionFailureReasonSchema]);
const LlmOutputRejectionSchema = z.enum(["resposta_grande_demais", "json_invalido", "poluicao_de_prototipo", "schema_invalido"]);
const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const normalizationCount = z.int().min(0).max(TELEMETRY_GUARD_NORMALIZATION_MAX);

export const LlmExtractionEventSchema = z.strictObject({
  kind: z.literal("llm_extraction"),
  platform: PlatformSchema,
  outcome: ExtractionOutcomeSchema,
  /** Quem respondeu ok; null na falha. */
  provider: LlmProviderIdSchema.nullable(),
  latencyMs: z.int().min(0).max(TELEMETRY_LATENCY_MAX_MS),
  /** Chamadas feitas (passos com `called`): no máximo 2 (ADR-009 D5). */
  llmCalls: z.int().min(0).max(2),
  inputTokens: count,
  outputTokens: count,
  steps: z
    .array(
      z.strictObject({
        provider: LlmProviderIdSchema,
        outcome: ExtractionOutcomeSchema,
        called: z.boolean(),
        guardRejection: LlmOutputRejectionSchema.optional(),
      }),
    )
    .max(TELEMETRY_STEPS_MAX),
  /**
   * Só três inteiros do `sanitization` da guarda (ADR-022 D10; emenda ao ADR-010 D5): nenhum texto, tag ou campo
   * dos fatos. Todos 0 na falha.
   */
  guardNormalizations: z.strictObject({
    /** g3: itens fora do enum removidos. */
    offEnumItemsRemoved: normalizationCount,
    /** g3: valores de ausência normalizados. */
    absentValuesNormalized: normalizationCount,
    /** g4: termos nas duas listas de stack resolvidos. */
    stackOverlapsResolved: normalizationCount,
  }),
});
export type LlmExtractionEvent = z.infer<typeof LlmExtractionEventSchema>;

const AnalysisModeSchema = z.enum(["auto", "aprofundada"]);
const PreFilterRuleSchema = z.enum(["R1", "R2", "R3", "R4"]);
const CacheMissReasonSchema = z.enum(["ausente", "corrompido", "obsoleto", "indisponivel"]);
const InjectionLevelSchema = z.enum(["baixa", "media", "alta"]);

/** `nao_consultado` (R1–R3 ou sem cache), `hit` ou o motivo do miss (ADR-015). */
export const AnalysisCacheStatusSchema = z.union([z.enum(["nao_consultado", "hit"]), CacheMissReasonSchema]);
export type AnalysisCacheStatus = z.infer<typeof AnalysisCacheStatusSchema>;

/**
 * Uma análise do funil (ADR-017 D5). Sem nota, veredito nem dimensão: derivam dos critérios do usuário, e a
 * telemetria não carrega nada derivado do perfil (minimização).
 */
export const AnalysisEventSchema = z.strictObject({
  kind: z.literal("analysis"),
  platform: PlatformSchema,
  mode: AnalysisModeSchema,
  rule: PreFilterRuleSchema,
  decisionPath: DecisionPathSchema,
  /** Condições do R3 sem a flag (ADR-016 D9): mede a D-H3 com dado real. */
  acceptEligible: z.boolean(),
  cache: AnalysisCacheStatusSchema,
  injectionLevel: InjectionLevelSchema,
  warnings: uniqueArray(AnalysisWarningSchema, AnalysisWarningSchema.options.length),
  durationMs: z.int().min(0).max(TELEMETRY_LATENCY_MAX_MS),
});
export type AnalysisEvent = z.infer<typeof AnalysisEventSchema>;

/** União fechada: um tipo novo de evento entra por ADR (ADR-010 D5; `analysis` pelo ADR-017 D5). */
export const TelemetryEventSchema = z.discriminatedUnion("kind", [LlmExtractionEventSchema, AnalysisEventSchema]);
export type TelemetryEvent = LlmExtractionEvent | AnalysisEvent;

export interface Telemetry {
  /** Nunca lança: a contabilidade não pode derrubar uma análise. */
  record(event: TelemetryEvent): void;
}

// Os enums acima são cópias dos tipos do router, da guarda, do cache e da Camada 1: a compilação quebra se divergirem.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameReason: Same<z.infer<typeof ExtractionFailureReasonSchema>, ExtractionFailureReason> = true;
const sameRejection: Same<z.infer<typeof LlmOutputRejectionSchema>, LlmOutputRejection> = true;
const sameStepKeys: Same<keyof LlmExtractionEvent["steps"][number], keyof RouterTrailEntry> = true;
// Os três contadores existem no `sanitization` da guarda com o mesmo nome.
const sameNormalizations: Same<
  Pick<LlmOutputSanitization, keyof LlmExtractionEvent["guardNormalizations"]>,
  LlmExtractionEvent["guardNormalizations"]
> = true;
const sameStepOutcome: Same<z.infer<typeof ExtractionOutcomeSchema>, RouterTrailEntry["outcome"]> = true;
const sameMode: Same<z.infer<typeof AnalysisModeSchema>, AnalysisMode> = true;
const sameRule: Same<z.infer<typeof PreFilterRuleSchema>, PreFilterRule> = true;
const sameMiss: Same<z.infer<typeof CacheMissReasonSchema>, CacheMissReason> = true;
const sameInjection: Same<z.infer<typeof InjectionLevelSchema>, InjectionLevel> = true;
const sameEvent: Same<z.infer<typeof TelemetryEventSchema>, TelemetryEvent> = true;
void [sameReason, sameRejection, sameStepKeys, sameNormalizations, sameStepOutcome, sameMode, sameRule, sameMiss, sameInjection, sameEvent];
