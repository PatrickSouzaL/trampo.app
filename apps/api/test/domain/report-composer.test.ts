// F1-DOM-03: ReportComposer (ADR-012). Unidade com textos exatos: composição da linha e do detalhe (D4),
// seleção e ordem dos itens (D5), summary por faixa, avisos, envelope e meta. ScoreResult montado à mão para
// isolar cada regra; os cenários de ponta a ponta passam pelo motor real.
import { describe, expect, test } from "vitest";

import { DEFAULT_REPORT_CATALOG, ReportComposer, type ReportCatalog, type ScoreResult } from "../../src/domain/index.js";
import { ENVELOPE, composeFor, composer, expectValidReport, scoreResult } from "./fakes/report-fixtures.js";
import { ELIMINATORY, NO_CRITERIA, REQUIRED, criteria, facts, input, stack, tolerance, weighted } from "./fakes/scoring-fixtures.js";

const F = facts();
const RESOLUTION = { facts: F, provenance: input(F).provenance, effectiveConfidence: 0.8 };
const compose = (score: ScoreResult, over: { facts?: typeof F; warnings?: Parameters<ReportComposer["compose"]>[0]["warnings"] } = {}) =>
  composer.compose({
    envelope: ENVELOPE,
    resolution: { ...RESOLUTION, facts: over.facts ?? F },
    warnings: over.warnings ?? [],
    score,
  });

describe("construtor", () => {
  test("recusa catálogo incoerente com RangeError e a lista das regras", () => {
    const bad = { ...DEFAULT_REPORT_CATALOG, version: "RC1", scoreLabel: "" } as ReportCatalog;
    expect(() => new ReportComposer(bad)).toThrow(RangeError);
    expect(() => new ReportComposer(bad)).toThrow("ReportCatalog incoerente (ADR-012 D6): version fora do formato VersionTag; scoreLabel vazio.");
  });

  test("usa o catálogo injetado", () => {
    const custom = new ReportComposer({ ...DEFAULT_REPORT_CATALOG, version: "rc9", scoreLabel: "Pontos" });
    const report = custom.compose({ envelope: ENVELOPE, resolution: RESOLUTION, warnings: [], score: scoreResult() });
    expect(report.meta.reportCatalogVersion).toBe("rc9");
    expect(report.summary).toBe("Neutro (oportunidade): a vaga atende em parte; vale ler os detalhes. Pontos 50.");
  });
});

describe("envelope, fatos e meta passam sem mudança", () => {
  test("campos copiados do envelope, da resolução e do ScoreResult", () => {
    const score = scoreResult({}, { score: 63, verdict: "neutro" });
    const facts_ = facts({ title: "Dev", workModels: ["remoto"] });
    const report = composer.compose({
      envelope: { ...ENVELOPE, platform: "gupy", decisionPath: "fallback_deterministico", extractorVersion: null, provider: null, durationMs: 0 },
      resolution: { facts: facts_, provenance: input(facts_).provenance, effectiveConfidence: 0 },
      warnings: [],
      score,
    });
    expect(report).toMatchObject({
      schemaVersion: 1,
      analysisId: ENVELOPE.analysisId,
      requestId: ENVELOPE.requestId,
      createdAt: ENVELOPE.createdAt,
      platform: "gupy",
      score: 63,
      verdict: "neutro",
      dealBreakerHit: false,
      decisionPath: "fallback_deterministico",
      effectiveConfidence: 0,
      meta: { engineVersion: "se1", reportCatalogVersion: "rc1", extractorVersion: null, provider: null, durationMs: 0 },
    });
    expect(report.facts).toBe(facts_);
    expect(report.provenance).toEqual(input(facts_).provenance);
    expectValidReport(report);
  });

  test("avisos sem duplicata e na ordem do enum", () => {
    const report = compose(scoreResult(), { warnings: ["decisao_sem_ia", "texto_truncado", "decisao_sem_ia", "possivel_prompt_injection"] });
    expect(report.warnings).toEqual(["possivel_prompt_injection", "texto_truncado", "decisao_sem_ia"]);
  });
});

describe("linha e detalhe (ADR-012 D4)", () => {
  const explanation = (score: ScoreResult, dimension: string, f = F) =>
    compose(score, { facts: f }).breakdown.find((e) => e.dimension === dimension)?.explanation;

  test("código geral: só o texto do outcome", () => {
    expect(explanation(scoreResult({ stack: { outcome: "atende", reason: "atende" } }), "stack")).toBe("Stack: dentro do que você procura.");
    expect(explanation(scoreResult(), "idiomas")).toBe("Idiomas: fora do cálculo da nota.");
  });

  test("código específico: o outcome e a frase da reason", () => {
    expect(explanation(scoreResult({ stack: { outcome: "nao_atende", reason: "deal_breaker_stack_exigida" } }), "stack")).toBe(
      "Stack: fora do que você aceita. A vaga exige uma tecnologia que você evita.",
    );
    expect(explanation(scoreResult({ localizacao: { outcome: "ignorado", reason: "localizacao_nao_se_aplica" } }), "localizacao")).toBe(
      "Localização: fora do cálculo da nota. Não se aplica a vaga só remota.",
    );
  });

  test("detalhe com os rótulos dos fatos, na ordem do enum e não na da vaga", () => {
    const f = facts({ workModels: ["presencial", "remoto"], seniorityLevels: ["senior", "pleno"], contractTypes: ["pj", "clt"] });
    const score = scoreResult({
      modelo_trabalho: { outcome: "atende_parcialmente", reason: "atende_parcialmente" },
      senioridade: { outcome: "atende_parcialmente", reason: "senioridade_adjacente_validada" },
      contrato: { outcome: "atende", reason: "atende" },
    });
    expect(explanation(score, "modelo_trabalho", f)).toBe("Modelo de trabalho: atende só em parte. Na vaga: remoto, presencial.");
    expect(explanation(score, "senioridade", f)).toBe(
      "Senioridade: atende só em parte. Nível um degrau acima, compensado pela sua stack. Na vaga: pleno, sênior.",
    );
    expect(explanation(score, "contrato", f)).toBe("Contrato: dentro do que você procura. Na vaga: CLT, PJ.");
  });

  test("sem detalhe com a lista vazia ou com a dimensão ignorada", () => {
    const f = facts({ workModels: ["hibrido"] });
    expect(explanation(scoreResult({ contrato: { outcome: "nao_informado", reason: "nao_informado" } }), "contrato", f)).toBe(
      "Contrato: sem informação na vaga.",
    );
    expect(explanation(scoreResult(), "modelo_trabalho", f)).toBe("Modelo de trabalho: fora do cálculo da nota.");
  });

  test("salário convertido mostra a moeda da vaga; sem moeda na vaga, não mostra nada", () => {
    const converted = scoreResult({ salario: { outcome: "atende", reason: "salario_convertido" } });
    const usd = facts({ salary: { min: 4_000, max: 5_000, currency: "USD", period: "mes" } });
    expect(explanation(converted, "salario", usd)).toBe("Salário: dentro do que você procura. Comparado por câmbio de tabela. Moeda da vaga: dólar (USD).");
    const noCurrency = facts({ salary: { min: 4_000, max: null, currency: null, period: null } });
    expect(explanation(converted, "salario", noCurrency)).toBe("Salário: dentro do que você procura. Comparado por câmbio de tabela.");
    const sameCurrency = scoreResult({ salario: { outcome: "atende", reason: "atende" } });
    expect(explanation(sameCurrency, "salario", usd)).toBe("Salário: dentro do que você procura.");
  });

  test("nenhum número do salário, cidade, país, título ou tag de stack entra no texto", () => {
    const f = facts({
      title: "Engenheira Canario",
      location: { city: "Cidade Canario", stateUf: "SP", countryIso2: "PT" },
      salary: { min: 12_345, max: 67_890, currency: "EUR", period: "ano" },
      stackRequired: ["CanarioLang"],
      workModels: ["hibrido"],
    });
    const lines = { atende: "atende", salario_convertido: "salario_convertido" } as const;
    const score = scoreResult({
      stack: { outcome: "atende", reason: lines.atende },
      salario: { outcome: "atende_parcialmente", reason: lines.salario_convertido },
      localizacao: { outcome: "nao_atende", reason: "nao_atende" },
    });
    const report = compose(score, { facts: f });
    const texts = JSON.stringify([report.summary, report.strengths, report.redFlags, report.missingInfo, report.breakdown]);
    for (const leak of ["Canario", "12345", "12.345", "67890", "67.890", "PT", "SP"]) expect(texts.includes(leak), leak).toBe(false);
  });
});

describe("pontos fortes (ADR-012 D5)", () => {
  test("só atende com ponto positivo, por pontos e, no empate, pela ordem do enum; no máximo 3", () => {
    const score = scoreResult({
      stack: { outcome: "atende", points: 10, reason: "atende" },
      modelo_trabalho: { outcome: "atende", points: 25, reason: "atende" },
      senioridade: { outcome: "atende", points: 10, reason: "atende" },
      contrato: { outcome: "atende", points: 30, reason: "atende" },
      salario: { outcome: "atende_parcialmente", points: 40, reason: "atende_parcialmente" },
      idiomas: { outcome: "atende", points: 0, reason: "atende" },
      red_flags: { outcome: "atende", points: 0, reason: "atende" },
    });
    expect(compose(score).strengths.map((s) => s.dimension)).toEqual(["contrato", "modelo_trabalho", "stack"]);
  });

  test("o texto é a linha, sem o detalhe", () => {
    const score = scoreResult({ modelo_trabalho: { outcome: "atende", points: 20, reason: "atende" } });
    expect(compose(score, { facts: facts({ workModels: ["remoto"] }) }).strengths).toEqual([
      { dimension: "modelo_trabalho", text: "Modelo de trabalho: dentro do que você procura." },
    ]);
  });
});

describe("red flags (ADR-012 D5)", () => {
  const dims = (score: ScoreResult) => compose(score).redFlags.map((r) => r.text);

  test("prioridade: deal-breaker, sinal eliminatório, must-have violado, penalidade, alerta", () => {
    const score = scoreResult(
      {
        contrato: { outcome: "nao_atende", importance: "obrigatorio", points: -30, reason: "nao_atende" },
        senioridade: { outcome: "nao_atende", importance: "eliminatorio", points: -30, dealBreakerHit: true, reason: "nao_atende" },
        red_flags: { outcome: "nao_atende", importance: "eliminatorio", points: -10, dealBreakerHit: true, reason: "deal_breaker_red_flag" },
      },
      {
        dealBreakerHit: true,
        verdict: "foge",
        redFlagHits: [
          { signal: "salario_omitido", effect: "alerta" },
          { signal: "escopo_excessivo", effect: "penalidade" },
          { signal: "pressao_excessiva", effect: "eliminatoria" },
        ],
      },
    );
    expect(composer.compose({ envelope: ENVELOPE, resolution: RESOLUTION, warnings: [], score }).redFlags).toEqual([
      { dimension: "senioridade", text: "Senioridade: fora do que você aceita." },
      { dimension: "red_flags", text: "Sinais de alerta: pressão excessiva, eliminatório para você." },
      { dimension: "contrato", text: "Contrato: fora do que você aceita." },
    ]);
  });

  test("depois do must-have, penalidade antes de alerta e o corte em 3", () => {
    const score = scoreResult(
      {},
      {
        redFlagHits: [
          { signal: "salario_omitido", effect: "alerta" },
          { signal: "escopo_excessivo", effect: "penalidade" },
          { signal: "teste_tecnico_longo", effect: "alerta" },
          { signal: "linguagem_vaga", effect: "alerta" },
        ],
      },
    );
    expect(dims(score)).toEqual([
      "Sinais de alerta: escopo excessivo, pesa contra a nota.",
      "Sinais de alerta: salário omitido, só alerta.",
      "Sinais de alerta: teste técnico longo, só alerta.",
    ]);
  });

  test("must-have violado: estrito em nao_atende, conflito eliminatório e rebaixamento, pelo pior ponto", () => {
    const score = scoreResult({
      stack: { outcome: "nao_atende", importance: "ponderado", points: 0, reason: "nao_atende" },
      modelo_trabalho: { outcome: "conflito", importance: "eliminatorio", points: -25, reason: "conflito_eliminatorio" },
      senioridade: { outcome: "nao_atende", importance: "ponderado", points: -30, reason: "senioridade_rebaixamento" },
      contrato: { outcome: "nao_atende", importance: "obrigatorio", points: -25, reason: "nao_atende" },
      salario: { outcome: "atende_parcialmente", importance: "obrigatorio", points: -12, reason: "atende_parcialmente" },
    });
    expect(compose(score).redFlags.map((r) => r.dimension)).toEqual(["senioridade", "modelo_trabalho", "contrato"]);
  });

  test("o composer aceita qualquer ScoreResult: nao_atende eliminatório sem deal-breaker conta como must-have", () => {
    const score = scoreResult({ idiomas: { outcome: "nao_atende", importance: "eliminatorio", points: -30, reason: "nao_atende" } });
    expect(compose(score).redFlags).toEqual([{ dimension: "idiomas", text: "Idiomas: fora do que você aceita." }]);
  });

  test("a linha de red_flags com deal-breaker não se repete: o sinal já entra", () => {
    const score = scoreResult(
      { red_flags: { outcome: "nao_atende", importance: "eliminatorio", points: 0, dealBreakerHit: true, reason: "deal_breaker_red_flag" } },
      { dealBreakerHit: true, verdict: "foge", redFlagHits: [{ signal: "sobreaviso_nao_remunerado", effect: "eliminatoria" }] },
    );
    expect(dims(score)).toEqual(["Sinais de alerta: sobreaviso sem remuneração, eliminatório para você."]);
  });
});

describe("informações ausentes (ADR-012 D5)", () => {
  test("uma por dimensão não informada ou em conflito, na ordem do enum, inclusive red_flags sem LLM", () => {
    const score = scoreResult({
      salario: { outcome: "nao_informado", importance: "obrigatorio", points: -5, reason: "salario_moeda_indeterminada" },
      stack: { outcome: "nao_informado", importance: "obrigatorio", reason: "stack_nao_informada" },
      contrato: { outcome: "conflito", importance: "ponderado", reason: "conflito" },
      red_flags: { outcome: "nao_informado", importance: "ignorar", reason: "nao_informado" },
      idiomas: { outcome: "nao_atende", importance: "obrigatorio", reason: "nao_atende" },
    });
    expect(compose(score).missingInfo).toEqual([
      { dimension: "stack", text: "Stack: sem informação na vaga. A vaga não lista tecnologias." },
      { dimension: "contrato", text: "Contrato: a vaga se contradiz neste ponto." },
      { dimension: "salario", text: "Salário: sem informação na vaga. Vaga do exterior sem moeda informada." },
      { dimension: "red_flags", text: "Sinais de alerta: sem informação na vaga." },
    ]);
  });
});

describe("summary por faixa (ADR-002 §3.4; ADR-012 D4)", () => {
  test.each([
    ["altamente_recomendado", 95, "Altamente recomendado: a vaga atende a quase tudo o que você procura. Nota 95."],
    ["recomendado", 80, "Recomendado: a vaga atende à maior parte do que você procura. Nota 80."],
    ["neutro", 60, "Neutro (oportunidade): a vaga atende em parte; vale ler os detalhes. Nota 60."],
    ["baixo_alinhamento", 30, "Baixo alinhamento: a vaga atende pouco do que você procura. Nota 30."],
    ["foge", 12, "Foge: a nota ficou muito baixa. Nota 12."],
  ] as const)("faixa %s sem destaques", (verdict, score, summary) => {
    expect(compose(scoreResult({}, { verdict, score })).summary).toBe(summary);
  });

  test("a favor (2 maiores) e contra (red flags primeiro, depois os fracos pelo pior ponto)", () => {
    const score = scoreResult(
      {
        stack: { outcome: "atende", points: 30, reason: "atende" },
        modelo_trabalho: { outcome: "atende", points: 20, reason: "atende" },
        senioridade: { outcome: "atende", points: 10, reason: "atende" },
        contrato: { outcome: "atende_parcialmente", importance: "ponderado", points: 5, reason: "atende_parcialmente" },
        salario: { outcome: "nao_atende", importance: "ponderado", points: 0, reason: "nao_atende" },
      },
      { verdict: "neutro", score: 65, redFlagHits: [{ signal: "linguagem_vaga", effect: "alerta" }] },
    );
    expect(compose(score).summary).toBe(
      "Neutro (oportunidade): a vaga atende em parte; vale ler os detalhes. Nota 65. A favor: Stack, Modelo de trabalho. Contra: Sinais de alerta, Salário.",
    );
  });

  test("contra sem red flag: só os fracos, sem repetir dimensão", () => {
    const score = scoreResult(
      {
        contrato: { outcome: "atende_parcialmente", importance: "obrigatorio", points: -10, reason: "atende_parcialmente" },
        salario: { outcome: "nao_atende", importance: "obrigatorio", points: -30, reason: "nao_atende" },
      },
      { verdict: "baixo_alinhamento", score: 40 },
    );
    expect(compose(score).summary).toBe("Baixo alinhamento: a vaga atende pouco do que você procura. Nota 40. Contra: Salário, Contrato.");
  });

  test("base neutra: avisa que nenhum critério entrou na média", () => {
    const score = scoreResult({}, { verdict: "neutro", score: 50, neutralBase: 50 });
    expect(compose(score).summary).toBe(
      "Neutro (oportunidade): a vaga atende em parte; vale ler os detalhes. Nota 50. Nenhum critério seu entrou na média.",
    );
  });

  test("deal-breaker: template próprio e as dimensões que eliminaram (até 3, na ordem do enum)", () => {
    const hit = { outcome: "nao_atende", importance: "eliminatorio", points: -30, dealBreakerHit: true, reason: "nao_atende" } as const;
    const score = scoreResult(
      { stack: { ...hit, reason: "deal_breaker_stack_exigida" }, contrato: hit, salario: hit, red_flags: { ...hit, reason: "deal_breaker_red_flag" } },
      { dealBreakerHit: true, verdict: "foge", score: 0, neutralBase: 50 },
    );
    expect(compose(score).summary).toBe("Foge: a vaga tem um deal-breaker para você. Nota 0. Eliminada por: Stack, Contrato, Salário.");
  });
});

describe("ponta a ponta com o motor real", () => {
  test("vaga boa para um perfil exigente", () => {
    const f = facts({ workModels: ["remoto"], seniorityLevels: ["pleno"], contractTypes: ["clt"], stackRequired: ["TypeScript"] });
    const c = criteria({
      workModel: { accepted: ["remoto"], importance: ELIMINATORY },
      seniority: { accepted: ["pleno"], importance: weighted(3) },
      contractType: { accepted: ["clt", "pj"], importance: REQUIRED },
      stack: stack({ mustHave: ["typescript"] }),
    });
    const { report, score } = composeFor(input(f), c);
    expectValidReport(report);
    expect(score.verdict).toBe("altamente_recomendado");
    expect(report.summary).toBe(
      "Altamente recomendado: a vaga atende a quase tudo o que você procura. Nota 100. A favor: Stack, Modelo de trabalho.",
    );
    expect(report.strengths.map((s) => s.dimension)).toEqual(["stack", "modelo_trabalho", "contrato"]);
    expect(report.redFlags).toEqual([]);
    expect(report.missingInfo).toEqual([]);
  });

  test("deal-breaker de stack e sinal eliminatório", () => {
    const f = facts({ workModels: ["hibrido"], stackRequired: ["Java"], redFlagSignals: ["sobreaviso_nao_remunerado"] });
    const c = criteria({
      workModel: { accepted: ["remoto"], importance: REQUIRED },
      stack: stack({ dealBreakers: ["java"] }),
      redFlagTolerance: tolerance("alertar", { sobreaviso_nao_remunerado: "eliminatorio" }),
    });
    const { report } = composeFor(input(f), c);
    expectValidReport(report);
    expect(report.verdict).toBe("foge");
    expect(report.summary).toBe("Foge: a vaga tem um deal-breaker para você. Nota 0. Eliminada por: Stack, Sinais de alerta.");
    expect(report.redFlags).toEqual([
      { dimension: "stack", text: "Stack: fora do que você aceita. A vaga exige uma tecnologia que você evita." },
      { dimension: "red_flags", text: "Sinais de alerta: sobreaviso sem remuneração, eliminatório para você." },
      { dimension: "modelo_trabalho", text: "Modelo de trabalho: fora do que você aceita." },
    ]);
  });

  test("perfil vazio: base neutra, nada a favor nem contra", () => {
    const { report } = composeFor(input(facts()), NO_CRITERIA);
    expectValidReport(report);
    expect(report.summary).toBe("Neutro (oportunidade): a vaga atende em parte; vale ler os detalhes. Nota 50. Nenhum critério seu entrou na média.");
    expect(report.breakdown.every((e) => e.explanation === `${DEFAULT_REPORT_CATALOG.dimensions[e.dimension]}: fora do cálculo da nota.`)).toBe(true);
  });
});
