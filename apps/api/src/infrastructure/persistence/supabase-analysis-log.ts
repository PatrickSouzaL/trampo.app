// AnalysisLog sobre o PostgREST do Supabase (ADR-031 D1). Um insert simples em `analyses` com o token do dono: as 5
// colunas da lista fechada, o id da análise (do servidor) e o dono do sujeito verificado. O banco força o relógio e o
// teto por usuário (D2), e a RLS é a segunda barreira. Entra no composeApp sempre embrulhado no AnalysisRecorder.
import type { AnalysisLog } from "../../application/ports/analysis-log.js";
import type { PostgrestUserClient } from "../supabase/postgrest-user-client.js";

/** As colunas da linha mínima, e só elas (ADR-031 D1). */
export const ANALYSES_INSERT_COLUMNS = Object.freeze(["id", "user_id", "decision_path", "verdict", "score"] as const);

export interface SupabaseAnalysisLogDeps {
  readonly client: PostgrestUserClient;
}

export function createSupabaseAnalysisLog(deps: SupabaseAnalysisLogDeps): AnalysisLog {
  const { client } = deps;
  return {
    append(subject, entry, signal) {
      const row = {
        id: entry.analysisId,
        user_id: subject.userId,
        decision_path: entry.decisionPath,
        verdict: entry.verdict,
        score: entry.score,
      };
      return client.insert("analyses", { columns: ANALYSES_INSERT_COLUMNS, row }, subject.accessToken, signal);
    },
  };
}
