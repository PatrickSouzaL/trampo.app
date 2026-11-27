// Gravador do histórico (ADR-031 D1 e D7; F1-API-06 fatia 3). A rota de análise o chama depois de o `result` sair no
// stream, sem esperar: ele copia do relatório só a linha mínima (o id do servidor, o caminho, o veredito e a nota),
// grava num prazo próprio de 2.000 ms e conta o resultado na telemetria. Nunca rejeita e nunca toca no relatório:
// a análise já saiu, e a falha da gravação não muda nada do que o usuário viu.
import type { AnalysisReport } from "@trampo/contracts";

import {
  ANALYSIS_LOG_OUTCOMES,
  type AnalysisLog,
  type AnalysisLogEntry,
  type AnalysisLogOutcome,
  type AnalysisLogSubject,
} from "../ports/analysis-log.js";
import type { Clock } from "../ports/clock.js";
import type { Telemetry } from "../ports/telemetry.js";
import { withDeadline } from "../shared/with-deadline.js";

export const ANALYSIS_RECORDER_POLICY = Object.freeze({
  /** O prazo da gravação inteira (ADR-031 D1): o cliente do PostgREST tem o próprio prazo por baixo dele. */
  timeoutMs: 2_000,
});

export interface AnalysisRecorderDeps {
  readonly log: AnalysisLog;
  readonly clock: Clock;
  readonly telemetry: Telemetry;
}

const OUTCOMES: ReadonlySet<unknown> = new Set(ANALYSIS_LOG_OUTCOMES);

/** A porta é de outra camada: o que não é um dos quatro resultados conta como indisponível. */
function outcomeOf(value: unknown): AnalysisLogOutcome {
  return OUTCOMES.has(value) ? (value as AnalysisLogOutcome) : "indisponivel";
}

/** Só os quatro campos da linha mínima saem do relatório (condição 1 do ADR-031 §3). */
function entryOf(report: AnalysisReport): AnalysisLogEntry {
  return { analysisId: report.analysisId, decisionPath: report.decisionPath, verdict: report.verdict, score: report.score };
}

export class AnalysisRecorder {
  readonly #deps: AnalysisRecorderDeps;

  constructor(deps: AnalysisRecorderDeps) {
    this.#deps = deps;
  }

  /** Nunca rejeita: devolve o resultado (o que não chegou a gravar é `indisponivel`). */
  async record(subject: AnalysisLogSubject, report: AnalysisReport): Promise<AnalysisLogOutcome> {
    const { log, clock, telemetry } = this.#deps;
    const outcome = await withDeadline(
      clock,
      ANALYSIS_RECORDER_POLICY.timeoutMs,
      async (signal) => outcomeOf(await log.append(subject, entryOf(report), signal)),
      "indisponivel" as AnalysisLogOutcome,
    );
    try {
      telemetry.record({ kind: "analysis_record", outcome });
    } catch {
      // A contabilidade nunca derruba nada (ADR-010 D5).
    }
    return outcome;
  }
}
