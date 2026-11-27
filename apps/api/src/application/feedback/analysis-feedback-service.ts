// A avaliação de uma análise (ADR-031 D4 e D7; F1-API-06 fatia 4). Grava pelo AnalysisFeedbackStore num prazo próprio,
// nunca rejeita e devolve só um dos três resultados; a telemetria conta só o `agreement` da avaliação gravada. O upsert
// é idempotente: repetir depois de um `indisponivel` é seguro.
import type { AnalysisFeedbackRequest } from "@trampo/contracts";

import {
  FEEDBACK_SAVE_OUTCOMES,
  type AnalysisFeedbackStore,
  type FeedbackSaveOutcome,
} from "../ports/analysis-feedback-store.js";
import type { AnalysisLogSubject } from "../ports/analysis-log.js";
import type { Clock } from "../ports/clock.js";
import type { Telemetry } from "../ports/telemetry.js";
import { withDeadline } from "../shared/with-deadline.js";

export const ANALYSIS_FEEDBACK_POLICY = Object.freeze({
  /** O prazo da gravação inteira: o cliente do PostgREST tem o próprio prazo por baixo dele. */
  timeoutMs: 2_000,
});

export interface AnalysisFeedbackServiceDeps {
  readonly store: AnalysisFeedbackStore;
  readonly clock: Clock;
  readonly telemetry: Telemetry;
}

const OUTCOMES: ReadonlySet<unknown> = new Set(FEEDBACK_SAVE_OUTCOMES);

export class AnalysisFeedbackService {
  readonly #deps: AnalysisFeedbackServiceDeps;

  constructor(deps: AnalysisFeedbackServiceDeps) {
    this.#deps = deps;
  }

  /** Nunca rejeita. Do corpo, só os dois campos do contrato seguem adiante. */
  async save(subject: AnalysisLogSubject, analysisId: string, feedback: AnalysisFeedbackRequest): Promise<FeedbackSaveOutcome> {
    const { store, clock, telemetry } = this.#deps;
    const entry = { analysisId, agreement: feedback.agreement, reason: feedback.reason };
    const outcome = await withDeadline(
      clock,
      ANALYSIS_FEEDBACK_POLICY.timeoutMs,
      async (signal) => {
        const saved: unknown = await store.save(subject, entry, signal);
        return OUTCOMES.has(saved) ? (saved as FeedbackSaveOutcome) : "indisponivel";
      },
      "indisponivel" as FeedbackSaveOutcome,
    );
    if (outcome === "gravada") {
      try {
        telemetry.record({ kind: "analysis_feedback", agreement: entry.agreement });
      } catch {
        // A contabilidade nunca derruba nada (ADR-010 D5).
      }
    }
    return outcome;
  }
}
