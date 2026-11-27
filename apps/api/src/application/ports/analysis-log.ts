// O histórico das análises (ADR-031 D1): a linha mínima de uma análise que já saiu no stream. O adapter em Supabase
// fica em infrastructure/persistence e entra sempre embrulhado no AnalysisRecorder (prazo, telemetria e o "nunca
// rejeita"). Como nos critérios, o dono vem do `sub` verificado e o token só trafega até o PostgREST, para a RLS valer.
import type { DecisionPath, Verdict } from "@trampo/contracts";

/** Os quatro resultados de uma gravação (ADR-031 D7): o rótulo `outcome` da métrica `analysis_record_total`. */
export const ANALYSIS_LOG_OUTCOMES = Object.freeze(["gravada", "recusada", "limite", "indisponivel"] as const);
export type AnalysisLogOutcome = (typeof ANALYSIS_LOG_OUTCOMES)[number];

/** O dono da linha: o `sub` verificado e o mesmo token já verificado nesta requisição. */
export interface AnalysisLogSubject {
  readonly userId: string;
  readonly accessToken: string;
}

/**
 * A linha mínima (ADR-031 D1): o id do servidor, o caminho, o veredito e a nota. Nunca texto, título, empresa,
 * `requestId`, plataforma, versões nem provedor (T38). O `created_at` é do banco (D2).
 */
export interface AnalysisLogEntry {
  readonly analysisId: string;
  readonly decisionPath: DecisionPath;
  readonly verdict: Verdict;
  readonly score: number;
}

export interface AnalysisLog {
  /** Grava uma linha. `gravada` só com o 201; o resto é recusa, o teto do banco ou indisponível. */
  append(subject: AnalysisLogSubject, entry: AnalysisLogEntry, signal?: AbortSignal): Promise<AnalysisLogOutcome>;
}
