// Construtores e arbitrários do ScoringEngine (F1-DOM-02). Tudo que sai daqui passa no zod do contrato,
// porque o motor confia nos tipos (ADR-002 §5.5): o teste não pode alimentá-lo com entrada impossível.
import {
  BenefitCategorySchema,
  BrazilUfSchema,
  ContractTypeSchema,
  LanguageCodeSchema,
  LanguageLevelSchema,
  RedFlagSignalSchema,
  ResolvedJobFactsSchema,
  SeniorityLevelSchema,
  UserCriteriaSchema,
  WorkModelSchema,
  type CriterionImportance,
  type RedFlagSignal,
  type RedFlagTolerance,
  type ResolvedJobFacts,
  type SalaryFacts,
  type UserCriteria,
} from "@trampo/contracts";
import fc from "fast-check";

import type { FactField, FactProvenance, ScoringInput } from "../../../src/domain/index.js";

export const NO_FACTS: ResolvedJobFacts = Object.freeze<ResolvedJobFacts>({
  title: null,
  seniorityLevels: [],
  yearsExperienceMin: null,
  workModels: [],
  location: null,
  salary: null,
  contractTypes: [],
  stackRequired: [],
  stackNiceToHave: [],
  benefits: [],
  languageRequirements: [],
  redFlagSignals: [],
});

export function facts(over: Partial<ResolvedJobFacts> = {}): ResolvedJobFacts {
  return ResolvedJobFactsSchema.parse({ ...NO_FACTS, ...over });
}

const isEmpty = (value: unknown): boolean => value === null || (Array.isArray(value) && value.length === 0);

/** "llm" para campo preenchido e "ausente" para vazio; `conflicts` vira "conflito" (o resolver esvazia o campo). */
export function provenanceOf(f: ResolvedJobFacts, conflicts: readonly FactField[] = []): Record<FactField, FactProvenance> {
  const keys = Object.keys(NO_FACTS) as FactField[];
  return Object.fromEntries(
    keys.map((key) => [key, conflicts.includes(key) ? "conflito" : isEmpty(f[key]) ? "ausente" : "llm"]),
  ) as Record<FactField, FactProvenance>;
}

export function input(f: ResolvedJobFacts, options: { conflicts?: readonly FactField[]; llmExtracted?: boolean } = {}): ScoringInput {
  return { facts: f, provenance: provenanceOf(f, options.conflicts), llmExtracted: options.llmExtracted ?? true };
}

export const tolerance = (level: RedFlagTolerance, over: Partial<Record<RedFlagSignal, RedFlagTolerance>> = {}): Record<RedFlagSignal, RedFlagTolerance> =>
  ({ ...Object.fromEntries(RedFlagSignalSchema.options.map((s) => [s, level])), ...over }) as Record<RedFlagSignal, RedFlagTolerance>;

export const IGNORE: CriterionImportance = { level: "ignorar" };
export const REQUIRED: CriterionImportance = { level: "obrigatorio" };
export const ELIMINATORY: CriterionImportance = { level: "eliminatorio" };
export const weighted = (weight: number): CriterionImportance => ({ level: "ponderado", weight });

/** Tudo ignorado: nenhuma dimensão na base (nota = emptyBase). */
export const NO_CRITERIA: UserCriteria = Object.freeze<UserCriteria>({
  schemaVersion: 1,
  workModel: { accepted: ["remoto"], importance: IGNORE },
  seniority: { accepted: ["pleno"], importance: IGNORE },
  contractType: { accepted: ["clt"], importance: IGNORE },
  salary: null,
  location: null,
  stack: { mustHave: [], niceToHave: [], dealBreakers: [], dealBreakerScope: "somente_obrigatoria", niceToHaveWeight: 0 },
  languages: null,
  benefits: null,
  redFlagTolerance: tolerance("ignorar"),
  notes: null,
});

export function criteria(over: Partial<UserCriteria> = {}): UserCriteria {
  return UserCriteriaSchema.parse({ ...NO_CRITERIA, ...over });
}

export const stack = (over: Partial<UserCriteria["stack"]> = {}): UserCriteria["stack"] => ({ ...NO_CRITERIA.stack, ...over });

/** Deep freeze, para provar que o motor não muta a entrada (invariante 1). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// ---------- arbitrários (propriedades) ----------

/** Pool pequeno com variação de caixa: força interseção entre a stack da vaga e as listas do usuário. */
export const TECH_POOL = ["TypeScript", "Go", "Java", "Docker", "Kafka", "Python", "Node.js", "C#", "AWS", "React"] as const;
export const CITY_POOL = ["São Paulo", "sao  paulo", "Recife", "Belo Horizonte", "Lisboa"] as const;
const UF_POOL = ["SP", "PE", "MG", "RJ"] as const;

const subset = <T extends string>(options: readonly T[], max: number, min = 0): fc.Arbitrary<T[]> =>
  fc.uniqueArray(fc.constantFrom(...options), { minLength: min, maxLength: max });

const tech = fc.constantFrom(...TECH_POOL).chain((t) => fc.constantFrom(t, t.toLowerCase(), t.toUpperCase()));
const lower = (t: string): string => t.toLowerCase();
const uniqueTech = (max: number): fc.Arbitrary<string[]> => fc.uniqueArray(tech, { maxLength: max, selector: lower });

export const importanceArb: fc.Arbitrary<CriterionImportance> = fc.oneof(
  fc.constant(IGNORE),
  fc.constant(REQUIRED),
  fc.constant(ELIMINATORY),
  fc.integer({ min: 1, max: 5 }).map(weighted),
);

export const salaryArb: fc.Arbitrary<SalaryFacts> = fc
  .record({
    a: fc.option(fc.integer({ min: 0, max: 60_000 }), { nil: null }),
    b: fc.option(fc.integer({ min: 0, max: 60_000 }), { nil: null }),
    currency: fc.constantFrom("BRL" as const, "USD" as const, "EUR" as const, "ARS" as const, null),
    period: fc.constantFrom("hora" as const, "mes" as const, "ano" as const, null),
  })
  .filter(({ a, b }) => a !== null || b !== null)
  .map(({ a, b, currency, period }) => ({
    min: a !== null && b !== null ? Math.min(a, b) : a,
    max: a !== null && b !== null ? Math.max(a, b) : b,
    currency,
    period,
  }));

const locationArb = fc
  .record({
    city: fc.option(fc.constantFrom(...CITY_POOL), { nil: null }),
    stateUf: fc.option(fc.constantFrom(...UF_POOL), { nil: null }),
    countryIso2: fc.constantFrom("BR", "AR", "US", null),
  })
  .filter((l) => l.city !== null || l.stateUf !== null || l.countryIso2 !== null);

const languageRequirementsArb = fc.uniqueArray(
  fc.record({
    language: fc.constantFrom(...LanguageCodeSchema.options),
    level: fc.option(fc.constantFrom(...LanguageLevelSchema.options), { nil: null }),
    required: fc.boolean(),
  }),
  { maxLength: 4, selector: (l) => l.language },
);

export const factsArb: fc.Arbitrary<ResolvedJobFacts> = fc
  .record({
    title: fc.constantFrom("Dev Backend", null),
    seniorityLevels: subset(SeniorityLevelSchema.options, 3),
    workModels: subset(WorkModelSchema.options, 3),
    location: fc.option(locationArb, { nil: null }),
    salary: fc.option(salaryArb, { nil: null }),
    contractTypes: subset(ContractTypeSchema.options, 5),
    stack: uniqueTech(8),
    split: fc.nat({ max: 8 }),
    benefits: subset(BenefitCategorySchema.options, 6),
    languageRequirements: languageRequirementsArb,
    redFlagSignals: subset(RedFlagSignalSchema.options, 7),
  })
  .map(({ stack: all, split, ...rest }) => ({
    ...rest,
    yearsExperienceMin: null,
    stackRequired: all.slice(0, split),
    stackNiceToHave: all.slice(split),
  }));

const toleranceArb = fc
  .array(fc.constantFrom<RedFlagTolerance>("ignorar", "alertar", "penalizar", "eliminatorio"), {
    minLength: RedFlagSignalSchema.options.length,
    maxLength: RedFlagSignalSchema.options.length,
  })
  .map((levels) => Object.fromEntries(RedFlagSignalSchema.options.map((s, i) => [s, levels[i]])) as Record<RedFlagSignal, RedFlagTolerance>);

export const criteriaArb: fc.Arbitrary<UserCriteria> = fc
  .record({
    workModel: fc.record({ accepted: subset(WorkModelSchema.options, 3, 1), importance: importanceArb }),
    seniority: fc.record({ accepted: subset(SeniorityLevelSchema.options, 6, 1), importance: importanceArb }),
    contractType: fc.record({ accepted: subset(ContractTypeSchema.options, 5, 1), importance: importanceArb }),
    salary: fc.option(
      fc.record({
        minimum: fc.integer({ min: 1, max: 60_000 }),
        currency: fc.constantFrom("BRL" as const, "USD" as const, "EUR" as const, "ARS" as const),
        period: fc.constantFrom("hora" as const, "mes" as const, "ano" as const),
        importance: importanceArb,
      }),
      { nil: null },
    ),
    location: fc.option(
      fc
        .record({ acceptedUfs: subset(BrazilUfSchema.options.slice(0, 8), 3), acceptedCities: fc.uniqueArray(fc.constantFrom(...CITY_POOL), { maxLength: 2 }), importance: importanceArb })
        .filter((l) => l.acceptedUfs.length + l.acceptedCities.length > 0),
      { nil: null },
    ),
    stackTerms: uniqueTech(9),
    cuts: fc.tuple(fc.nat({ max: 9 }), fc.nat({ max: 9 })),
    dealBreakerScope: fc.constantFrom("somente_obrigatoria" as const, "qualquer_mencao" as const),
    niceToHaveWeight: fc.integer({ min: 0, max: 5 }),
    languages: fc.option(
      fc.record({
        proficiencies: fc.uniqueArray(
          fc.record({ language: fc.constantFrom(...LanguageCodeSchema.options), level: fc.constantFrom(...LanguageLevelSchema.options) }),
          { maxLength: 4, selector: (p) => p.language },
        ),
        importance: importanceArb,
      }),
      { nil: null },
    ),
    benefits: fc.option(fc.record({ desired: subset(BenefitCategorySchema.options, 6, 1), importance: importanceArb }), { nil: null }),
    redFlagTolerance: toleranceArb,
    notes: fc.constantFrom(null, "Prefiro produto."),
  })
  .map(({ stackTerms, cuts, dealBreakerScope, niceToHaveWeight, ...rest }) => {
    const [x, y] = [Math.min(...cuts), Math.max(...cuts)];
    return {
      schemaVersion: 1 as const,
      ...rest,
      stack: {
        mustHave: stackTerms.slice(0, x),
        niceToHave: stackTerms.slice(x, y),
        dealBreakers: stackTerms.slice(y, y + 3),
        dealBreakerScope,
        niceToHaveWeight,
      },
    };
  });

/** Campos que o resolver pode marcar como conflito (e esvazia). */
export const CONFLICTABLE = ["workModels", "seniorityLevels", "contractTypes", "salary", "location", "benefits"] as const satisfies readonly FactField[];

const blank = (f: ResolvedJobFacts, field: (typeof CONFLICTABLE)[number]): ResolvedJobFacts =>
  ({ ...f, [field]: field === "salary" || field === "location" ? null : [] }) as ResolvedJobFacts;

export const inputArb: fc.Arbitrary<ScoringInput> = fc
  .record({ f: factsArb, conflicts: subset(CONFLICTABLE, 2), llmExtracted: fc.boolean() })
  .map(({ f, conflicts, llmExtracted }) => {
    const blanked = conflicts.reduce(blank, f);
    return input(blanked, { conflicts, llmExtracted });
  });
