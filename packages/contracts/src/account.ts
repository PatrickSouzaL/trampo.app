import { z } from 'zod';
import { DecisionPathSchema, VerdictSchema } from './analysis-report.js';
import { ACCOUNT_EXPORT_MAX_ROWS } from './limits.js';
import { UserCriteriaSchema } from './user-criteria.js';

/**
 * Contratos de exportar e excluir a conta (ADR-029 D3, D4 e D10; SR-16). O portal chama as duas rotas de servidor a
 * servidor, com o Bearer da sessão; a extensão não as alcança. Nenhum código de erro novo: o login antigo responde
 * `PROIBIDO`, e o que não confirma responde `SERVICO_INDISPONIVEL`.
 */
export const ACCOUNT_SCHEMA_VERSION = 1 as const;

/** Caminhos exatos das duas rotas. A API compara pelo padrão registrado, nunca por prefixo. */
export const ACCOUNT_ROUTES = Object.freeze({
  export: '/v1/account/export',
  delete: '/v1/account/delete',
} as const);

/** A frase que o usuário digita no portal e que a API exige no corpo: um POST vazio ou de outra rota não apaga nada. */
export const ACCOUNT_DELETE_CONFIRMATION = 'excluir minha conta' as const;

/** POST /v1/account/delete. Sem alvo no corpo: a conta é sempre a do JWT. */
export const AccountDeleteRequestSchema = z.strictObject({
  schemaVersion: z.literal(ACCOUNT_SCHEMA_VERSION),
  confirmation: z.literal(ACCOUNT_DELETE_CONFIRMATION),
});
export type AccountDeleteRequest = z.infer<typeof AccountDeleteRequestSchema>;

/**
 * O que a função `public.delete_own_account()` do banco devolve (ADR-029 D2), e só isto: `login_antigo` é a sessão
 * com mais de ACCOUNT_RECENT_LOGIN_SECONDS, e nada é apagado.
 */
export const AccountDeleteResultSchema = z.enum(['excluida', 'ja_excluida', 'login_antigo']);
export type AccountDeleteResult = z.infer<typeof AccountDeleteResultSchema>;

/** Uma linha de `analyses` na exportação: o registro mínimo (sem texto, título nem empresa da vaga) e sem o dono. */
export const ExportedAnalysisSchema = z.strictObject({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  decisionPath: DecisionPathSchema,
  verdict: VerdictSchema,
  score: z.int().min(0).max(100),
});
export type ExportedAnalysis = z.infer<typeof ExportedAnalysisSchema>;

/** Uma linha de `analysis_feedback` na exportação. */
export const ExportedFeedbackSchema = z.strictObject({
  analysisId: z.uuid(),
  agreement: z.enum(['concordo', 'discordo']),
  reason: z.enum(['nota_alta_demais', 'nota_baixa_demais', 'fato_extraido_errado', 'veredito_errado', 'outro']).nullable(),
  updatedAt: z.iso.datetime(),
});
export type ExportedFeedback = z.infer<typeof ExportedFeedbackSchema>;

/**
 * GET /v1/account/export, validado na saída. `criteria` traz a pretensão em claro, só para o dono; `null` é quem
 * nunca salvou. As listas vêm da mais nova para a mais velha, com corte declarado em ACCOUNT_EXPORT_MAX_ROWS. Fora
 * daqui, por desenho: o cifrado, o dono, o e-mail, o provedor de login, tokens e logs.
 */
export const AccountExportSchema = z.strictObject({
  schemaVersion: z.literal(ACCOUNT_SCHEMA_VERSION),
  exportedAt: z.iso.datetime(),
  criteria: UserCriteriaSchema.nullable(),
  analyses: z.array(ExportedAnalysisSchema).max(ACCOUNT_EXPORT_MAX_ROWS),
  analysesTruncated: z.boolean(),
  feedback: z.array(ExportedFeedbackSchema).max(ACCOUNT_EXPORT_MAX_ROWS),
  feedbackTruncated: z.boolean(),
});
export type AccountExport = z.infer<typeof AccountExportSchema>;
