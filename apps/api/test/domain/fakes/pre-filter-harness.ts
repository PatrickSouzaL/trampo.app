// Monta a Camada 1 como o AnalyzeJob fará: normalizador n1 → DeterministicPreFilter (ADR-016 §4).
import { truncateCodePoints } from "@trampo/contracts/primitives";

import { DeterministicPreFilter, JobTextNormalizer, type DeterministicSignals } from "../../../src/domain/index.js";
import { fold, splitLines, type Line } from "../../../src/domain/prefilter/folding.js";
import { nodeTextHasher } from "../../../src/infrastructure/crypto/node-text-hasher.js";

export const normalizer = new JobTextNormalizer({ hasher: nodeTextHasher, truncateCodePoints });
export const preFilter = new DeterministicPreFilter();

/** Sinais do texto bruto, com o título opcional (null explícito por padrão). */
export function signalsOf(raw: string, title: string | null = null): DeterministicSignals {
  return preFilter.extract({ text: normalizer.normalize(raw), title: title === null ? null : normalizer.normalizeTitle(title) });
}

/** Texto já dobrado e em linhas, para testar um detector isolado. */
export function foldedLines(raw: string): { text: string; lines: Line[] } {
  const text = fold(raw).text;
  return { text, lines: splitLines(text) };
}
