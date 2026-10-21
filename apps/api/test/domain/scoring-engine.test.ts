// F1-DOM-02: ScoringEngine (ADR-002). Uma regra por teste, com os números calculados à mão a partir do
// §3 (base ponderada, maior resto, penalidades) e do §4.2 (regra de cada dimensão).
import type { ResolvedJobFacts, ScoreDimension, UserCriteria } from "@trampo/contracts";
import { describe, expect, test } from "vitest";

import {
  DependencyContractError,
  ScoringEngine,
  foldCity,
  type DimensionEvaluation,
  type ScoreResult,
} from "../../src/domain/index.js";
import {
  ELIMINATORY,
  IGNORE,
  NO_CRITERIA,
  REQUIRED,
  criteria,
  facts,
  input,
  stack,
  tolerance,
  weighted,
} from "./fakes/scoring-fixtures.js";

const engine = new ScoringEngine();

function run(f: Partial<ResolvedJobFacts>, c: Partial<UserCriteria>, options?: Parameters<typeof input>[1]): ScoreResult {
  return engine.score(input(facts(f), options), criteria(c));
}

function line(result: ScoreResult, dimension: ScoreDimension): DimensionEvaluation {
  const found = result.breakdown.find((entry) => entry.dimension === dimension);
  if (found === undefined) throw new Error(`sem a linha ${dimension}`);
  return found;
}

const summary = (entry: DimensionEvaluation) => [entry.outcome, entry.importance, entry.points, entry.dealBreakerHit, entry.reason];

describe("nota, base e faixas (§3)", () => {
  test("sem critério ativo: tudo ignorado, base neutra 50 fora do breakdown", () => {
    const r = run({}, {});
    expect(r).toEqual({
      score: 50,
      verdict: "neutro",
      dealBreakerHit: false,
      neutralBase: 50,
      breakdown: ["stack", "modelo_trabalho", "senioridade", "contrato", "salario", "localizacao", "idiomas", "beneficios", "red_flags"].map(
        (dimension) => ({ dimension, outcome: "ignorado", importance: "ignorar", points: 0, dealBreakerHit: false, reason: "ignorado" }),
      ),
      redFlagHits: [],
      engineVersion: "se1",
    });
  });

  test.each([
    [["clt", "pj", "cooperado"], ["clt"], 33, "baixo_alinhamento"],
    [["clt", "pj", "cooperado"], ["clt", "pj"], 67, "neutro"],
    [["clt", "pj"], ["clt", "pj"], 100, "altamente_recomendado"],
    [["pj"], ["clt"], 0, "foge"],
  ] as const)("contrato ponderado %j aceitando %j: nota %i, %s", (values, accepted, score, verdict) => {
    const r = run({ contractTypes: [...values] }, { contractType: { accepted: [...accepted], importance: weighted(1) } });
    expect([r.score, r.verdict, r.dealBreakerHit, r.neutralBase]).toEqual([score, verdict, false, 0]);
  });

  test("75 é recomendado (benefícios 3 de 4)", () => {
    const desired = ["plano_saude", "vale_refeicao", "vale_alimentacao", "seguro_vida"] as const;
    const r = run({ benefits: ["plano_saude", "vale_refeicao", "vale_alimentacao"] }, { benefits: { desired: [...desired], importance: weighted(2) } });
    expect([r.score, r.verdict]).toEqual([75, "recomendado"]);
  });

  test("deal-breaker: teto 20 e foge, mesmo com a soma acima; empate do maior resto vai para a ordem do enum", () => {
    const r = run(
      { workModels: ["presencial"], contractTypes: ["clt"], benefits: ["plano_saude"] },
      {
        workModel: { accepted: ["remoto"], importance: ELIMINATORY },
        contractType: { accepted: ["clt"], importance: REQUIRED },
        benefits: { desired: ["plano_saude"], importance: weighted(5) },
      },
    );
    expect(summary(line(r, "modelo_trabalho"))).toEqual(["nao_atende", "eliminatorio", -30, true, "nao_atende"]);
    expect(line(r, "contrato").points).toBe(34);
    expect(line(r, "beneficios").points).toBe(33);
    expect([r.score, r.verdict, r.dealBreakerHit]).toEqual([20, "foge", true]);
  });

  test("piso 0: a soma negativa vira 0", () => {
    const r = run({ workModels: ["presencial"], redFlagSignals: ["linguagem_vaga"] }, {
      workModel: { accepted: ["remoto"], importance: REQUIRED },
      redFlagTolerance: tolerance("penalizar"),
    });
    expect(r.breakdown.reduce((acc, e) => acc + e.points, 0)).toBe(-40);
    expect([r.score, r.verdict]).toEqual([0, "foge"]);
  });
});

describe("conjuntos: modelo de trabalho e contrato (§4.2.2 e §3.3)", () => {
  const model = (importance: UserCriteria["workModel"]["importance"]) => ({ workModel: { accepted: ["remoto" as const], importance } });

  test.each([
    ["ponderado", weighted(3), ["conflito", "ponderado", 50, false, "conflito"]],
    ["obrigatorio", REQUIRED, ["conflito", "obrigatorio", 45, false, "conflito"]],
    ["eliminatorio", ELIMINATORY, ["conflito", "eliminatorio", 20, false, "conflito_eliminatorio"]],
  ] as const)("conflito em %s", (_name, importance, expected) => {
    const r = run({}, model(importance), { conflicts: ["workModels"] });
    expect(summary(line(r, "modelo_trabalho"))).toEqual(expected);
    expect(r.dealBreakerHit).toBe(false);
  });

  test.each([
    ["ponderado", weighted(2), [], "nao_informado", 50],
    ["obrigatorio", REQUIRED, [], "nao_informado", 45],
    ["obrigatorio", REQUIRED, ["remoto"], "atende", 100],
    ["obrigatorio", REQUIRED, ["remoto", "hibrido"], "atende_parcialmente", 35],
    ["eliminatorio", ELIMINATORY, ["remoto", "hibrido"], "atende_parcialmente", 35],
    ["ponderado", weighted(2), ["hibrido"], "nao_atende", 0],
    ["obrigatorio", REQUIRED, ["hibrido"], "nao_atende", -30],
  ] as const)("%s com %j: %s (%i pontos)", (_name, importance, values, outcome, points) => {
    const r = run({ workModels: [...values] }, model(importance));
    expect([line(r, "modelo_trabalho").outcome, line(r, "modelo_trabalho").points, r.dealBreakerHit]).toEqual([outcome, points, false]);
  });

  test("ignorar tira a dimensão da base", () => {
    expect(summary(line(run({ workModels: ["hibrido"] }, model(IGNORE)), "modelo_trabalho"))).toEqual(["ignorado", "ignorar", 0, false, "ignorado"]);
  });
});

describe("senioridade: adjacência ascendente validada e rebaixamento (D-S5, HITL-018)", () => {
  const seniority = (accepted: UserCriteria["seniority"]["accepted"], importance: UserCriteria["seniority"]["importance"] = REQUIRED) => ({
    seniority: { accepted, importance },
  });

  test.each([
    ["ponderado", weighted(3), -30, false],
    ["obrigatorio", REQUIRED, -30, false],
    ["eliminatorio", ELIMINATORY, -30, true],
  ] as const)("rebaixamento evidente em %s: −30 (sem somar duas vezes)", (_name, importance, points, dealBreaker) => {
    const r = run({ seniorityLevels: ["junior"] }, seniority(["senior"], importance));
    expect(summary(line(r, "senioridade"))).toEqual(["nao_atende", importance.level, points, dealBreaker, "senioridade_rebaixamento"]);
  });

  test("um nível acima: parcial com r = 0,5 e −15; nunca deal-breaker", () => {
    for (const importance of [REQUIRED, ELIMINATORY]) {
      const r = run({ seniorityLevels: ["senior"] }, seniority(["pleno"], importance));
      expect(summary(line(r, "senioridade"))).toEqual(["atende_parcialmente", importance.level, 35, false, "senioridade_adjacente_acima"]);
    }
  });

  test("stack > 80% eleva o r para 0,8 e dispensa a penalidade", () => {
    const r = run({ seniorityLevels: ["senior"], stackRequired: ["Java"] }, { ...seniority(["pleno"]), stack: stack({ mustHave: ["java"] }) });
    expect(summary(line(r, "senioridade"))).toEqual(["atende_parcialmente", "obrigatorio", 40, false, "senioridade_adjacente_validada"]);
    expect([line(r, "stack").points, r.score, r.verdict]).toEqual([50, 90, "altamente_recomendado"]);
  });

  test("validação também em ponderado e só pelo nice-to-have", () => {
    const r = run(
      { seniorityLevels: ["senior"], stackNiceToHave: ["Go"] },
      { ...seniority(["pleno"], weighted(5)), stack: stack({ niceToHave: ["Go"], niceToHaveWeight: 5 }) },
    );
    expect([line(r, "senioridade").reason, line(r, "senioridade").points]).toEqual(["senioridade_adjacente_validada", 40]);
  });

  test("sem validação: stack em exatamente 0,8, stack desconhecida ou deal-breaker de stack", () => {
    const four = ["Java", "Go", "Docker", "Kafka"];
    const exact = run({ seniorityLevels: ["senior"], stackRequired: four }, { ...seniority(["pleno"]), stack: stack({ mustHave: [...four, "AWS"] }) });
    const unknown = run({ seniorityLevels: ["senior"] }, { ...seniority(["pleno"]), stack: stack({ mustHave: ["Java"] }) });
    const breaker = run(
      { seniorityLevels: ["senior"], stackRequired: ["Java", "PHP"] },
      { ...seniority(["pleno"]), stack: stack({ mustHave: ["Java"], dealBreakers: ["PHP"] }) },
    );
    for (const r of [exact, unknown, breaker]) expect(line(r, "senioridade").reason).toBe("senioridade_adjacente_acima");
  });

  test("dois níveis acima seguem a regra comum; especialista e liderança dividem o posto 4", () => {
    expect(summary(line(run({ seniorityLevels: ["senior"] }, seniority(["junior"])), "senioridade"))).toEqual([
      "nao_atende",
      "obrigatorio",
      -30,
      false,
      "nao_atende",
    ]);
    expect(line(run({ seniorityLevels: ["lideranca"] }, seniority(["senior"])), "senioridade").reason).toBe("senioridade_adjacente_acima");
    expect(line(run({ seniorityLevels: ["lideranca"] }, seniority(["especialista"])), "senioridade").reason).toBe("nao_atende");
    expect(line(run({ seniorityLevels: ["junior", "lideranca"] }, seniority(["senior"])), "senioridade").reason).toBe("senioridade_adjacente_acima");
  });

  test("com interseção vale a regra de conjunto (Pleno/Sênior para quem aceita só sênior)", () => {
    expect(summary(line(run({ seniorityLevels: ["junior", "senior"] }, seniority(["senior"])), "senioridade"))).toEqual([
      "atende_parcialmente",
      "obrigatorio",
      35,
      false,
      "atende_parcialmente",
    ]);
  });
});

describe("stack (§4.2.1)", () => {
  test("sem lista ativa (nice-to-have com peso 0 incluso) a dimensão é ignorada", () => {
    expect(line(run({ stackRequired: ["Go"] }, { stack: stack({ niceToHave: ["Go"] }) }), "stack").outcome).toBe("ignorado");
  });

  test("só deal-breakers, sem acerto: fora da base", () => {
    const known = run({ stackRequired: ["Go"] }, { stack: stack({ dealBreakers: ["PHP"] }) });
    const unknown = run({}, { stack: stack({ dealBreakers: ["PHP"] }) });
    expect(summary(line(known, "stack"))).toEqual(["atende", "ignorar", 0, false, "atende"]);
    expect(summary(line(unknown, "stack"))).toEqual(["nao_informado", "ignorar", 0, false, "stack_nao_informada"]);
  });

  test("deal-breaker na stack exigida, sem diferenciar caixa", () => {
    const r = run({ stackRequired: ["PHP"] }, { stack: stack({ dealBreakers: ["php"] }) });
    expect(summary(line(r, "stack"))).toEqual(["nao_atende", "eliminatorio", -30, true, "deal_breaker_stack_exigida"]);
    expect([r.score, r.verdict]).toEqual([20, "foge"]);
  });

  test("deal-breaker só desejável: elimina com qualquer_mencao e não com somente_obrigatoria", () => {
    const any = run({ stackNiceToHave: ["PHP"] }, { stack: stack({ dealBreakers: ["PHP"], dealBreakerScope: "qualquer_mencao" }) });
    const only = run({ stackNiceToHave: ["PHP"] }, { stack: stack({ dealBreakers: ["PHP"] }) });
    const both = run({ stackRequired: ["PHP"], stackNiceToHave: ["Perl"] }, {
      stack: stack({ dealBreakers: ["PHP", "Perl"], dealBreakerScope: "qualquer_mencao" }),
    });
    expect(line(any, "stack").reason).toBe("deal_breaker_stack_desejavel");
    expect([line(only, "stack").dealBreakerHit, line(only, "stack").outcome]).toEqual([false, "atende"]);
    expect(line(both, "stack").reason).toBe("deal_breaker_stack_exigida");
  });

  test.each([
    [["Java"], ["Go"], "atende", 100],
    [["Java"], ["Kafka"], "atende_parcialmente", 35],
    [["Rust"], ["Kafka"], "nao_atende", -30],
  ] as const)("must-have sobre a união da vaga (exigida %j, desejável %j): %s", (required, desired, outcome, points) => {
    const r = run({ stackRequired: [...required], stackNiceToHave: [...desired] }, { stack: stack({ mustHave: ["Java", "Go"] }) });
    expect([line(r, "stack").outcome, line(r, "stack").importance, line(r, "stack").points]).toEqual([outcome, "obrigatorio", points]);
  });

  test("must-have parcial com deal-breaker: vale a penalidade mais severa", () => {
    const r = run({ stackRequired: ["Java", "PHP"] }, { stack: stack({ mustHave: ["Java", "Go"], dealBreakers: ["PHP"] }) });
    expect(summary(line(r, "stack"))).toEqual(["nao_atende", "eliminatorio", 20, true, "deal_breaker_stack_exigida"]);
  });

  test("stack vazia: must-have não informado (−5) e nice-to-have em 0,5", () => {
    const must = run({}, { stack: stack({ mustHave: ["Java"] }) });
    const nice = run({}, { stack: stack({ niceToHave: ["Go"], niceToHaveWeight: 2 }) });
    expect(summary(line(must, "stack"))).toEqual(["nao_informado", "obrigatorio", 45, false, "stack_nao_informada"]);
    expect(summary(line(nice, "stack"))).toEqual(["nao_informado", "ponderado", 50, false, "stack_nao_informada"]);
  });

  test("só nice-to-have segue a regra de conjunto; com must-have, o outcome é o do must-have", () => {
    const nice = run({ stackRequired: ["Go"] }, { stack: stack({ niceToHave: ["Go", "Rust"], niceToHaveWeight: 3 }) });
    expect(summary(line(nice, "stack"))).toEqual(["atende_parcialmente", "ponderado", 50, false, "atende_parcialmente"]);
    const both = run({ stackRequired: ["Java"] }, { stack: stack({ mustHave: ["Java"], niceToHave: ["Rust"], niceToHaveWeight: 5 }) });
    expect(summary(line(both, "stack"))).toEqual(["atende", "obrigatorio", 50, false, "atende"]);
    const none = run({ stackRequired: ["Java"] }, { stack: stack({ niceToHave: ["Rust"], niceToHaveWeight: 3 }) });
    expect(line(none, "stack").outcome).toBe("nao_atende");
  });
});

describe("salário (D-S3: câmbio por tabela fixa)", () => {
  const brl = (minimum: number, importance: UserCriteria["workModel"]["importance"] = REQUIRED) => ({
    salary: { minimum, currency: "BRL" as const, period: "mes" as const, importance },
  });
  const sal = (min: number | null, max: number | null, currency: "BRL" | "USD" | "EUR" | "ARS" | null, period: "hora" | "mes" | "ano" | null) => ({
    salary: { min, max, currency, period },
  });

  test("critério nulo ou ignorar", () => {
    expect(line(run(sal(1, 2, "BRL", "mes"), {}), "salario").outcome).toBe("ignorado");
    expect(line(run(sal(1, 2, "BRL", "mes"), brl(10_000, IGNORE)), "salario").outcome).toBe("ignorado");
  });

  test("conflito e salário ausente", () => {
    expect(summary(line(run({}, brl(10_000), { conflicts: ["salary"] }), "salario"))).toEqual(["conflito", "obrigatorio", 45, false, "conflito"]);
    expect(summary(line(run({}, brl(10_000)), "salario"))).toEqual(["nao_informado", "obrigatorio", 45, false, "nao_informado"]);
  });

  test("vaga estrangeira com moeda nula não vira BRL", () => {
    const r = run({ ...sal(3_800_000, 3_900_000, null, "mes"), location: { city: null, stateUf: null, countryIso2: "AR" } }, brl(10_000));
    expect(summary(line(r, "salario"))).toEqual(["nao_informado", "obrigatorio", 45, false, "salario_moeda_indeterminada"]);
  });

  test("vaga brasileira com moeda e período nulos assume BRL por mês", () => {
    const r = run({ ...sal(12_000, null, null, null), location: { city: null, stateUf: null, countryIso2: "BR" } }, brl(10_000));
    expect(summary(line(r, "salario"))).toEqual(["atende", "obrigatorio", 100, false, "atende"]);
  });

  test("ARS pela tabela (0,0034): 3,8–3,9 milhões viram R$ 12.920–13.260, nunca R$ 3,8 milhões", () => {
    const argentina = { location: { city: null, stateUf: null, countryIso2: "AR" } };
    const ok = run({ ...sal(3_800_000, 3_900_000, "ARS", "mes"), ...argentina }, brl(12_000));
    const short = run({ ...sal(3_800_000, 3_900_000, "ARS", "mes"), ...argentina }, brl(14_000, ELIMINATORY));
    expect(summary(line(ok, "salario"))).toEqual(["atende", "obrigatorio", 100, false, "salario_convertido"]);
    expect(summary(line(short, "salario"))).toEqual(["nao_atende", "eliminatorio", -30, true, "salario_convertido"]);
  });

  test("USD por hora × 220 e EUR por ano ÷ 12", () => {
    const usd = run(sal(35, 45, "USD", "hora"), brl(42_350));
    expect([line(usd, "salario").outcome, line(usd, "salario").reason]).toEqual(["atende", "salario_convertido"]);
    // 42.000–50.000 EUR/ano = R$ 21.000–25.000/mês; mínimo 22.000: r = 3.000/4.000 = 0,75 e −round(7,5) = −8.
    const eur = run(sal(42_000, 50_000, "EUR", "ano"), brl(22_000));
    expect(summary(line(eur, "salario"))).toEqual(["atende_parcialmente", "obrigatorio", 67, false, "salario_convertido"]);
  });

  test("mínimo do usuário em outra moeda também é convertido", () => {
    const r = run(sal(12_000, 12_000, "BRL", "mes"), { salary: { minimum: 2_000, currency: "USD", period: "mes", importance: REQUIRED } });
    expect([line(r, "salario").outcome, line(r, "salario").reason]).toEqual(["atende", "salario_convertido"]);
  });

  test("faixa que toca o mínimo só no topo: parcial com r = 0, sem deal-breaker", () => {
    const r = run(sal(8_000, 10_000, "BRL", "mes"), brl(10_000, ELIMINATORY));
    expect(summary(line(r, "salario"))).toEqual(["atende_parcialmente", "eliminatorio", -30, false, "atende_parcialmente"]);
  });

  test("'até R$ X' é o ponto [X, X] (otimista) e 'a partir de' também", () => {
    expect(line(run(sal(null, 12_000, "BRL", "mes"), brl(10_000)), "salario").outcome).toBe("atende");
    expect(line(run(sal(9_000, null, "BRL", "mes"), brl(10_000)), "salario").outcome).toBe("nao_atende");
  });

  test("ponderado nunca tem penalidade", () => {
    expect(line(run(sal(1_000, 1_000, "BRL", "mes"), brl(10_000, weighted(3))), "salario").points).toBe(0);
  });

  test("salário sem min nem max viola o contrato", () => {
    const broken = { ...facts(), salary: { min: null, max: null, currency: "BRL", period: "mes" } } as unknown as ResolvedJobFacts;
    expect(() => engine.score(input(broken), criteria(brl(10_000)))).toThrow(DependencyContractError);
  });
});

describe("localização (§4.2.4)", () => {
  const loc = (importance: UserCriteria["workModel"]["importance"] = REQUIRED) => ({
    location: { acceptedUfs: ["SP" as const], acceptedCities: ["Recife", "Sao Paulo"], importance },
  });
  const at = (city: string | null, stateUf: "SP" | "PE" | "PR" | null, countryIso2: string | null, workModels: ResolvedJobFacts["workModels"] = ["presencial"]) => ({
    location: { city, stateUf, countryIso2 },
    workModels,
  });

  test("critério nulo ou ignorar; vaga só remota não se aplica", () => {
    expect(line(run(at("Recife", null, null), {}), "localizacao").outcome).toBe("ignorado");
    expect(line(run(at("Recife", null, null), loc(IGNORE)), "localizacao").outcome).toBe("ignorado");
    expect(summary(line(run(at("Curitiba", "PR", "BR", ["remoto"]), loc()), "localizacao"))).toEqual([
      "ignorado",
      "ignorar",
      0,
      false,
      "localizacao_nao_se_aplica",
    ]);
  });

  test("conflito e localização ausente", () => {
    expect(line(run({ workModels: ["hibrido"] }, loc(), { conflicts: ["location"] }), "localizacao").outcome).toBe("conflito");
    expect(line(run({ workModels: ["hibrido"] }, loc()), "localizacao").outcome).toBe("nao_informado");
  });

  test.each([
    ["cidade com caixa e acento diferentes", at("  SÃO   paulo ", null, "BR"), "atende"],
    ["cidade aceita", at("RECIFE", "PE", "BR"), "atende"],
    ["UF aceita", at("Campinas", "SP", "BR"), "atende"],
    ["só o país BR", at(null, null, "BR"), "nao_informado"],
    ["fora do aceito", at("Curitiba", "PR", "BR"), "nao_atende"],
    ["país estrangeiro, mesmo com cidade homônima", at("Recife", null, "PT"), "nao_atende"],
    ["só um país estrangeiro", at(null, null, "AR"), "nao_atende"],
    ["estrangeira com opção remota", at("Lisboa", null, "PT", ["remoto", "hibrido"]), "atende_parcialmente"],
    ["fora do aceito com opção remota", at("Curitiba", "PR", "BR", ["remoto", "presencial"]), "atende_parcialmente"],
    ["modelo de trabalho vazio é avaliado", at("Recife", null, null, []), "atende"],
  ] as const)("%s", (_name, f, outcome) => {
    expect(line(run(f, loc()), "localizacao").outcome).toBe(outcome);
  });

  test("parcial pela opção remota vale r = 0,5 (−15 em obrigatório)", () => {
    expect(line(run(at("Curitiba", "PR", "BR", ["remoto", "hibrido"]), loc()), "localizacao").points).toBe(35);
  });
});

describe("idiomas (§4.2.5, D-S7)", () => {
  const langs = (proficiencies: NonNullable<UserCriteria["languages"]>["proficiencies"], importance: UserCriteria["workModel"]["importance"] = REQUIRED) => ({
    languages: { proficiencies, importance },
  });
  const intermediate = langs([{ language: "ingles", level: "intermediario" }]);
  const req = (language: "ingles" | "espanhol" | "portugues" | "outro", level: "basico" | "avancado" | "nativo" | null, required = true) => ({
    language,
    level,
    required,
  });
  const abroad = { location: { city: null, stateUf: null, countryIso2: "US" } };

  test("critério nulo, ignorar ou conflito", () => {
    expect(line(run({}, {}), "idiomas").outcome).toBe("ignorado");
    expect(line(run({}, langs([], IGNORE)), "idiomas").outcome).toBe("ignorado");
    expect(line(run({}, intermediate, { conflicts: ["languageRequirements"] }), "idiomas").outcome).toBe("conflito");
  });

  test("nenhum exigido: atende com LLM, não informado sem LLM", () => {
    const desirable = { languageRequirements: [req("ingles", "avancado", false)] };
    expect(summary(line(run(desirable, intermediate), "idiomas"))).toEqual(["atende", "obrigatorio", 100, false, "idioma_nao_exigido"]);
    expect(line(run({}, intermediate, { llmExtracted: false }), "idiomas").outcome).toBe("nao_informado");
  });

  test("outro nunca casa: sozinho é não informado; com outro idioma, fica fora da conta", () => {
    expect(line(run({ languageRequirements: [req("outro", null)] }, intermediate), "idiomas").outcome).toBe("nao_informado");
    expect(line(run({ languageRequirements: [req("outro", null), req("ingles", "basico")] }, intermediate), "idiomas").outcome).toBe("atende");
  });

  test("português sem declaração conta como nativo; nível nulo basta ter o idioma", () => {
    expect(line(run({ languageRequirements: [req("portugues", "nativo")] }, intermediate), "idiomas").outcome).toBe("atende");
    expect(line(run({ languageRequirements: [req("ingles", null)] }, intermediate), "idiomas").outcome).toBe("atende");
  });

  test("nível abaixo ou idioma ausente não atende; um de dois é parcial", () => {
    expect(summary(line(run({ languageRequirements: [req("ingles", "avancado")] }, intermediate), "idiomas"))).toEqual([
      "nao_atende",
      "obrigatorio",
      -30,
      false,
      "nao_atende",
    ]);
    expect(line(run({ languageRequirements: [req("espanhol", null)] }, intermediate), "idiomas").outcome).toBe("nao_atende");
    expect(line(run({ languageRequirements: [req("ingles", "basico"), req("espanhol", null)] }, intermediate), "idiomas").outcome).toBe(
      "atende_parcialmente",
    );
  });

  test("vaga internacional: inglês desejável conta, nível nulo vale avançado", () => {
    const f = { ...abroad, languageRequirements: [req("ingles", null, false)] };
    expect(summary(line(run(f, intermediate), "idiomas"))).toEqual(["nao_atende", "obrigatorio", -30, false, "idioma_ingles_internacional"]);
    expect(line(run(f, langs([{ language: "ingles", level: "avancado" }])), "idiomas").outcome).toBe("atende");
    expect(line(run(f, langs([])), "idiomas").reason).toBe("idioma_ingles_internacional");
  });

  test("internacional também pela moeda; falha que não é de inglês mantém o código geral", () => {
    const usd = { salary: { min: 5_000, max: 6_000, currency: "USD" as const, period: "mes" as const }, languageRequirements: [req("ingles", null, false)] };
    expect(line(run(usd, intermediate), "idiomas").reason).toBe("idioma_ingles_internacional");
    const spanish = { ...abroad, languageRequirements: [req("ingles", null), req("espanhol", null)] };
    expect(line(run(spanish, langs([{ language: "ingles", level: "fluente" }])), "idiomas").reason).toBe("atende_parcialmente");
  });

  test("inglês não mencionado não vira requisito inventado", () => {
    expect(line(run({ ...abroad }, intermediate), "idiomas").reason).toBe("idioma_nao_exigido");
  });
});

describe("benefícios (§4.2.6)", () => {
  const ben = (importance: UserCriteria["workModel"]["importance"] = REQUIRED) => ({
    benefits: { desired: ["plano_saude" as const, "vale_refeicao" as const], importance },
  });

  test.each([
    ["nulo", {}, {}, undefined, "ignorado"],
    ["ignorar", { benefits: ["plano_saude"] }, ben(IGNORE), undefined, "ignorado"],
    ["conflito", {}, ben(), ["benefits"], "conflito"],
    ["lista vazia é omissão", {}, ben(), undefined, "nao_informado"],
    ["metade", { benefits: ["plano_saude", "outro"] }, ben(), undefined, "atende_parcialmente"],
    ["todos", { benefits: ["plano_saude", "vale_refeicao"] }, ben(), undefined, "atende"],
    ["nenhum", { benefits: ["outro"] }, ben(), undefined, "nao_atende"],
  ] as const)("%s", (_name, f, c, conflicts, outcome) => {
    expect(line(run(f as Partial<ResolvedJobFacts>, c, { conflicts: conflicts ? [...conflicts] : [] }), "beneficios").outcome).toBe(outcome);
  });
});

describe("red flags (§4.2.7, D-S8)", () => {
  const generous = { benefits: { desired: ["plano_saude" as const], importance: REQUIRED } };

  test("tudo ignorar: dimensão ignorada, mesmo com sinal", () => {
    expect(line(run({ redFlagSignals: ["linguagem_vaga"] }, {}), "red_flags").outcome).toBe("ignorado");
  });

  test("sem sinal: atende com LLM e não informado sem LLM; sinal com tolerância ignorar não conta", () => {
    const c = { redFlagTolerance: tolerance("alertar", { linguagem_vaga: "ignorar" }) };
    expect(summary(line(run({}, c), "red_flags"))).toEqual(["atende", "ignorar", 0, false, "atende"]);
    expect(line(run({}, c, { llmExtracted: false }), "red_flags").outcome).toBe("nao_informado");
    expect(line(run({ redFlagSignals: ["linguagem_vaga"] }, c), "red_flags").outcome).toBe("atende");
  });

  test("alertar: parcial, zero ponto, aparece em redFlagHits", () => {
    const r = run({ redFlagSignals: ["linguagem_vaga"] }, { redFlagTolerance: tolerance("alertar") });
    expect(summary(line(r, "red_flags"))).toEqual(["atende_parcialmente", "ignorar", 0, false, "atende_parcialmente"]);
    expect(r.redFlagHits).toEqual([{ signal: "linguagem_vaga", effect: "alerta" }]);
  });

  test("penalizar: −10 cada, teto −30, na ordem do enum", () => {
    const two = run({ redFlagSignals: ["linguagem_vaga", "escopo_excessivo"] }, { redFlagTolerance: tolerance("penalizar") });
    expect(summary(line(two, "red_flags"))).toEqual(["nao_atende", "obrigatorio", -20, false, "nao_atende"]);
    expect(two.redFlagHits.map((h) => h.signal)).toEqual(["escopo_excessivo", "linguagem_vaga"]);
    const four = run(
      { redFlagSignals: ["linguagem_vaga", "escopo_excessivo", "multiplas_funcoes", "pressao_excessiva"] },
      { redFlagTolerance: tolerance("penalizar") },
    );
    expect(line(four, "red_flags").points).toBe(-30);
  });

  test("benefícios com r > 0,8 cortam pela metade só os sinais de cultura", () => {
    const r = run(
      { benefits: ["plano_saude"], redFlagSignals: ["multiplas_funcoes", "sobreaviso_nao_remunerado"] },
      { ...generous, redFlagTolerance: tolerance("penalizar") },
    );
    expect(summary(line(r, "red_flags"))).toEqual(["nao_atende", "obrigatorio", -15, false, "red_flag_atenuada_por_beneficios"]);
    const neverSoft = run({ benefits: ["plano_saude"], redFlagSignals: ["teste_tecnico_longo", "salario_omitido"] }, {
      ...generous,
      redFlagTolerance: tolerance("penalizar"),
    });
    expect([line(neverSoft, "red_flags").points, line(neverSoft, "red_flags").reason]).toEqual([-20, "nao_atende"]);
  });

  test("sem atenuação com r = 0,8 exato, benefícios ignorados ou não informados", () => {
    const desired = ["plano_saude", "vale_refeicao", "vale_alimentacao", "seguro_vida", "plr_bonus"] as const;
    const exact = run(
      { benefits: ["plano_saude", "vale_refeicao", "vale_alimentacao", "seguro_vida"], redFlagSignals: ["linguagem_vaga"] },
      { benefits: { desired: [...desired], importance: REQUIRED }, redFlagTolerance: tolerance("penalizar") },
    );
    const ignored = run({ benefits: ["plano_saude"], redFlagSignals: ["linguagem_vaga"] }, {
      benefits: { desired: ["plano_saude"], importance: IGNORE },
      redFlagTolerance: tolerance("penalizar"),
    });
    const unknown = run({ redFlagSignals: ["linguagem_vaga"] }, { ...generous, redFlagTolerance: tolerance("penalizar") });
    for (const r of [exact, ignored, unknown]) expect(line(r, "red_flags").points).toBe(-10);
  });

  test("eliminatório: deal-breaker nunca atenuado", () => {
    const r = run(
      { benefits: ["plano_saude"], redFlagSignals: ["multiplas_funcoes", "linguagem_vaga"] },
      { ...generous, redFlagTolerance: tolerance("penalizar", { linguagem_vaga: "eliminatorio" }) },
    );
    expect(summary(line(r, "red_flags"))).toEqual(["nao_atende", "eliminatorio", -5, true, "deal_breaker_red_flag"]);
    expect(r.redFlagHits).toEqual([
      { signal: "multiplas_funcoes", effect: "penalidade" },
      { signal: "linguagem_vaga", effect: "eliminatoria" },
    ]);
    expect([r.verdict, r.dealBreakerHit]).toEqual(["foge", true]);
  });

  test("sem LLM, salario_omitido (do código) continua valendo", () => {
    const r = run({ redFlagSignals: ["salario_omitido"] }, { redFlagTolerance: tolerance("penalizar") }, { llmExtracted: false });
    expect([line(r, "red_flags").outcome, line(r, "red_flags").points]).toEqual(["nao_atende", -10]);
  });
});

describe("foldCity (§4.1)", () => {
  test.each([
    ["São Paulo", "sao paulo"],
    ["  SÃO   PAULO  ", "sao paulo"],
    ["Goiânia", "goiania"],
    ["İstanbul", "istanbul"],
    ["Ｒｅｃｉｆｅ", "recife"],
    ["Mogi das Cruzes", "mogi das cruzes"],
    // Um caractere de cada bloco de marcas (latino, estendido, suplemento, símbolos e meio-sinais) sai; CJK e
    // emoji (acima de todos os blocos) ficam.
    ["àb᪰c᷀d⃐e︠f", "abcdef"],
    ["中😀", "中😀"],
  ])("%j → %j", (raw, folded) => {
    expect(foldCity(raw)).toBe(folded);
  });
});

test("NO_CRITERIA é válido no contrato (base dos testes)", () => {
  expect(criteria({})).toEqual(NO_CRITERIA);
});
