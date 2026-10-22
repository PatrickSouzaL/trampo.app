// F1-DOM-04 (ADR-016 D9): tabela R1–R4 sobre o FactResolver e o ScoringEngine reais. R1 só por deal-breaker
// das dimensões da Camada 1; red flag nunca rejeita sem IA; R2 em qualquer modo; R3 desligado (D-H3) e com a
// guarda de vacuidade; "aprofundada" ignora R1 e R3.
import { ResolvedJobFactsSchema, type UserCriteria } from "@trampo/contracts";
import { JOB_TITLE_MAX_CHARS } from "@trampo/contracts/limits";
import { safeText } from "@trampo/contracts/primitives";
import { describe, expect, test } from "vitest";

import {
  DEFAULT_PRE_FILTER_ROUTER_POLICY,
  FactResolver,
  PRE_FILTER_ROUTER_VERSION,
  PreFilterRouter,
  ScoringEngine,
  hasMustCriterion,
  type DeterministicSignals,
  type PreFilterRoutingInput,
} from "../../src/domain/index.js";
import { ELIMINATORY, IGNORE, REQUIRED, criteria, stack, tolerance, weighted } from "./fakes/scoring-fixtures.js";

const titleSchema = safeText(JOB_TITLE_MAX_CHARS);
const resolver = new FactResolver({ isSafeTitle: (value) => titleSchema.safeParse(value).success });
const engine = new ScoringEngine();
const router = new PreFilterRouter({ resolver, engine });
const accepting = new PreFilterRouter({ resolver, engine, policy: { shortCircuitAccept: true } });

const NO_SIGNALS: DeterministicSignals = {
  workModels: null,
  contractTypes: null,
  seniorityLevels: null,
  salary: null,
  stackMentions: [],
  injectionLevel: "baixa",
};
const signals = (over: Partial<DeterministicSignals> = {}): DeterministicSignals => ({ ...NO_SIGNALS, ...over });
const explicit = <T extends string>(...values: T[]) => ({ values, strength: "explicita" as const });
const weak = <T extends string>(...values: T[]) => ({ values, strength: "fraca" as const });
const brl = (amount: number, strength: "explicita" | "fraca" = "explicita") => ({
  value: { min: amount, max: amount, currency: "BRL" as const, period: "mes" as const },
  strength,
});

const route = (over: Partial<PreFilterRoutingInput> = {}, with_: PreFilterRouter = router) =>
  with_.route({ mode: "auto", signals: NO_SIGNALS, titleHint: null, criteria: criteria(), ...over });

const remoteOnly = (importance = ELIMINATORY): Partial<UserCriteria> => ({ workModel: { accepted: ["remoto"], importance } });

describe("R1: curto-circuito de rejeição (ADR-016 D9)", () => {
  test("modelo de trabalho eliminatório violado por sinal explícito", () => {
    const decision = route({ criteria: criteria(remoteOnly()), signals: signals({ workModels: explicit("presencial") }) });
    expect(decision).toMatchObject({
      rule: "R1",
      route: "curto_circuito_rejeicao",
      callsLlm: false,
      warnings: [],
      rejectedDimensions: ["modelo_trabalho"],
      acceptEligible: false,
      routerVersion: PRE_FILTER_ROUTER_VERSION,
    });
    expect(decision.deterministic.score.dealBreakerHit).toBe(true);
    expect(decision.deterministic.score.verdict).toBe("foge");
  });

  test("sinal fraco nunca rejeita (o resolver o ignora)", () => {
    expect(route({ criteria: criteria(remoteOnly()), signals: signals({ workModels: weak("presencial") }) }).rule).toBe("R4");
  });

  test("violação de dimensão obrigatória ou ponderada não é R1", () => {
    for (const importance of [REQUIRED, weighted(3)]) {
      expect(route({ criteria: criteria(remoteOnly(importance)), signals: signals({ workModels: explicit("presencial") }) }).rule).toBe("R4");
    }
  });

  test("senioridade segue o motor: um nível acima é parcial (D-S5), dois acima rejeitam, abaixo rejeita", () => {
    const c = criteria({ seniority: { accepted: ["pleno"], importance: ELIMINATORY } });
    expect(route({ criteria: c, signals: signals({ seniorityLevels: explicit("senior") }) }).rule).toBe("R4");
    expect(route({ criteria: c, signals: signals({ seniorityLevels: explicit("especialista") }) }).rejectedDimensions).toEqual(["senioridade"]);
    expect(route({ criteria: c, signals: signals({ seniorityLevels: explicit("junior") }) }).rejectedDimensions).toEqual(["senioridade"]);
  });

  test("contrato, salário (câmbio e período do motor) e stack", () => {
    const contract = criteria({ contractType: { accepted: ["clt"], importance: ELIMINATORY } });
    expect(route({ criteria: contract, signals: signals({ contractTypes: explicit("pj") }) }).rejectedDimensions).toEqual(["contrato"]);

    const salary = criteria({ salary: { minimum: 8000, currency: "BRL", period: "mes", importance: ELIMINATORY } });
    expect(route({ criteria: salary, signals: signals({ salary: brl(5000) }) }).rejectedDimensions).toEqual(["salario"]);
    expect(route({ criteria: salary, signals: signals({ salary: brl(5000, "fraca") }) }).rule).toBe("R4");
    const usdHour = { value: { min: 10, max: 10, currency: "USD" as const, period: "hora" as const }, strength: "explicita" as const };
    expect(route({ criteria: salary, signals: signals({ salary: usdHour }) }).rule).toBe("R4");

    const breaker = criteria({ stack: stack({ dealBreakers: ["PHP"] }) });
    expect(route({ criteria: breaker, signals: signals({ stackMentions: [{ term: "PHP", strength: "explicita" }] }) }).rejectedDimensions).toEqual(["stack"]);
    expect(route({ criteria: breaker, signals: signals({ stackMentions: [{ term: "php", strength: "explicita" }] }) }).rule).toBe("R1");
    expect(route({ criteria: breaker, signals: signals({ stackMentions: [{ term: "PHP", strength: "fraca" }] }) }).rule).toBe("R4");
  });

  test("várias dimensões saem na ordem do enum do contrato", () => {
    const c = criteria({ ...remoteOnly(), contractType: { accepted: ["clt"], importance: ELIMINATORY }, stack: stack({ dealBreakers: ["PHP"] }) });
    const s = signals({ workModels: explicit("presencial"), contractTypes: explicit("pj"), stackMentions: [{ term: "PHP", strength: "explicita" }] });
    expect(route({ criteria: c, signals: s }).rejectedDimensions).toEqual(["stack", "modelo_trabalho", "contrato"]);
  });

  test("red flag eliminatória sem IA não rejeita: salario_omitido é ausência de evidência", () => {
    const c = criteria({ redFlagTolerance: tolerance("eliminatorio") });
    const decision = route({ criteria: c });
    expect(decision.deterministic.score.dealBreakerHit).toBe(true);
    expect(decision.deterministic.resolution.facts.redFlagSignals).toEqual(["salario_omitido"]);
    expect(decision.rule).toBe("R4");
  });

  test("dimensão sem sinal na Camada 1 (localização, idiomas, benefícios) nunca rejeita", () => {
    const c = criteria({
      location: { acceptedUfs: ["SP"], acceptedCities: [], importance: ELIMINATORY },
      languages: { proficiencies: [], importance: ELIMINATORY },
      benefits: { desired: ["plano_saude"], importance: ELIMINATORY },
    });
    expect(route({ criteria: c, signals: signals({ workModels: explicit("presencial") }) }).rule).toBe("R4");
  });

  test("modo aprofundada ignora o R1", () => {
    const decision = route({ mode: "aprofundada", criteria: criteria(remoteOnly()), signals: signals({ workModels: explicit("presencial") }) });
    expect(decision).toMatchObject({ rule: "R4", rejectedDimensions: [], callsLlm: true });
    expect(decision.deterministic.score.dealBreakerHit).toBe(true);
  });
});

describe("R2: injection alta (qualquer modo)", () => {
  test("auto e aprofundada vão para o só determinístico com o aviso", () => {
    for (const mode of ["auto", "aprofundada"] as const) {
      expect(route({ mode, signals: signals({ injectionLevel: "alta" }) })).toMatchObject({
        rule: "R2",
        route: "somente_deterministico",
        callsLlm: false,
        warnings: ["possivel_prompt_injection"],
        rejectedDimensions: [],
        acceptEligible: false,
      });
    }
  });

  test("R1 vem antes do R2 no auto (o atacante só prejudica a própria vaga); no aprofundada, R2", () => {
    const over = { criteria: criteria(remoteOnly()), signals: signals({ workModels: explicit("presencial"), injectionLevel: "alta" as const }) };
    expect(route(over).rule).toBe("R1");
    expect(route({ ...over, mode: "aprofundada" }).rule).toBe("R2");
  });

  test("injection média não é R2", () => {
    expect(route({ signals: signals({ injectionLevel: "media" }) }).rule).toBe("R4");
  });
});

/** Critério que o sinal explícito de modelo remoto atende sozinho. */
const acceptable = (over: Partial<UserCriteria> = {}) => criteria({ ...remoteOnly(REQUIRED), redFlagTolerance: tolerance("alertar"), ...over });
const remoteSignal = (over: Partial<DeterministicSignals> = {}) => signals({ workModels: explicit("remoto"), ...over });

describe("R3: curto-circuito de aceite (D-H3) e guarda de vacuidade", () => {
  test("a política padrão deixa o aceite desligado", () => {
    expect(DEFAULT_PRE_FILTER_ROUTER_POLICY).toEqual({ shortCircuitAccept: false });
    expect(Object.isFrozen(DEFAULT_PRE_FILTER_ROUTER_POLICY)).toBe(true);
  });

  test("desligado: nunca R3, mas a elegibilidade fica registrada para medir a D-H3", () => {
    expect(route({ criteria: acceptable(), signals: remoteSignal() })).toMatchObject({ rule: "R4", acceptEligible: true, callsLlm: true });
  });

  test("ligado: aceita com o aviso decisao_sem_ia", () => {
    expect(route({ criteria: acceptable(), signals: remoteSignal() }, accepting)).toMatchObject({
      rule: "R3",
      route: "curto_circuito_aceite",
      callsLlm: false,
      warnings: ["decisao_sem_ia"],
      acceptEligible: true,
      rejectedDimensions: [],
    });
  });

  test("vacuidade: sem critério eliminatório ou obrigatório não há aceite, nem com deal-breaker de stack", () => {
    const onlyWeighted = criteria({ ...remoteOnly(weighted(5)), redFlagTolerance: tolerance("alertar"), stack: stack({ dealBreakers: ["PHP"] }) });
    expect(route({ criteria: onlyWeighted, signals: remoteSignal() }, accepting)).toMatchObject({ rule: "R4", acceptEligible: false });
  });

  test("must-have de stack conta como critério e precisa de menção explícita", () => {
    const c = acceptable({ ...remoteOnly(IGNORE), stack: stack({ mustHave: ["Java"] }) });
    expect(route({ criteria: c, signals: signals({ stackMentions: [{ term: "Java", strength: "explicita" }] }) }, accepting).rule).toBe("R3");
    expect(route({ criteria: c, signals: signals({ stackMentions: [{ term: "Java", strength: "fraca" }] }) }, accepting).rule).toBe("R4");
  });

  test("localização obrigatória em vaga só remota 'não se aplica' e não fura a guarda sozinha", () => {
    const c = acceptable({ ...remoteOnly(IGNORE), location: { acceptedUfs: ["SP"], acceptedCities: [], importance: REQUIRED } });
    expect(hasMustCriterion(c)).toBe(true);
    expect(route({ criteria: c, signals: remoteSignal() }, accepting)).toMatchObject({ rule: "R4", acceptEligible: false });
  });

  test("bloqueios: injection não baixa, red flag que penaliza ou elimina, critério não atendido, deal-breaker em menção fraca", () => {
    const blocked = (over: Partial<PreFilterRoutingInput>) => route({ criteria: acceptable(), signals: remoteSignal(), ...over }, accepting);
    expect(blocked({ signals: remoteSignal({ injectionLevel: "media" }) }).acceptEligible).toBe(false);
    expect(blocked({ criteria: acceptable({ redFlagTolerance: tolerance("alertar", { pressao_excessiva: "penalizar" }) }) }).acceptEligible).toBe(false);
    expect(blocked({ criteria: acceptable({ redFlagTolerance: tolerance("ignorar", { escopo_excessivo: "eliminatorio" }) }) }).acceptEligible).toBe(false);
    expect(blocked({ criteria: acceptable({ redFlagTolerance: tolerance("ignorar") }) }).acceptEligible).toBe(true);
    expect(blocked({ signals: signals({ workModels: weak("remoto") }) }).acceptEligible).toBe(false);
    expect(blocked({ criteria: acceptable({ languages: { proficiencies: [], importance: REQUIRED } }) }).acceptEligible).toBe(false);
    const breaker = acceptable({ stack: stack({ dealBreakers: ["PHP"] }) });
    expect(blocked({ criteria: breaker, signals: remoteSignal({ stackMentions: [{ term: "php", strength: "fraca" }] }) }).acceptEligible).toBe(false);
    expect(blocked({ criteria: breaker, signals: remoteSignal({ stackMentions: [{ term: "Java", strength: "fraca" }] }) }).acceptEligible).toBe(true);
  });

  test("modo aprofundada nunca aceita", () => {
    expect(route({ mode: "aprofundada", criteria: acceptable(), signals: remoteSignal() }, accepting)).toMatchObject({ rule: "R4", acceptEligible: false });
  });

  test.each([
    ["modelo", { workModel: { accepted: ["remoto"], importance: ELIMINATORY } }],
    ["senioridade", { seniority: { accepted: ["pleno"], importance: REQUIRED } }],
    ["contrato", { contractType: { accepted: ["clt"], importance: ELIMINATORY } }],
    ["salário", { salary: { minimum: 1, currency: "BRL", period: "mes", importance: REQUIRED } }],
    ["localização", { location: { acceptedUfs: ["SP"], acceptedCities: [], importance: ELIMINATORY } }],
    ["idiomas", { languages: { proficiencies: [], importance: REQUIRED } }],
    ["benefícios", { benefits: { desired: ["plano_saude"], importance: ELIMINATORY } }],
    ["must-have", { stack: stack({ mustHave: ["Java"] }) }],
  ] as const)("hasMustCriterion: %s conta", (_name, over) => {
    expect(hasMustCriterion(criteria(over as Partial<UserCriteria>))).toBe(true);
  });

  test("hasMustCriterion: ponderado, ignorado, nulo e deal-breaker não contam", () => {
    expect(hasMustCriterion(criteria())).toBe(false);
    expect(
      hasMustCriterion(
        criteria({
          ...remoteOnly(weighted(2)),
          salary: { minimum: 1, currency: "BRL", period: "mes", importance: IGNORE },
          benefits: { desired: ["plano_saude"], importance: weighted(1) },
          stack: stack({ dealBreakers: ["PHP"], niceToHave: ["Go"], niceToHaveWeight: 3 }),
        }),
      ),
    ).toBe(false);
  });
});

describe("fatos só determinísticos (ADR-011 D7)", () => {
  test("usam o titleHint e os termos marcados, e valem no contrato", () => {
    const decision = route({
      titleHint: "Desenvolvedor Java",
      criteria: criteria({ stack: stack({ mustHave: ["Java"], dealBreakers: ["PHP"] }) }),
      signals: signals({ stackMentions: [{ term: "Java", strength: "explicita" }, { term: "Go", strength: "fraca" }] }),
    });
    const { facts } = decision.deterministic.resolution;
    expect(ResolvedJobFactsSchema.parse(facts)).toEqual(facts);
    expect(facts.title).toBe("Desenvolvedor Java");
    expect(facts.stackRequired).toEqual(["Java"]);
    expect(decision.deterministic.resolution.effectiveConfidence).toBe(0);
  });

  test("o roteamento não muta a entrada", () => {
    const input: PreFilterRoutingInput = Object.freeze({
      mode: "auto",
      signals: Object.freeze(remoteSignal()),
      titleHint: null,
      criteria: Object.freeze(acceptable()),
    });
    const before = JSON.stringify(input);
    accepting.route(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
