// S-4: protótipo descartável do DeterministicPreFilter (ADR-001 §5.3). Produz a porta DeterministicSignals
// (ADR-011 D1) sobre o texto do normalizador REAL (n1), como a produção fará. Puro: sem rede e sem log.
import { createHash } from "node:crypto";
import { truncateCodePoints } from "@trampo/contracts";
import { JobTextNormalizer, type DeterministicSignals, type JobTextSignals } from "../../../apps/api/src/domain/index.js";
import { scoreInjection, type InjectionOptions, type InjectionResult } from "./injection.js";
import { detectSalary, type SalaryResult } from "./salary.js";
import { classifyLines } from "./sections.js";
import { detectContractTypes, detectSeniority, detectWorkModels } from "./sets.js";
import { detectStack, type MentionDetail, type TextLanguage } from "./stack.js";
import { fold, splitLines, tokens } from "./text-tools.js";

export const PREFILTER_SPIKE_VERSION = "pf-s4";

const normalizer = new JobTextNormalizer({
  hasher: { sha256Hex: (text) => createHash("sha256").update(text, "utf8").digest("hex") },
  truncateCodePoints,
});

const STOPWORDS: Readonly<Record<TextLanguage, readonly string[]>> = {
  pt: ["de", "voce", "com", "para", "uma", "experiencia", "nao", "nosso", "nossa", "vaga"],
  en: ["the", "and", "you", "with", "our", "experience", "will", "for", "are", "we"],
  es: ["el", "los", "las", "con", "experiencia", "para", "una", "nuestro", "usted", "y"],
};

export function guessLanguage(foldedText: string): TextLanguage {
  const counts = new Map<string, number>();
  for (const t of tokens(foldedText)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const score = (lang: TextLanguage): number => STOPWORDS[lang].reduce((n, w) => n + (counts.get(w) ?? 0), 0);
  const ranked = (["pt", "en", "es"] as const).map((l) => [l, score(l)] as const).sort((x, y) => y[1] - x[1]);
  return ranked[0]?.[0] ?? "pt";
}

export interface PreFilterOutput {
  /** A forma da porta (ADR-011 D1): o que o FactResolver e o roteamento consomem. */
  readonly signals: DeterministicSignals;
  /** Dados extras do protótipo, para medir e para propor emendas. Nunca contêm texto da vaga. */
  readonly extended: {
    readonly language: TextLanguage;
    readonly mentionDetails: readonly MentionDetail[];
    readonly salary: SalaryResult;
    readonly injection: InjectionResult;
    readonly normalizer: JobTextSignals;
    readonly workModelNegated: boolean;
  };
}

export function runPreFilter(rawText: string, titleHint: string | null, options: InjectionOptions): PreFilterOutput {
  const normalized = normalizer.normalize(rawText);
  const folded = fold(normalized.text);
  const lines = splitLines(folded.text);
  const contexts = classifyLines(lines);
  const language = guessLanguage(folded.text);
  const stack = detectStack(folded, lines, contexts, language);
  const workModels = detectWorkModels(folded.text, lines, contexts);
  const title = titleHint === null ? null : fold(normalizer.normalizeTitle(titleHint).text).text;
  const salary = detectSalary(lines);
  const injection = scoreInjection(folded.text, lines, rawText, normalized.signals, options);
  return {
    signals: {
      workModels: workModels.signal,
      contractTypes: detectContractTypes(folded.text, lines),
      seniorityLevels: detectSeniority(title, folded.text),
      salary: salary.signal,
      stackMentions: stack.mentions,
      injectionLevel: injection.level,
    },
    extended: {
      language,
      mentionDetails: stack.details,
      salary,
      injection,
      normalizer: normalized.signals,
      workModelNegated: workModels.negatedMention,
    },
  };
}
