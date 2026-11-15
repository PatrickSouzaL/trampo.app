// AccountStore sobre o PostgREST do Supabase (ADR-029 D2 a D4). A exclusão chama a função `delete_own_account` por
// RPC com o token do dono: sem service_role e sem chave secret, a função só apaga a conta do `sub` do próprio JWT. As
// duas listas da exportação saem por `select` com colunas explícitas, o filtro pelo dono (a RLS é a segunda barreira),
// da mais nova para a mais velha, com uma linha além do teto só para saber se houve corte. Entra no compose-app
// sempre embrulhado no AccountService. Nunca rejeita, e nenhuma linha fora da forma passa.
import { AccountDeleteResultSchema, type ExportedAnalysis, type ExportedFeedback } from "@trampo/contracts/account";
import { DecisionPathSchema, VerdictSchema } from "@trampo/contracts/analysis-report";
import { ACCOUNT_EXPORT_MAX_ROWS } from "@trampo/contracts/limits";
import { z } from "zod";

import type { AccountDeletion, AccountRecords, AccountStore } from "../../application/ports/account-store.js";
import type { PostgrestUserClient } from "../supabase/postgrest-user-client.js";

export const ACCOUNT_DELETE_FUNCTION = "delete_own_account";
/** As colunas de cada lista, e só elas: nada do `user_id`. */
export const ANALYSES_SELECT = "id,created_at,decision_path,verdict,score";
export const FEEDBACK_SELECT = "analysis_id,agreement,reason,updated_at";
/** Uma linha além do teto: ela só liga a marca de corte e nunca sai. */
const PROBE_ROWS = ACCOUNT_EXPORT_MAX_ROWS + 1;

/** O `timestamptz` como o PostgREST o escreve (com fuso), convertido depois para o ISO em UTC do contrato. */
const Timestamp = z.iso.datetime({ offset: true });

const AnalysisRowsSchema = z
  .array(
    z.strictObject({
      id: z.uuid(),
      created_at: Timestamp,
      decision_path: DecisionPathSchema,
      verdict: VerdictSchema,
      score: z.int().min(0).max(100),
    }),
  )
  .max(PROBE_ROWS);

const FeedbackRowsSchema = z
  .array(
    z.strictObject({
      analysis_id: z.uuid(),
      agreement: z.enum(["concordo", "discordo"]),
      reason: z.enum(["nota_alta_demais", "nota_baixa_demais", "fato_extraido_errado", "veredito_errado", "outro"]).nullable(),
      updated_at: Timestamp,
    }),
  )
  .max(PROBE_ROWS);

const DELETE_UNAVAILABLE: AccountDeletion = { done: false, unavailable: true };
const RECORDS_UNAVAILABLE: AccountRecords = { found: false, unavailable: true };

const utc = (timestamp: string): string => new Date(timestamp).toISOString();

export interface SupabaseAccountStoreDeps {
  /** Cliente de usuário próprio da conta: prazo e teto de leitura maiores que os dos critérios (ADR-029 D3 e D4). */
  readonly client: PostgrestUserClient;
}

export function createSupabaseAccountStore(deps: SupabaseAccountStoreDeps): AccountStore {
  const { client } = deps;
  return {
    async deleteOwn(subject, signal) {
      const called = await client.rpc(ACCOUNT_DELETE_FUNCTION, subject.accessToken, signal);
      if (!called.ok) return DELETE_UNAVAILABLE;
      const result = AccountDeleteResultSchema.safeParse(called.value);
      return result.success ? { done: true, result: result.data } : DELETE_UNAVAILABLE;
    },

    async records(subject, signal) {
      const owner = `eq.${subject.userId}`;
      const limit = String(PROBE_ROWS);
      const [analysesRead, feedbackRead] = await Promise.all([
        client.select("analyses", { select: ANALYSES_SELECT, user_id: owner, order: "created_at.desc,id.desc", limit }, subject.accessToken, signal),
        client.select("analysis_feedback", { select: FEEDBACK_SELECT, user_id: owner, order: "updated_at.desc,analysis_id.desc", limit }, subject.accessToken, signal),
      ]);
      if (!analysesRead.ok || !feedbackRead.ok) return RECORDS_UNAVAILABLE;
      const analysisRows = AnalysisRowsSchema.safeParse(analysesRead.value);
      const feedbackRows = FeedbackRowsSchema.safeParse(feedbackRead.value);
      if (!analysisRows.success || !feedbackRows.success) return RECORDS_UNAVAILABLE;
      const analyses: ExportedAnalysis[] = analysisRows.data.slice(0, ACCOUNT_EXPORT_MAX_ROWS).map((row) => ({
        id: row.id,
        createdAt: utc(row.created_at),
        decisionPath: row.decision_path,
        verdict: row.verdict,
        score: row.score,
      }));
      const feedback: ExportedFeedback[] = feedbackRows.data.slice(0, ACCOUNT_EXPORT_MAX_ROWS).map((row) => ({
        analysisId: row.analysis_id,
        agreement: row.agreement,
        reason: row.reason,
        updatedAt: utc(row.updated_at),
      }));
      return {
        found: true,
        analyses,
        analysesTruncated: analysisRows.data.length > ACCOUNT_EXPORT_MAX_ROWS,
        feedback,
        feedbackTruncated: feedbackRows.data.length > ACCOUNT_EXPORT_MAX_ROWS,
      };
    },
  };
}
