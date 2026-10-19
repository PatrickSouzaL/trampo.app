// F1-DOM-05: propriedades do FactResolver (ADR-011 §3). Evidência preservada, perfil nunca vira fato,
// conflito sempre "não informado" com aviso, salario_omitido do código, penalidade de injection e pureza.
import {
  ContractTypeSchema,
  FactFieldSchema,
  FactProvenanceSchema,
  JobFactsSchema,
  ResolvedJobFactsSchema,
  SeniorityLevelSchema,
  WorkModelSchema,
  type JobFacts,
  type SalaryFacts,
} from "@trampo/contracts";
import { JOB_TITLE_MAX_CHARS } from "@trampo/contracts/limits";
import { safeText } from "@trampo/contracts/primitives";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import {
  DEFAULT_FACT_RESOLVER_POLICY,
  FactResolver,
  type DeterministicSignals,
  type FactResolverInput,
} from "../../src/domain/index.js";

const RUNS = 1_000;
const titleSchema = safeText(JOB_TITLE_MAX_CHARS);
const resolver = new FactResolver({ isSafeTitle: (value) => titleSchema.safeParse(value).success });

// Pool pequeno para forçar colisões entre LLM, menções e termos marcados, com variação de caixa.
const POOL = ["TypeScript", "Go", "Java", "Docker", "Kafka", "Python", "Node.js", "C#", "AWS", "React"] as const;
const term = fc.constantFrom(...POOL).chain((t) => fc.constantFrom(t, t.toLowerCase(), t.toUpperCase()));
const lower = (t: string): string => t.toLowerCase();

const strength = fc.constantFrom("explicita" as const, "fraca" as const);
const subset = <T extends string>(options: readonly T[], max: number) =>
  fc.uniqueArray(fc.constantFrom(...options), { maxLength: max });
const setSignal = <T extends string>(options: readonly T[]) =>
  fc.option(fc.record({ values: fc.array(fc.constantFrom(...options), { maxLength: 5 }), strength }), { nil: null });

const salaryArb: fc.Arbitrary<SalaryFacts> = fc
  .record({
    a: fc.option(fc.integer({ min: 0, max: 50_000 }), { nil: null }),
    b: fc.option(fc.integer({ min: 0, max: 50_000 }), { nil: null }),
    currency: fc.constantFrom("BRL" as const, "USD" as const, null),
    period: fc.constantFrom("mes" as const, "ano" as const, null),
  })
  .filter(({ a, b }) => a !== null || b !== null)
  .map(({ a, b, currency, period }) => ({
    min: a !== null && b !== null ? Math.min(a, b) : a,
    max: a !== null && b !== null ? Math.max(a, b) : b,
    currency,
    period,
  }));

const uniqueTerms = (max: number) => fc.uniqueArray(term, { maxLength: max, selector: lower });

const llmFactsArb: fc.Arbitrary<JobFacts> = fc
  .record({
    title: fc.constantFrom("Dev Backend", null),
    seniorityLevels: subset(SeniorityLevelSchema.options, 3),
    yearsExperienceMin: fc.constantFrom(null, 2),
    workModels: subset(WorkModelSchema.options, 3),
    location: fc.constant(null),
    salary: fc.option(salaryArb, { nil: null }),
    contractTypes: subset(ContractTypeSchema.options, 5),
    stack: uniqueTerms(8),
    split: fc.nat({ max: 8 }),
    benefits: fc.constant<JobFacts["benefits"]>([]),
    languageRequirements: fc.constant<JobFacts["languageRequirements"]>([]),
    redFlagSignals: fc.uniqueArray(fc.constantFrom("salario_omitido" as const, "escopo_excessivo" as const), { maxLength: 2 }),
    extractionConfidence: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(({ stack, split, ...rest }) => ({ ...rest, stackRequired: stack.slice(0, split), stackNiceToHave: stack.slice(split) }))
  .filter((facts) => JobFactsSchema.safeParse(facts).success);

const signalsArb: fc.Arbitrary<DeterministicSignals> = fc.record({
  workModels: setSignal(WorkModelSchema.options),
  contractTypes: setSignal(ContractTypeSchema.options),
  seniorityLevels: setSignal(SeniorityLevelSchema.options),
  salary: fc.option(fc.record({ value: salaryArb, strength }), { nil: null }),
  stackMentions: fc.array(fc.record({ term, strength }), { maxLength: 8 }),
  injectionLevel: fc.constantFrom("baixa" as const, "media" as const, "alta" as const),
});

const inputArb: fc.Arbitrary<FactResolverInput> = fc.record({
  llmFacts: fc.option(llmFactsArb, { nil: null, freq: 4 }),
  llmOutputInjection: fc.boolean(),
  signals: signalsArb,
  titleHint: fc.constantFrom(null, "Engenheiro de Dados", "Dev <b>"),
  markedStackTerms: fc.uniqueArray(term, { maxLength: 6, selector: lower }),
});

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const outputStack = (facts: { stackRequired: string[]; stackNiceToHave: string[] }) => [
  ...facts.stackRequired,
  ...facts.stackNiceToHave,
];

describe("propriedades do FactResolver", () => {
  test("toda saída vale no contrato, com proveniência completa e confiança em [0, 1]", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = resolver.resolve(input);
        expect(ResolvedJobFactsSchema.safeParse(out.facts).success).toBe(true);
        expect(Object.keys(out.provenance).sort()).toEqual([...FactFieldSchema.options].sort());
        for (const value of Object.values(out.provenance)) expect(FactProvenanceSchema.options).toContain(value);
        expect(out.effectiveConfidence).toBeGreaterThanOrEqual(0);
        expect(out.effectiveConfidence).toBeLessThanOrEqual(1);
        expect(new Set(out.warnings).size).toBe(out.warnings.length);
      }),
      { numRuns: RUNS },
    );
  });

  test("evidência preservada: termo marcado com menção explícita sempre está na stack de saída", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        fc.pre(input.llmFacts !== null && input.signals.injectionLevel !== "alta");
        const out = resolver.resolve(input);
        const present = new Set(outputStack(out.facts).map(lower));
        const marked = new Set(input.markedStackTerms.map(lower));
        for (const m of input.signals.stackMentions) {
          if (m.strength === "explicita" && marked.has(lower(m.term))) expect(present.has(lower(m.term))).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });

  test("LGPD: todo termo da saída vem, com a mesma grafia, do LLM ou de uma menção explícita do texto", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = resolver.resolve(input);
        const sources = new Set([
          ...(input.signals.injectionLevel === "alta" || input.llmFacts === null ? [] : outputStack(input.llmFacts)),
          ...input.signals.stackMentions.filter((m) => m.strength === "explicita").map((m) => m.term),
        ]);
        for (const t of outputStack(out.facts)) expect(sources.has(t)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  test("conflito: campo vazio ou nulo, proveniência conflito e aviso informacao_contraditoria", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = resolver.resolve(input);
        for (const field of out.conflicts) {
          expect(out.provenance[field]).toBe("conflito");
          const value = out.facts[field];
          expect(value === null || (Array.isArray(value) && value.length === 0)).toBe(true);
        }
        expect(out.warnings.includes("informacao_contraditoria")).toBe(out.conflicts.length > 0);
      }),
      { numRuns: RUNS },
    );
  });

  test("salario_omitido presente se e só se o salário final é nulo", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = resolver.resolve(input);
        expect(out.facts.redFlagSignals.includes("salario_omitido")).toBe(out.facts.salary === null);
      }),
      { numRuns: RUNS },
    );
  });

  test("injection média ou saída saneada: confiança é exatamente a metade da mesma entrada limpa", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        fc.pre(input.llmFacts !== null);
        const clean = resolver.resolve({ ...input, llmOutputInjection: false, signals: { ...input.signals, injectionLevel: "baixa" } });
        const dirty = resolver.resolve({ ...input, llmOutputInjection: true, signals: { ...input.signals, injectionLevel: "media" } });
        expect(dirty.effectiveConfidence).toBe(clean.effectiveConfidence * DEFAULT_FACT_RESOLVER_POLICY.mediumInjectionFactor);
        expect(dirty.warnings).toContain("possivel_prompt_injection");
        expect(dirty.facts).toEqual(clean.facts);
      }),
      { numRuns: RUNS },
    );
  });

  test("pureza: entrada congelada não quebra nada e a mesma entrada dá a mesma saída", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const frozen = deepFreeze(structuredClone(input));
        expect(resolver.resolve(frozen)).toEqual(resolver.resolve(input));
      }),
      { numRuns: RUNS },
    );
  });
});
