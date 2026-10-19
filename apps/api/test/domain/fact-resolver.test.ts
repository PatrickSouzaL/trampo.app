// F1-DOM-05: FactResolver (ADR-001 §5.6; ADR-011). Casos de cada tabela de fusão, limiares, injection,
// modo só determinístico, LGPD (o perfil só filtra) e pureza. Toda saída passa pelos schemas do contrato.
import { FactFieldSchema, FactProvenanceSchema, ResolvedJobFactsSchema, type JobFacts } from "@trampo/contracts";
import { JOB_TITLE_MAX_CHARS } from "@trampo/contracts/limits";
import { VersionTagSchema, safeText } from "@trampo/contracts/primitives";
import { describe, expect, test } from "vitest";

import {
  DEFAULT_FACT_RESOLVER_POLICY,
  DependencyContractError,
  FACT_RESOLVER_VERSION,
  FactResolver,
  MAX_STACK_TERMS,
  type DeterministicSignals,
  type FactResolution,
  type FactResolverInput,
  type FactResolverPolicy,
} from "../../src/domain/index.js";

const titleSchema = safeText(JOB_TITLE_MAX_CHARS);
const isSafeTitle = (value: string): boolean => titleSchema.safeParse(value).success;
const resolver = new FactResolver({ isSafeTitle });

const llmFacts = (overrides: Partial<JobFacts> = {}): JobFacts => ({
  title: "Desenvolvedor Backend",
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
  extractionConfidence: 0.9,
  ...overrides,
});

const noSignals: DeterministicSignals = {
  workModels: null,
  contractTypes: null,
  seniorityLevels: null,
  salary: null,
  stackMentions: [],
  injectionLevel: "baixa",
};

const signals = (overrides: Partial<DeterministicSignals> = {}): DeterministicSignals => ({ ...noSignals, ...overrides });

const explicit = <T>(values: readonly T[]) => ({ values, strength: "explicita" as const });
const mention = (term: string, strength: "explicita" | "fraca" = "explicita") => ({ term, strength });

/** Resolve e confere que a saída vale no contrato (fatos e proveniência). */
function resolve(input: Partial<FactResolverInput> = {}, with_: FactResolver = resolver): FactResolution {
  const out = with_.resolve({
    llmFacts: llmFacts(),
    llmOutputInjection: false,
    signals: noSignals,
    titleHint: null,
    markedStackTerms: [],
    ...input,
  });
  expect(ResolvedJobFactsSchema.safeParse(out.facts).success).toBe(true);
  expect(Object.keys(out.provenance).sort()).toEqual([...FactFieldSchema.options].sort());
  for (const value of Object.values(out.provenance)) expect(FactProvenanceSchema.options).toContain(value);
  expect(out.effectiveConfidence).toBeGreaterThanOrEqual(0);
  expect(out.effectiveConfidence).toBeLessThanOrEqual(1);
  return out;
}

const salary = (min: number | null, max: number | null, currency: "BRL" | "USD" | null = "BRL", period: "mes" | "ano" | null = "mes") => ({
  min,
  max,
  currency,
  period,
});

describe("versão, política e entrada", () => {
  test("versão fr1 casa com VersionTagSchema; limiares padrão são os do ADR-001 §5.6", () => {
    expect(VersionTagSchema.safeParse(FACT_RESOLVER_VERSION).success).toBe(true);
    expect(FACT_RESOLVER_VERSION).toBe("fr1");
    expect(DEFAULT_FACT_RESOLVER_POLICY).toEqual({ salaryTolerance: 0.05, lowConfidenceThreshold: 0.4, mediumInjectionFactor: 0.5 });
    expect(Object.isFrozen(DEFAULT_FACT_RESOLVER_POLICY)).toBe(true);
    expect(MAX_STACK_TERMS).toBe(30);
    expect(resolve().resolverVersion).toBe("fr1");
  });

  test("política nas bordas é aceita", () => {
    for (const policy of [
      { salaryTolerance: 0, lowConfidenceThreshold: 0, mediumInjectionFactor: 0 },
      { salaryTolerance: 0.5, lowConfidenceThreshold: 1, mediumInjectionFactor: 1 },
    ]) {
      expect(() => new FactResolver({ isSafeTitle, policy })).not.toThrow();
    }
  });

  test.each<[string, Partial<FactResolverPolicy>]>([
    ["tolerância negativa", { salaryTolerance: -0.01 }],
    ["tolerância acima de 0,5", { salaryTolerance: 0.51 }],
    ["tolerância NaN", { salaryTolerance: Number.NaN }],
    ["limiar negativo", { lowConfidenceThreshold: -0.01 }],
    ["limiar acima de 1", { lowConfidenceThreshold: 1.01 }],
    ["fator negativo", { mediumInjectionFactor: -0.01 }],
    ["fator acima de 1", { mediumInjectionFactor: 1.01 }],
  ])("política fora da faixa falha no construtor: %s", (_name, override) => {
    expect(() => new FactResolver({ isSafeTitle, policy: { ...DEFAULT_FACT_RESOLVER_POLICY, ...override } })).toThrow(RangeError);
  });

  test("mais de 30 termos marcados: RangeError; 30 passa", () => {
    const terms = Array.from({ length: 31 }, (_, i) => `Tech${String(i)}`);
    expect(() => resolve({ markedStackTerms: terms })).toThrow(RangeError);
    expect(() => resolve({ markedStackTerms: terms.slice(0, 30) })).not.toThrow();
  });

  test.each([Number.NaN, -0.1, 1.1])("extractionConfidence fora de [0, 1] (%s): DependencyContractError", (value) => {
    expect(() => resolve({ llmFacts: llmFacts({ extractionConfidence: value }) })).toThrow(DependencyContractError);
  });
});

describe("conjuntos (ADR-011 D3)", () => {
  test("sem sinal determinístico: vale o LLM; os dois vazios: ausente", () => {
    const out = resolve({ llmFacts: llmFacts({ workModels: ["remoto"] }) });
    expect(out.facts.workModels).toEqual(["remoto"]);
    expect(out.provenance.workModels).toBe("llm");
    expect(out.provenance.contractTypes).toBe("ausente");
  });

  test("sinal fraco é ignorado: não preenche nem gera conflito", () => {
    const weak = { values: ["presencial"] as const, strength: "fraca" as const };
    const withLlm = resolve({ llmFacts: llmFacts({ workModels: ["remoto"] }), signals: signals({ workModels: weak }) });
    expect(withLlm.facts.workModels).toEqual(["remoto"]);
    expect(withLlm.conflicts).toEqual([]);
    const withoutLlm = resolve({ signals: signals({ workModels: weak }) });
    expect(withoutLlm.facts.workModels).toEqual([]);
    expect(withoutLlm.provenance.workModels).toBe("ausente");
  });

  test("LLM vazio: vale o determinístico", () => {
    const out = resolve({ signals: signals({ contractTypes: explicit(["clt", "clt", "pj"]) }) });
    expect(out.facts.contractTypes).toEqual(["clt", "pj"]);
    expect(out.provenance.contractTypes).toBe("deterministico");
  });

  test("LLM ⊇ determinístico: vale o LLM", () => {
    const out = resolve({
      llmFacts: llmFacts({ seniorityLevels: ["pleno", "senior"] }),
      signals: signals({ seniorityLevels: explicit(["senior"]) }),
    });
    expect(out.facts.seniorityLevels).toEqual(["pleno", "senior"]);
    expect(out.provenance.seniorityLevels).toBe("deterministico_e_llm");
  });

  test("sobreposição parcial: união, primeiro o LLM (omissão não apaga evidência)", () => {
    const out = resolve({
      llmFacts: llmFacts({ contractTypes: ["clt", "cooperado"] }),
      signals: signals({ contractTypes: explicit(["pj", "clt"]) }),
    });
    expect(out.facts.contractTypes).toEqual(["clt", "cooperado", "pj"]);
    expect(out.provenance.contractTypes).toBe("deterministico_e_llm");
    expect(out.conflicts).toEqual([]);
  });

  test("disjuntos: conflito, campo vazio e aviso", () => {
    const out = resolve({
      llmFacts: llmFacts({ workModels: ["hibrido"] }),
      signals: signals({ workModels: explicit(["remoto"]) }),
    });
    expect(out.facts.workModels).toEqual([]);
    expect(out.provenance.workModels).toBe("conflito");
    expect(out.conflicts).toEqual(["workModels"]);
    expect(out.warnings).toContain("informacao_contraditoria");
  });

  test("união acima do teto da senioridade (3): conflito", () => {
    const out = resolve({
      llmFacts: llmFacts({ seniorityLevels: ["junior", "pleno"] }),
      signals: signals({ seniorityLevels: explicit(["pleno", "senior", "especialista"]) }),
    });
    expect(out.facts.seniorityLevels).toEqual([]);
    expect(out.provenance.seniorityLevels).toBe("conflito");
  });

  test("união exatamente no teto (3) passa", () => {
    const out = resolve({
      llmFacts: llmFacts({ seniorityLevels: ["junior", "pleno"] }),
      signals: signals({ seniorityLevels: explicit(["pleno", "senior"]) }),
    });
    expect(out.facts.seniorityLevels).toEqual(["junior", "pleno", "senior"]);
  });

  test("só o determinístico, acima do teto (4 senioridades no título): conflito", () => {
    const out = resolve({
      llmFacts: null,
      signals: signals({ seniorityLevels: explicit(["estagio", "junior", "pleno", "senior"]) }),
    });
    expect(out.facts.seniorityLevels).toEqual([]);
    expect(out.provenance.seniorityLevels).toBe("conflito");
    expect(out.warnings).toEqual(["informacao_contraditoria"]);
  });
});

describe("salário (ADR-011 D4)", () => {
  test("nenhum lado: ausente; só o LLM: llm; só o determinístico: deterministico", () => {
    expect(resolve().provenance.salary).toBe("ausente");
    const onlyLlm = resolve({ llmFacts: llmFacts({ salary: salary(8_000, 10_000) }) });
    expect(onlyLlm.facts.salary).toEqual(salary(8_000, 10_000));
    expect(onlyLlm.provenance.salary).toBe("llm");
    const onlyDet = resolve({ signals: signals({ salary: { value: salary(8_000, null), strength: "explicita" } }) });
    expect(onlyDet.facts.salary).toEqual(salary(8_000, null));
    expect(onlyDet.provenance.salary).toBe("deterministico");
  });

  test("sinal fraco de salário é ignorado", () => {
    const out = resolve({ signals: signals({ salary: { value: salary(8_000, null), strength: "fraca" } }) });
    expect(out.facts.salary).toBeNull();
  });

  test("diferença de exatamente 5%: concordam; vale o LLM com moeda e período completados", () => {
    const out = resolve({
      llmFacts: llmFacts({ salary: salary(9_500, 10_000, null, null) }),
      signals: signals({ salary: { value: salary(10_000, 10_000, "BRL", "mes"), strength: "explicita" } }),
    });
    expect(out.facts.salary).toEqual(salary(9_500, 10_000, "BRL", "mes"));
    expect(out.provenance.salary).toBe("deterministico_e_llm");
    expect(out.conflicts).toEqual([]);
  });

  test("moeda e período do LLM prevalecem quando compatíveis", () => {
    const out = resolve({
      llmFacts: llmFacts({ salary: salary(10_000, null, "BRL", "mes") }),
      signals: signals({ salary: { value: salary(10_000, null, null, null), strength: "explicita" } }),
    });
    expect(out.facts.salary).toEqual(salary(10_000, null, "BRL", "mes"));
  });

  test("diferença acima de 5% em qualquer ponta: conflito, null e aviso", () => {
    for (const llmSalary of [salary(9_499, 10_000), salary(10_000, 10_527)]) {
      const out = resolve({
        llmFacts: llmFacts({ salary: llmSalary }),
        signals: signals({ salary: { value: salary(10_000, 10_000), strength: "explicita" } }),
      });
      expect(out.facts.salary).toBeNull();
      expect(out.provenance.salary).toBe("conflito");
      expect(out.conflicts).toEqual(["salary"]);
      expect(out.warnings).toContain("informacao_contraditoria");
    }
  });

  test("moeda ou período diferentes: conflito", () => {
    const det = { value: salary(10_000, null, "BRL", "mes"), strength: "explicita" as const };
    for (const llmSalary of [salary(10_000, null, "USD", "mes"), salary(10_000, null, "BRL", "ano")]) {
      const out = resolve({ llmFacts: llmFacts({ salary: llmSalary }), signals: signals({ salary: det }) });
      expect(out.provenance.salary).toBe("conflito");
    }
  });

  test("período ausente no LLM vem do determinístico", () => {
    const out = resolve({
      llmFacts: llmFacts({ salary: salary(10_000, null, "BRL", null) }),
      signals: signals({ salary: { value: salary(10_000, null, null, "ano"), strength: "explicita" } }),
    });
    expect(out.facts.salary).toEqual(salary(10_000, null, "BRL", "ano"));
  });

  test("intervalos com uma ponta só: [min ?? max, max ?? min]", () => {
    const out = resolve({
      llmFacts: llmFacts({ salary: salary(null, 10_000) }),
      signals: signals({ salary: { value: salary(10_000, null), strength: "explicita" } }),
    });
    expect(out.provenance.salary).toBe("deterministico_e_llm");
  });

  test("zero com zero concorda", () => {
    const out = resolve({
      llmFacts: llmFacts({ salary: salary(0, 0) }),
      signals: signals({ salary: { value: salary(0, 0), strength: "explicita" } }),
    });
    expect(out.provenance.salary).toBe("deterministico_e_llm");
  });

  test("salário sem min nem max (fora do contrato) falha fechado nos dois lados", () => {
    const empty = salary(null, null);
    expect(() => resolve({ signals: signals({ salary: { value: empty, strength: "explicita" } }) })).toThrow(
      DependencyContractError,
    );
    expect(() =>
      resolve({
        llmFacts: llmFacts({ salary: empty }),
        signals: signals({ salary: { value: salary(1, 1), strength: "explicita" } }),
      }),
    ).toThrow(DependencyContractError);
  });
});

describe("stack e termos marcados (ADR-011 D5, LGPD)", () => {
  test("termo marcado explícito omitido pelo LLM entra no fim, com a grafia do dicionário", () => {
    const out = resolve({
      llmFacts: llmFacts({ stackRequired: ["Java"] }),
      signals: signals({ stackMentions: [mention("TypeScript"), mention("Java")] }),
      markedStackTerms: ["typescript"],
    });
    expect(out.facts.stackRequired).toEqual(["Java", "TypeScript"]);
    expect(out.provenance.stackRequired).toBe("deterministico_e_llm");
    expect(out.conflicts).toEqual([]);
  });

  test("LLM sem stack: só os marcados com evidência, proveniência deterministico", () => {
    const out = resolve({
      signals: signals({ stackMentions: [mention("Go"), mention("Docker")] }),
      markedStackTerms: ["GO"],
    });
    expect(out.facts.stackRequired).toEqual(["Go"]);
    expect(out.provenance.stackRequired).toBe("deterministico");
  });

  test("a classificação do LLM prevalece: marcado como desejável não é promovido", () => {
    const out = resolve({
      llmFacts: llmFacts({ stackNiceToHave: ["docker"] }),
      signals: signals({ stackMentions: [mention("Docker")] }),
      markedStackTerms: ["Docker"],
    });
    expect(out.facts.stackRequired).toEqual([]);
    expect(out.facts.stackNiceToHave).toEqual(["docker"]);
    expect(out.provenance.stackRequired).toBe("ausente");
  });

  test("termo marcado ausente do texto, menção fraca ou menção não marcada: nunca entram", () => {
    const out = resolve({
      llmFacts: llmFacts({ stackRequired: ["Python"] }),
      signals: signals({ stackMentions: [mention("Rust", "fraca"), mention("Kotlin")] }),
      markedStackTerms: ["Elixir", "Rust"],
    });
    expect(out.facts.stackRequired).toEqual(["Python"]);
    expect(out.provenance.stackRequired).toBe("llm");
    expect(JSON.stringify(out)).not.toMatch(/Elixir|Rust|Kotlin/);
  });

  test("menções duplicadas (sem diferenciar maiúsculas): a primeira grafia vence", () => {
    const out = resolve({
      signals: signals({ stackMentions: [mention("Node.js"), mention("node.js")] }),
      markedStackTerms: ["NODE.JS"],
    });
    expect(out.facts.stackRequired).toEqual(["Node.js"]);
  });

  test("teto de 30: saem itens não marcados do fim do LLM; os marcados ficam", () => {
    const llmStack = Array.from({ length: 30 }, (_, i) => `Tech${String(i)}`);
    const out = resolve({
      llmFacts: llmFacts({ stackRequired: llmStack }),
      signals: signals({ stackMentions: [mention("TypeScript"), mention("Go")] }),
      markedStackTerms: ["TypeScript", "Go", "tech29"],
    });
    expect(out.facts.stackRequired).toHaveLength(30);
    expect(out.facts.stackRequired.slice(-3)).toEqual(["Tech29", "TypeScript", "Go"]);
    expect(out.facts.stackRequired).not.toContain("Tech27");
    expect(out.facts.stackRequired).not.toContain("Tech28");
    expect(out.facts.stackRequired).toContain("Tech26");
  });

  test("omissão reduz a corroboração sem gerar aviso de contradição", () => {
    const out = resolve({
      llmFacts: llmFacts({ extractionConfidence: 1 }),
      signals: signals({ stackMentions: [mention("Go")] }),
      markedStackTerms: ["Go"],
    });
    expect(out.effectiveConfidence).toBe(0);
    expect(out.warnings).toEqual(["baixa_confianca_extracao"]);
    const kept = resolve({
      llmFacts: llmFacts({ extractionConfidence: 1, stackRequired: ["Go"] }),
      signals: signals({ stackMentions: [mention("Go")] }),
      markedStackTerms: ["Go"],
    });
    expect(kept.effectiveConfidence).toBe(1);
  });
});

describe("título, red flags e demais campos (ADR-011 D6)", () => {
  test("titleHint seguro vence o LLM; inseguro ou nulo cede ao LLM", () => {
    const safe = resolve({ titleHint: "Engenheira de Dados Sênior" });
    expect(safe.facts.title).toBe("Engenheira de Dados Sênior");
    expect(safe.provenance.title).toBe("deterministico");
    const unsafe = resolve({ titleHint: "Dev <script>" });
    expect(unsafe.facts.title).toBe("Desenvolvedor Backend");
    expect(unsafe.provenance.title).toBe("llm");
    const none = resolve({ llmFacts: llmFacts({ title: null }) });
    expect(none.facts.title).toBeNull();
    expect(none.provenance.title).toBe("ausente");
  });

  test("salario_omitido é do código: some se há salário, entra se não há", () => {
    const withSalary = resolve({
      llmFacts: llmFacts({ salary: salary(5_000, null), redFlagSignals: ["salario_omitido", "escopo_excessivo"] }),
    });
    expect(withSalary.facts.redFlagSignals).toEqual(["escopo_excessivo"]);
    expect(withSalary.provenance.redFlagSignals).toBe("llm");
    const without = resolve({ llmFacts: llmFacts({ redFlagSignals: ["linguagem_vaga"] }) });
    expect(without.facts.redFlagSignals).toEqual(["linguagem_vaga", "salario_omitido"]);
    expect(without.provenance.redFlagSignals).toBe("deterministico_e_llm");
    expect(resolve().provenance.redFlagSignals).toBe("deterministico");
    const nothing = resolve({ llmFacts: llmFacts({ salary: salary(5_000, null), redFlagSignals: ["salario_omitido"] }) });
    expect(nothing.facts.redFlagSignals).toEqual([]);
    expect(nothing.provenance.redFlagSignals).toBe("ausente");
  });

  test("demais campos vêm do LLM", () => {
    const out = resolve({
      llmFacts: llmFacts({
        yearsExperienceMin: 3,
        location: { city: "Recife", stateUf: "PE", countryIso2: "BR" },
        stackNiceToHave: ["Kafka"],
        benefits: ["plano_saude"],
        languageRequirements: [{ language: "ingles", level: "avancado", required: true }],
      }),
    });
    expect(out.facts).toMatchObject({
      yearsExperienceMin: 3,
      location: { city: "Recife" },
      stackNiceToHave: ["Kafka"],
      benefits: ["plano_saude"],
    });
    for (const field of ["yearsExperienceMin", "location", "stackNiceToHave", "benefits", "languageRequirements"] as const) {
      expect(out.provenance[field]).toBe("llm");
    }
    const empty = resolve();
    for (const field of ["yearsExperienceMin", "location", "stackNiceToHave", "benefits", "languageRequirements"] as const) {
      expect(empty.provenance[field]).toBe("ausente");
    }
  });
});

describe("confiança efetiva e injection (ADR-011 D7, D8)", () => {
  test("min(confiança do LLM, corroboração): 1 conflito em 2 comparáveis dá 0,5", () => {
    const out = resolve({
      llmFacts: llmFacts({ extractionConfidence: 0.9, workModels: ["hibrido"], contractTypes: ["clt"] }),
      signals: signals({ workModels: explicit(["remoto"]), contractTypes: explicit(["clt"]) }),
    });
    expect(out.effectiveConfidence).toBe(0.5);
    expect(out.warnings).toEqual(["informacao_contraditoria"]);
  });

  test("campo só do determinístico não conta como comparável", () => {
    const out = resolve({
      llmFacts: llmFacts({ extractionConfidence: 1, contractTypes: ["pj"] }),
      signals: signals({ workModels: explicit(["remoto"]), contractTypes: explicit(["clt"]) }),
    });
    expect(out.facts.workModels).toEqual(["remoto"]);
    expect(out.effectiveConfidence).toBe(0);
  });

  test("sem campos comparáveis, vale a confiança do LLM", () => {
    expect(resolve({ llmFacts: llmFacts({ extractionConfidence: 0.7 }) }).effectiveConfidence).toBe(0.7);
  });

  test("abaixo de 0,4 avisa; exatamente 0,4 não", () => {
    expect(resolve({ llmFacts: llmFacts({ extractionConfidence: 0.39 }) }).warnings).toEqual(["baixa_confianca_extracao"]);
    expect(resolve({ llmFacts: llmFacts({ extractionConfidence: 0.4 }) }).warnings).toEqual([]);
  });

  test("injection média ou saída saneada: ×0,5 e aviso", () => {
    const media = resolve({ llmFacts: llmFacts({ extractionConfidence: 1 }), signals: signals({ injectionLevel: "media" }) });
    expect(media.effectiveConfidence).toBe(0.5);
    expect(media.warnings).toEqual(["possivel_prompt_injection"]);
    const sanitized = resolve({ llmFacts: llmFacts({ extractionConfidence: 0.6 }), llmOutputInjection: true });
    expect(sanitized.effectiveConfidence).toBe(0.3);
    expect(sanitized.warnings).toEqual(["possivel_prompt_injection", "baixa_confianca_extracao"]);
  });

  test("fator da política é respeitado", () => {
    const custom = new FactResolver({ isSafeTitle, policy: { ...DEFAULT_FACT_RESOLVER_POLICY, mediumInjectionFactor: 0.25 } });
    const out = resolve({ llmFacts: llmFacts({ extractionConfidence: 1 }), llmOutputInjection: true }, custom);
    expect(out.effectiveConfidence).toBe(0.25);
  });

  test("injection alta com fatos do LLM: os fatos são descartados (defesa em profundidade)", () => {
    const out = resolve({
      llmFacts: llmFacts({ workModels: ["remoto"], stackRequired: ["Cobol"], extractionConfidence: 1 }),
      signals: signals({ injectionLevel: "alta", contractTypes: explicit(["pj"]) }),
      titleHint: null,
    });
    expect(out.facts.workModels).toEqual([]);
    expect(out.facts.stackRequired).toEqual([]);
    expect(out.facts.title).toBeNull();
    expect(out.facts.contractTypes).toEqual(["pj"]);
    expect(out.effectiveConfidence).toBe(0);
    expect(out.warnings).toEqual(["possivel_prompt_injection"]);
  });
});

describe("modo só determinístico (ADR-011 D7)", () => {
  test("campos dos sinais explícitos; stack = menções explícitas até 30; confiança 0 sem aviso de baixa", () => {
    const mentions = Array.from({ length: 32 }, (_, i) => mention(`Tech${String(i)}`));
    const out = resolve({
      llmFacts: null,
      signals: signals({
        workModels: explicit(["remoto"]),
        salary: { value: salary(7_000, 9_000), strength: "explicita" },
        stackMentions: [mention("Weak", "fraca"), ...mentions],
      }),
      titleHint: "Analista de Dados",
    });
    expect(out.facts).toMatchObject({
      title: "Analista de Dados",
      workModels: ["remoto"],
      salary: salary(7_000, 9_000),
      redFlagSignals: [],
      stackNiceToHave: [],
    });
    expect(out.facts.stackRequired).toHaveLength(30);
    expect(out.facts.stackRequired[0]).toBe("Tech0");
    expect(out.provenance.stackRequired).toBe("deterministico");
    expect(out.provenance.title).toBe("deterministico");
    expect(out.effectiveConfidence).toBe(0);
    expect(out.warnings).toEqual([]);
  });

  test("sem nenhum sinal: tudo ausente, salário omitido", () => {
    const out = resolve({ llmFacts: null });
    expect(out.facts.stackRequired).toEqual([]);
    expect(out.provenance.stackRequired).toBe("ausente");
    expect(out.facts.redFlagSignals).toEqual(["salario_omitido"]);
    expect(out.provenance.title).toBe("ausente");
  });
});

describe("pureza", () => {
  test("não muta a entrada e a saída não compartilha arrays com ela", () => {
    const facts = llmFacts({
      stackRequired: ["Java"],
      stackNiceToHave: ["Kafka"],
      benefits: ["plano_saude"],
      languageRequirements: [{ language: "ingles", level: null, required: false }],
      workModels: ["remoto"],
      location: { city: "Recife", stateUf: null, countryIso2: null },
      salary: { min: 1_000, max: null, currency: null, period: null },
    });
    const snapshot = structuredClone(facts);
    const input: FactResolverInput = {
      llmFacts: facts,
      llmOutputInjection: false,
      signals: signals({ stackMentions: [mention("Go")] }),
      titleHint: null,
      markedStackTerms: ["Go"],
    };
    const first = resolver.resolve(input);
    expect(resolver.resolve(input)).toEqual(first);
    first.facts.stackRequired.push("X");
    first.facts.stackNiceToHave.push("X");
    first.facts.benefits.push("outro");
    first.facts.workModels.push("hibrido");
    const firstLanguage = first.facts.languageRequirements[0];
    if (firstLanguage !== undefined) firstLanguage.required = true;
    if (first.facts.location !== null) first.facts.location.city = "Outra";
    if (first.facts.salary !== null) first.facts.salary.min = 2;
    expect(facts).toEqual(snapshot);
  });

  test("no modo só determinístico, a saída não compartilha o salário do sinal", () => {
    const detSalary = salary(7_000, 9_000);
    const out = resolve({ llmFacts: null, signals: signals({ salary: { value: detSalary, strength: "explicita" } }) });
    if (out.facts.salary !== null) out.facts.salary.min = 1;
    expect(detSalary.min).toBe(7_000);
  });
});
