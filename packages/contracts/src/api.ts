import { z } from 'zod';
import { AnalysisReportSchema } from './analysis-report.js';
import { PlatformSchema } from './enums.js';
import { JOB_TEXT_MAX_CHARS, JOB_TEXT_MIN_CHARS, JOB_TITLE_MAX_CHARS } from './limits.js';
import { VersionTagSchema, safeText, truncateCodePoints } from './primitives.js';

/**
 * Texto da vaga na borda da API. A ordem das defesas é:
 *   1) servidor rejeita corpo > HTTP_BODY_MAX_BYTES ANTES do parse (413);
 *   2) este schema exige o mínimo e TRUNCA em JOB_TEXT_MAX_CHARS code points (AGENTS.md §1.3);
 *   3) a normalização (NFKC, remoção de invisíveis, PII/URL) acontece depois, no servidor.
 * Entrada = string; saída = { text, truncatedAtEdge } para o relatório avisar "texto_truncado".
 */
export const JobTextSchema = z
  .string()
  .trim()
  .min(JOB_TEXT_MIN_CHARS)
  .transform((raw) => {
    const text = truncateCodePoints(raw, JOB_TEXT_MAX_CHARS);
    return { text, truncatedAtEdge: text.length < raw.length };
  });

export const ANALYZE_REQUEST_SCHEMA_VERSION = 1 as const;

/**
 * POST /v1/analyze (extensão -> API). Minimização: NÃO trafega URL da página
 * (sem histórico de navegação, sem superfície de SSRF) nem dado de perfil.
 * Sem `userId`: o usuário vem do JWT.
 */
export const AnalyzeJobRequestSchema = z.strictObject({
  schemaVersion: z.literal(ANALYZE_REQUEST_SCHEMA_VERSION),
  /** Gerado pelo cliente (crypto.randomUUID): correlação + idempotência de cota. */
  requestId: z.uuid(),
  source: z.strictObject({
    platform: PlatformSchema,
    /** Qual extrator rodou ("linkedin-1", "gupy-1", "generico-1", "colado-1"): telemetria de falha. */
    extractorVersion: VersionTagSchema,
  }),
  job: z.strictObject({
    /** Título lido do DOM. Não confiável: só um indício para a Camada 1. */
    titleHint: z.string().trim().max(JOB_TITLE_MAX_CHARS).nullable(),
    text: JobTextSchema,
    /** O cliente já cortou o texto antes de enviar. */
    clientTruncated: z.boolean(),
  }),
  /** "aprofundada" ignora o curto-circuito da Camada 1 (botão "Reanalisar com IA"). */
  mode: z.enum(['auto', 'aprofundada']),
});
export type AnalyzeJobRequestInput = z.input<typeof AnalyzeJobRequestSchema>;
export type AnalyzeJobRequest = z.output<typeof AnalyzeJobRequestSchema>;

export const ApiErrorCodeSchema = z.enum([
  'NAO_AUTENTICADO',
  'PROIBIDO',
  'PAYLOAD_GRANDE_DEMAIS',
  'PAYLOAD_INVALIDO',
  'TEXTO_CURTO_DEMAIS',
  'CRITERIOS_NAO_CONFIGURADOS',
  'LIMITE_DE_TAXA',
  'COTA_DIARIA_ESGOTADA',
  'SERVICO_INDISPONIVEL',
  'ERRO_INTERNO',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** Erro acionável e sem vazamento: sem stack trace, sem detalhes do Zod, sem nomes internos. */
export const ApiErrorSchema = z.strictObject({
  code: ApiErrorCodeSchema,
  message: safeText(200),
  requestId: z.uuid().nullable(),
  retryAfterSeconds: z.int().min(0).max(86_400).nullable(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const AnalysisStageSchema = z.enum([
  'recebido',
  'normalizando',
  'triagem_deterministica',
  'consultando_cache',
  'extraindo_fatos',
  'pontuando',
]);

/** Eventos de progresso (SSE/NDJSON — formato fechado no Spike S-1). */
export const AnalysisStreamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('stage'), stage: AnalysisStageSchema, elapsedMs: z.int().min(0).max(120_000) }),
  z.strictObject({ type: z.literal('result'), report: AnalysisReportSchema }),
  z.strictObject({ type: z.literal('error'), error: ApiErrorSchema }),
]);
export type AnalysisStreamEvent = z.infer<typeof AnalysisStreamEventSchema>;

/** POST /v1/analyses/:analysisId/feedback — "concordo/discordo da nota" (Blueprint §3). */
export const AnalysisFeedbackRequestSchema = z.strictObject({
  agreement: z.enum(['concordo', 'discordo']),
  reason: z
    .enum(['nota_alta_demais', 'nota_baixa_demais', 'fato_extraido_errado', 'veredito_errado', 'outro'])
    .nullable(),
});
export type AnalysisFeedbackRequest = z.infer<typeof AnalysisFeedbackRequestSchema>;
