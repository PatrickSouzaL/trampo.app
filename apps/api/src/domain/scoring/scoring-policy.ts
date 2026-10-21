// E7 ScoringPolicy (ADR-002 §3, §4.2 e §9). Todas as constantes do motor são hipóteses versionadas: trocar
// qualquer valor (inclusive uma taxa de câmbio) muda o `engineVersion`, e notas de versões diferentes não são
// comparáveis (ADR-002 R4). A política é da versão do motor, não da requisição: o construtor a valida uma vez.
import type {
  Currency,
  LanguageLevel,
  RedFlagSignal,
  SalaryPeriod,
  ScoreDimension,
  SeniorityLevel,
  Verdict,
} from "@trampo/contracts";

export const SCORING_ENGINE_VERSION = "se1";

/*
 * Cópias dos enums do contrato: o domínio não roda zod. Um teste compara cada lista com `Schema.options`,
 * na mesma ordem, e falha se o contrato ganhar um valor (ex.: moeda nova sem taxa nunca vira "1").
 */
export const SCORE_DIMENSIONS = [
  "stack",
  "modelo_trabalho",
  "senioridade",
  "contrato",
  "salario",
  "localizacao",
  "idiomas",
  "beneficios",
  "red_flags",
] as const satisfies readonly ScoreDimension[];
export const CURRENCIES = ["BRL", "USD", "EUR", "ARS"] as const satisfies readonly Currency[];
export const SENIORITY_LEVELS = [
  "estagio",
  "junior",
  "pleno",
  "senior",
  "especialista",
  "lideranca",
] as const satisfies readonly SeniorityLevel[];
export const RED_FLAG_SIGNALS = [
  "salario_omitido",
  "escopo_excessivo",
  "sobreaviso_nao_remunerado",
  "teste_tecnico_longo",
  "multiplas_funcoes",
  "linguagem_vaga",
  "pressao_excessiva",
] as const satisfies readonly RedFlagSignal[];
export const LANGUAGE_LEVELS = ["basico", "intermediario", "avancado", "fluente", "nativo"] as const satisfies readonly LanguageLevel[];
export const SALARY_PERIODS = ["hora", "mes", "ano"] as const satisfies readonly SalaryPeriod[];

/** Sinais que a atenuação do D-S8 nunca toca: transparência de salário, irregularidade trabalhista e processo. */
export const NEVER_ATTENUATED_RED_FLAGS: readonly RedFlagSignal[] = ["salario_omitido", "sobreaviso_nao_remunerado", "teste_tecnico_longo"];

/** Piso de pontos por dimensão (ADR-002 §3.5): `points` fica em [−30, 100]. */
export const MAX_DIMENSION_PENALTY = 30;

export type BandedVerdict = Exclude<Verdict, "foge">;

export interface ScoringPolicy {
  /** r de `nao_informado` e de `conflito` (D-S1). */
  readonly unknownRatio: number;
  /** Peso de `obrigatorio` e `eliminatorio` na base (D-S1). */
  readonly requiredWeight: number;
  /** Base quando nenhuma dimensão entra na média (todas ignoradas). */
  readonly emptyBase: number;
  /** Penalidade do parcial em obrigatório e eliminatório: −round(escala × (1 − r)) (D-S2). */
  readonly partialPenaltyScale: number;
  readonly mustHaveViolatedPenalty: number;
  readonly mustHaveUnknownPenalty: number;
  readonly eliminatoryConflictPenalty: number;
  /** Rebaixamento evidente de senioridade, também em `ponderado` (D-S5). */
  readonly seniorityDowngradePenalty: number;
  readonly dealBreakerCap: number;
  /** Mínimo de cada faixa (D-S9); abaixo de `baixo_alinhamento` é `foge`. */
  readonly bandMins: Readonly<Record<BandedVerdict, number>>;
  readonly seniorityRank: Readonly<Record<SeniorityLevel, number>>;
  readonly adjacentUpRatio: number;
  /** r da adjacência ascendente quando a stack passa do limiar (HITL-018). */
  readonly adjacentValidatedRatio: number;
  readonly adjacencyStackThreshold: number;
  /** Tabela fixa de câmbio para BRL (D-S3). */
  readonly fxToBrl: Readonly<Record<Currency, number>>;
  /** Mês de referência da tabela ("AAAA-MM"), só documental. */
  readonly fxReferenceDate: string;
  /** Moeda assumida quando a vaga não é internacional e não informa moeda. */
  readonly defaultCurrency: Currency;
  readonly defaultPeriod: SalaryPeriod;
  readonly hoursPerMonth: number;
  readonly monthsPerYear: number;
  /** Localização fora do aceito numa vaga que também aceita remoto (§4.2.4). */
  readonly remoteOptionRatio: number;
  /** Nível de inglês lido quando a vaga internacional não informa (HITL-018, interpretação 3). */
  readonly internationalEnglishMinLevel: LanguageLevel;
  readonly redFlagPenalty: number;
  readonly redFlagMaxPenalty: number;
  readonly riskAttenuationBenefitsMinRatio: number;
  readonly riskAttenuationFactor: number;
  readonly cultureRedFlags: readonly RedFlagSignal[];
}

export const DEFAULT_SCORING_POLICY: ScoringPolicy = Object.freeze({
  unknownRatio: 0.5,
  requiredWeight: 5,
  emptyBase: 50,
  partialPenaltyScale: 30,
  mustHaveViolatedPenalty: 30,
  mustHaveUnknownPenalty: 5,
  eliminatoryConflictPenalty: 30,
  seniorityDowngradePenalty: 30,
  dealBreakerCap: 20,
  bandMins: Object.freeze({ altamente_recomendado: 90, recomendado: 75, neutro: 50, baixo_alinhamento: 21 }),
  seniorityRank: Object.freeze({ estagio: 0, junior: 1, pleno: 2, senior: 3, especialista: 4, lideranca: 4 }),
  adjacentUpRatio: 0.5,
  adjacentValidatedRatio: 0.8,
  adjacencyStackThreshold: 0.8,
  fxToBrl: Object.freeze({ BRL: 1, USD: 5.5, EUR: 6.0, ARS: 0.0034 }),
  fxReferenceDate: "2026-07",
  defaultCurrency: "BRL",
  defaultPeriod: "mes",
  hoursPerMonth: 220,
  monthsPerYear: 12,
  remoteOptionRatio: 0.5,
  internationalEnglishMinLevel: "avancado",
  redFlagPenalty: 10,
  redFlagMaxPenalty: 30,
  riskAttenuationBenefitsMinRatio: 0.8,
  riskAttenuationFactor: 0.5,
  cultureRedFlags: Object.freeze<RedFlagSignal[]>(["escopo_excessivo", "multiplas_funcoes", "linguagem_vaga", "pressao_excessiva"]),
});

const isIntIn = (value: number, min: number, max: number): boolean => Number.isInteger(value) && value >= min && value <= max;
const isOpenUnit = (value: number): boolean => value > 0 && value < 1;
const isPositiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;

/** Lista das incoerências; vazia = política válida. Cada item nomeia a regra do ADR-002 que caiu. */
export function scoringPolicyIssues(p: ScoringPolicy): string[] {
  const issues: string[] = [];
  const check = (ok: boolean, rule: string): void => {
    if (!ok) issues.push(rule);
  };
  const bands = p.bandMins;
  check(isOpenUnit(p.unknownRatio), "unknownRatio em (0, 1)");
  check(isIntIn(p.requiredWeight, 1, 5), "requiredWeight inteiro em [1, 5]");
  check(isIntIn(p.emptyBase, 0, 100), "emptyBase inteiro em [0, 100]");
  for (const [name, value] of [
    ["partialPenaltyScale", p.partialPenaltyScale],
    ["mustHaveViolatedPenalty", p.mustHaveViolatedPenalty],
    ["mustHaveUnknownPenalty", p.mustHaveUnknownPenalty],
    ["eliminatoryConflictPenalty", p.eliminatoryConflictPenalty],
    ["seniorityDowngradePenalty", p.seniorityDowngradePenalty],
    ["redFlagPenalty", p.redFlagPenalty],
    ["redFlagMaxPenalty", p.redFlagMaxPenalty],
  ] as const) {
    check(isIntIn(value, 0, MAX_DIMENSION_PENALTY), `${name} inteiro em [0, ${String(MAX_DIMENSION_PENALTY)}]`);
  }
  check(p.mustHaveUnknownPenalty <= p.mustHaveViolatedPenalty, "não informado pesa menos que violado");
  check(p.redFlagPenalty <= p.redFlagMaxPenalty, "redFlagPenalty ≤ redFlagMaxPenalty");
  // Invariantes 4 e 5: conflito eliminatório e must-have violado nunca chegam a `recomendado` (base ≤ 100).
  check(p.eliminatoryConflictPenalty > 100 - bands.recomendado, "eliminatoryConflictPenalty > 100 − bandMins.recomendado");
  check(p.mustHaveViolatedPenalty > 100 - bands.recomendado, "mustHaveViolatedPenalty > 100 − bandMins.recomendado");
  // Invariante 12: faixas estritamente decrescentes cobrem [0, 100]; invariante 3: o teto cai em `foge`.
  check(
    isIntIn(bands.altamente_recomendado, 1, 100) &&
      isIntIn(bands.recomendado, 1, 100) &&
      isIntIn(bands.neutro, 1, 100) &&
      isIntIn(bands.baixo_alinhamento, 1, 100) &&
      bands.altamente_recomendado > bands.recomendado &&
      bands.recomendado > bands.neutro &&
      bands.neutro > bands.baixo_alinhamento,
    "bandMins inteiros em [1, 100] e estritamente decrescentes",
  );
  check(isIntIn(p.dealBreakerCap, 0, 100) && p.dealBreakerCap < bands.baixo_alinhamento, "dealBreakerCap < bandMins.baixo_alinhamento");
  check(
    SENIORITY_LEVELS.every((level) => isIntIn(p.seniorityRank[level], 0, SENIORITY_LEVELS.length)),
    "seniorityRank inteiro para todo nível",
  );
  // HITL-018: 0 < adjacente < validada < 1 (1 confundiria o parcial com `atende`).
  check(
    isOpenUnit(p.adjacentUpRatio) && isOpenUnit(p.adjacentValidatedRatio) && p.adjacentUpRatio < p.adjacentValidatedRatio,
    "0 < adjacentUpRatio < adjacentValidatedRatio < 1",
  );
  check(p.adjacencyStackThreshold >= 0 && p.adjacencyStackThreshold < 1, "adjacencyStackThreshold em [0, 1)");
  // D-S3: falha fechado se faltar taxa para qualquer moeda do contrato.
  check(CURRENCIES.every((currency) => isPositiveFinite(p.fxToBrl[currency])), "fxToBrl finito e > 0 para toda moeda");
  check(p.fxToBrl.BRL === 1, "fxToBrl.BRL = 1");
  check(isPositiveFinite(p.hoursPerMonth) && isPositiveFinite(p.monthsPerYear), "hoursPerMonth e monthsPerYear > 0");
  check(isOpenUnit(p.remoteOptionRatio), "remoteOptionRatio em (0, 1)");
  check(p.riskAttenuationBenefitsMinRatio >= 0 && p.riskAttenuationBenefitsMinRatio < 1, "riskAttenuationBenefitsMinRatio em [0, 1)");
  // Invariante 14: a atenuação nunca reduz uma penalidade a menos da metade.
  check(p.riskAttenuationFactor >= 0.5 && p.riskAttenuationFactor <= 1, "riskAttenuationFactor em [0,5, 1]");
  const never = new Set<string>(NEVER_ATTENUATED_RED_FLAGS);
  const signals = new Set<string>(RED_FLAG_SIGNALS);
  check(p.cultureRedFlags.every((signal) => signals.has(signal) && !never.has(signal)), "cultureRedFlags do enum e sem sinal nunca atenuado");
  check(new Set<string>(CURRENCIES).has(p.defaultCurrency), "defaultCurrency do enum");
  check(new Set<string>(SALARY_PERIODS).has(p.defaultPeriod), "defaultPeriod do enum");
  check(new Set<string>(LANGUAGE_LEVELS).has(p.internationalEnglishMinLevel), "internationalEnglishMinLevel do enum");
  return issues;
}
