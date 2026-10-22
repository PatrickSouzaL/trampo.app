// E2 Camada 1 (ADR-001 §5.3; ADR-016): DeterministicPreFilter. Produz a porta DeterministicSignals (ADR-011 D1)
// sobre o texto JÁ normalizado (n1). Puro: sem rede, relógio, aleatoriedade nem log. Independente do usuário.
// A saída tem só enums, números e termos canônicos do TechDictionary: nenhum trecho da vaga (ADR-016 §3).
import type { DeterministicSignals } from "../ports/deterministic-signals.js";
import {
  JOB_TEXT_NORMALIZER_VERSION,
  type NormalizedJobText,
  type NormalizedJobTitle,
} from "../normalization/job-text-normalizer.js";
import { DependencyContractError } from "../text/code-points.js";
import { fold, splitLines } from "./folding.js";
import { assessInjection } from "./injection-heuristics.js";
import { classifyLines } from "./line-context.js";
import { detectSalary } from "./salary-signal.js";
import { detectContractTypes, detectSeniority, detectWorkModels } from "./set-signals.js";
import { detectStack, guessLanguage } from "./stack-mentions.js";

/** Versão da Camada 1. Fora do extractorVersion: o cache guarda os fatos do LLM, e a Camada 1 roda sempre. */
export const PRE_FILTER_VERSION = "pf1";

export interface PreFilterInput {
  readonly text: NormalizedJobText;
  /**
   * Obrigatório, com `null` explícito (S-4 §5.7, item 3): o título é a única fonte de senioridade explícita.
   * Já passou pelo `normalizeTitle`.
   */
  readonly title: NormalizedJobTitle | null;
}

export class DeterministicPreFilter {
  extract(input: PreFilterInput): DeterministicSignals {
    // As heurísticas foram calibradas no n1 (S-4): outra versão do normalizador exige recalibrar.
    if (input.text.normalizerVersion !== JOB_TEXT_NORMALIZER_VERSION) {
      throw new DependencyContractError("A Camada 1 só aceita texto do normalizador n1.");
    }
    const folded = fold(input.text.text);
    const lines = splitLines(folded.text);
    const contexts = classifyLines(lines);
    const workModels = detectWorkModels(folded.text, lines, contexts);
    return {
      workModels: workModels.signal,
      contractTypes: detectContractTypes(folded.text, lines),
      seniorityLevels: detectSeniority(input.title === null ? null : fold(input.title.text).text, folded.text),
      salary: detectSalary(lines),
      stackMentions: detectStack(folded, lines, contexts, guessLanguage(folded.text)).mentions,
      injectionLevel: assessInjection(folded.text, lines, input.text.signals).level,
    };
  }
}
