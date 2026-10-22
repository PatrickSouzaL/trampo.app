// F1-DOM-03: catálogo de templates rc1 (ADR-012 D3 e D6). Espelho dos enums do contrato, completude, lista
// fechada de caracteres, limites no pior caso e trava da versão (texto novo exige catálogo novo).
import { createHash } from "node:crypto";

import {
  AnalysisWarningSchema,
  ContractTypeSchema,
  DimensionOutcomeSchema,
  ResolvedJobFactsSchema,
  SeniorityLevelSchema,
  VerdictSchema,
  WorkModelSchema,
  safeText,
  type ScoreDimension,
} from "@trampo/contracts";
import { describe, expect, test } from "vitest";

import {
  ANALYSIS_WARNINGS,
  CONTRACT_TYPES,
  DEFAULT_REPORT_CATALOG,
  DIMENSION_OUTCOMES,
  MAX_LISTED_FACTS,
  RED_FLAG_EFFECTS,
  REPORT_CATALOG_VERSION,
  ReportComposer,
  SCORE_DIMENSIONS,
  SPECIFIC_REASON_CODES,
  VERDICTS,
  WORK_MODELS,
  reportCatalogIssues,
  type DimensionEvaluation,
  type ReportCatalog,
  type ScoreResult,
} from "../../src/domain/index.js";
import { ENVELOPE, scoreResult } from "./fakes/report-fixtures.js";
import { NO_FACTS, facts, input } from "./fakes/scoring-fixtures.js";

const C = DEFAULT_REPORT_CATALOG;
const with_ = (over: Partial<Record<keyof ReportCatalog, unknown>>): ReportCatalog => ({ ...C, ...over }) as ReportCatalog;
const issues = (over: Partial<Record<keyof ReportCatalog, unknown>>): string[] => reportCatalogIssues(with_(over));

/** Todo texto do catálogo, com o caminho. */
function allTexts(c: ReportCatalog): [string, string][] {
  return Object.entries(c).flatMap(([key, value]): [string, string][] =>
    typeof value === "string" ? [[key, value]] : Object.entries(value as Record<string, string>).map(([k, v]): [string, string] => [`${key}.${k}`, v]),
  );
}

describe("listas do domínio espelham o contrato, na ordem", () => {
  test.each([
    ["DIMENSION_OUTCOMES", DIMENSION_OUTCOMES, DimensionOutcomeSchema.options],
    ["VERDICTS", VERDICTS, VerdictSchema.options],
    ["WORK_MODELS", WORK_MODELS, WorkModelSchema.options],
    ["CONTRACT_TYPES", CONTRACT_TYPES, ContractTypeSchema.options],
    ["ANALYSIS_WARNINGS", ANALYSIS_WARNINGS, AnalysisWarningSchema.options],
  ])("%s", (_name, domain, contract) => {
    expect([...domain]).toEqual([...contract]);
  });

  test("efeitos de red flag: os 3 do motor, do mais severo ao mais leve", () => {
    expect([...RED_FLAG_EFFECTS]).toEqual(["eliminatoria", "penalidade", "alerta"]);
  });

  test("os 14 códigos específicos e os 6 outcomes cobrem os 20 ScoreReasonCode, sem sobreposição", () => {
    expect(SPECIFIC_REASON_CODES).toHaveLength(14);
    expect(SPECIFIC_REASON_CODES).not.toContain("salario_moeda_diferente");
    const outcomes = new Set<string>(DIMENSION_OUTCOMES);
    expect(SPECIFIC_REASON_CODES.filter((r) => outcomes.has(r))).toEqual([]);
  });

  test("MAX_LISTED_FACTS é o teto de cada lista no contrato dos fatos", () => {
    const parses = (field: keyof typeof MAX_LISTED_FACTS, values: readonly string[]): boolean =>
      ResolvedJobFactsSchema.safeParse({ ...NO_FACTS, [field]: values }).success;
    expect(parses("workModels", WorkModelSchema.options)).toBe(true);
    expect(MAX_LISTED_FACTS.workModels).toBe(WorkModelSchema.options.length);
    expect(parses("contractTypes", ContractTypeSchema.options)).toBe(true);
    expect(MAX_LISTED_FACTS.contractTypes).toBe(ContractTypeSchema.options.length);
    expect(parses("seniorityLevels", ["estagio", "junior", "pleno"])).toBe(true);
    expect(parses("seniorityLevels", ["estagio", "junior", "pleno", "senior"])).toBe(false);
    expect(MAX_LISTED_FACTS.seniorityLevels).toBe(3);
  });
});

describe("catálogo rc1 (ADR-012 D3)", () => {
  test("é coerente e o composer aceita", () => {
    expect(reportCatalogIssues(C)).toEqual([]);
    expect(() => new ReportComposer()).not.toThrow();
    expect(C.version).toBe(REPORT_CATALOG_VERSION);
    expect(REPORT_CATALOG_VERSION).toBe("rc1");
  });

  test("trava: mudar qualquer texto exige catálogo novo (rc2) e este teste novo", () => {
    const digest = createHash("sha256").update(JSON.stringify(C)).digest("hex");
    expect([C.version, digest]).toEqual(["rc1", "18ce6ebc2c25c3437567645fc8a08efd6507f20572d3d53a31a1a48e9a082ed5"]);
  });

  test("todo texto passa no safeText(140) do contrato", () => {
    const item = safeText(140);
    for (const [path, text] of allTexts(C)) expect(item.safeParse(text).success, path).toBe(true);
  });

  test("SR-11: nenhuma frase ecoa critério ('você exige', 'você quer', 'seu mínimo', 'sua pretensão')", () => {
    const forbidden = ["você exige", "voce exige", "você quer", "seu mínimo", "sua pretensão", "você pediu"];
    for (const [path, text] of allTexts(C)) {
      for (const phrase of forbidden) expect(text.toLowerCase().includes(phrase), `${path}: ${phrase}`).toBe(false);
    }
  });
});

describe("validação do catálogo (ADR-012 D6)", () => {
  test.each([["RC1"], ["-rc1"], [""], ["r".repeat(33)], ["rc 1"], [7]])("version inválida: %s", (version) => {
    expect(issues({ version })).toContain("version fora do formato VersionTag");
  });

  test("version válidas", () => {
    for (const version of ["rc1", "rc1.2-b", "9", "r".repeat(32)]) expect(issues({ version }), version).toEqual([]);
  });

  test("chave de enum ausente", () => {
    const { pj: _pj, ...contractTypes } = C.contractTypes;
    expect(issues({ contractTypes })).toEqual(["contractTypes.pj vazio"]);
    const { conflito_eliminatorio: _c, ...reasons } = C.reasons;
    expect(issues({ reasons })).toEqual(["reasons.conflito_eliminatorio vazio"]);
  });

  test.each([
    ["vazio", "", "vazio"],
    ["espaço no início", " Nota", "com espaço nas pontas"],
    ["espaço no fim", "Nota ", "com espaço nas pontas"],
    ["espaço duplo", "Nota  final", "com espaço duplo"],
    ["barra", "Neutro / oportunidade", "com caractere fora da lista fechada"],
    ["arroba", "a@b", "com caractere fora da lista fechada"],
    ["sinal de menor", "<b>", "com caractere fora da lista fechada"],
    ["colchete", "[x]", "com caractere fora da lista fechada"],
    ["zero-width", "No​ta", "com caractere fora da lista fechada"],
    ["quebra de linha", "No\nta", "com caractere fora da lista fechada"],
    ["emoji", "Nota 👍", "com caractere fora da lista fechada"],
  ])("texto recusado: %s", (_name, scoreLabel, rule) => {
    expect(issues({ scoreLabel })).toEqual([`scoreLabel ${rule}`]);
  });

  test("todo caractere da lista fechada passa, inclusive as pontas dos intervalos ASCII", () => {
    const allowed = [..."aAzZ09mM", ..."áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ", ...".,;:()-"];
    for (const ch of allowed) expect(issues({ scoreLabel: `x${ch}x` }), ch).toEqual([]);
    expect(issues({ scoreLabel: "Ação, fé; título: (ÚLTIMA-çã) 9." })).toEqual([]);
  });

  test.each([["`"], ["{"], ["/"], ["@"], ["["], ["!"], ["ñ"], ["ß"]])("vizinho fora da lista: %s", (ch) => {
    expect(issues({ scoreLabel: `x${ch}x` })).toEqual(["scoreLabel com caractere fora da lista fechada"]);
  });

  test("toda chave de toda tabela e todo texto avulso são exigidos", () => {
    for (const [key, value] of Object.entries(C) as [keyof ReportCatalog, unknown][]) {
      if (key === "version") continue;
      if (typeof value === "string") {
        expect(issues({ [key]: undefined }), key).toEqual([`${key} vazio`]);
        continue;
      }
      for (const inner of Object.keys(value as object)) {
        const { [inner]: _gone, ...rest } = value as Record<string, string>;
        expect(issues({ [key]: rest }), `${key}.${inner}`).toEqual([`${key}.${inner} vazio`]);
      }
    }
  });

  test("um texto inválido suspende a conta dos limites (que dependeria dele)", () => {
    expect(issues({ against: "", dimensions: { ...C.dimensions, stack: "x".repeat(200) } })).toEqual(["against vazio"]);
  });

  test("linha (ReportItem.text) acima de 140 no pior caso", () => {
    // stack não tem detalhe: 60 estoura só a linha (140); 70 estoura também a explanation (160).
    // O rótulo da dimensão também entra nas listas do summary, que estoura junto.
    expect(issues({ dimensions: { ...C.dimensions, stack: "S".repeat(60) } })).toEqual([
      "linha de stack pode passar de 140",
      "summary pode passar de 200",
    ]);
    expect(issues({ dimensions: { ...C.dimensions, stack: "S".repeat(70) } })).toEqual([
      "linha de stack pode passar de 140",
      "explanation de stack pode passar de 160",
      "summary pode passar de 200",
    ]);
  });

  test("explanation acima de 160 só pelo detalhe da dimensão", () => {
    const found = issues({ contractTypes: { ...C.contractTypes, cooperado: "c".repeat(20) } });
    expect(found).toEqual(["explanation de contrato pode passar de 160"]);
    expect(issues({ currencies: { ...C.currencies, ARS: "a".repeat(60) } })).toEqual(["explanation de salario pode passar de 160"]);
    expect(issues({ workModels: { ...C.workModels, remoto: "r".repeat(30) } })).toEqual(["explanation de modelo_trabalho pode passar de 160"]);
    expect(issues({ seniorityLevels: { ...C.seniorityLevels, estagio: "e".repeat(30) } })).toEqual(["explanation de senioridade pode passar de 160"]);
  });

  test("o pior caso do detalhe usa as listas no teto do contrato, não o enum inteiro", () => {
    // 6 rótulos de senioridade somam mais que 3: se a conta usasse o enum inteiro, o rc1 seria recusado.
    expect(issues({ seniorityLevels: { ...C.seniorityLevels, estagio: "e".repeat(14) } })).toEqual([]);
  });

  test("item de sinal acima de 140", () => {
    expect(issues({ redFlagEffects: { ...C.redFlagEffects, alerta: "a".repeat(110) } })).toEqual(["item de sinal pode passar de 140"]);
  });

  test.each([
    ["template de faixa", { verdicts: { ...C.verdicts, neutro: "N".repeat(110) } }],
    ["template de deal-breaker", { dealBreakerVerdict: "D".repeat(140) }],
    ["nota da base neutra", { emptyBaseNote: "E".repeat(90) }],
    ["rótulo A favor", { inFavor: "F".repeat(60) }],
    ["rótulo Eliminada por", { eliminatedBy: "L".repeat(100) }],
  ])("summary acima de 200: %s", (_name, over) => {
    expect(issues(over)).toEqual(["summary pode passar de 200"]);
  });
});

describe("os limites do pior caso são exatos (ADR-012 D6)", () => {
  type Over = Partial<Record<keyof ReportCatalog, unknown>>;
  /** Maior n em que a regra ainda não cai (e nenhuma outra cai), e o catálogo nesse n. */
  function edge(make: (n: number) => Over, rule: string): ReportCatalog {
    for (let n = 1; n < 400; n += 1) {
      if (issues(make(n)).includes(rule)) {
        const catalog = with_(make(n - 1));
        expect(reportCatalogIssues(catalog), `n = ${n - 1}`).toEqual([]);
        return catalog;
      }
    }
    throw new Error(`a regra "${rule}" nunca caiu`);
  }
  const argmax = <K extends string>(table: Readonly<Record<K, string>>): K =>
    (Object.keys(table) as K[]).reduce((best, key) => (table[key].length > table[best].length ? key : best));
  const longestDims = (c: ReportCatalog) => [...SCORE_DIMENSIONS].sort((a, b) => c.dimensions[b].length - c.dimensions[a].length);
  const ALL_FACTS = facts({
    workModels: ["remoto", "hibrido", "presencial"],
    contractTypes: ["clt", "pj", "cooperado", "estagio", "temporario"],
    salary: { min: 1, max: 2, currency: "ARS", period: "mes" },
  });
  const render = (c: ReportCatalog, score: ScoreResult, f = ALL_FACTS) =>
    new ReportComposer(c).compose({ envelope: ENVELOPE, resolution: { facts: f, provenance: input(f).provenance, effectiveConfidence: 1 }, warnings: [], score });
  /** A linha mais longa possível: o maior outcome com a maior reason específica. */
  const worstLine = (c: ReportCatalog): Partial<DimensionEvaluation> => ({ outcome: argmax(c.outcomes), reason: argmax(c.reasons), points: 1 });

  test("linha (ReportItem.text) = 140 no limiar", () => {
    const c = edge((n) => ({ dimensions: { ...C.dimensions, stack: "S".repeat(n) } }), "linha de stack pode passar de 140");
    // A stack não tem detalhe: a explanation é a própria linha, o mesmo texto dos itens.
    expect(render(c, scoreResult({ stack: worstLine(c) })).breakdown[0]?.explanation.length).toBe(140);
  });

  test.each([
    ["contrato", (n: number) => ({ contractTypes: { ...C.contractTypes, cooperado: "c".repeat(n) } })],
    ["modelo_trabalho", (n: number) => ({ workModels: { ...C.workModels, remoto: "r".repeat(n) } })],
    ["salario", (n: number) => ({ currencies: { ...C.currencies, ARS: "a".repeat(n) } })],
  ] as const)("explanation de %s = 160 no limiar", (dimension, make) => {
    const c = edge(make, `explanation de ${dimension} pode passar de 160`);
    const line = dimension === "salario" ? { ...worstLine(c), reason: "salario_convertido" as const } : worstLine(c);
    const explanation = render(c, scoreResult({ [dimension]: line })).breakdown.find((e) => e.dimension === dimension)?.explanation ?? "";
    // No salário, a reason é a salario_convertido, e não a mais longa: o limite conta a mais longa.
    const slack = dimension === "salario" ? c.reasons[argmax(c.reasons)].length - c.reasons.salario_convertido.length : 0;
    expect(explanation.length).toBe(160 - slack);
  });

  test("explanation de senioridade = 160 no limiar, com as 3 senioridades mais longas", () => {
    const c = edge((n) => ({ seniorityLevels: { ...C.seniorityLevels, estagio: "e".repeat(n) } }), "explanation de senioridade pode passar de 160");
    const top3 = [...SeniorityLevelSchema.options].sort((a, b) => c.seniorityLevels[b].length - c.seniorityLevels[a].length).slice(0, 3);
    const explanation = render(c, scoreResult({ senioridade: worstLine(c) }), facts({ seniorityLevels: top3 })).breakdown[2]?.explanation ?? "";
    expect(explanation.length).toBe(160);
  });

  test("item de sinal = 140 no limiar", () => {
    const c = edge((n) => ({ redFlagEffects: { ...C.redFlagEffects, alerta: "a".repeat(n) } }), "item de sinal pode passar de 140");
    const report = render(c, scoreResult({}, { redFlagHits: [{ signal: argmax(c.redFlags), effect: "alerta" }] }));
    expect(report.redFlags[0]?.text.length).toBe(140);
  });

  test("summary com A favor e Contra = 200 no limiar, com 4 dimensões distintas", () => {
    const c = edge((n) => ({ inFavor: "F".repeat(n) }), "summary pode passar de 200");
    const [a, b, d, e] = longestDims(c) as [ScoreDimension, ScoreDimension, ScoreDimension, ScoreDimension];
    const weak = { outcome: "nao_atende", importance: "ponderado", points: 0 } as const;
    const score = scoreResult(
      { [a]: { outcome: "atende", points: 30 }, [b]: { outcome: "atende", points: 20 }, [d]: weak, [e]: weak },
      { verdict: argmax(c.verdicts), score: 100 },
    );
    expect(render(c, score).summary.length).toBe(200);
  });

  test("summary com a base neutra e Contra = 200 no limiar", () => {
    const c = edge((n) => ({ emptyBaseNote: `${"E".repeat(n)}.` }), "summary pode passar de 200");
    const [a, b] = longestDims(c) as [ScoreDimension, ScoreDimension];
    const weak = { outcome: "nao_atende", importance: "ponderado", points: 0 } as const;
    const score = scoreResult({ [a]: weak, [b]: weak }, { verdict: argmax(c.verdicts), score: 100, neutralBase: 50 });
    expect(render(c, score).summary.length).toBe(200);
  });

  test("summary com deal-breaker = 200 no limiar, com 3 dimensões", () => {
    const c = edge((n) => ({ eliminatedBy: "L".repeat(n) }), "summary pode passar de 200");
    const [a, b, d] = longestDims(c) as [ScoreDimension, ScoreDimension, ScoreDimension];
    const hit = { outcome: "nao_atende", importance: "eliminatorio", points: -30, dealBreakerHit: true } as const;
    const score = scoreResult({ [a]: hit, [b]: hit, [d]: hit }, { dealBreakerHit: true, verdict: "foge", score: 100 });
    expect(render(c, score).summary.length).toBe(200);
  });
});
