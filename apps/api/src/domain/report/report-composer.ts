// E8 ReportComposer (ADR-001 §5.8; ADR-012). Domínio puro: monta o AnalysisReport a partir do ScoreResult e dos
// fatos resolvidos, com textos do catálogo pt-BR. NÃO recebe os critérios do usuário (SR-11 por construção) e
// só interpola rótulos de enum dos fatos da vaga; título, cidade, país e tags de stack nunca entram em texto.
// Não valida a própria saída (o domínio não roda zod): o AnalyzeJob faz AnalysisReportSchema.parse.
import type {
  AnalysisReport,
  AnalysisWarning,
  DecisionPath,
  LlmProviderId,
  Platform,
  ReportItem,
  ResolvedJobFacts,
  ScoreBreakdownEntry,
  ScoreDimension,
} from "@trampo/contracts";

import type { FactField, FactProvenance } from "../fusion/fact-resolver.js";
import type { DimensionEvaluation, RedFlagEffect, ScoreReasonCode, ScoreResult } from "../scoring/scoring-engine.js";
import { SENIORITY_LEVELS } from "../scoring/scoring-policy.js";
import {
  ANALYSIS_WARNINGS,
  CONTRACT_TYPES,
  DEFAULT_REPORT_CATALOG,
  SPECIFIC_REASON_CODES,
  SUMMARY_AGAINST_MAX,
  SUMMARY_ELIMINATED_MAX,
  SUMMARY_FAVOR_MAX,
  WORK_MODELS,
  reportCatalogIssues,
  type ReportCatalog,
  type SpecificReasonCode,
} from "./report-catalog.js";

/** O que só a aplicação sabe: ids, relógio e o caminho no funil (o domínio não tem relógio nem aleatoriedade). */
export interface ReportEnvelope {
  readonly analysisId: string;
  readonly requestId: string;
  /** ISO 8601, do `Clock` da aplicação. */
  readonly createdAt: string;
  readonly platform: Platform;
  readonly decisionPath: DecisionPath;
  readonly extractorVersion: string | null;
  readonly provider: LlmProviderId | null;
  readonly durationMs: number;
}

/** A parte do `FactResolution` (ADR-011) que vai para o relatório. */
export interface ReportResolution {
  readonly facts: ResolvedJobFacts;
  readonly provenance: Readonly<Record<FactField, FactProvenance>>;
  readonly effectiveConfidence: number;
}

export interface ReportComposerInput {
  readonly envelope: ReportEnvelope;
  readonly resolution: ReportResolution;
  /** Do resolver, da borda e do AnalyzeJob; o composer só tira duplicatas e ordena pelo enum. */
  readonly warnings: readonly AnalysisWarning[];
  readonly score: ScoreResult;
}

const REPORT_SCHEMA_VERSION: AnalysisReport["schemaVersion"] = 1;
const STRENGTHS_MAX = 3;
const RED_FLAGS_MAX = 3;

const SPECIFIC_REASONS: ReadonlySet<string> = new Set(SPECIFIC_REASON_CODES);
const isSpecific = (reason: ScoreReasonCode): reason is SpecificReasonCode => SPECIFIC_REASONS.has(reason);

const STRICT_IMPORTANCE: ReadonlySet<string> = new Set(["obrigatorio", "eliminatorio"]);
/** Linhas que o ADR-001 §5.8 trata como must-have violado mesmo fora de `nao_atende` estrito (ADR-012 D5). */
const SEVERE_REASONS: ReadonlySet<string> = new Set(["conflito_eliminatorio", "senioridade_rebaixamento"]);
const WEAK_OUTCOMES: ReadonlySet<string> = new Set(["nao_atende", "atende_parcialmente"]);
const MISSING_OUTCOMES: ReadonlySet<string> = new Set(["nao_informado", "conflito"]);

const byPointsDesc = (a: DimensionEvaluation, b: DimensionEvaluation): number => b.points - a.points;
const byPointsAsc = (a: DimensionEvaluation, b: DimensionEvaluation): number => a.points - b.points;

/** Os valores presentes, na ordem do enum (a ordem da vaga não importa no texto). */
function labelsInOrder<T extends string>(order: readonly T[], present: readonly T[], labels: Readonly<Record<T, string>>): string[] {
  const set = new Set<string>(present);
  return order.filter((value) => set.has(value)).map((value) => labels[value]);
}

export class ReportComposer {
  readonly #catalog: ReportCatalog;

  constructor(catalog: ReportCatalog = DEFAULT_REPORT_CATALOG) {
    const issues = reportCatalogIssues(catalog);
    if (issues.length > 0) {
      throw new RangeError(`ReportCatalog incoerente (ADR-012 D6): ${issues.join("; ")}.`);
    }
    this.#catalog = catalog;
  }

  compose(input: ReportComposerInput): AnalysisReport {
    const { envelope, resolution, score } = input;
    const lines = score.breakdown;
    // `sort` é estável: no empate, fica a ordem do enum em que o motor entrega o breakdown.
    const strengths = lines.filter((line) => line.outcome === "atende" && line.points > 0).sort(byPointsDesc);
    const redFlags = this.#redFlagCandidates(score);
    const present = new Set<string>(input.warnings);
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      analysisId: envelope.analysisId,
      requestId: envelope.requestId,
      createdAt: envelope.createdAt,
      platform: envelope.platform,
      score: score.score,
      verdict: score.verdict,
      summary: this.#summary(score, strengths, redFlags),
      dealBreakerHit: score.dealBreakerHit,
      strengths: strengths.slice(0, STRENGTHS_MAX).map((line) => this.#item(line)),
      redFlags: redFlags.slice(0, RED_FLAGS_MAX),
      missingInfo: lines.filter((line) => MISSING_OUTCOMES.has(line.outcome)).map((line) => this.#item(line)),
      breakdown: lines.map((line) => this.#entry(line, resolution.facts)),
      warnings: ANALYSIS_WARNINGS.filter((warning) => present.has(warning)),
      decisionPath: envelope.decisionPath,
      facts: resolution.facts,
      provenance: { ...resolution.provenance },
      effectiveConfidence: resolution.effectiveConfidence,
      meta: {
        engineVersion: score.engineVersion,
        reportCatalogVersion: this.#catalog.version,
        extractorVersion: envelope.extractorVersion,
        provider: envelope.provider,
        durationMs: envelope.durationMs,
      },
    };
  }

  /** `<dimensão>: <outcome>` e, se a reason for específica, a frase dela (ADR-012 D4). */
  #line(line: DimensionEvaluation): string {
    const c = this.#catalog;
    const head = `${c.dimensions[line.dimension]}: ${c.outcomes[line.outcome]}`;
    return isSpecific(line.reason) ? `${head} ${c.reasons[line.reason]}` : head;
  }

  #item(line: DimensionEvaluation): ReportItem {
    return { dimension: line.dimension, text: this.#line(line) };
  }

  #entry(line: DimensionEvaluation, facts: ResolvedJobFacts): ScoreBreakdownEntry {
    return {
      dimension: line.dimension,
      outcome: line.outcome,
      importance: line.importance,
      points: line.points,
      dealBreakerHit: line.dealBreakerHit,
      explanation: `${this.#line(line)}${this.#detail(line, facts)}`,
    };
  }

  /** Rótulos dos fatos da vaga, só onde o fato é enum (ADR-012 D4). Nenhuma string nem número do LLM. */
  #detail(line: DimensionEvaluation, facts: ResolvedJobFacts): string {
    const c = this.#catalog;
    if (line.outcome === "ignorado") return "";
    const list = (labels: readonly string[]): string => (labels.length === 0 ? "" : ` ${c.jobValues}: ${labels.join(", ")}.`);
    if (line.dimension === "modelo_trabalho") return list(labelsInOrder(WORK_MODELS, facts.workModels, c.workModels));
    if (line.dimension === "senioridade") return list(labelsInOrder(SENIORITY_LEVELS, facts.seniorityLevels, c.seniorityLevels));
    if (line.dimension === "contrato") return list(labelsInOrder(CONTRACT_TYPES, facts.contractTypes, c.contractTypes));
    const currency = facts.salary?.currency ?? null;
    if (line.reason === "salario_convertido" && currency !== null) return ` ${c.jobCurrency}: ${c.currencies[currency]}.`;
    return "";
  }

  #signals(score: ScoreResult, effect: RedFlagEffect): ReportItem[] {
    const c = this.#catalog;
    return score.redFlagHits
      .filter((hit) => hit.effect === effect)
      .map((hit) => ({ dimension: "red_flags", text: `${c.dimensions.red_flags}: ${c.redFlags[hit.signal]}, ${c.redFlagEffects[effect]}.` }));
  }

  /** Prioridade do ADR-001 §5.8 (ADR-012 D5), sem o corte de 3: o `summary` também a usa. */
  #redFlagCandidates(score: ScoreResult): ReportItem[] {
    const others = score.breakdown.filter((line) => line.dimension !== "red_flags");
    const violated = others
      .filter(
        (line) =>
          !line.dealBreakerHit &&
          ((line.outcome === "nao_atende" && STRICT_IMPORTANCE.has(line.importance)) || SEVERE_REASONS.has(line.reason)),
      )
      .sort(byPointsAsc);
    return [
      ...others.filter((line) => line.dealBreakerHit).map((line) => this.#item(line)),
      ...this.#signals(score, "eliminatoria"),
      ...violated.map((line) => this.#item(line)),
      ...this.#signals(score, "penalidade"),
      ...this.#signals(score, "alerta"),
    ];
  }

  /** Template da faixa (ADR-002 §3.4; ADR-012 D4). */
  #summary(score: ScoreResult, strengths: readonly DimensionEvaluation[], redFlags: readonly ReportItem[]): string {
    const c = this.#catalog;
    const names = (dimensions: readonly ScoreDimension[]): string => dimensions.map((d) => c.dimensions[d]).join(", ");
    if (score.dealBreakerHit) {
      const eliminated = score.breakdown.filter((line) => line.dealBreakerHit).map((line) => line.dimension);
      return `${c.dealBreakerVerdict} ${c.scoreLabel} ${score.score}. ${c.eliminatedBy}: ${names(eliminated.slice(0, SUMMARY_ELIMINATED_MAX))}.`;
    }
    const parts = [`${c.verdicts[score.verdict]} ${c.scoreLabel} ${score.score}.`];
    const favor = strengths.slice(0, SUMMARY_FAVOR_MAX).map((line) => line.dimension);
    // Sem nenhuma dimensão na média não há ponto positivo: "A favor" e a nota da base neutra se excluem.
    if (favor.length > 0) parts.push(`${c.inFavor}: ${names(favor)}.`);
    else if (score.neutralBase > 0) parts.push(c.emptyBaseNote);
    const weak = score.breakdown.filter((line) => WEAK_OUTCOMES.has(line.outcome)).sort(byPointsAsc);
    const against = [...new Set([...redFlags.map((item) => item.dimension), ...weak.map((line) => line.dimension)])];
    if (against.length > 0) parts.push(`${c.against}: ${names(against.slice(0, SUMMARY_AGAINST_MAX))}.`);
    return parts.join(" ");
  }
}
