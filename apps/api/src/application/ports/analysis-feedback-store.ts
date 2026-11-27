// A avaliação de uma análise pelo dono (ADR-031 D4). O adapter em Supabase fica em infrastructure/persistence e entra
// sempre embrulhado no AnalysisFeedbackService (prazo, telemetria e o "nunca rejeita"). O dono vem só do `sub`
// verificado; o banco confere, pela FK composta e pela RLS, que a análise é dele.
import type { AnalysisFeedbackRequest } from "@trampo/contracts";

import type { AnalysisLogSubject } from "./analysis-log.js";

/**
 * `negada` junta a análise que não existe e a de outro dono (o 409 `23503` e o 403 `42501`): a rota responde as duas
 * do mesmo jeito, sem oráculo de existência (ADR-031 D4).
 */
export const FEEDBACK_SAVE_OUTCOMES = Object.freeze(["gravada", "negada", "indisponivel"] as const);
export type FeedbackSaveOutcome = (typeof FEEDBACK_SAVE_OUTCOMES)[number];

/** A avaliação: o id da análise (do caminho) e os dois campos do corpo. O dono nunca vem do pedido. */
export interface AnalysisFeedbackEntry {
  readonly analysisId: string;
  readonly agreement: AnalysisFeedbackRequest["agreement"];
  readonly reason: AnalysisFeedbackRequest["reason"];
}

export interface AnalysisFeedbackStore {
  save(subject: AnalysisLogSubject, entry: AnalysisFeedbackEntry, signal?: AbortSignal): Promise<FeedbackSaveOutcome>;
}
