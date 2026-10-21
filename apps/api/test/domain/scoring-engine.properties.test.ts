// F1-DOM-02: as 14 invariantes do ADR-002 §4.4 como propriedades (fast-check), sobre entradas válidas no
// contrato. Cada propriedade nomeia a invariante que prova.
import type { ResolvedJobFacts, ScoreDimension, UserCriteria, Verdict } from "@trampo/contracts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import {
  DEFAULT_SCORING_POLICY,
  SCORE_DIMENSIONS,
  ScoringEngine,
  foldCity,
  type FactField,
  type FactProvenance,
  type ScoreResult,
  type ScoringInput,
} from "../../src/domain/index.js";
import {
  CONFLICTABLE,
  ELIMINATORY,
  NO_CRITERIA,
  REQUIRED,
  criteriaArb,
  deepFreeze,
  facts,
  importanceArb,
  input,
  inputArb,
  provenanceOf,
  weighted,
} from "./fakes/scoring-fixtures.js";

const RUNS = { numRuns: 1_000 };
const engine = new ScoringEngine();
const P = DEFAULT_SCORING_POLICY;
const HIGH: ReadonlySet<Verdict> = new Set(["recomendado", "altamente_recomendado"]);

const line = (r: ScoreResult, dimension: ScoreDimension) => r.breakdown.find((e) => e.dimension === dimension);
const pointsSum = (r: ScoreResult): number => r.breakdown.reduce((acc, e) => acc + e.points, 0);

function band(score: number): Verdict {
  if (score >= P.bandMins.altamente_recomendado) return "altamente_recomendado";
  if (score >= P.bandMins.recomendado) return "recomendado";
  if (score >= P.bandMins.neutro) return "neutro";
  return score >= P.bandMins.baixo_alinhamento ? "baixo_alinhamento" : "foge";
}

const conflictsOf = (i: ScoringInput): FactField[] =>
  (Object.entries(i.provenance) as [FactField, FactProvenance][]).filter(([, p]) => p === "conflito").map(([f]) => f);

/** Refaz a entrada com fatos novos, mantendo os conflitos e o `llmExtracted`. */
const withFacts = (i: ScoringInput, f: ResolvedJobFacts, conflicts = conflictsOf(i)): ScoringInput =>
  input(f, { conflicts, llmExtracted: i.llmExtracted });

/** Tira toda fonte de deal-breaker que não seja a dimensão em teste. */
function withoutEliminations(c: UserCriteria): UserCriteria {
  const soften = <T extends { importance: UserCriteria["workModel"]["importance"] }>(x: T): T =>
    x.importance.level === "eliminatorio" ? { ...x, importance: REQUIRED } : x;
  return {
    ...c,
    workModel: soften(c.workModel),
    seniority: soften(c.seniority),
    contractType: soften(c.contractType),
    salary: c.salary === null ? null : soften(c.salary),
    location: c.location === null ? null : soften(c.location),
    languages: c.languages === null ? null : soften(c.languages),
    benefits: c.benefits === null ? null : soften(c.benefits),
    stack: { ...c.stack, dealBreakers: [] },
    redFlagTolerance: Object.fromEntries(
      Object.entries(c.redFlagTolerance).map(([s, t]) => [s, t === "eliminatorio" ? "penalizar" : t]),
    ) as UserCriteria["redFlagTolerance"],
  };
}

describe("invariantes do ADR-002 §4.4", () => {
  test("1. determinismo e pureza: mesma saída e entrada congelada intacta", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, (i, c) => {
        const before = JSON.stringify([i, c]);
        const frozen = deepFreeze(structuredClone({ i, c }));
        const first = engine.score(frozen.i, frozen.c);
        expect(engine.score(frozen.i, frozen.c)).toEqual(first);
        expect(new ScoringEngine().score(i, c)).toEqual(first);
        expect(JSON.stringify([i, c])).toBe(before);
      }),
      RUNS,
    );
  });

  test("2. nota inteira em [0, 100], pontos inteiros em [−30, 100] e as 9 dimensões na ordem do enum", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, (i, c) => {
        const r = engine.score(i, c);
        expect(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100).toBe(true);
        expect(r.breakdown.map((e) => e.dimension)).toEqual([...SCORE_DIMENSIONS]);
        for (const e of r.breakdown) expect(Number.isInteger(e.points) && e.points >= -30 && e.points <= 100, e.dimension).toBe(true);
      }),
      RUNS,
    );
  });

  test("3. deal-breaker ⇒ foge com nota ≤ 20", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, (i, c) => {
        const r = engine.score(i, c);
        if (r.dealBreakerHit) expect([r.verdict, r.score <= P.dealBreakerCap]).toEqual(["foge", true]);
        expect(r.dealBreakerHit).toBe(r.breakdown.some((e) => e.dealBreakerHit));
      }),
      RUNS,
    );
  });

  test("4. conflito em dimensão eliminatória, sozinho, nunca elimina nem chega a recomendado", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, fc.constantFrom(...CONFLICTABLE), (i, c, field) => {
        const blanked = { ...i.facts, [field]: field === "salary" || field === "location" ? null : [] } as ResolvedJobFacts;
        // Localização só vale para vaga não exclusivamente remota (§4.2.4).
        const f = field === "location" ? { ...blanked, workModels: ["hibrido" as const] } : blanked;
        const base = withoutEliminations(c);
        const dims: Record<(typeof CONFLICTABLE)[number], [ScoreDimension, UserCriteria]> = {
          workModels: ["modelo_trabalho", { ...base, workModel: { ...base.workModel, importance: ELIMINATORY } }],
          seniorityLevels: ["senioridade", { ...base, seniority: { ...base.seniority, importance: ELIMINATORY } }],
          contractTypes: ["contrato", { ...base, contractType: { ...base.contractType, importance: ELIMINATORY } }],
          salary: ["salario", { ...base, salary: { minimum: 5_000, currency: "BRL", period: "mes", ...base.salary, importance: ELIMINATORY } }],
          location: ["localizacao", { ...base, location: { acceptedUfs: ["SP"], acceptedCities: [], ...base.location, importance: ELIMINATORY } }],
          benefits: ["beneficios", { ...base, benefits: { desired: ["plano_saude"], ...base.benefits, importance: ELIMINATORY } }],
        };
        const [dimension, criteria] = dims[field];
        const r = engine.score(withFacts(i, f, [...new Set([...conflictsOf(i), field])]), criteria);
        expect(line(r, dimension)?.reason).toBe("conflito_eliminatorio");
        expect(r.dealBreakerHit).toBe(false);
        expect(HIGH.has(r.verdict)).toBe(false);
      }),
      RUNS,
    );
  });

  test("5. must-have não atendido nunca chega a recomendado (modelo de trabalho e stack)", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, fc.boolean(), (i, c, viaStack) => {
        if (viaStack) {
          const f = { ...i.facts, stackRequired: [...i.facts.stackRequired, "Elixir"] };
          const r = engine.score(withFacts(i, f), { ...c, stack: { ...c.stack, mustHave: ["Haskell"], dealBreakers: [] } });
          expect(line(r, "stack")?.outcome).toBe("nao_atende");
          expect(HIGH.has(r.verdict)).toBe(false);
          return;
        }
        const f = { ...i.facts, workModels: ["presencial" as const] };
        const r = engine.score(withFacts(i, f, conflictsOf(i).filter((x) => x !== "workModels")), {
          ...c,
          workModel: { accepted: ["remoto"], importance: REQUIRED },
        });
        expect(HIGH.has(r.verdict)).toBe(false);
      }),
      RUNS,
    );
  });

  test("6. monotonicidade entre fatos informados (contrato e salário)", () => {
    const contracts = fc.uniqueArray(fc.constantFrom("clt" as const, "pj" as const, "cooperado" as const, "estagio" as const, "temporario" as const), {
      minLength: 1,
      maxLength: 5,
    });
    fc.assert(
      fc.property(inputArb, criteriaArb, contracts, contracts, importanceArb, (i, c, a, b, importance) => {
        const crit = { ...c, contractType: { ...c.contractType, importance } };
        const accepted = new Set<string>(crit.contractType.accepted);
        const ratio = (values: readonly string[]): number => values.filter((v) => accepted.has(v)).length / values.length;
        const others = conflictsOf(i).filter((x) => x !== "contractTypes");
        const [lo, hi] = ratio(a) <= ratio(b) ? [a, b] : [b, a];
        const low = engine.score(withFacts(i, { ...i.facts, contractTypes: lo }, others), crit);
        const high = engine.score(withFacts(i, { ...i.facts, contractTypes: hi }, others), crit);
        expect(high.score).toBeGreaterThanOrEqual(low.score);
      }),
      RUNS,
    );
    fc.assert(
      fc.property(inputArb, criteriaArb, fc.integer({ min: 0, max: 20_000 }), (i, c, delta) => {
        const s = i.facts.salary;
        fc.pre(s !== null);
        const shift = (v: number | null): number | null => (v === null ? null : v + delta);
        const raised = engine.score(withFacts(i, { ...i.facts, salary: { ...s, min: shift(s.min), max: shift(s.max) } }), c);
        expect(raised.score).toBeGreaterThanOrEqual(engine.score(i, c).score);
      }),
      RUNS,
    );
  });

  test("7. conflito ≡ omissão em ponderado", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, fc.constantFrom(...CONFLICTABLE), fc.integer({ min: 1, max: 5 }), (i, c, field, w) => {
        const f = { ...i.facts, [field]: field === "salary" || field === "location" ? null : [] } as ResolvedJobFacts;
        const pond = weighted(w);
        const crit: UserCriteria = {
          ...c,
          workModel: field === "workModels" ? { ...c.workModel, importance: pond } : c.workModel,
          seniority: field === "seniorityLevels" ? { ...c.seniority, importance: pond } : c.seniority,
          contractType: field === "contractTypes" ? { ...c.contractType, importance: pond } : c.contractType,
          salary: field === "salary" ? { minimum: 5_000, currency: "BRL", period: "mes", ...c.salary, importance: pond } : c.salary,
          location: field === "location" ? { acceptedUfs: ["SP"], acceptedCities: [], ...c.location, importance: pond } : c.location,
          benefits: field === "benefits" ? { desired: ["plano_saude"], ...c.benefits, importance: pond } : c.benefits,
        };
        const others = conflictsOf(i).filter((x) => x !== field);
        const omitted = engine.score(withFacts(i, f, others), crit);
        const conflicted = engine.score(withFacts(i, f, [...others, field]), crit);
        expect(conflicted.score).toBe(omitted.score);
        expect(conflicted.breakdown.map((e) => e.points)).toEqual(omitted.breakdown.map((e) => e.points));
      }),
      RUNS,
    );
  });

  test("8. independência de texto livre: título, notas e cidade fora da lista do usuário", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, fc.constantFrom("Outro título", null), fc.constantFrom("Outra nota.", null), (i, c, title, notes) => {
        const accepted = new Set((c.location?.acceptedCities ?? []).map(foldCity));
        const loc = i.facts.location;
        const cityOutside = loc !== null && loc.city !== null && !accepted.has(foldCity(loc.city));
        const f = { ...i.facts, title, location: cityOutside ? { ...loc, city: "Cidade Forasteira" } : loc };
        expect(engine.score(withFacts(i, f), { ...c, notes }).score).toBe(engine.score(i, c).score);
      }),
      RUNS,
    );
  });

  test("9. SR-11: nenhum valor do perfil na saída (canários)", () => {
    const CANARY = { must: "Zqcanarymust", nice: "Zqcanarynice", breaker: "Zqcanarybreaker", city: "Zqcanarycity", notes: "zq-canary-notes" };
    fc.assert(
      fc.property(inputArb, criteriaArb, fc.boolean(), (i, c, echo) => {
        const crit: UserCriteria = {
          ...c,
          stack: { ...c.stack, mustHave: [...c.stack.mustHave, CANARY.must], niceToHave: [CANARY.nice], dealBreakers: [CANARY.breaker] },
          location: { acceptedUfs: [], acceptedCities: [CANARY.city], importance: REQUIRED },
          salary: { minimum: 98_765.4321, currency: "BRL", period: "mes", importance: REQUIRED },
          notes: CANARY.notes,
        };
        // Com `echo`, a vaga repete os valores do perfil: casar não pode ecoar.
        const f: ResolvedJobFacts = echo
          ? { ...i.facts, stackRequired: [CANARY.must], stackNiceToHave: [CANARY.nice], location: { city: CANARY.city, stateUf: null, countryIso2: "BR" } }
          : i.facts;
        const out = JSON.stringify(engine.score(withFacts(i, f), crit)).toLowerCase();
        for (const value of [...Object.values(CANARY), "98765"]) expect(out).not.toContain(value.toLowerCase());
      }),
      RUNS,
    );
  });

  test("10. score = min(teto?, clamp(neutralBase + Σ points, 0, 100))", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, (i, c) => {
        const r = engine.score(i, c);
        const clamped = Math.min(100, Math.max(0, r.neutralBase + pointsSum(r)));
        expect(r.score).toBe(r.dealBreakerHit ? Math.min(P.dealBreakerCap, clamped) : clamped);
        // Só deal-breakers de stack não entram na base (a linha mostra `eliminatorio` sem parcela).
        const stackShares = c.stack.mustHave.length > 0 || (c.stack.niceToHave.length > 0 && c.stack.niceToHaveWeight > 0);
        const inBase = r.breakdown.some(
          (e) => e.outcome !== "ignorado" && e.dimension !== "red_flags" && e.importance !== "ignorar" && (e.dimension !== "stack" || stackShares),
        );
        expect(r.neutralBase).toBe(inBase ? 0 : P.emptyBase);
      }),
      RUNS,
    );
  });

  test("11. acoplamento stack → senioridade: mais stack nunca baixa a nota", () => {
    const terms = fc.uniqueArray(fc.constantFrom("Java", "Go", "Docker", "Kafka", "Python", "AWS"), { minLength: 1, maxLength: 6 });
    fc.assert(
      fc.property(inputArb, criteriaArb, terms, terms, terms, importanceArb, (i, c, must, s1, extra, importance) => {
        const crit: UserCriteria = {
          ...c,
          seniority: { accepted: ["pleno"], importance },
          stack: { mustHave: must, niceToHave: [], dealBreakers: [], dealBreakerScope: "somente_obrigatoria", niceToHaveWeight: 0 },
        };
        const s2 = [...new Set([...s1, ...extra])];
        const job = (stackRequired: string[]) => withFacts(i, { ...i.facts, seniorityLevels: ["senior"], stackRequired, stackNiceToHave: [] });
        expect(engine.score(job(s2), crit).score).toBeGreaterThanOrEqual(engine.score(job(s1), crit).score);
      }),
      RUNS,
    );
  });

  test("11. adjacente validada ≥ adjacente acima ≥ rebaixamento, e atende ≥ validada", () => {
    const lenient = new ScoringEngine({ ...P, adjacencyStackThreshold: 0.75 });
    const must = ["Java", "Go", "Docker", "Kafka", "Python"];
    fc.assert(
      fc.property(inputArb, criteriaArb, importanceArb, (i, c, importance) => {
        fc.pre(importance.level !== "ignorar");
        const crit: UserCriteria = {
          ...c,
          seniority: { accepted: ["pleno"], importance },
          stack: { mustHave: must, niceToHave: [], dealBreakers: [], dealBreakerScope: "somente_obrigatoria", niceToHaveWeight: 0 },
        };
        // r da stack = 4/5 = 0,8: validada só com o limiar 0,75 (o se1 exige > 0,8).
        const job = (level: "junior" | "pleno" | "senior") =>
          withFacts(i, { ...i.facts, seniorityLevels: [level], stackRequired: must.slice(0, 4), stackNiceToHave: [] }, conflictsOf(i).filter((x) => x !== "seniorityLevels"));
        const validated = lenient.score(job("senior"), crit);
        expect(line(validated, "senioridade")?.reason).toBe("senioridade_adjacente_validada");
        const above = engine.score(job("senior"), crit);
        expect(line(above, "senioridade")?.reason).toBe("senioridade_adjacente_acima");
        const down = engine.score(job("junior"), crit);
        expect(line(down, "senioridade")?.reason).toBe("senioridade_rebaixamento");
        expect(validated.score).toBeGreaterThanOrEqual(above.score);
        expect(above.score).toBeGreaterThanOrEqual(down.score);
        expect(lenient.score(job("pleno"), crit).score).toBeGreaterThanOrEqual(validated.score);
      }),
      RUNS,
    );
  });

  test("12. o veredito é função só da nota e do deal-breaker", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, (i, c) => {
        const r = engine.score(i, c);
        expect(r.verdict).toBe(r.dealBreakerHit ? "foge" : band(r.score));
      }),
      RUNS,
    );
  });

  test("12. as 5 faixas cobrem as notas 0 a 100 sem buraco nem sobreposição", () => {
    // Uma só dimensão ponderada (salário): r = (1.000 − m)/1.000 faz a nota valer exatamente s.
    for (let s = 0; s <= 100; s += 1) {
      const low = s === 100 ? 1_000 : 0;
      const f = facts({ salary: { min: low, max: 1_000, currency: "BRL", period: "mes" } });
      const c: UserCriteria = { ...NO_CRITERIA, salary: { minimum: 1_000 - 10 * Math.min(s, 99), currency: "BRL", period: "mes", importance: weighted(1) } };
      const r = engine.score(input(f), c);
      expect([r.score, r.verdict]).toEqual([s, band(s)]);
    }
  });

  test("13. câmbio: escalar vaga e mínimo na mesma moeda não muda o outcome; estrangeira sem moeda nunca atende", () => {
    const currency = fc.constantFrom("BRL" as const, "USD" as const, "EUR" as const, "ARS" as const);
    const period = fc.constantFrom("hora" as const, "mes" as const, "ano" as const);
    fc.assert(
      fc.property(
        inputArb,
        criteriaArb,
        currency,
        period,
        fc.integer({ min: 0, max: 60_000 }),
        fc.integer({ min: 0, max: 60_000 }),
        fc.integer({ min: 1, max: 60_000 }),
        fc.constantFrom(2, 3, 10),
        (i, c, cur, per, a, b, minimum, k) => {
          const salaryOf = (scale: number) => ({ min: Math.min(a, b) * scale, max: Math.max(a, b) * scale, currency: cur, period: per });
          const critOf = (scale: number): UserCriteria => ({ ...c, salary: { minimum: minimum * scale, currency: cur, period: per, importance: REQUIRED } });
          const others = conflictsOf(i).filter((x) => x !== "salary");
          const one = engine.score(withFacts(i, { ...i.facts, salary: salaryOf(1) }, others), critOf(1));
          const many = engine.score(withFacts(i, { ...i.facts, salary: salaryOf(k) }, others), critOf(k));
          expect(line(many, "salario")?.outcome).toBe(line(one, "salario")?.outcome);
        },
      ),
      RUNS,
    );
    fc.assert(
      fc.property(inputArb, criteriaArb, fc.constantFrom("AR", "US", "PT"), fc.integer({ min: 1, max: 9_000_000 }), (i, c, country, amount) => {
        const f = { ...i.facts, salary: { min: amount, max: amount, currency: null, period: null }, location: { city: null, stateUf: null, countryIso2: country } };
        const crit: UserCriteria = { ...c, salary: { minimum: 1, currency: "BRL", period: "mes", importance: REQUIRED } };
        const r = engine.score(withFacts(i, f, conflictsOf(i).filter((x) => x !== "salary")), crit);
        expect(line(r, "salario")?.outcome).not.toBe("atende");
      }),
      RUNS,
    );
  });

  test("14. atenuação limitada: não muda deal-breaker, não corta além da metade, só toca cultura", () => {
    const strict = new ScoringEngine({ ...P, riskAttenuationFactor: 1 });
    const culture = new Set<string>(P.cultureRedFlags);
    fc.assert(
      fc.property(inputArb, criteriaArb, (i, c) => {
        const soft = engine.score(i, c);
        const hard = strict.score(i, c);
        expect(soft.dealBreakerHit).toBe(hard.dealBreakerHit);
        const ps = line(soft, "red_flags")?.points ?? 0;
        const ph = line(hard, "red_flags")?.points ?? 0;
        expect(ps).toBeGreaterThanOrEqual(ph);
        expect(-ps).toBeGreaterThanOrEqual(-ph / 2);
        const touchesCulture = i.facts.redFlagSignals.some((s) => culture.has(s) && c.redFlagTolerance[s] === "penalizar");
        if (!touchesCulture) expect(ps).toBe(ph);
        expect(soft.breakdown.filter((e) => e.dimension !== "red_flags")).toEqual(hard.breakdown.filter((e) => e.dimension !== "red_flags"));
      }),
      RUNS,
    );
  });
});

test("os construtores de entrada repetem a proveniência do resolver", () => {
  expect(provenanceOf(facts({ workModels: ["remoto"] })).workModels).toBe("llm");
  expect(provenanceOf(facts()).salary).toBe("ausente");
});
