import { z } from 'zod';
import { LlmProviderIdSchema, PlatformSchema } from './enums.js';
import { ResolvedJobFactsSchema } from './job-facts.js';
import { VersionTagSchema, safeText, uniqueArray } from './primitives.js';

export const ANALYSIS_REPORT_SCHEMA_VERSION = 1 as const;

/** 5 faixas (ADR-002 §3.4, D-S9). Os mínimos de cada faixa são regra de domínio (`ScoringPolicy`). */
export const VerdictSchema = z.enum(['altamente_recomendado', 'recomendado', 'neutro', 'baixo_alinhamento', 'foge']);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Por onde a decisão passou no funil híbrido (ADR-001). */
export const DecisionPathSchema = z.enum([
  'triagem_deterministica', // Camada 1 decidiu sozinha (curto-circuito)
  'cache_jobfacts', // fatos vieram do cache compartilhado
  'extracao_llm', // Camada 2 executada nesta requisição
  'fallback_deterministico', // Camada 2 indisponível/inválida: só sinais da Camada 1
]);
export type DecisionPath = z.infer<typeof DecisionPathSchema>;

export const ScoreDimensionSchema = z.enum([
  'stack',
  'modelo_trabalho',
  'senioridade',
  'contrato',
  'salario',
  'localizacao',
  'idiomas',
  'beneficios',
  'red_flags',
]);
export type ScoreDimension = z.infer<typeof ScoreDimensionSchema>;

export const DimensionOutcomeSchema = z.enum([
  'atende',
  'atende_parcialmente',
  'nao_atende',
  'nao_informado',
  'conflito',
  'ignorado',
]);
export type DimensionOutcome = z.infer<typeof DimensionOutcomeSchema>;

export const AppliedImportanceSchema = z.enum(['eliminatorio', 'obrigatorio', 'ponderado', 'ignorar']);
export type AppliedImportance = z.infer<typeof AppliedImportanceSchema>;

/** Uma linha da composição da nota: auditabilidade ("−30: modelo híbrido, você exige remoto"). */
export const ScoreBreakdownEntrySchema = z.strictObject({
  dimension: ScoreDimensionSchema,
  outcome: DimensionOutcomeSchema,
  importance: AppliedImportanceSchema,
  /** Contribuição assinada desta dimensão para a nota final. */
  points: z.int().min(-100).max(100),
  dealBreakerHit: z.boolean(),
  /** Gerado por template no servidor. Não ecoa valores do perfil (ex.: pretensão salarial). */
  explanation: safeText(160),
});
export type ScoreBreakdownEntry = z.infer<typeof ScoreBreakdownEntrySchema>;

export const ReportItemSchema = z.strictObject({
  dimension: ScoreDimensionSchema,
  text: safeText(140),
});
export type ReportItem = z.infer<typeof ReportItemSchema>;

export const AnalysisWarningSchema = z.enum([
  'possivel_prompt_injection',
  'informacao_contraditoria',
  'baixa_confianca_extracao',
  'texto_truncado',
  'analise_degradada',
  'decisao_sem_ia',
]);
export type AnalysisWarning = z.infer<typeof AnalysisWarningSchema>;

export const FactFieldSchema = z.enum([
  'title',
  'seniorityLevels',
  'yearsExperienceMin',
  'workModels',
  'location',
  'salary',
  'contractTypes',
  'stackRequired',
  'stackNiceToHave',
  'benefits',
  'languageRequirements',
  'redFlagSignals',
]);

export const FactProvenanceSchema = z.enum(['deterministico', 'llm', 'deterministico_e_llm', 'conflito', 'ausente']);

function uniqueByDimension(items: ReadonlyArray<{ dimension: string }>): boolean {
  return new Set(items.map((i) => i.dimension)).size === items.length;
}

/**
 * Relatório entregue ao Side Panel. Só texto simples: nenhuma string contém HTML,
 * markdown de link ou URL (D8). A extensão revalida com este schema antes de renderizar.
 * Formas apenas: invariantes de NEGÓCIO (ex.: deal-breaker => "foge", teto da nota)
 * são garantidas e testadas no domínio da API, não aqui.
 */
export const AnalysisReportSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_REPORT_SCHEMA_VERSION),
  analysisId: z.uuid(),
  requestId: z.uuid(),
  createdAt: z.iso.datetime(),
  platform: PlatformSchema,
  score: z.int().min(0).max(100),
  verdict: VerdictSchema,
  dealBreakerHit: z.boolean(),
  strengths: z.array(ReportItemSchema).max(3),
  redFlags: z.array(ReportItemSchema).max(3),
  missingInfo: z.array(ReportItemSchema).max(ScoreDimensionSchema.options.length).refine(uniqueByDimension, {
    error: 'dimensao_duplicada',
  }),
  breakdown: z
    .array(ScoreBreakdownEntrySchema)
    .min(1)
    .max(ScoreDimensionSchema.options.length)
    .refine(uniqueByDimension, { error: 'dimensao_duplicada' }),
  warnings: uniqueArray(AnalysisWarningSchema, AnalysisWarningSchema.options.length),
  decisionPath: DecisionPathSchema,
  facts: ResolvedJobFactsSchema,
  provenance: z.record(FactFieldSchema, FactProvenanceSchema),
  /** Confiança efetiva calculada pela API (não a autodeclarada pelo LLM). */
  effectiveConfidence: z.number().min(0).max(1),
  meta: z.strictObject({
    engineVersion: VersionTagSchema,
    extractorVersion: VersionTagSchema.nullable(),
    provider: LlmProviderIdSchema.nullable(),
    durationMs: z.int().min(0).max(120_000),
  }),
});
export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;
