// Construtores do ReportComposer (F1-DOM-03). O envelope imita o que o AnalyzeJob monta; o ScoreResult sai do
// motor real (propriedades) ou é montado à mão (exaustivo), já que o composer aceita qualquer ScoreResult tipado.
import { AnalysisReportSchema, type AnalysisReport, type AnalysisWarning, type ScoreDimension, type UserCriteria } from "@trampo/contracts";

import {
  SCORE_DIMENSIONS,
  ScoringEngine,
  ReportComposer,
  type DimensionEvaluation,
  type ReportEnvelope,
  type ScoreResult,
  type ScoringInput,
} from "../../../src/domain/index.js";

export const ENVELOPE: ReportEnvelope = Object.freeze({
  analysisId: "0b6c0b9e-6f43-4d4a-9a39-0d8f1f0c2a11",
  requestId: "6f1d4b0e-2a7c-4c3e-8b1a-3f7e9d2c5b44",
  createdAt: "2026-10-21T12:00:00.000Z",
  platform: "linkedin",
  decisionPath: "extracao_llm",
  extractorVersion: "jf-p3-s1",
  provider: "groq",
  durationMs: 1_234,
});

export const engine = new ScoringEngine();
export const composer = new ReportComposer();

export function composeFor(
  i: ScoringInput,
  c: UserCriteria,
  options: { warnings?: readonly AnalysisWarning[]; effectiveConfidence?: number } = {},
): { report: AnalysisReport; score: ScoreResult } {
  const score = engine.score(i, c);
  const report = composer.compose({
    envelope: ENVELOPE,
    resolution: { facts: i.facts, provenance: i.provenance, effectiveConfidence: options.effectiveConfidence ?? 0.8 },
    warnings: options.warnings ?? [],
    score,
  });
  return { report, score };
}

/** Linha neutra do breakdown; o teste sobrescreve o que importa. */
export const evaluation = (dimension: ScoreDimension, over: Partial<DimensionEvaluation> = {}): DimensionEvaluation => ({
  dimension,
  outcome: "ignorado",
  importance: "ignorar",
  points: 0,
  dealBreakerHit: false,
  reason: "ignorado",
  ...over,
});

/** ScoreResult montado à mão: as 9 linhas na ordem do enum, com as sobrescritas por dimensão. */
export function scoreResult(
  lines: Partial<Record<ScoreDimension, Partial<DimensionEvaluation>>> = {},
  over: Partial<Omit<ScoreResult, "breakdown">> = {},
): ScoreResult {
  return {
    score: 50,
    verdict: "neutro",
    dealBreakerHit: false,
    neutralBase: 0,
    breakdown: SCORE_DIMENSIONS.map((d) => evaluation(d, lines[d])),
    redFlagHits: [],
    engineVersion: "se1",
    ...over,
  };
}

/** Falha com as issues do zod: a mensagem diz qual texto quebrou o contrato. */
export function expectValidReport(report: AnalysisReport): void {
  const result = AnalysisReportSchema.safeParse(report);
  if (!result.success) throw new Error(`relatório inválido: ${JSON.stringify(result.error.issues)}\n${JSON.stringify(report)}`);
}
