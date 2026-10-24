// S-1: casos do gd1, o micro-payload real (normalizador `n1` + seletor `sel1`) e o plano estratificado decidido
// pelo humano em 2026-10-24: 6k nos 83 casos; 4k e 8k só onde o orçamento muda o texto.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { truncateCodePoints } from "@trampo/contracts";
import { JobTextNormalizer, RelevantSectionSelector, countCodePoints } from "../../../apps/api/src/domain/index.js";
import type { GoldenCase } from "../../src/case-schema.js";
import { loadCases, validCase } from "../../src/load-cases.js";

export const CASES_ROOT = join(import.meta.dirname, "..", "..", "golden", "cases");
export const BUDGETS = [4_000, 6_000, 8_000] as const;
export type Budget = (typeof BUDGETS)[number];
export const PRIMARY_BUDGET: Budget = 6_000;
/** Teto do subconjunto 4k/8k (cota: ~25 casos × 2 orçamentos por provedor). */
export const SWEEP_MAX_CASES = 25;

export interface SpikeCase {
  readonly golden: GoldenCase;
  /** Texto normalizado inteiro, em code points. */
  readonly normalizedChars: number;
  readonly payloads: ReadonlyMap<Budget, string>;
}

export interface PlanItem {
  readonly caseId: string;
  readonly budget: Budget;
}

const sha = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");

export function loadSpikeCases(root: string = CASES_ROOT): SpikeCase[] {
  const normalizer = new JobTextNormalizer({ hasher: { sha256Hex: sha }, truncateCodePoints });
  const selectors = new Map(BUDGETS.map((b) => [b, new RelevantSectionSelector({ truncateCodePoints, budgetChars: b })] as const));
  const out: SpikeCase[] = [];
  for (const loaded of loadCases(root).cases) {
    const golden = validCase(loaded);
    if (golden === null) throw new Error(`caso inválido: ${loaded.fileId}`);
    const normalized = normalizer.normalize(loaded.text);
    const payloads = new Map<Budget, string>();
    for (const [budget, selector] of selectors) payloads.set(budget, selector.select(normalized).text);
    out.push({ golden, normalizedChars: countCodePoints(normalized.text), payloads });
  }
  return out;
}

/** Ordem embaralhada com semente fixa (sha256 do id): um dia de cota cobre todas as categorias. */
function shuffled(cases: readonly SpikeCase[]): SpikeCase[] {
  return [...cases].sort((a, b) => sha(`s1:${a.golden.id}`).localeCompare(sha(`s1:${b.golden.id}`)));
}

/** O orçamento muda o texto enviado em relação ao de 6k. */
export function differs(c: SpikeCase, budget: Budget): boolean {
  return c.payloads.get(budget) !== c.payloads.get(PRIMARY_BUDGET);
}

const SWEEP_PRIORITY: Readonly<Record<string, number>> = {
  injection_visivel: 0,
  injection_oculta: 0,
  ambigua: 1,
  armadilha_negacao: 2,
  normal: 3,
  controle_negativo: 4,
};

/**
 * Subconjunto 4k/8k: só casos em que algum dos dois orçamentos muda o texto em relação ao de 6k (senão a chamada
 * repetiria a de 6k), por prioridade de categoria e depois pelo tamanho do texto.
 */
export function sweepCases(cases: readonly SpikeCase[]): SpikeCase[] {
  return cases
    .filter((c) => differs(c, 4_000) || differs(c, 8_000))
    .sort(
      (a, b) =>
        (SWEEP_PRIORITY[a.golden.category] ?? 9) - (SWEEP_PRIORITY[b.golden.category] ?? 9) ||
        b.normalizedChars - a.normalizedChars ||
        a.golden.id.localeCompare(b.golden.id),
    )
    .slice(0, SWEEP_MAX_CASES);
}

/** 6k primeiro (os 83), depois 4k e 8k por caso, só quando o orçamento muda o texto. */
export function buildPlan(cases: readonly SpikeCase[]): PlanItem[] {
  const primary = shuffled(cases).map((c) => ({ caseId: c.golden.id, budget: PRIMARY_BUDGET }));
  const sweep = shuffled(sweepCases(cases)).flatMap((c) =>
    ([4_000, 8_000] as const).filter((b) => differs(c, b)).map((budget) => ({ caseId: c.golden.id, budget })),
  );
  return [...primary, ...sweep];
}
