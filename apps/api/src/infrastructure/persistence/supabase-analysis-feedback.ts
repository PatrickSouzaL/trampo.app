// AnalysisFeedbackStore sobre o PostgREST do Supabase (ADR-031 D4). Um upsert por `on_conflict=analysis_id` com o token
// do dono e as 4 colunas da lista fechada (o `updated_at` é do banco, D2). O dono vem só do sujeito verificado; a FK
// composta (analysis_id, user_id) e a RLS recusam a análise de outro dono, e o cliente classifica a resposta só pelo
// status, sem ler o corpo. Entra no composeApp sempre embrulhado no AnalysisFeedbackService.
import type { AnalysisFeedbackStore } from "../../application/ports/analysis-feedback-store.js";
import type { PostgrestUserClient } from "../supabase/postgrest-user-client.js";

/** As colunas do upsert, e só elas (ADR-031 D4). */
export const ANALYSIS_FEEDBACK_COLUMNS = Object.freeze(["analysis_id", "user_id", "agreement", "reason"] as const);

export interface SupabaseAnalysisFeedbackStoreDeps {
  readonly client: PostgrestUserClient;
}

export function createSupabaseAnalysisFeedbackStore(deps: SupabaseAnalysisFeedbackStoreDeps): AnalysisFeedbackStore {
  const { client } = deps;
  return {
    save(subject, entry, signal) {
      const row = { analysis_id: entry.analysisId, user_id: subject.userId, agreement: entry.agreement, reason: entry.reason };
      return client.upsertClassified(
        "analysis_feedback",
        { columns: ANALYSIS_FEEDBACK_COLUMNS, onConflict: "analysis_id", row },
        subject.accessToken,
        signal,
      );
    },
  };
}
