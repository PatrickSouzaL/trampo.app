// E7 ScoringEngine (ADR-001 §5.7; ADR-002). Domínio puro: a única autoridade da nota. Sem I/O, relógio,
// aleatoriedade, log ou texto livre; mesma entrada e mesma política dão a mesma saída, bit a bit.
// Strings vindas do LLM (tags de stack e cidade) só entram por igualdade exata após dobra contra a lista
// fechada do usuário (ADR-002 §4.1 e §5.1; a regra de lint do diretório proíbe busca em string e regex).
import type {
  AppliedImportance,
  CriterionImportance,
  Currency,
  DimensionOutcome,
  LanguageLevel,
  LanguageRequirement,
  RedFlagSignal,
  ResolvedJobFacts,
  SalaryFacts,
  SalaryPeriod,
  ScoreDimension,
  SeniorityLevel,
  UserCriteria,
  Verdict,
} from "@trampo/contracts";

import type { FactField, FactProvenance } from "../fusion/fact-resolver.js";
import { DependencyContractError } from "../text/code-points.js";
import {
  DEFAULT_SCORING_POLICY,
  LANGUAGE_LEVELS,
  RED_FLAG_SIGNALS,
  SCORE_DIMENSIONS,
  SCORING_ENGINE_VERSION,
  scoringPolicyIssues,
  type ScoringPolicy,
} from "./scoring-policy.js";

/** Enum fechado (ADR-002 §4.3): entrada do ReportComposer (F1-DOM-03). O motor não emite string livre. */
export type ScoreReasonCode =
  | DimensionOutcome
  | "deal_breaker_stack_exigida"
  | "deal_breaker_stack_desejavel"
  | "deal_breaker_red_flag"
  | "conflito_eliminatorio"
  | "localizacao_nao_se_aplica"
  | "idioma_nao_exigido"
  | "stack_nao_informada"
  | "salario_convertido"
  | "salario_moeda_indeterminada"
  | "senioridade_adjacente_acima"
  | "senioridade_adjacente_validada"
  | "senioridade_rebaixamento"
  | "idioma_ingles_internacional"
  | "red_flag_atenuada_por_beneficios";

export type RedFlagEffect = "alerta" | "penalidade" | "eliminatoria";

export interface RedFlagHit {
  readonly signal: RedFlagSignal;
  readonly effect: RedFlagEffect;
}

export interface DimensionEvaluation {
  readonly dimension: ScoreDimension;
  readonly outcome: DimensionOutcome;
  readonly importance: AppliedImportance;
  /** Inteiro em [−30, 100]: contribuição na base mais a penalidade. */
  readonly points: number;
  readonly dealBreakerHit: boolean;
  readonly reason: ScoreReasonCode;
}

export interface ScoreResult {
  /** Inteiro em [0, 100]. */
  readonly score: number;
  readonly verdict: Verdict;
  readonly dealBreakerHit: boolean;
  /**
   * `emptyBase` quando nenhuma dimensão entra na média (todas ignoradas), senão 0. Mantém a auditoria
   * `score = min(teto?, clamp(neutralBase + Σ points, 0, 100))` sem atribuir a base a uma dimensão.
   */
  readonly neutralBase: number;
  /** As 9 dimensões, na ordem do enum `ScoreDimension`. */
  readonly breakdown: readonly DimensionEvaluation[];
  /** Na ordem do enum `RedFlagSignal`. */
  readonly redFlagHits: readonly RedFlagHit[];
  readonly engineVersion: typeof SCORING_ENGINE_VERSION;
}

export interface ScoringInput {
  readonly facts: ResolvedJobFacts;
  readonly provenance: Readonly<Record<FactField, FactProvenance>>;
  /** D-S6: `decisionPath ∈ {extracao_llm, cache_jobfacts}`. Distingue "a vaga não exige" de "não sabemos". */
  readonly llmExtracted: boolean;
}

/** Uma parcela da base ponderada: peso e razão de atendimento r ∈ [0, 1]. */
interface Share {
  readonly weight: number;
  readonly ratio: number;
}

interface Assessment {
  readonly outcome: DimensionOutcome;
  readonly importance: AppliedImportance;
  readonly shares: readonly Share[];
  /** Inteiro ≤ 0, nunca −0. */
  readonly penalty: number;
  readonly dealBreakerHit: boolean;
  readonly reason: ScoreReasonCode;
}

type Rated = Exclude<DimensionOutcome, "ignorado">;

const IGNORED: Assessment = Object.freeze({
  outcome: "ignorado",
  importance: "ignorar",
  shares: Object.freeze([]),
  penalty: 0,
  dealBreakerHit: false,
  reason: "ignorado",
});

const LANGUAGE_RANK: Readonly<Record<LanguageLevel, number>> = Object.freeze(
  Object.fromEntries(LANGUAGE_LEVELS.map((level, rank) => [level, rank])) as Record<LanguageLevel, number>,
);

/** `0 - n` e não `-n`: −0 quebraria a igualdade estrita (Object.is) dos testes e não é um inteiro "limpo". */
const negate = (n: number): number => 0 - n;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const sum = (values: readonly number[]): number => values.reduce((acc, value) => acc + value, 0);

const lowerSet = (terms: readonly string[]): ReadonlySet<string> => new Set(terms.map((t) => t.toLowerCase()));

const countIn = (terms: ReadonlySet<string>, pool: ReadonlySet<string>): number => [...terms].filter((t) => pool.has(t)).length;

/** Marcas combinantes dos blocos latinos e genéricos (U+0300–036F, 1AB0–1AFF, 1DC0–1DFF, 20D0–20FF, FE20–FE2F). */
function isCombiningMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

/**
 * Dobra da cidade (ADR-002 §4.1): NFKC → minúsculas → NFD sem marcas → espaços colapsados, sem regex.
 * As minúsculas vêm antes do NFD (o ADR lista depois): "İ".toLowerCase() gera "i" + U+0307, que assim também sai.
 */
export function foldCity(value: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of value.normalize("NFKC").toLowerCase().normalize("NFD")) {
    // Os blocos de marcas estão no BMP; um caractere astral começa por surrogate e nunca cai neles.
    if (isCombiningMark(char.charCodeAt(0))) continue;
    if (char === " ") {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += char;
  }
  return out;
}

/**
 * Inteiros pelo maior resto (ADR-002 §3.5): `floor` de cada parte, e as unidades que faltam até `round(Σ)` vão
 * para os maiores restos; em empate, a ordem de entrada (a do enum `ScoreDimension`).
 */
function apportion<T>(items: readonly T[], real: (item: T) => number): { readonly item: T; readonly share: number }[] {
  const parts = items.map((item, index) => {
    const value = real(item);
    const floor = Math.floor(value);
    return { item, index, value, floor, rest: value - floor };
  });
  const missing = Math.round(sum(parts.map((part) => part.value))) - sum(parts.map((part) => part.floor));
  const ranked = [...parts].sort((a, b) => b.rest - a.rest || a.index - b.index);
  const bonus = new Set(ranked.slice(0, missing).map((part) => part.index));
  return parts.map((part) => ({ item: part.item, share: bonus.has(part.index) ? part.floor + 1 : part.floor }));
}

function interval(salary: SalaryFacts): readonly [number, number] {
  const low = salary.min ?? salary.max;
  if (low === null) {
    throw new DependencyContractError("Salário sem min nem max: o contrato exige null no lugar.");
  }
  return [low, salary.max ?? low];
}

function outcomeOf(ratio: number): Rated {
  if (ratio >= 1) return "atende";
  return ratio <= 0 ? "nao_atende" : "atende_parcialmente";
}

export class ScoringEngine {
  readonly #policy: ScoringPolicy;

  constructor(policy: ScoringPolicy = DEFAULT_SCORING_POLICY) {
    const issues = scoringPolicyIssues(policy);
    if (issues.length > 0) {
      throw new RangeError(`ScoringPolicy incoerente (ADR-002 §9): ${issues.join("; ")}.`);
    }
    this.#policy = policy;
  }

  score(input: ScoringInput, criteria: UserCriteria): ScoreResult {
    const { facts } = input;
    // Ordem fixa (ADR-002 §4.2.2): a stack antes da senioridade, os benefícios antes dos red flags.
    const stack = this.#stack(facts, criteria.stack);
    const benefits = this.#benefits(input, criteria.benefits);
    const assessments: Readonly<Record<ScoreDimension, Assessment>> = {
      stack: stack.assessment,
      modelo_trabalho: this.#set(input, "workModels", facts.workModels, criteria.workModel.accepted, criteria.workModel.importance),
      senioridade: this.#seniority(input, criteria.seniority, stack.validationRatio),
      contrato: this.#set(input, "contractTypes", facts.contractTypes, criteria.contractType.accepted, criteria.contractType.importance),
      salario: this.#salary(input, criteria.salary),
      localizacao: this.#location(input, criteria.location),
      idiomas: this.#languages(input, criteria.languages),
      beneficios: benefits.assessment,
      red_flags: this.#redFlags(input, criteria.redFlagTolerance, benefits.ratio),
    };
    const redFlagHits = this.#redFlagHits(facts, criteria.redFlagTolerance);

    const ordered = SCORE_DIMENSIONS.map((dimension) => ({ dimension, assessment: assessments[dimension] }));
    const totalWeight = sum(ordered.flatMap(({ assessment }) => assessment.shares.map((s) => s.weight)));
    const real = ({ assessment }: (typeof ordered)[number]): number =>
      totalWeight === 0 ? 0 : (100 * sum(assessment.shares.map((s) => s.weight * s.ratio))) / totalWeight;
    const breakdown = apportion(ordered, real).map(({ item: { dimension, assessment }, share }): DimensionEvaluation => ({
      dimension,
      outcome: assessment.outcome,
      importance: assessment.importance,
      points: share + assessment.penalty,
      dealBreakerHit: assessment.dealBreakerHit,
      reason: assessment.reason,
    }));

    const neutralBase = totalWeight === 0 ? this.#policy.emptyBase : 0;
    const dealBreakerHit = breakdown.some((entry) => entry.dealBreakerHit);
    const clamped = clamp(neutralBase + sum(breakdown.map((entry) => entry.points)), 0, 100);
    const score = dealBreakerHit ? Math.min(clamped, this.#policy.dealBreakerCap) : clamped;
    return {
      score,
      // Com deal-breaker a nota fica ≤ dealBreakerCap < bandMins.baixo_alinhamento (validado): a faixa já é `foge`.
      verdict: this.#band(score),
      dealBreakerHit,
      neutralBase,
      breakdown,
      redFlagHits,
      engineVersion: SCORING_ENGINE_VERSION,
    };
  }

  #band(score: number): Verdict {
    const bands = this.#policy.bandMins;
    if (score >= bands.altamente_recomendado) return "altamente_recomendado";
    if (score >= bands.recomendado) return "recomendado";
    if (score >= bands.neutro) return "neutro";
    return score >= bands.baixo_alinhamento ? "baixo_alinhamento" : "foge";
  }

  #weight(importance: CriterionImportance): number {
    return importance.level === "ponderado" ? importance.weight : this.#policy.requiredWeight;
  }

  /** −round(escala × (1 − r)) do parcial (D-S2), já assinado. */
  #partialPenalty(ratio: number): number {
    return negate(Math.round(this.#policy.partialPenaltyScale * (1 - ratio)));
  }

  /** Tabela do ADR-002 §3.3 para uma dimensão com `importance` do usuário (fora de `ignorar`). */
  #rated(importance: CriterionImportance, outcome: Rated, ratio: number, reason?: ScoreReasonCode): Assessment {
    const p = this.#policy;
    const level = importance.level;
    const shares = [{ weight: this.#weight(importance), ratio }];
    const strict = level !== "ponderado";
    let penalty = 0;
    let dealBreakerHit = false;
    let finalReason: ScoreReasonCode = reason ?? outcome;
    if (strict && outcome === "atende_parcialmente") penalty = this.#partialPenalty(ratio);
    if (strict && outcome === "nao_atende") {
      penalty = negate(p.mustHaveViolatedPenalty);
      dealBreakerHit = level === "eliminatorio";
    }
    if (strict && outcome === "nao_informado") penalty = negate(p.mustHaveUnknownPenalty);
    if (strict && outcome === "conflito") {
      const eliminatory = level === "eliminatorio";
      penalty = negate(eliminatory ? p.eliminatoryConflictPenalty : p.mustHaveUnknownPenalty);
      if (eliminatory) finalReason = "conflito_eliminatorio";
    }
    return { outcome, importance: level, shares, penalty, dealBreakerHit, reason: finalReason };
  }

  #unknown(importance: CriterionImportance, outcome: "nao_informado" | "conflito", reason?: ScoreReasonCode): Assessment {
    return this.#rated(importance, outcome, this.#policy.unknownRatio, reason);
  }

  /** Conjuntos (§4.2.2): `modelo_trabalho` e `contrato`; a senioridade reaproveita a parte com interseção. */
  #set<T extends string>(
    input: ScoringInput,
    field: FactField,
    values: readonly T[],
    accepted: readonly T[],
    importance: CriterionImportance,
  ): Assessment {
    if (importance.level === "ignorar") return IGNORED;
    if (input.provenance[field] === "conflito") return this.#unknown(importance, "conflito");
    if (values.length === 0) return this.#unknown(importance, "nao_informado");
    const acceptedSet = new Set<string>(accepted);
    const ratio = values.filter((value) => acceptedSet.has(value)).length / values.length;
    return this.#rated(importance, outcomeOf(ratio), ratio);
  }

  /** §4.2.2 com a adjacência ascendente validada (D-S5, HITL-018) e o rebaixamento evidente. */
  #seniority(input: ScoringInput, criterion: UserCriteria["seniority"], stackRatio: number | null): Assessment {
    const { importance, accepted } = criterion;
    const values = input.facts.seniorityLevels;
    const base = this.#set(input, "seniorityLevels", values, accepted, importance);
    if (base.outcome !== "nao_atende") return base;
    const p = this.#policy;
    const rank = (level: SeniorityLevel): number => p.seniorityRank[level];
    const acceptedRanks = accepted.map(rank);
    const lowest = Math.min(...acceptedRanks);
    const highest = Math.max(...acceptedRanks);
    if (values.every((level) => rank(level) < lowest)) {
      return { ...base, penalty: negate(p.seniorityDowngradePenalty), reason: "senioridade_rebaixamento" };
    }
    if (!values.some((level) => rank(level) === highest + 1)) return base;
    // Parcial: nunca deal-breaker (D-S2). Com a stack acima do limiar, o r sobe e a penalidade sai (HITL-018).
    if (stackRatio !== null && stackRatio > p.adjacencyStackThreshold) {
      const validated = this.#rated(importance, "atende_parcialmente", p.adjacentValidatedRatio, "senioridade_adjacente_validada");
      return { ...validated, penalty: 0 };
    }
    return this.#rated(importance, "atende_parcialmente", p.adjacentUpRatio, "senioridade_adjacente_acima");
  }

  /** §4.2.1: uma linha só, com deal-breakers, must-have e nice-to-have. */
  #stack(facts: ResolvedJobFacts, criterion: UserCriteria["stack"]): { assessment: Assessment; validationRatio: number | null } {
    const p = this.#policy;
    const mustHave = lowerSet(criterion.mustHave);
    const niceToHave = lowerSet(criterion.niceToHave);
    const dealBreakers = lowerSet(criterion.dealBreakers);
    const niceActive = niceToHave.size > 0 && criterion.niceToHaveWeight > 0;
    if (mustHave.size === 0 && dealBreakers.size === 0 && !niceActive) return { assessment: IGNORED, validationRatio: null };

    const required = lowerSet(facts.stackRequired);
    const desired = lowerSet(facts.stackNiceToHave);
    const union = new Set([...required, ...desired]);
    const known = union.size > 0;
    const hitRequired = countIn(dealBreakers, required) > 0;
    const hitDesired = criterion.dealBreakerScope === "qualquer_mencao" && countIn(dealBreakers, desired) > 0;
    const dealBreakerHit = hitRequired || hitDesired;

    const shares: Share[] = [];
    let penalty = 0;
    let outcome: DimensionOutcome = known ? "atende" : "nao_informado";
    let mustRatio: number | null = null;
    let niceRatio: number | null = null;
    if (mustHave.size > 0) {
      mustRatio = known ? countIn(mustHave, union) / mustHave.size : null;
      shares.push({ weight: p.requiredWeight, ratio: mustRatio ?? p.unknownRatio });
      if (mustRatio === null) {
        penalty = negate(p.mustHaveUnknownPenalty);
      } else {
        outcome = outcomeOf(mustRatio);
        if (outcome === "nao_atende") penalty = negate(p.mustHaveViolatedPenalty);
        if (outcome === "atende_parcialmente") penalty = this.#partialPenalty(mustRatio);
      }
    }
    if (niceActive) {
      niceRatio = known ? countIn(niceToHave, union) / niceToHave.size : null;
      shares.push({ weight: criterion.niceToHaveWeight, ratio: niceRatio ?? p.unknownRatio });
      if (mustHave.size === 0 && niceRatio !== null) outcome = outcomeOf(niceRatio);
    }
    if (dealBreakerHit) {
      // A mais severa: nenhuma penalidade de must-have passa de −30.
      outcome = "nao_atende";
      penalty = negate(p.mustHaveViolatedPenalty);
    }

    let importance: AppliedImportance = "ignorar";
    if (niceActive) importance = "ponderado";
    if (mustHave.size > 0) importance = "obrigatorio";
    if (dealBreakerHit) importance = "eliminatorio";

    let reason: ScoreReasonCode = outcome;
    if (!known) reason = "stack_nao_informada";
    if (hitDesired) reason = "deal_breaker_stack_desejavel";
    if (hitRequired) reason = "deal_breaker_stack_exigida";

    const validationRatio = dealBreakerHit ? null : (mustRatio ?? niceRatio);
    return { assessment: { outcome, importance, shares, penalty, dealBreakerHit, reason }, validationRatio };
  }

  /** §4.2.3 (D-S3): câmbio por tabela fixa; tudo em BRL por mês. */
  #salary(input: ScoringInput, criterion: UserCriteria["salary"]): Assessment {
    if (criterion === null || criterion.importance.level === "ignorar") return IGNORED;
    const { importance } = criterion;
    const { salary, location } = input.facts;
    if (input.provenance.salary === "conflito") return this.#unknown(importance, "conflito");
    if (salary === null) return this.#unknown(importance, "nao_informado");
    const country = location?.countryIso2 ?? null;
    const international = country !== null && country !== "BR";
    // Moeda nula em vaga estrangeira não vira BRL: "AR$ 3.800.000" não pode ser lido como R$ 3,8 milhões.
    if (salary.currency === null && international) return this.#unknown(importance, "nao_informado", "salario_moeda_indeterminada");
    const p = this.#policy;
    const currency = salary.currency ?? p.defaultCurrency;
    const toBrlMonth = (amount: number, from: Currency, period: SalaryPeriod): number => this.#toMonth(amount * p.fxToBrl[from], period);
    const [low, high] = interval(salary);
    const period = salary.period ?? p.defaultPeriod;
    const lo = toBrlMonth(low, currency, period);
    const hi = toBrlMonth(high, currency, period);
    const minimum = toBrlMonth(criterion.minimum, criterion.currency, criterion.period);
    const reason = currency === criterion.currency ? undefined : "salario_convertido";
    if (lo >= minimum) return this.#rated(importance, "atende", 1, reason);
    if (hi < minimum) return this.#rated(importance, "nao_atende", 0, reason);
    // lo < mínimo ≤ hi, então hi > lo: a fração da faixa da vaga que fica acima do mínimo.
    return this.#rated(importance, "atende_parcialmente", (hi - minimum) / (hi - lo), reason);
  }

  /** Hora × 220 e ano ÷ 12, por divisão: × (1/12) é inexato e mudaria o arredondamento de 7,5 (§3.5). */
  #toMonth(amount: number, period: SalaryPeriod): number {
    if (period === "hora") return amount * this.#policy.hoursPerMonth;
    return period === "ano" ? amount / this.#policy.monthsPerYear : amount;
  }

  /** §4.2.4: localização só vale para vaga híbrida ou presencial. */
  #location(input: ScoringInput, criterion: UserCriteria["location"]): Assessment {
    if (criterion === null || criterion.importance.level === "ignorar") return IGNORED;
    const { importance } = criterion;
    const { workModels, location } = input.facts;
    if (workModels.length === 1 && workModels[0] === "remoto") return { ...IGNORED, reason: "localizacao_nao_se_aplica" };
    if (input.provenance.location === "conflito") return this.#unknown(importance, "conflito");
    if (location === null) return this.#unknown(importance, "nao_informado");
    const { city, stateUf, countryIso2 } = location;
    const foreign = countryIso2 !== null && countryIso2 !== "BR";
    const cities = new Set(criterion.acceptedCities.map(foldCity));
    const ufs = new Set<string>(criterion.acceptedUfs);
    const matches = !foreign && ((city !== null && cities.has(foldCity(city))) || (stateUf !== null && ufs.has(stateUf)));
    if (matches) return this.#rated(importance, "atende", 1);
    if (!foreign && city === null && stateUf === null) return this.#unknown(importance, "nao_informado");
    // A opção remota continua de pé ("remoto ou híbrido"): fora do aceito vira parcial.
    if (workModels.some((model) => model === "remoto")) {
      return this.#rated(importance, "atende_parcialmente", this.#policy.remoteOptionRatio);
    }
    return this.#rated(importance, "nao_atende", 0);
  }

  /** §4.2.5 (D-S7): o que o usuário tem contra o que a vaga exige; inglês com rigor em vaga internacional. */
  #languages(input: ScoringInput, criterion: UserCriteria["languages"]): Assessment {
    if (criterion === null || criterion.importance.level === "ignorar") return IGNORED;
    const { importance } = criterion;
    if (input.provenance.languageRequirements === "conflito") return this.#unknown(importance, "conflito");
    const { location, salary, languageRequirements } = input.facts;
    const country = location?.countryIso2 ?? null;
    const currency = salary?.currency ?? null;
    const international = (country !== null && country !== "BR") || (currency !== null && currency !== "BRL");
    const strictEnglish = (req: LanguageRequirement): boolean => international && req.language === "ingles";
    const required = languageRequirements.filter((req) => req.required || strictEnglish(req));
    if (required.length === 0) {
      return input.llmExtracted ? this.#rated(importance, "atende", 1, "idioma_nao_exigido") : this.#unknown(importance, "nao_informado");
    }
    // `outro` nunca casa (podem ser idiomas diferentes): fica fora da conta e, sozinho, é "não informado".
    const comparable = required.filter((req) => req.language !== "outro");
    if (comparable.length === 0) return this.#unknown(importance, "nao_informado");
    const userLevels = new Map<string, LanguageLevel>(criterion.proficiencies.map((pr) => [pr.language, pr.level]));
    const meets = (req: LanguageRequirement): boolean => {
      const has = userLevels.get(req.language) ?? (req.language === "portugues" ? "nativo" : null);
      if (has === null) return false;
      const needed = req.level ?? (strictEnglish(req) ? this.#policy.internationalEnglishMinLevel : null);
      return needed === null || LANGUAGE_RANK[has] >= LANGUAGE_RANK[needed];
    };
    const failed = comparable.filter((req) => !meets(req));
    const ratio = (comparable.length - failed.length) / comparable.length;
    const englishFailed = failed.some(strictEnglish);
    return this.#rated(importance, outcomeOf(ratio), ratio, englishFailed ? "idioma_ingles_internacional" : undefined);
  }

  /** §4.2.6: anúncio sem benefícios listados é omissão, não ausência. */
  #benefits(input: ScoringInput, criterion: UserCriteria["benefits"]): { assessment: Assessment; ratio: number | null } {
    if (criterion === null || criterion.importance.level === "ignorar") return { assessment: IGNORED, ratio: null };
    const { importance } = criterion;
    if (input.provenance.benefits === "conflito") return { assessment: this.#unknown(importance, "conflito"), ratio: null };
    const offered = new Set<string>(input.facts.benefits);
    if (offered.size === 0) return { assessment: this.#unknown(importance, "nao_informado"), ratio: null };
    const ratio = criterion.desired.filter((benefit) => offered.has(benefit)).length / criterion.desired.length;
    return { assessment: this.#rated(importance, outcomeOf(ratio), ratio), ratio };
  }

  /** §4.2.7 (D-S8): fora da base, só penalidade; atenuação de 50% nos sinais de cultura. */
  #redFlags(input: ScoringInput, tolerance: UserCriteria["redFlagTolerance"], benefitsRatio: number | null): Assessment {
    const p = this.#policy;
    if (RED_FLAG_SIGNALS.every((signal) => tolerance[signal] === "ignorar")) return IGNORED;
    const present = new Set<string>(input.facts.redFlagSignals);
    const culture = new Set<string>(p.cultureRedFlags);
    const attenuate = benefitsRatio !== null && benefitsRatio > p.riskAttenuationBenefitsMinRatio;
    let total = 0;
    let eliminated = false;
    let penalized = false;
    let alerted = false;
    let attenuated = false;
    for (const signal of RED_FLAG_SIGNALS) {
      if (!present.has(signal)) continue;
      const level = tolerance[signal];
      if (level === "eliminatorio") eliminated = true;
      if (level === "alertar") alerted = true;
      if (level !== "penalizar") continue;
      penalized = true;
      const soft = attenuate && culture.has(signal);
      attenuated ||= soft;
      total += soft ? Math.round(p.redFlagPenalty * p.riskAttenuationFactor) : p.redFlagPenalty;
    }
    let outcome: DimensionOutcome = input.llmExtracted ? "atende" : "nao_informado";
    if (alerted) outcome = "atende_parcialmente";
    if (penalized || eliminated) outcome = "nao_atende";
    let importance: AppliedImportance = "ignorar";
    if (penalized) importance = "obrigatorio";
    if (eliminated) importance = "eliminatorio";
    let reason: ScoreReasonCode = attenuated ? "red_flag_atenuada_por_beneficios" : outcome;
    if (eliminated) reason = "deal_breaker_red_flag";
    const penalty = negate(Math.min(total, p.redFlagMaxPenalty));
    return { outcome, importance, shares: [], penalty, dealBreakerHit: eliminated, reason };
  }

  #redFlagHits(facts: ResolvedJobFacts, tolerance: UserCriteria["redFlagTolerance"]): RedFlagHit[] {
    const present = new Set<string>(facts.redFlagSignals);
    const effects = { ignorar: null, alertar: "alerta", penalizar: "penalidade", eliminatorio: "eliminatoria" } as const;
    return RED_FLAG_SIGNALS.flatMap((signal) => {
      const effect = effects[tolerance[signal]];
      return present.has(signal) && effect !== null ? [{ signal, effect }] : [];
    });
  }
}
