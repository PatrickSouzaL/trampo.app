// F1-DOM-03: propriedades do ReportComposer (ADR-012 D8) sobre o ScoringEngine real, com os arbitrários do
// motor (1.000 execuções), e varredura exaustiva de todo texto alcançável contra o safeText do contrato.
import {
  ContractTypeSchema,
  CurrencySchema,
  SeniorityLevelSchema,
  WorkModelSchema,
  type AnalysisWarning,
  type DimensionOutcome,
  type ScoreDimension,
  type UserCriteria,
} from "@trampo/contracts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import {
  ANALYSIS_WARNINGS,
  DEFAULT_REPORT_CATALOG,
  DIMENSION_OUTCOMES,
  RED_FLAG_EFFECTS,
  RED_FLAG_SIGNALS,
  SCORE_DIMENSIONS,
  SPECIFIC_REASON_CODES,
  VERDICTS,
  type ScoreReasonCode,
  type ScoreResult,
  type ScoringInput,
} from "../../src/domain/index.js";
import { ENVELOPE, composeFor, composer, expectValidReport, scoreResult } from "./fakes/report-fixtures.js";
import { criteriaArb, deepFreeze, facts, input, inputArb } from "./fakes/scoring-fixtures.js";

const RUNS = { numRuns: 1_000 };
const warningsArb = fc.array(fc.constantFrom<AnalysisWarning>(...ANALYSIS_WARNINGS), { maxLength: 8 });
const textsOf = (r: ReturnType<typeof composeFor>["report"]) =>
  JSON.stringify([r.summary, r.strengths, r.redFlags, r.missingInfo, r.breakdown.map((e) => e.explanation)]);

describe("propriedades (ADR-012 D8)", () => {
  test("a saída passa sempre no AnalysisReportSchema", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, warningsArb, fc.double({ min: 0, max: 1, noNaN: true }), (i, c, warnings, confidence) => {
        expectValidReport(composeFor(i, c, { warnings, effectiveConfidence: confidence }).report);
      }),
      RUNS,
    );
  });

  test("determinismo e entrada congelada intacta", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, warningsArb, (i, c, warnings) => {
        const score = deepFreeze(composeFor(i, c).score);
        const frozen = deepFreeze(structuredClone({ i, warnings }));
        const before = JSON.stringify([frozen, score]);
        const once = () =>
          composer.compose({
            envelope: ENVELOPE,
            resolution: { facts: frozen.i.facts, provenance: frozen.i.provenance, effectiveConfidence: 0.5 },
            warnings: frozen.warnings,
            score,
          });
        expect(once()).toEqual(once());
        expect(JSON.stringify([frozen, score])).toBe(before);
      }),
      RUNS,
    );
  });

  test("o relatório reproduz o motor: nota, faixa, deal-breaker e as 9 linhas", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, (i, c) => {
        const { report, score } = composeFor(i, c);
        expect([report.score, report.verdict, report.dealBreakerHit]).toEqual([score.score, score.verdict, score.dealBreakerHit]);
        expect(report.breakdown.map(({ explanation: _e, ...rest }) => rest)).toEqual(score.breakdown.map(({ reason: _r, ...rest }) => rest));
      }),
      RUNS,
    );
  });

  test("seleção: pontos fortes atendem com ponto, ausentes são exatamente as não informadas e em conflito", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, (i, c) => {
        const { report, score } = composeFor(i, c);
        const byDimension = new Map(score.breakdown.map((line) => [line.dimension, line]));
        for (const s of report.strengths) expect([byDimension.get(s.dimension)?.outcome, (byDimension.get(s.dimension)?.points ?? 0) > 0]).toEqual(["atende", true]);
        const strong = score.breakdown.filter((line) => line.outcome === "atende" && line.points > 0);
        expect(report.strengths).toHaveLength(Math.min(3, strong.length));
        const missing = score.breakdown.filter((line) => line.outcome === "nao_informado" || line.outcome === "conflito").map((line) => line.dimension);
        expect(report.missingInfo.map((m) => m.dimension)).toEqual(missing);
        if (score.dealBreakerHit) expect(report.redFlags.length).toBeGreaterThan(0);
        expect(report.summary.startsWith(score.dealBreakerHit ? DEFAULT_REPORT_CATALOG.dealBreakerVerdict : DEFAULT_REPORT_CATALOG.verdicts[score.verdict])).toBe(true);
      }),
      RUNS,
    );
  });

  test("SR-11: nenhum canário do perfil aparece no relatório", () => {
    // Canários fora dos pools dos fatos: se aparecerem, vieram do perfil.
    const CANARY = { tech: "Zyxcanario", city: "Canariópolis do Sul", minimum: 98_765.43, notes: "canario-das-observacoes" };
    fc.assert(
      fc.property(inputArb, criteriaArb, (i, base) => {
        const c: UserCriteria = {
          ...base,
          salary: { minimum: CANARY.minimum, currency: "BRL", period: "mes", importance: base.salary?.importance ?? { level: "obrigatorio" } },
          location: { acceptedUfs: [], acceptedCities: [CANARY.city], importance: base.location?.importance ?? { level: "obrigatorio" } },
          stack: { ...base.stack, mustHave: [...base.stack.mustHave.slice(0, 14), CANARY.tech] },
          notes: CANARY.notes,
        };
        const json = JSON.stringify(composeFor(i, c).report);
        for (const canary of [CANARY.tech, CANARY.tech.toLowerCase(), CANARY.city, "98765", "98.765", CANARY.notes]) {
          expect(json.includes(canary), canary).toBe(false);
        }
      }),
      RUNS,
    );
  });

  test("independência de texto livre: título, cidade, país e tags de stack só mudam o subobjeto facts", () => {
    fc.assert(
      fc.property(inputArb, criteriaArb, (i, c) => {
        const { score } = composeFor(i, c);
        const swapped: ScoringInput = {
          ...i,
          facts: {
            ...i.facts,
            title: "Titulo Canario",
            location: i.facts.location === null ? null : { ...i.facts.location, city: "Cidade Canario", countryIso2: i.facts.location.countryIso2 === null ? null : "ZZ" },
            stackRequired: i.facts.stackRequired.map((_t, n) => `CanarioReq${n}`),
            stackNiceToHave: i.facts.stackNiceToHave.map((_t, n) => `CanarioNice${n}`),
          },
        };
        const compose = (s: ScoringInput) =>
          composer.compose({ envelope: ENVELOPE, resolution: { facts: s.facts, provenance: s.provenance, effectiveConfidence: 0.5 }, warnings: [], score });
        const a = compose(i);
        const b = compose(swapped);
        expect(textsOf(b)).toBe(textsOf(a));
        expect(textsOf(b).includes("Canario")).toBe(false);
        expect({ ...b, facts: null }).toEqual({ ...a, facts: null });
      }),
      RUNS,
    );
  });
});

describe("varredura exaustiva de todo texto alcançável (ADR-012 D6 e D8)", () => {
  const REASONS: readonly ScoreReasonCode[] = [...DIMENSION_OUTCOMES, ...SPECIFIC_REASON_CODES];
  /** Os fatos com o maior detalhe possível: as listas no teto do contrato e a moeda de rótulo mais longo. */
  const LONGEST = facts({
    workModels: [...WorkModelSchema.options],
    seniorityLevels: ["estagio", "especialista", "lideranca"],
    contractTypes: [...ContractTypeSchema.options],
    salary: { min: 1, max: 2, currency: "ARS", period: "mes" },
  });

  test("9 dimensões × 6 outcomes × 20 reasons, com o maior detalhe: tudo válido no contrato", () => {
    expect(REASONS).toHaveLength(20);
    let checked = 0;
    for (const dimension of SCORE_DIMENSIONS) {
      for (const outcome of DIMENSION_OUTCOMES) {
        for (const reason of REASONS) {
          const lines = Object.fromEntries(SCORE_DIMENSIONS.map((d) => [d, { outcome, reason, points: 1 }])) as Record<
            ScoreDimension,
            { outcome: DimensionOutcome; reason: ScoreReasonCode; points: number }
          >;
          const report = composer.compose({
            envelope: ENVELOPE,
            resolution: { facts: LONGEST, provenance: input(LONGEST).provenance, effectiveConfidence: 1 },
            warnings: [],
            score: scoreResult({ ...lines, [dimension]: { outcome, reason, points: 1 } }),
          });
          expectValidReport(report);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(9 * 6 * 20);
  });

  test("toda moeda, todo sinal e todo efeito formam texto válido", () => {
    for (const currency of CurrencySchema.options) {
      const f = facts({ salary: { min: 1, max: null, currency, period: null } });
      const report = composer.compose({
        envelope: ENVELOPE,
        resolution: { facts: f, provenance: input(f).provenance, effectiveConfidence: 1 },
        warnings: [],
        score: scoreResult({ salario: { outcome: "atende", reason: "salario_convertido" } }),
      });
      expectValidReport(report);
      expect(report.breakdown.find((e) => e.dimension === "salario")?.explanation.endsWith(`${DEFAULT_REPORT_CATALOG.currencies[currency]}.`)).toBe(true);
    }
    for (const effect of RED_FLAG_EFFECTS) {
      const hits = RED_FLAG_SIGNALS.map((signal) => ({ signal, effect }));
      const report = composer.compose({ envelope: ENVELOPE, resolution: { facts: LONGEST, provenance: input(LONGEST).provenance, effectiveConfidence: 1 }, warnings: [], score: scoreResult({}, { redFlagHits: hits }) });
      expectValidReport(report);
    }
    for (const level of SeniorityLevelSchema.options) {
      const f = facts({ seniorityLevels: [level] });
      expectValidReport(
        composer.compose({ envelope: ENVELOPE, resolution: { facts: f, provenance: input(f).provenance, effectiveConfidence: 1 }, warnings: [], score: scoreResult({ senioridade: { outcome: "atende", reason: "atende" } }) }),
      );
    }
  });

  test("summary no pior caso de cada faixa: as dimensões de rótulo mais longo a favor e contra", () => {
    const longestFirst = [...SCORE_DIMENSIONS].sort((a, b) => DEFAULT_REPORT_CATALOG.dimensions[b].length - DEFAULT_REPORT_CATALOG.dimensions[a].length);
    const [first, second, third] = longestFirst as [ScoreDimension, ScoreDimension, ScoreDimension];
    for (const verdict of VERDICTS) {
      for (const neutralBase of [0, 50]) {
        const favor: ScoreResult = scoreResult(
          { [first]: { outcome: "atende", points: 30 }, [second]: { outcome: "atende", points: 20 }, [third]: { outcome: "nao_atende", importance: "obrigatorio", points: -30 } },
          { verdict, score: 100, neutralBase },
        );
        expectValidReport(composer.compose({ envelope: ENVELOPE, resolution: { facts: LONGEST, provenance: input(LONGEST).provenance, effectiveConfidence: 1 }, warnings: [], score: favor }));
      }
    }
    const hit = { outcome: "nao_atende", importance: "eliminatorio", points: -30, dealBreakerHit: true } as const;
    const eliminated = scoreResult({ [first]: hit, [second]: hit, [third]: hit }, { dealBreakerHit: true, verdict: "foge", score: 20 });
    expectValidReport(composer.compose({ envelope: ENVELOPE, resolution: { facts: LONGEST, provenance: input(LONGEST).provenance, effectiveConfidence: 1 }, warnings: [], score: eliminated }));
  });
});
