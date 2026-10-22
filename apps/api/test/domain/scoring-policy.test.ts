// F1-DOM-02: ScoringPolicy se1 (ADR-002 §9). As listas do domínio espelham os enums do contrato, e cada
// regra de coerência derruba o construtor com RangeError (falha fechado).
import {
  CurrencySchema,
  LanguageLevelSchema,
  RedFlagSignalSchema,
  SalaryPeriodSchema,
  ScoreDimensionSchema,
  SeniorityLevelSchema,
} from "@trampo/contracts";
import { describe, expect, test } from "vitest";

import {
  CURRENCIES,
  DEFAULT_SCORING_POLICY,
  LANGUAGE_LEVELS,
  RED_FLAG_SIGNALS,
  SALARY_PERIODS,
  SCORE_DIMENSIONS,
  SCORING_ENGINE_VERSION,
  SENIORITY_LEVELS,
  ScoringEngine,
  scoringPolicyIssues,
  type ScoringPolicy,
} from "../../src/domain/index.js";

describe("listas do domínio espelham o contrato (na mesma ordem)", () => {
  test.each([
    ["ScoreDimension", SCORE_DIMENSIONS, ScoreDimensionSchema.options],
    ["Currency", CURRENCIES, CurrencySchema.options],
    ["SeniorityLevel", SENIORITY_LEVELS, SeniorityLevelSchema.options],
    ["RedFlagSignal", RED_FLAG_SIGNALS, RedFlagSignalSchema.options],
    ["LanguageLevel", LANGUAGE_LEVELS, LanguageLevelSchema.options],
    ["SalaryPeriod", SALARY_PERIODS, SalaryPeriodSchema.options],
  ])("%s", (_name, domain, contract) => {
    expect([...domain]).toEqual([...contract]);
  });
});

describe("política se1", () => {
  test("é a do ADR-002, congelada e coerente", () => {
    expect(SCORING_ENGINE_VERSION).toBe("se1");
    expect(scoringPolicyIssues(DEFAULT_SCORING_POLICY)).toEqual([]);
    expect(Object.isFrozen(DEFAULT_SCORING_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SCORING_POLICY.fxToBrl)).toBe(true);
    expect(DEFAULT_SCORING_POLICY.fxToBrl).toEqual({ BRL: 1, USD: 5.5, EUR: 6.0, ARS: 0.0034 });
    expect(DEFAULT_SCORING_POLICY.bandMins).toEqual({ altamente_recomendado: 90, recomendado: 75, neutro: 50, baixo_alinhamento: 21 });
    expect(DEFAULT_SCORING_POLICY.cultureRedFlags).toEqual(["escopo_excessivo", "multiplas_funcoes", "linguagem_vaga", "pressao_excessiva"]);
    expect(() => new ScoringEngine()).not.toThrow();
  });
});

const P = DEFAULT_SCORING_POLICY;
const BROKEN: readonly (readonly [string, Partial<ScoringPolicy>])[] = [
  ["unknownRatio em (0, 1)", { unknownRatio: 1 }],
  ["unknownRatio em (0, 1)", { unknownRatio: 0 }],
  ["requiredWeight inteiro em [1, 5]", { requiredWeight: 6 }],
  ["requiredWeight inteiro em [1, 5]", { requiredWeight: 2.5 }],
  ["emptyBase inteiro em [0, 100]", { emptyBase: 101 }],
  ["partialPenaltyScale inteiro em [0, 30]", { partialPenaltyScale: 31 }],
  ["mustHaveViolatedPenalty inteiro em [0, 30]", { mustHaveViolatedPenalty: -1 }],
  ["mustHaveUnknownPenalty inteiro em [0, 30]", { mustHaveUnknownPenalty: 0.5 }],
  ["eliminatoryConflictPenalty inteiro em [0, 30]", { eliminatoryConflictPenalty: 40 }],
  ["seniorityDowngradePenalty inteiro em [0, 30]", { seniorityDowngradePenalty: Number.NaN }],
  ["redFlagPenalty inteiro em [0, 30]", { redFlagPenalty: 31 }],
  ["redFlagMaxPenalty inteiro em [0, 30]", { redFlagMaxPenalty: 31 }],
  ["não informado pesa menos que violado", { mustHaveUnknownPenalty: 30, mustHaveViolatedPenalty: 29 }],
  ["redFlagPenalty ≤ redFlagMaxPenalty", { redFlagPenalty: 20, redFlagMaxPenalty: 10 }],
  ["eliminatoryConflictPenalty > 100 − bandMins.recomendado", { eliminatoryConflictPenalty: 25 }],
  ["mustHaveViolatedPenalty > 100 − bandMins.recomendado", { mustHaveViolatedPenalty: 25, mustHaveUnknownPenalty: 5 }],
  ["bandMins inteiros em [1, 100] e estritamente decrescentes", { bandMins: { ...P.bandMins, recomendado: 90 } }],
  ["bandMins inteiros em [1, 100] e estritamente decrescentes", { bandMins: { ...P.bandMins, neutro: 75 } }],
  ["bandMins inteiros em [1, 100] e estritamente decrescentes", { bandMins: { ...P.bandMins, baixo_alinhamento: 50 } }],
  ["bandMins inteiros em [1, 100] e estritamente decrescentes", { bandMins: { ...P.bandMins, altamente_recomendado: 101 } }],
  ["bandMins inteiros em [1, 100] e estritamente decrescentes", { bandMins: { ...P.bandMins, recomendado: 75.5 } }],
  ["bandMins inteiros em [1, 100] e estritamente decrescentes", { bandMins: { ...P.bandMins, neutro: 0 } }],
  ["bandMins inteiros em [1, 100] e estritamente decrescentes", { bandMins: { ...P.bandMins, baixo_alinhamento: 0 } }],
  ["dealBreakerCap < bandMins.baixo_alinhamento", { dealBreakerCap: 21 }],
  ["dealBreakerCap < bandMins.baixo_alinhamento", { dealBreakerCap: -1 }],
  ["seniorityRank inteiro para todo nível", { seniorityRank: { ...P.seniorityRank, pleno: 1.5 } }],
  ["0 < adjacentUpRatio < adjacentValidatedRatio < 1", { adjacentValidatedRatio: 1 }],
  ["0 < adjacentUpRatio < adjacentValidatedRatio < 1", { adjacentUpRatio: 0 }],
  ["0 < adjacentUpRatio < adjacentValidatedRatio < 1", { adjacentUpRatio: 0.8, adjacentValidatedRatio: 0.8 }],
  ["adjacencyStackThreshold em [0, 1)", { adjacencyStackThreshold: 1 }],
  ["adjacencyStackThreshold em [0, 1)", { adjacencyStackThreshold: -0.1 }],
  ["fxToBrl finito e > 0 para toda moeda", { fxToBrl: { BRL: 1, USD: 5.5, EUR: 6 } as ScoringPolicy["fxToBrl"] }],
  ["fxToBrl finito e > 0 para toda moeda", { fxToBrl: { ...P.fxToBrl, ARS: 0 } }],
  ["fxToBrl finito e > 0 para toda moeda", { fxToBrl: { ...P.fxToBrl, USD: Number.POSITIVE_INFINITY } }],
  ["fxToBrl.BRL = 1", { fxToBrl: { ...P.fxToBrl, BRL: 2 } }],
  ["hoursPerMonth e monthsPerYear > 0", { hoursPerMonth: 0 }],
  ["hoursPerMonth e monthsPerYear > 0", { monthsPerYear: Number.NaN }],
  ["remoteOptionRatio em (0, 1)", { remoteOptionRatio: 1 }],
  ["riskAttenuationBenefitsMinRatio em [0, 1)", { riskAttenuationBenefitsMinRatio: 1 }],
  ["riskAttenuationBenefitsMinRatio em [0, 1)", { riskAttenuationBenefitsMinRatio: -0.5 }],
  ["riskAttenuationFactor em [0,5, 1]", { riskAttenuationFactor: 0.4 }],
  ["riskAttenuationFactor em [0,5, 1]", { riskAttenuationFactor: 1.1 }],
  ["cultureRedFlags do enum e sem sinal nunca atenuado", { cultureRedFlags: ["salario_omitido"] }],
  ["cultureRedFlags do enum e sem sinal nunca atenuado", { cultureRedFlags: ["sobreaviso_nao_remunerado"] }],
  ["cultureRedFlags do enum e sem sinal nunca atenuado", { cultureRedFlags: ["teste_tecnico_longo"] }],
  ["cultureRedFlags do enum e sem sinal nunca atenuado", { cultureRedFlags: ["cultura_nova"] as unknown as ScoringPolicy["cultureRedFlags"] }],
  ["defaultCurrency do enum", { defaultCurrency: "CLP" as ScoringPolicy["defaultCurrency"] }],
  ["defaultPeriod do enum", { defaultPeriod: "semana" as ScoringPolicy["defaultPeriod"] }],
  ["internationalEnglishMinLevel do enum", { internationalEnglishMinLevel: "excelente" as ScoringPolicy["internationalEnglishMinLevel"] }],
];

describe("o construtor recusa política incoerente (RangeError)", () => {
  test.each(BROKEN)("%s (%j)", (rule, change) => {
    const policy = { ...P, ...change };
    expect(scoringPolicyIssues(policy)).toContain(rule);
    expect(() => new ScoringEngine(policy)).toThrow(RangeError);
    expect(() => new ScoringEngine(policy)).toThrow(rule);
  });

  test("aceita os extremos válidos de cada faixa", () => {
    const edge: ScoringPolicy = {
      ...P,
      adjacencyStackThreshold: 0,
      riskAttenuationBenefitsMinRatio: 0,
      riskAttenuationFactor: 1,
      dealBreakerCap: 0,
      emptyBase: 0,
      cultureRedFlags: [],
    };
    expect(scoringPolicyIssues(edge)).toEqual([]);
    expect(scoringPolicyIssues({ ...P, riskAttenuationFactor: 0.5, emptyBase: 100, redFlagPenalty: 30 })).toEqual([]);
  });
});
