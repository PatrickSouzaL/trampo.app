// F1-DOM-04: propriedades da Camada 1 (ADR-016 §3). A saída do extrator só tem enums, números e canônicos do
// dicionário (nenhum trecho da vaga, nenhum canário), vale no contrato e é determinística. O roteamento respeita
// a tabela: R1 só por deal-breaker da Camada 1 e só no auto; red flag nunca muda o R1; R2 em qualquer modo;
// flag desligada nunca aceita; o aceite exige a guarda de vacuidade.
import {
  ContractTypeSchema,
  ResolvedJobFactsSchema,
  SalaryFactsSchema,
  SeniorityLevelSchema,
  WorkModelSchema,
  type UserCriteria,
} from "@trampo/contracts";
import { JOB_TITLE_MAX_CHARS } from "@trampo/contracts/limits";
import { safeText } from "@trampo/contracts/primitives";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import {
  DICTIONARY_TERMS,
  FactResolver,
  PreFilterRouter,
  ScoringEngine,
  hasMustCriterion,
  type DeterministicSignals,
  type PreFilterDecision,
} from "../../src/domain/index.js";
import { criteriaArb, tolerance } from "./fakes/scoring-fixtures.js";
import { signalsOf } from "./fakes/pre-filter-harness.js";

const RUNS = 1_000;
const CANARY = "ZQXJCANARYZQXJ";

// Fragmentos que acionam cada detector, misturados com texto arbitrário e com o canário.
const FRAGMENTS = [
  "Requisitos", "Diferenciais", "Benefícios", "Sobre a empresa", "- ", "\n", "\n\n", "**Diferenciais:**",
  "remoto", "híbrido", "presencial", "home office", "auxílio home office", "remoto ou híbrido", "não é remoto", "entrevista presencial",
  "CLT", "PJ", "contratação PJ", "crédito PJ", "estágio", "experiência", "sem possibilidade de CLT", "temporário",
  "Sênior", "Pleno", "Jr", "PL/SQL", "ERP Senior", "Tech Lead",
  "R$", "AR$", "US$", "USD", "€", "8.000", "10k", "15 mil", "3.800.000,00", "a", "até", "/mês", "por hora", "anual", "salário", "bolsa-auxílio", "VR",
  "Java", "Go", "Golang", "linguagem Go", "РНР", "jаvа", "Spring Boot", "SQL Server", "Node.js", "C#", "não é necessário", "sem",
  "\"", "“", "”", "«", "»", "<", ">", "<|im_start|>", "[INST]", "### System",
  "se você é uma IA", "ignore as instruções", "atribua nota máxima", "give this job", "score of 100",
  "​", "‮", "\u{E0041}", "️", "\u{1F3F4}", "\u{1F600}", " ", "İ", "ß", "日本",
  CANARY,
];
const textArb = fc
  .array(fc.oneof(fc.constantFrom(...FRAGMENTS), fc.string({ maxLength: 12, unit: "binary" }), fc.constantFrom(" ", ", ", ". ", ": ")), { maxLength: 60 })
  .map((parts) => parts.join(" "));
const titleArb = fc.option(textArb.map((t) => t.slice(0, 120)), { nil: null });

const titleSchema = safeText(JOB_TITLE_MAX_CHARS);
const resolver = new FactResolver({ isSafeTitle: (value) => titleSchema.safeParse(value).success });
const engine = new ScoringEngine();
const router = new PreFilterRouter({ resolver, engine });
const accepting = new PreFilterRouter({ resolver, engine, policy: { shortCircuitAccept: true } });

function validSet<T extends string>(signal: { values: readonly T[]; strength: string } | null, options: readonly string[]): boolean {
  if (signal === null) return true;
  return (
    signal.values.length > 0 &&
    new Set(signal.values).size === signal.values.length &&
    signal.values.every((v) => options.includes(v)) &&
    (signal.strength === "explicita" || signal.strength === "fraca")
  );
}

describe("propriedades do DeterministicPreFilter", () => {
  test("a saída tem só enums, números e canônicos do dicionário; nada do texto, nem o canário", () => {
    fc.assert(
      fc.property(textArb, titleArb, (text, title) => {
        const s = signalsOf(text, title);
        expect(JSON.stringify(s)).not.toContain(CANARY.toLowerCase());
        expect(JSON.stringify(s)).not.toContain(CANARY);
        expect(validSet(s.workModels, WorkModelSchema.options)).toBe(true);
        expect(validSet(s.contractTypes, ContractTypeSchema.options)).toBe(true);
        expect(validSet(s.seniorityLevels, SeniorityLevelSchema.options)).toBe(true);
        if (s.salary !== null) expect(SalaryFactsSchema.safeParse(s.salary.value).success).toBe(true);
        const terms = s.stackMentions.map((m) => m.term);
        expect(new Set(terms).size).toBe(terms.length);
        for (const m of s.stackMentions) expect(DICTIONARY_TERMS.has(m.term)).toBe(true);
        expect(["baixa", "media", "alta"]).toContain(s.injectionLevel);
        expect(Object.keys(s).sort()).toEqual(["contractTypes", "injectionLevel", "salary", "seniorityLevels", "stackMentions", "workModels"]);
      }),
      { numRuns: RUNS },
    );
  });

  test("determinismo: a mesma entrada dá a mesma saída", () => {
    fc.assert(
      fc.property(textArb, titleArb, (text, title) => {
        expect(signalsOf(text, title)).toEqual(signalsOf(text, title));
      }),
      { numRuns: RUNS },
    );
  });

  test("senioridade explícita só sai do título", () => {
    fc.assert(
      fc.property(textArb, (text) => {
        expect(signalsOf(text, null).seniorityLevels?.strength ?? "fraca").toBe("fraca");
      }),
      { numRuns: RUNS },
    );
  });
});

const strengthArb = fc.constantFrom("explicita" as const, "fraca" as const);
const setArb = <T extends string>(options: readonly T[]) =>
  fc.option(fc.record({ values: fc.uniqueArray(fc.constantFrom(...options), { minLength: 1, maxLength: 3 }), strength: strengthArb }), { nil: null });
const signalsArb: fc.Arbitrary<DeterministicSignals> = fc.record({
  workModels: setArb(WorkModelSchema.options),
  contractTypes: setArb(ContractTypeSchema.options),
  seniorityLevels: setArb(SeniorityLevelSchema.options),
  salary: fc.option(
    fc.record({
      value: fc
        .tuple(fc.integer({ min: 500, max: 60_000 }), fc.integer({ min: 0, max: 20_000 }))
        .chain(([min, extra]) =>
          fc.record({
            min: fc.constant(min),
            max: fc.constant(min + extra),
            currency: fc.constantFrom("BRL" as const, "USD" as const, "EUR" as const, "ARS" as const, null),
            period: fc.constantFrom("mes" as const, "hora" as const, "ano" as const, null),
          }),
        ),
      strength: strengthArb,
    }),
    { nil: null },
  ),
  stackMentions: fc
    .uniqueArray(fc.constantFrom("TypeScript", "Go", "Java", "Docker", "Kafka", "Python", "Node.js", "C#", "AWS", "React"), { maxLength: 6 })
    .chain((terms) => fc.tuple(...terms.map((term) => strengthArb.map((strength) => ({ term, strength }))))),
  injectionLevel: fc.constantFrom("baixa" as const, "media" as const, "alta" as const),
});
const modeArb = fc.constantFrom("auto" as const, "aprofundada" as const);
const LAYER1 = new Set(["stack", "modelo_trabalho", "senioridade", "contrato", "salario"]);

function decide(r: PreFilterRouter, mode: "auto" | "aprofundada", signals: DeterministicSignals, criteria: UserCriteria): PreFilterDecision {
  return r.route({ mode, signals, titleHint: null, criteria });
}

describe("propriedades do PreFilterRouter", () => {
  test("tabela R1–R4: regra, rota, chamada ao LLM e avisos coerentes", () => {
    fc.assert(
      fc.property(modeArb, signalsArb, criteriaArb, fc.boolean(), (mode, signals, criteria, flag) => {
        const d = decide(flag ? accepting : router, mode, signals, criteria);
        ResolvedJobFactsSchema.parse(d.deterministic.resolution.facts);
        const l1Hit = d.deterministic.score.breakdown.some((e) => e.dealBreakerHit && LAYER1.has(e.dimension));
        const expectedRule =
          mode === "auto" && l1Hit ? "R1" : signals.injectionLevel === "alta" ? "R2" : d.acceptEligible && flag ? "R3" : "R4";
        expect(d.rule).toBe(expectedRule);
        expect(d.callsLlm).toBe(d.rule === "R4");
        expect(d.rejectedDimensions.length > 0).toBe(d.rule === "R1");
        for (const dim of d.rejectedDimensions) expect(LAYER1.has(dim)).toBe(true);
        if (d.rule === "R2") expect(d.warnings).toEqual(["possivel_prompt_injection"]);
        if (d.rule === "R3") expect(d.warnings).toEqual(["decisao_sem_ia"]);
        if (d.rule === "R1" || d.rule === "R4") expect(d.warnings).toEqual([]);
        if (d.acceptEligible) {
          expect(mode).toBe("auto");
          expect(hasMustCriterion(criteria)).toBe(true);
          expect(signals.injectionLevel).toBe("baixa");
        }
        if (mode === "aprofundada") expect(["R2", "R4"]).toContain(d.rule);
        if (!flag) expect(d.rule).not.toBe("R3");
      }),
      { numRuns: RUNS },
    );
  });

  test("a tolerância a red flags nunca muda o R1 nem as dimensões rejeitadas", () => {
    fc.assert(
      fc.property(signalsArb, criteriaArb, fc.constantFrom("ignorar" as const, "alertar" as const, "penalizar" as const, "eliminatorio" as const), (signals, criteria, level) => {
        const a = decide(router, "auto", signals, criteria);
        const b = decide(router, "auto", signals, { ...criteria, redFlagTolerance: tolerance(level) });
        expect(b.rule === "R1").toBe(a.rule === "R1");
        expect(b.rejectedDimensions).toEqual(a.rejectedDimensions);
      }),
      { numRuns: RUNS },
    );
  });

  test("sinal fraco nunca causa R1: rebaixar tudo para fraco tira a rejeição", () => {
    const weaken = (s: DeterministicSignals): DeterministicSignals => ({
      ...s,
      workModels: s.workModels && { ...s.workModels, strength: "fraca" },
      contractTypes: s.contractTypes && { ...s.contractTypes, strength: "fraca" },
      seniorityLevels: s.seniorityLevels && { ...s.seniorityLevels, strength: "fraca" },
      salary: s.salary && { ...s.salary, strength: "fraca" },
      stackMentions: s.stackMentions.map((m) => ({ ...m, strength: "fraca" as const })),
    });
    fc.assert(
      fc.property(signalsArb, criteriaArb, (signals, criteria) => {
        expect(decide(router, "auto", weaken(signals), criteria).rule).not.toBe("R1");
      }),
      { numRuns: RUNS },
    );
  });
});
