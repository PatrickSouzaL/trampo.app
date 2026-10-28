// S-1, Trilha A3 (HITL-031 1A): o efeito da stack extraída na nota. Roda o `ScoringEngine` real (`se1`, sem mudança) nos
// casos do gd1 com os fatos do gabarito e com os MESMOS fatos trocando só as duas listas de stack pelas de uma saída do LLM.
// Personas do S-4 mapeadas para `UserCriteria`. Sem rede. O resultado tem só ids, enums e números (nenhum termo de stack).
import { FactFieldSchema, UserCriteriaSchema, type JobFacts, type ResolvedJobFacts, type UserCriteria, type Verdict } from "@trampo/contracts";
import { RED_FLAG_SIGNALS, SCORING_ENGINE_VERSION, ScoringEngine, type FactField, type FactProvenance, type ScoreResult } from "../../../apps/api/src/domain/index.js";
import type { GoldenCase } from "../../src/case-schema.js";
import type { Level, Persona } from "../s4-layer1/routing.js";
import { stackKey } from "./score.js";

/** Peso do `ponderado` (o S-4 não tem peso): o meio da escala de 1 a 5. */
export const PONDERADO_WEIGHT = 3;
/** Gate do HITL-031 1A: até 5% dos pares (caso × persona) mudando de faixa nas personas do S-4. */
export const BAND_CHANGE_GATE = 0.05;
/** Pior caso (fora do gate): quantos dos falsos positivos mais frequentes a persona marca. */
export const WORST_CASE_TERMS = 5;

const VERDICT_RANK: Readonly<Record<Verdict, number>> = { foge: 0, baixo_alinhamento: 1, neutro: 2, recomendado: 3, altamente_recomendado: 4 };

const importance = (level: Level): UserCriteria["workModel"]["importance"] =>
  level === "ponderado" ? { level, weight: PONDERADO_WEIGHT } : { level };

/**
 * Persona do S-4 → `UserCriteria` validado pelo contrato. Localização, idiomas e benefícios ficam nulos (o S-4 não os
 * define, e o fato é o mesmo nos dois lados); red flags em `alertar`, sem peso na nota.
 */
export function toUserCriteria(p: Persona): UserCriteria {
  const criteria = {
    schemaVersion: 1,
    workModel: { accepted: [...p.workModel.accepted], importance: importance(p.workModel.level) },
    seniority: { accepted: [...p.seniority.accepted], importance: importance(p.seniority.level) },
    contractType: { accepted: [...p.contract.accepted], importance: importance(p.contract.level) },
    salary: p.salary === null ? null : { minimum: p.salary.minimumBrlMonth, currency: "BRL", period: "mes", importance: importance(p.salary.level) },
    location: null,
    stack: { mustHave: [...p.stack.mustHave], niceToHave: [], dealBreakers: [...p.stack.dealBreakers], dealBreakerScope: p.stack.scope, niceToHaveWeight: 0 },
    languages: null,
    benefits: null,
    redFlagTolerance: Object.fromEntries(RED_FLAG_SIGNALS.map((s) => [s, "alertar"])),
    notes: null,
  };
  return UserCriteriaSchema.parse(criteria);
}

/** Proveniência `llm` em todos os campos: o mesmo nos dois lados, sem `conflito`. */
const PROVENANCE = Object.fromEntries(FactFieldSchema.options.map((f) => [f, "llm"])) as Readonly<Record<FactField, FactProvenance>>;

/** O lado "LLM": o gabarito com só as duas listas de stack trocadas (isola a stack). */
export function withStack(gold: ResolvedJobFacts, got: Pick<JobFacts, "stackRequired" | "stackNiceToHave">): ResolvedJobFacts {
  return { ...gold, stackRequired: [...got.stackRequired], stackNiceToHave: [...got.stackNiceToHave] };
}

/** Variantes de stack do gabarito (golden-dataset-spec §5.2): o `expected` e cada alternativa das duas listas. */
export function goldStackVariants(golden: GoldenCase): ResolvedJobFacts[] {
  const out = [golden.expected];
  for (const field of ["stackRequired", "stackNiceToHave"] as const) {
    for (const alt of (golden.alternatives[field] ?? []) as string[][]) out.push({ ...golden.expected, [field]: alt });
  }
  return out;
}

export interface PairOutcome {
  readonly caseId: string;
  readonly personaId: string;
  readonly goldVerdict: Verdict;
  readonly llmVerdict: Verdict;
  readonly scoreDelta: number;
  /** A faixa mudou contra o `expected` (gate). */
  readonly bandChanged: boolean;
  /** A faixa do LLM não é a de nenhuma variante de stack do gabarito. */
  readonly bandChangedVsAlternatives: boolean;
  /** Deal-breaker de stack só no lado do LLM (o termo a mais derruba a vaga). */
  readonly falseDealBreaker: boolean;
  /** Deal-breaker de stack só no gabarito (o termo que faltou salva a vaga). */
  readonly missedDealBreaker: boolean;
  readonly stackOutcomeChanged: boolean;
}

const stackEval = (r: ScoreResult) => r.breakdown.find((d) => d.dimension === "stack");

export function scorePair(engine: ScoringEngine, golden: GoldenCase, got: Pick<JobFacts, "stackRequired" | "stackNiceToHave">, personaId: string, criteria: UserCriteria): PairOutcome {
  const run = (facts: ResolvedJobFacts): ScoreResult => engine.score({ facts, provenance: PROVENANCE, llmExtracted: true }, criteria);
  const gold = run(golden.expected);
  const variants = goldStackVariants(golden).map(run);
  const llm = run(withStack(golden.expected, got));
  const gs = stackEval(gold);
  const ls = stackEval(llm);
  return {
    caseId: golden.id,
    personaId,
    goldVerdict: gold.verdict,
    llmVerdict: llm.verdict,
    scoreDelta: llm.score - gold.score,
    bandChanged: gold.verdict !== llm.verdict,
    bandChangedVsAlternatives: !variants.some((v) => v.verdict === llm.verdict),
    falseDealBreaker: ls?.dealBreakerHit === true && gs?.dealBreakerHit !== true,
    missedDealBreaker: gs?.dealBreakerHit === true && ls?.dealBreakerHit !== true,
    stackOutcomeChanged: gs?.outcome !== ls?.outcome,
  };
}

export interface GroupSummary {
  readonly pairs: number;
  readonly bandChanged: number;
  readonly bandChangedRate: number;
  readonly bandChangedVsAlternatives: number;
  readonly up: number;
  readonly down: number;
  /** Mudanças de mais de uma faixa. */
  readonly multiBand: number;
  readonly falseDealBreakers: number;
  readonly missedDealBreakers: number;
  readonly stackOutcomeChanged: number;
  readonly scoreChanged: number;
  readonly meanAbsScoreDelta: number;
  readonly maxAbsScoreDelta: number;
  readonly transitions: Readonly<Record<string, number>>;
  readonly changedCases: readonly string[];
}

export function summarize(pairs: readonly PairOutcome[]): GroupSummary {
  const changed = pairs.filter((p) => p.bandChanged);
  const rankDelta = (p: PairOutcome): number => VERDICT_RANK[p.llmVerdict] - VERDICT_RANK[p.goldVerdict];
  const transitions: Record<string, number> = {};
  for (const p of changed) {
    const k = `${p.goldVerdict}->${p.llmVerdict}`;
    transitions[k] = (transitions[k] ?? 0) + 1;
  }
  const abs = pairs.map((p) => Math.abs(p.scoreDelta));
  const round = (n: number): number => Math.round(n * 10_000) / 10_000;
  return {
    pairs: pairs.length,
    bandChanged: changed.length,
    bandChangedRate: pairs.length === 0 ? 0 : round(changed.length / pairs.length),
    bandChangedVsAlternatives: pairs.filter((p) => p.bandChangedVsAlternatives).length,
    up: changed.filter((p) => rankDelta(p) > 0).length,
    down: changed.filter((p) => rankDelta(p) < 0).length,
    multiBand: changed.filter((p) => Math.abs(rankDelta(p)) > 1).length,
    falseDealBreakers: pairs.filter((p) => p.falseDealBreaker).length,
    missedDealBreakers: pairs.filter((p) => p.missedDealBreaker).length,
    stackOutcomeChanged: pairs.filter((p) => p.stackOutcomeChanged).length,
    scoreChanged: pairs.filter((p) => p.scoreDelta !== 0).length,
    meanAbsScoreDelta: abs.length === 0 ? 0 : round(abs.reduce((a, b) => a + b, 0) / abs.length),
    maxAbsScoreDelta: abs.length === 0 ? 0 : Math.max(...abs),
    transitions,
    changedCases: [...new Set(changed.map((p) => p.caseId))].sort(),
  };
}

/**
 * Falsos positivos de stack do LLM pela `stackKey` do avaliador (com a equivalência de nome): termo cuja chave não está
 * em nenhuma variante do gabarito (nas duas listas). Devolve, por chave, o número de casos e a grafia mais frequente.
 */
export function falsePositiveRanking(items: readonly { readonly golden: GoldenCase; readonly got: Pick<JobFacts, "stackRequired" | "stackNiceToHave"> }[]): { key: string; cases: number; surface: string }[] {
  const byKey = new Map<string, { cases: Set<string>; surfaces: Map<string, number> }>();
  for (const { golden, got } of items) {
    const goldKeys = new Set(goldStackVariants(golden).flatMap((f) => [...f.stackRequired, ...f.stackNiceToHave].map(stackKey)));
    for (const term of [...got.stackRequired, ...got.stackNiceToHave]) {
      const key = stackKey(term);
      if (goldKeys.has(key)) continue;
      const entry = byKey.get(key) ?? { cases: new Set<string>(), surfaces: new Map<string, number>() };
      entry.cases.add(golden.id);
      const surface = term.trim();
      entry.surfaces.set(surface, (entry.surfaces.get(surface) ?? 0) + 1);
      byKey.set(key, entry);
    }
  }
  return [...byKey.entries()]
    .map(([key, e]) => ({ key, cases: e.cases.size, surface: [...e.surfaces.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? key }))
    .sort((a, b) => b.cases - a.cases || a.key.localeCompare(b.key));
}

/**
 * Pior caso (fora do gate): a persona só-ponderado do S-4 marcando os termos que mais aparecem como falso positivo,
 * como deal-breaker (`qualquer_mencao`) ou como must-have. Termos com chave igual ao lowercase ficam de fora da lista
 * duplicada pelo contrato.
 */
export function worstCasePersonas(base: Persona, terms: readonly string[]): Persona[] {
  const unique = [...new Map(terms.map((t) => [t.toLowerCase(), t])).values()];
  return [
    { ...base, id: "pior-deal-breaker", stack: { mustHave: [], dealBreakers: unique, scope: "qualquer_mencao" } },
    { ...base, id: "pior-must-have", stack: { mustHave: unique, dealBreakers: [], scope: "somente_obrigatoria" } },
  ];
}

export const ENGINE_VERSION = SCORING_ENGINE_VERSION;
