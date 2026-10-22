// F1-DOM-02, critério de aceite do ADR-002 §8.2: os `expected` dos casos `estresse` (lote HITL-017) e os
// sintéticos de câmbio, senioridade e cultura do golden dataset, contra um conjunto fixo de perfis de teste.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ResolvedJobFactsSchema, type ResolvedJobFacts, type ScoreDimension, type UserCriteria } from "@trampo/contracts";
import { describe, expect, test } from "vitest";

import { DEFAULT_SCORING_POLICY, SCORE_DIMENSIONS, ScoringEngine, type ScoreResult } from "../../src/domain/index.js";
import { ELIMINATORY, NO_CRITERIA, REQUIRED, input, stack, tolerance, weighted } from "./fakes/scoring-fixtures.js";

const CASES = fileURLToPath(new URL("../../../../evals/golden/cases/", import.meta.url));
const SYNTHETIC = ["syn-12", "syn-13", "syn-14", "syn-15", "syn-16", "syn-17", "syn-18", "syn-19"];

interface Fixture {
  readonly id: string;
  readonly facts: ResolvedJobFacts;
}

function load(): Fixture[] {
  const out: Fixture[] = [];
  for (const dir of ["real", "synthetic"]) {
    for (const name of readdirSync(`${CASES}${dir}`).filter((n) => n.endsWith(".case.json")).sort()) {
      const c = JSON.parse(readFileSync(`${CASES}${dir}/${name}`, "utf8")) as { id: string; tags: string[]; expected: unknown };
      const wanted = c.tags.includes("estresse") || SYNTHETIC.some((prefix) => c.id.startsWith(`${prefix}-`));
      if (wanted) out.push({ id: c.id, facts: ResolvedJobFactsSchema.parse(c.expected) });
    }
  }
  return out;
}

const FIXTURES = load();
const byId = (prefix: string): ResolvedJobFacts => {
  const found = FIXTURES.find((f) => f.id === prefix || f.id.startsWith(`${prefix}-`));
  if (found === undefined) throw new Error(`fixture ausente: ${prefix}`);
  return found.facts;
};

const CANARY_MINIMUM = 13_579.2468;
const PROFILES: Readonly<Record<string, UserCriteria>> = {
  "backend-java-senior": {
    ...NO_CRITERIA,
    workModel: { accepted: ["remoto"], importance: REQUIRED },
    seniority: { accepted: ["senior"], importance: REQUIRED },
    contractType: { accepted: ["clt", "pj"], importance: weighted(3) },
    salary: { minimum: 12_000, currency: "BRL", period: "mes", importance: REQUIRED },
    stack: stack({ mustHave: ["Java", "Spring Boot"], niceToHave: ["AWS", "Docker"], niceToHaveWeight: 2, dealBreakers: ["PHP"] }),
    languages: { proficiencies: [{ language: "ingles", level: "avancado" }], importance: weighted(2) },
    benefits: { desired: ["plano_saude", "vale_refeicao"], importance: weighted(2) },
    redFlagTolerance: tolerance("alertar", { escopo_excessivo: "penalizar", multiplas_funcoes: "penalizar", pressao_excessiva: "penalizar" }),
  },
  "dados-pj-exigente": {
    ...NO_CRITERIA,
    workModel: { accepted: ["remoto", "hibrido"], importance: weighted(4) },
    seniority: { accepted: ["senior", "especialista"], importance: ELIMINATORY },
    contractType: { accepted: ["pj"], importance: ELIMINATORY },
    salary: { minimum: 15_000, currency: "BRL", period: "mes", importance: ELIMINATORY },
    stack: stack({ mustHave: ["Python", "SQL"], niceToHave: ["Spark", "GCP"], niceToHaveWeight: 3, dealBreakerScope: "qualquer_mencao", dealBreakers: ["Excel"] }),
    redFlagTolerance: tolerance("penalizar", { sobreaviso_nao_remunerado: "eliminatorio" }),
  },
  "estagio-curitiba": {
    ...NO_CRITERIA,
    workModel: { accepted: ["hibrido", "presencial", "remoto"], importance: weighted(1) },
    seniority: { accepted: ["estagio"], importance: REQUIRED },
    contractType: { accepted: ["estagio"], importance: REQUIRED },
    salary: { minimum: 1_500, currency: "BRL", period: "mes", importance: weighted(5) },
    location: { acceptedUfs: ["PR"], acceptedCities: ["Curitiba"], importance: REQUIRED },
    benefits: { desired: ["vale_refeicao"], importance: weighted(1) },
    redFlagTolerance: tolerance("alertar"),
  },
  "internacional-usd": {
    ...NO_CRITERIA,
    workModel: { accepted: ["remoto"], importance: ELIMINATORY },
    seniority: { accepted: ["senior"], importance: weighted(2) },
    salary: { minimum: 3_000, currency: "USD", period: "mes", importance: REQUIRED },
    languages: { proficiencies: [{ language: "ingles", level: "fluente" }, { language: "espanhol", level: "intermediario" }], importance: REQUIRED },
    stack: stack({ mustHave: ["Node.js", "TypeScript"] }),
    redFlagTolerance: tolerance("ignorar"),
  },
  "canario-sr11": {
    ...NO_CRITERIA,
    seniority: { accepted: ["pleno"], importance: REQUIRED },
    salary: { minimum: CANARY_MINIMUM, currency: "EUR", period: "ano", importance: REQUIRED },
    location: { acceptedUfs: [], acceptedCities: ["Zqcanarycity"], importance: weighted(2) },
    stack: stack({ mustHave: ["Zqcanarytech"], niceToHave: ["Zqcanarynice"], niceToHaveWeight: 1, dealBreakers: ["Zqcanarybreaker"] }),
    notes: "zq-canary-notes",
    redFlagTolerance: tolerance("penalizar"),
  },
};

const engine = new ScoringEngine();
const P = DEFAULT_SCORING_POLICY;
const score = (f: ResolvedJobFacts, c: UserCriteria): ScoreResult => engine.score(input(f), c);
const line = (r: ScoreResult, d: ScoreDimension) => r.breakdown.find((e) => e.dimension === d);

describe("fixtures de estresse (ADR-002 §8.2)", () => {
  test("carrega os 33 casos de estresse e os 8 sintéticos", () => {
    expect(FIXTURES).toHaveLength(41);
  });

  test("as invariantes de forma, teto, faixa e auditoria valem em toda fixture × perfil", () => {
    for (const { id, facts } of FIXTURES) {
      for (const [name, criteria] of Object.entries(PROFILES)) {
        const r = score(facts, criteria);
        const where = `${id} × ${name}`;
        expect(score(facts, criteria), where).toEqual(r);
        expect(r.breakdown.map((e) => e.dimension), where).toEqual([...SCORE_DIMENSIONS]);
        expect(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100, where).toBe(true);
        for (const e of r.breakdown) expect(Number.isInteger(e.points) && e.points >= -30 && e.points <= 100, where).toBe(true);
        if (r.dealBreakerHit) expect([r.verdict, r.score <= P.dealBreakerCap], where).toEqual(["foge", true]);
        const clamped = Math.min(100, Math.max(0, r.neutralBase + r.breakdown.reduce((a, e) => a + e.points, 0)));
        expect(r.score, where).toBe(r.dealBreakerHit ? Math.min(P.dealBreakerCap, clamped) : clamped);
      }
    }
  });

  test("SR-11: nenhuma fixture ecoa um valor do perfil canário", () => {
    for (const { id, facts } of FIXTURES) {
      const out = JSON.stringify(score(facts, PROFILES["canario-sr11"] as UserCriteria)).toLowerCase();
      for (const canary of ["zqcanary", "zq-canary", "13579"]) expect(out, id).not.toContain(canary);
    }
  });

  test("ARS (geekhunter-03) passa pela tabela e nunca é lido como BRL", () => {
    const ars = byId("geekhunter-03");
    expect(ars.salary).toEqual({ min: 3_800_000, max: 3_900_000, currency: "ARS", period: "mes" });
    const base = PROFILES["backend-java-senior"] as UserCriteria;
    const ok = score(ars, base);
    // 3,8–3,9 milhões × 0,0034 = R$ 12.920–13.260 por mês.
    expect([line(ok, "salario")?.outcome, line(ok, "salario")?.reason]).toEqual(["atende", "salario_convertido"]);
    const above = score(ars, { ...base, salary: { minimum: 14_000, currency: "BRL", period: "mes", importance: REQUIRED } });
    expect([line(above, "salario")?.outcome, line(above, "salario")?.reason]).toEqual(["nao_atende", "salario_convertido"]);
  });

  test("vaga sem salário com salário ponderado custa 100·w·0,5/Σpeso (±1) e nenhuma penalidade", () => {
    const w = 4;
    // Σpeso = 4 (salário) + 2 (contrato) + 5 (modelo, obrigatório) = 11.
    const criteria: UserCriteria = {
      ...NO_CRITERIA,
      workModel: { accepted: ["remoto", "hibrido", "presencial"], importance: REQUIRED },
      contractType: { accepted: ["clt"], importance: weighted(2) },
      salary: { minimum: 5_000, currency: "BRL", period: "mes", importance: weighted(w) },
    };
    const withoutSalary = FIXTURES.filter((f) => f.facts.salary === null && f.facts.workModels.length > 0);
    expect(withoutSalary.length).toBeGreaterThan(10);
    for (const { id, facts } of withoutSalary) {
      const missing = score(facts, criteria);
      const paid = score({ ...facts, salary: { min: 9_000, max: 9_000, currency: "BRL", period: "mes" } }, criteria);
      const salaryLine = line(missing, "salario");
      expect([salaryLine?.outcome, salaryLine?.reason], id).toEqual(["nao_informado", "nao_informado"]);
      expect(Math.abs(paid.score - missing.score - (100 * w * 0.5) / 11), id).toBeLessThanOrEqual(1);
      // Sem penalidade: os pontos da linha são só a contribuição na base (≈ 100·4·0,5/11 = 18,2).
      expect(Math.abs((salaryLine?.points ?? 0) - (100 * w * 0.5) / 11), id).toBeLessThanOrEqual(1);
    }
  });

  test("USD por hora e EUR por ano (sintéticos) convertem pela tabela e respeitam a invariante 13", () => {
    const criteria: UserCriteria = { ...NO_CRITERIA, salary: { minimum: 22_000, currency: "BRL", period: "mes", importance: REQUIRED } };
    const usd = score(byId("syn-12"), criteria);
    const eur = score(byId("syn-13"), criteria);
    // USD 35–45/h × 5,5 × 220 = R$ 42.350–54.450; EUR 42.000–50.000/ano × 6 ÷ 12 = R$ 21.000–25.000.
    expect([line(usd, "salario")?.outcome, line(usd, "salario")?.reason]).toEqual(["atende", "salario_convertido"]);
    expect([line(eur, "salario")?.outcome, line(eur, "salario")?.points]).toEqual(["atende_parcialmente", 67]);
    for (const prefix of ["syn-12", "syn-13"]) {
      const f = byId(prefix);
      const s = f.salary;
      if (s === null || s.currency === null || s.period === null) throw new Error(prefix);
      const same = { minimum: 200, currency: s.currency, period: s.period, importance: REQUIRED } as const;
      const one = score(f, { ...criteria, salary: same });
      const scaled = { ...f, salary: { ...s, min: (s.min ?? 0) * 3, max: (s.max ?? 0) * 3 } };
      const three = score(scaled, { ...criteria, salary: { ...same, minimum: 600 } });
      expect(line(three, "salario")?.outcome, prefix).toBe(line(one, "salario")?.outcome);
    }
  });

  test("adjacência ascendente e rebaixamento (sintéticos) dão os reason do §4.2.2", () => {
    const senior = byId("syn-15");
    const plenoOnly = { ...NO_CRITERIA, seniority: { accepted: ["pleno" as const], importance: REQUIRED } };
    expect(line(score(senior, plenoOnly), "senioridade")?.reason).toBe("senioridade_adjacente_acima");
    const validated = score(senior, { ...plenoOnly, stack: stack({ mustHave: ["Node.js", "TypeScript", "PostgreSQL", "Docker", "AWS"] }) });
    expect([line(validated, "senioridade")?.reason, line(validated, "senioridade")?.points]).toEqual(["senioridade_adjacente_validada", 40]);
    const junior = byId("syn-16");
    const seniorOnly = { ...NO_CRITERIA, seniority: { accepted: ["senior" as const], importance: weighted(3) } };
    expect([line(score(junior, seniorOnly), "senioridade")?.reason, line(score(junior, seniorOnly), "senioridade")?.points]).toEqual([
      "senioridade_rebaixamento",
      -30,
    ]);
    const both = byId("syn-14");
    expect(line(score(both, seniorOnly), "senioridade")?.outcome).toBe("atende_parcialmente");
  });

  test("cultura tóxica (syn-18): benefícios fartos cortam pela metade só os sinais de cultura", () => {
    const toxic = byId("syn-18");
    const criteria: UserCriteria = {
      ...NO_CRITERIA,
      benefits: { desired: ["plano_saude", "vale_refeicao"], importance: REQUIRED },
      redFlagTolerance: tolerance("ignorar", { multiplas_funcoes: "penalizar", pressao_excessiva: "penalizar", sobreaviso_nao_remunerado: "penalizar" }),
    };
    const r = score(toxic, criteria);
    // multiplas_funcoes e pressao_excessiva: −5 cada; sobreaviso_nao_remunerado nunca atenuado: −10.
    expect([line(r, "red_flags")?.points, line(r, "red_flags")?.reason]).toEqual([-20, "red_flag_atenuada_por_beneficios"]);
    const noBenefits = score(toxic, { ...criteria, benefits: null });
    expect(line(noBenefits, "red_flags")?.points).toBe(-30);
  });
});
