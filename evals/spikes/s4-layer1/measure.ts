// S-4: medição no golden dataset gd1. A saída só tem números, ids de caso, nomes de dimensão e termos
// CANÔNICOS do dicionário: nenhum texto de vaga e nenhum canário (AGENTS §1.3; pedido do [APPSEC]).
import type { ContractType, ResolvedJobFacts, SeniorityLevel, WorkModel } from "@trampo/contracts";
import type { DeterministicSignals, InjectionLevel, SetSignal } from "../../../apps/api/src/domain/index.js";
import type { GoldenCase } from "../../src/case-schema.js";
import { loadCases, validCase } from "../../src/load-cases.js";
import { runPreFilter, type PreFilterOutput } from "./prefilter.js";
import {
  PERSONAS,
  acceptCorrect,
  falseRejection,
  mustCriteriaCount,
  r1Dimensions,
  r3Fires,

  termKey,
  type Dimension,
  type GoldView,
  type Persona,
} from "./routing.js";
import { dictionaryAliases } from "./tech-dictionary.js";

export interface EvalCase {
  readonly gold: GoldenCase;
  readonly view: GoldView;
  readonly text: string;
  readonly out: PreFilterOutput;
  readonly outCountOnly: PreFilterOutput;
}

export function loadAndRun(casesRoot: string): EvalCase[] {
  const { cases } = loadCases(casesRoot);
  return cases.map((c) => {
    const gold = validCase(c);
    if (gold === null) throw new RangeError(`caso inválido: ${c.fileId}`);
    const view: GoldView = { expected: gold.expected, alternatives: gold.alternatives as GoldView["alternatives"] };
    // titleHint: o título como escrito (gabarito `title`), no papel do título que o extrator do DOM entrega.
    const out = runPreFilter(c.text, gold.expected.title, { useInvisibleClasses: true });
    const outCountOnly = runPreFilter(c.text, gold.expected.title, { useInvisibleClasses: false });
    return { gold, view, text: c.text, out, outCountOnly };
  });
}

const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((1000 * n) / d) / 10);

function variantsOf<T>(c: EvalCase, field: keyof ResolvedJobFacts): T[] {
  const alts = (c.gold.alternatives as Record<string, unknown[] | undefined>)[field] ?? [];
  return [c.gold.expected[field] as T, ...(alts as T[])];
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function setMetrics<T extends string>(cases: readonly EvalCase[], field: "workModels" | "contractTypes" | "seniorityLevels", pick: (s: DeterministicSignals) => SetSignal<T> | null) {
  let explicit = 0;
  let explicitExact = 0;
  let weak = 0;
  let goldNonEmpty = 0;
  const wrongExplicit: string[] = [];
  for (const c of cases) {
    const sig = pick(c.out.signals);
    const gold = variantsOf<readonly T[]>(c, field);
    if (c.gold.expected[field].length > 0) goldNonEmpty += 1;
    if (sig === null) continue;
    if (sig.strength === "fraca") {
      weak += 1;
      continue;
    }
    explicit += 1;
    if (gold.some((g) => sameSet(g, sig.values))) explicitExact += 1;
    else wrongExplicit.push(`${c.gold.id}:${[...sig.values].sort().join("+")}`);
  }
  return {
    goldNonEmpty, explicit, weak, explicitExact,
    explicitPrecisionPct: pct(explicitExact, explicit),
    explicitCoveragePct: pct(explicitExact, goldNonEmpty),
    wrongExplicit,
  };
}

function salaryMetrics(cases: readonly EvalCase[]) {
  let withGold = 0;
  let explicitCorrect = 0;
  let explicitWrong = 0;
  let invented = 0;
  const wrong: string[] = [];
  let arsReadAsBrl = 0;
  let arsDetected = 0;
  for (const c of cases) {
    const sig = c.out.signals.salary;
    const goldList = variantsOf<ResolvedJobFacts["salary"]>(c, "salary").filter((s) => s !== null);
    if (c.gold.expected.salary?.currency === "ARS") {
      if (sig?.value.currency === "ARS") arsDetected += 1;
      if (sig !== null && (sig.value.currency === "BRL" || sig.value.currency === null)) arsReadAsBrl += 1;
      continue;
    }
    if (goldList.length > 0) withGold += 1;
    if (sig === null || sig.strength !== "explicita") continue;
    if (goldList.length === 0) {
      invented += 1;
      wrong.push(`${c.gold.id}:inventado`);
      continue;
    }
    const ok = goldList.some((g) => {
      const lo = g.min ?? g.max ?? 0;
      const hi = g.max ?? g.min ?? 0;
      const close = (a: number | null, b: number): boolean => a !== null && Math.abs(a - b) <= 0.01 * Math.max(b, 1);
      return g.currency === sig.value.currency && g.period === sig.value.period && close(sig.value.min, lo) && close(sig.value.max, hi);
    });
    if (ok) explicitCorrect += 1;
    else {
      explicitWrong += 1;
      wrong.push(`${c.gold.id}:errado`);
    }
  }
  return { withGold, explicitCorrect, explicitWrong, invented, recallPct: pct(explicitCorrect, withGold), arsDetected, arsReadAsBrl, wrong };
}

function stackMetrics(cases: readonly EvalCase[]) {
  let explicitTotal = 0;
  let explicitInUnion = 0;
  let explicitInRequired = 0;
  let goldTotal = 0;
  let goldFoundAny = 0;
  let goldFoundExplicit = 0;
  let goldInDictionary = 0;
  const known = new Set(dictionaryAliases().map((a) => a.canonical.toLowerCase()));
  const negationTrapViolations: string[] = [];
  const explicitNotInGold: Record<string, number> = {};
  for (const c of cases) {
    const union = new Set([...c.gold.expected.stackRequired, ...c.gold.expected.stackNiceToHave].map(termKey));
    const altUnion = new Set(
      [...variantsOf<readonly string[]>(c, "stackRequired"), ...variantsOf<readonly string[]>(c, "stackNiceToHave")].flat().map(termKey),
    );
    const required = new Set(variantsOf<readonly string[]>(c, "stackRequired").flat().map(termKey));
    const explicit = c.out.signals.stackMentions.filter((m) => m.strength === "explicita").map((m) => termKey(m.term));
    const any = new Set(c.out.signals.stackMentions.map((m) => termKey(m.term)));
    explicitTotal += explicit.length;
    for (const t of explicit) {
      if (altUnion.has(t)) explicitInUnion += 1;
      else explicitNotInGold[t] = (explicitNotInGold[t] ?? 0) + 1;
      if (required.has(t)) explicitInRequired += 1;
    }
    for (const t of union) {
      goldTotal += 1;
      if (known.has(t)) goldInDictionary += 1;
      if (any.has(t)) goldFoundAny += 1;
      if (explicit.includes(t)) goldFoundExplicit += 1;
    }
    const negationCase = c.gold.category === "armadilha_negacao" || c.gold.traps.includes("negacao");
    if (negationCase) for (const t of explicit) if (!altUnion.has(t)) negationTrapViolations.push(`${c.gold.id}:${t}`);
  }
  return {
    explicitTotal,
    explicitPrecisionUnionPct: pct(explicitInUnion, explicitTotal),
    explicitPrecisionRequiredPct: pct(explicitInRequired, explicitTotal),
    goldTotal,
    goldInDictionaryPct: pct(goldInDictionary, goldTotal),
    recallAnyPct: pct(goldFoundAny, goldTotal),
    recallExplicitPct: pct(goldFoundExplicit, goldTotal),
    negationTrapViolations,
    explicitNotInGold,
  };
}

const NEGATIVE_CONTROLS = ["gupy-19", "geekhunter-07"];

function injectionMetrics(cases: readonly EvalCase[], pick: (c: EvalCase) => InjectionLevel) {
  const injection = cases.filter((c) => c.gold.category === "injection_visivel" || c.gold.category === "injection_oculta");
  const controls = cases.filter((c) => c.gold.category === "controle_negativo" || NEGATIVE_CONTROLS.includes(c.gold.id));
  const benign = cases.filter((c) => !injection.includes(c));
  const levels = (list: readonly EvalCase[]): Record<string, InjectionLevel> =>
    Object.fromEntries(list.map((c) => [c.gold.id, pick(c)]));
  return {
    injectionCases: injection.length,
    detectedAlta: injection.filter((c) => pick(c) === "alta").length,
    detectedMediaOrAlta: injection.filter((c) => pick(c) !== "baixa").length,
    injectionLevels: levels(injection),
    controlLevels: levels(controls),
    controlsAlta: controls.filter((c) => pick(c) === "alta").length,
    benignAlta: benign.filter((c) => pick(c) === "alta").map((c) => c.gold.id),
    benignMedia: benign.filter((c) => pick(c) === "media").map((c) => c.gold.id),
  };
}

function personaMetrics(cases: readonly EvalCase[], p: Persona) {
  let r1 = 0;
  let r1False = 0;
  let r2 = 0;
  let r3 = 0;
  let r3Correct = 0;
  let r3CorrectStrict = 0;
  const falseRejections: string[] = [];
  const wrongAccepts: string[] = [];
  for (const c of cases) {
    const dims = r1Dimensions(p, c.out.signals);
    if (dims.length > 0) {
      r1 += 1;
      const wrong = dims.filter((d) => falseRejection(p, c.view, d));
      // A rejeição é falsa só se TODAS as dimensões que a dispararam são falsas.
      if (wrong.length === dims.length) {
        r1False += 1;
        falseRejections.push(`${c.gold.id}:${wrong.join("+")}`);
      }
      continue;
    }
    if (c.out.signals.injectionLevel === "alta") {
      r2 += 1;
      continue;
    }
    if (r3Fires(p, c.out.signals)) {
      r3 += 1;
      if (acceptCorrect(p, c.view, false)) r3Correct += 1;
      else wrongAccepts.push(c.gold.id);
      if (acceptCorrect(p, c.view, true)) r3CorrectStrict += 1;
    }
  }
  const n = cases.length;
  return {
    persona: p.id,
    mustCriteria: mustCriteriaCount(p),
    r1, r1False, r2, r3, r3Correct, r3CorrectStrict,
    withoutLlmFlagOffPct: pct(r1 + r2, n),
    withoutLlmFlagOnPct: pct(r1 + r2 + r3, n),
    falseRejections,
    wrongAccepts,
  };
}

// Varredura exaustiva de critérios eliminatórios isolados: o limite superior do falso "foge".
const WORK: readonly WorkModel[] = ["remoto", "hibrido", "presencial"];
const SEN: readonly SeniorityLevel[] = ["estagio", "junior", "pleno", "senior", "especialista", "lideranca"];
const CON: readonly ContractType[] = ["clt", "pj", "cooperado", "estagio", "temporario"];
const SALARY_GRID = [1500, 3000, 5000, 8000, 12000, 20000, 35000, 60000];

function subsets<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 1; mask < 1 << values.length; mask += 1) out.push(values.filter((_, i) => (mask & (1 << i)) !== 0));
  return out;
}

const BASE: Persona = {
  id: "varredura", otherMustDimensions: 0,
  workModel: { accepted: WORK, level: "ignorar" },
  seniority: { accepted: SEN, level: "ignorar" },
  contract: { accepted: CON, level: "ignorar" },
  salary: null,
  stack: { mustHave: [], dealBreakers: [], scope: "somente_obrigatoria" },
};

function sweepProfiles(): { dim: Dimension; persona: Persona }[] {
  const out: { dim: Dimension; persona: Persona }[] = [];
  for (const a of subsets(WORK)) out.push({ dim: "workModel", persona: { ...BASE, workModel: { accepted: a, level: "eliminatorio" } } });
  for (const a of subsets(SEN)) out.push({ dim: "seniority", persona: { ...BASE, seniority: { accepted: a, level: "eliminatorio" } } });
  for (const a of subsets(CON)) out.push({ dim: "contract", persona: { ...BASE, contract: { accepted: a, level: "eliminatorio" } } });
  for (const m of SALARY_GRID) out.push({ dim: "salary", persona: { ...BASE, salary: { minimumBrlMonth: m, level: "eliminatorio" } } });
  const terms = [...new Set(dictionaryAliases().map((a) => a.canonical))];
  for (const t of terms) {
    for (const scope of ["somente_obrigatoria", "qualquer_mencao"] as const) {
      out.push({ dim: "stack", persona: { ...BASE, stack: { mustHave: [], dealBreakers: [t], scope } } });
    }
  }
  return out;
}

function sweepMetrics(cases: readonly EvalCase[]) {
  const byDim: Record<string, { firings: number; falseFirings: number; casesWithFalse: string[] }> = {};
  for (const { dim, persona } of sweepProfiles()) {
    const slot = (byDim[dim] ??= { firings: 0, falseFirings: 0, casesWithFalse: [] });
    for (const c of cases) {
      if (!r1Dimensions(persona, c.out.signals).includes(dim)) continue;
      slot.firings += 1;
      if (falseRejection(persona, c.view, dim)) {
        slot.falseFirings += 1;
        if (!slot.casesWithFalse.includes(c.gold.id)) slot.casesWithFalse.push(c.gold.id);
      }
    }
  }
  const firings = Object.values(byDim).reduce((n, d) => n + d.firings, 0);
  const falseFirings = Object.values(byDim).reduce((n, d) => n + d.falseFirings, 0);
  return { firings, falseFirings, falsePct: pct(falseFirings, firings), byDim: Object.fromEntries(Object.entries(byDim).map(([k, v]) => [k, { ...v, falsePct: pct(v.falseFirings, v.firings) }])) };
}

export function measure(cases: readonly EvalCase[]) {
  return {
    cases: cases.length,
    fields: {
      workModels: setMetrics(cases, "workModels", (s) => s.workModels),
      contractTypes: setMetrics(cases, "contractTypes", (s) => s.contractTypes),
      seniorityLevels: setMetrics(cases, "seniorityLevels", (s) => s.seniorityLevels),
    },
    salary: salaryMetrics(cases),
    stack: stackMetrics(cases),
    injection: {
      withInvisibleClasses: injectionMetrics(cases, (c) => c.out.signals.injectionLevel),
      countOnlyN1: injectionMetrics(cases, (c) => c.outCountOnly.signals.injectionLevel),
    },
    personas: PERSONAS.map((p) => personaMetrics(cases, p)),
    sweep: sweepMetrics(cases),
  };
}
