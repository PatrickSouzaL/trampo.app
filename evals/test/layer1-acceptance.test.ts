// F1-DOM-04: aceite da Camada 1 de produção no golden dataset gd1 (ADR-016 §4). Roda o DeterministicPreFilter
// real ao lado do protótipo do S-4 (spike-metrics §5) e exige métricas iguais ou melhores: falso "foge" zero,
// precisão por campo, injection e controles negativos. O R1 de produção (PreFilterRouter sobre o ScoringEngine)
// é julgado pelo mesmo oráculo do S-4. A saída do teste só tem números, ids de caso e nomes de campo.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { RedFlagSignal, UserCriteria } from "@trampo/contracts";
import { JOB_TITLE_MAX_CHARS } from "@trampo/contracts/limits";
import { RedFlagSignalSchema, ResolvedJobFactsSchema } from "@trampo/contracts";
import { safeText, truncateCodePoints } from "@trampo/contracts/primitives";
import { describe, expect, test } from "vitest";
import {
  DICTIONARY_TERMS,
  DeterministicPreFilter,
  FactResolver,
  JobTextNormalizer,
  PreFilterRouter,
  ScoringEngine,
  type DeterministicSignals,
} from "../../apps/api/src/domain/index.js";
import { loadAndRun, measure, type EvalCase } from "../spikes/s4-layer1/measure.js";
import { PERSONAS, falseRejection, type Dimension, type Persona } from "../spikes/s4-layer1/routing.js";

const CASES_ROOT = join(import.meta.dirname, "..", "golden", "cases");
const normalizer = new JobTextNormalizer({
  hasher: { sha256Hex: (text) => createHash("sha256").update(text, "utf8").digest("hex") },
  truncateCodePoints,
});
const preFilter = new DeterministicPreFilter();
const titleSchema = safeText(JOB_TITLE_MAX_CHARS);
const resolver = new FactResolver({ isSafeTitle: (value) => titleSchema.safeParse(value).success });
const engine = new ScoringEngine();
const router = new PreFilterRouter({ resolver, engine });
const acceptRouter = new PreFilterRouter({ resolver, engine, policy: { shortCircuitAccept: true } });

/** O titleHint é o título do gabarito, no papel do título que o extrator do DOM entrega (como no S-4). */
function production(c: EvalCase): DeterministicSignals {
  const title = c.gold.expected.title;
  return preFilter.extract({ text: normalizer.normalize(c.text), title: title === null ? null : normalizer.normalizeTitle(title) });
}

const baselineCases = loadAndRun(CASES_ROOT);
const productionSignals = new Map(baselineCases.map((c) => [c.gold.id, production(c)]));
const signalsOf = (c: EvalCase): DeterministicSignals => productionSignals.get(c.gold.id) as DeterministicSignals;
const productionCases: EvalCase[] = baselineCases.map((c) => ({
  ...c,
  out: { ...c.out, signals: signalsOf(c) },
  outCountOnly: { ...c.outCountOnly, signals: signalsOf(c) },
}));
const baseline = measure(baselineCases);
const prod = measure(productionCases);

const importance = (level: Persona["workModel"]["level"]) =>
  level === "ponderado" ? ({ level, weight: 3 } as const) : ({ level } as const);

/** A persona do S-4 como UserCriteria real; dimensões sem sinal na Camada 1 entram como idioma obrigatório. */
function criteriaOf(p: Persona): UserCriteria {
  const tolerance = Object.fromEntries(RedFlagSignalSchema.options.map((s) => [s, "alertar"])) as Record<RedFlagSignal, "alertar">;
  return {
    schemaVersion: 1,
    workModel: { accepted: [...p.workModel.accepted], importance: importance(p.workModel.level) },
    seniority: { accepted: [...p.seniority.accepted], importance: importance(p.seniority.level) },
    contractType: { accepted: [...p.contract.accepted], importance: importance(p.contract.level) },
    salary: p.salary === null ? null : { minimum: p.salary.minimumBrlMonth, currency: "BRL", period: "mes", importance: importance(p.salary.level) },
    location: null,
    stack: { mustHave: [...p.stack.mustHave], niceToHave: [], dealBreakers: [...p.stack.dealBreakers], dealBreakerScope: p.stack.scope, niceToHaveWeight: 0 },
    languages: p.otherMustDimensions > 0 ? { proficiencies: [{ language: "ingles", level: "avancado" }], importance: { level: "obrigatorio" } } : null,
    benefits: null,
    redFlagTolerance: tolerance,
    notes: null,
  };
}

const DIMENSION_OF = { modelo_trabalho: "workModel", senioridade: "seniority", contrato: "contract", salario: "salary", stack: "stack" } as const;

describe("F1-DOM-04: Camada 1 de produção no gd1, comparada com o S-4", () => {
  test("os 83 casos rodam, e a saída só tem enums, números e canônicos do dicionário", () => {
    expect(productionCases).toHaveLength(83);
    const serialized = JSON.stringify([...productionSignals.values()]);
    expect(serialized).not.toMatch(/TRAMPO-CANARY/u);
    for (const c of productionCases) {
      for (const line of c.text.split("\n")) {
        const t = line.trim();
        if (t.length >= 25) expect(serialized.includes(t), c.gold.id).toBe(false);
      }
      for (const m of signalsOf(c).stackMentions) expect(DICTIONARY_TERMS.has(m.term), m.term).toBe(true);
    }
  });

  test("os sinais são os mesmos do protótipo do S-4 nos 83 casos (só a ordem da stack muda: sem locale)", () => {
    const byTerm = (s: DeterministicSignals) => ({ ...s, stackMentions: [...s.stackMentions].sort((a, b) => (a.term < b.term ? -1 : 1)) });
    const differing = baselineCases.filter((c) => JSON.stringify(byTerm(c.out.signals)) !== JSON.stringify(byTerm(signalsOf(c))));
    expect(differing.map((c) => c.gold.id)).toEqual([]);
  });

  test("precisão por campo: 100% nos explícitos de modelo, contrato e senioridade, cobertura ≥ S-4", () => {
    for (const field of ["workModels", "contractTypes", "seniorityLevels"] as const) {
      const p = prod.fields[field];
      const b = baseline.fields[field];
      expect({ field, wrong: p.wrongExplicit }).toEqual({ field, wrong: [] });
      expect(p.explicitPrecisionPct, field).toBe(100);
      expect(p.explicitExact, field).toBeGreaterThanOrEqual(b.explicitExact);
    }
  });

  test("salário: nenhum inventado nem errado, ARS nunca como BRL, acertos ≥ S-4", () => {
    expect(prod.salary.wrong).toEqual([]);
    expect(prod.salary.invented).toBe(0);
    expect(prod.salary.arsReadAsBrl).toBe(0);
    expect(prod.salary.arsDetected).toBeGreaterThanOrEqual(baseline.salary.arsDetected);
    expect(prod.salary.explicitCorrect).toBeGreaterThanOrEqual(baseline.salary.explicitCorrect);
  });

  test("stack: precisão ≥ S-4, recall explícito ≥ S-4 e nenhuma armadilha de negação", () => {
    expect(prod.stack.explicitNotInGold).toEqual(baseline.stack.explicitNotInGold);
    expect(prod.stack.explicitPrecisionUnionPct).toBeGreaterThanOrEqual(baseline.stack.explicitPrecisionUnionPct);
    expect(prod.stack.recallExplicitPct).toBeGreaterThanOrEqual(baseline.stack.recallExplicitPct);
    expect(prod.stack.negationTrapViolations).toEqual([]);
  });

  test("injection (H10): 7/7 em alta, nenhum controle negativo nem vaga benigna em alta (SR-04)", () => {
    const p = prod.injection.withInvisibleClasses;
    expect(p.detectedAlta).toBe(p.injectionCases);
    expect(p.injectionCases).toBe(7);
    expect(p.controlsAlta).toBe(0);
    expect(p.benignAlta).toEqual([]);
    expect(p.controlLevels).toEqual({ "gupy-19": "baixa", "geekhunter-07": "baixa", "syn-08-controle-negativo-appsec-llm": "media", "syn-09-controle-negativo-red-team-ia": "baixa" });
    expect(p.benignMedia).toEqual(baseline.injection.withInvisibleClasses.benignMedia);
  });

  test("falso \"foge\" do sinal: 0 nas personas e na varredura exaustiva (S-4 final: 0)", () => {
    expect(prod.sweep.falseFirings).toBe(0);
    expect(prod.sweep.firings).toBeGreaterThanOrEqual(baseline.sweep.firings);
    for (const p of prod.personas) expect({ persona: p.persona, falso: p.falseRejections }).toEqual({ persona: p.persona, falso: [] });
  });

  test("R1 de produção (PreFilterRouter + ScoringEngine): zero rejeição falsa e o mesmo alcance do S-4", () => {
    for (const persona of PERSONAS) {
      const criteria = criteriaOf(persona);
      let rejections = 0;
      const falses: string[] = [];
      for (const c of productionCases) {
        const decision = router.route({ mode: "auto", signals: signalsOf(c), titleHint: c.gold.expected.title, criteria });
        ResolvedJobFactsSchema.parse(decision.deterministic.resolution.facts);
        expect(decision.rule, `${persona.id}:${c.gold.id}`).not.toBe("R3");
        if (decision.rule !== "R1") continue;
        rejections += 1;
        const dims = decision.rejectedDimensions.map((d) => DIMENSION_OF[d as keyof typeof DIMENSION_OF] as Dimension);
        if (dims.every((d) => falseRejection(persona, c.view, d))) falses.push(c.gold.id);
      }
      const s4 = prod.personas.find((p) => p.persona === persona.id);
      expect({ persona: persona.id, falses }).toEqual({ persona: persona.id, falses: [] });
      expect(rejections, persona.id).toBe(s4?.r1);
    }
  });

  test("R3 (D-H3): desligado nunca aceita; ligado, a guarda de vacuidade barra o perfil só ponderado (p8)", () => {
    const p8 = PERSONAS.find((p) => p.id === "p8-so-ponderado") as Persona;
    for (const c of productionCases) {
      const input = { mode: "auto" as const, signals: signalsOf(c), titleHint: c.gold.expected.title, criteria: criteriaOf(p8) };
      expect(acceptRouter.route(input).rule).not.toBe("R3");
      expect(acceptRouter.route(input).acceptEligible).toBe(false);
    }
  });
});
