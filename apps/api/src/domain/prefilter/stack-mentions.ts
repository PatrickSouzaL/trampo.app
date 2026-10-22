// Menções de stack (ADR-001 §5.3; ADR-016 D6): dicionário com aliases, negação, contexto de diferencial,
// termos ambíguos e mistura de scripts (T15). Sobre o texto dobrado; custo linear (SR-09).
import type { SignalStrength, StackMentionSignal } from "../ports/deterministic-signals.js";
import { findAll, itemAt, lineAt, perLine, textAfter, textBefore, tokens, type FoldedText, type Line } from "./folding.js";
import type { MentionContext } from "./line-context.js";
import { DICTIONARY_ALIASES, type AmbiguousSpec } from "./tech-dictionary.js";

export type TextLanguage = "pt" | "en" | "es";

const NEGATORS: Readonly<Record<TextLanguage, readonly string[]>> = {
  // "no" em português é preposição ("experiência no React"): só vale em en e es.
  pt: ["nao", "sem", "nenhum", "nenhuma", "dispensa", "dispensamos", "nem", "deixamos", "deixou", "deixaram", "abandonamos", "jamais"],
  en: ["not", "no", "without", "never", "dont", "don", "isn", "aren"],
  es: ["no", "sin", "ningun", "ninguna", "ni"],
};

/** Negação logo depois do termo ("PHP não é necessário"), depois de espaço ou de ":", "," e "-". */
const POST_NEGATIONS: readonly string[] = [
  "nao e necessario", "nao e obrigatorio", "nao e requisito", "nao e preciso", "nao sera necessario",
  "is not required", "not required", "is not needed", "no es necesario", "no es requisito",
];

/** Janela de negação: até 4 tokens antes, na mesma oração (ADR-001 §5.3). */
export const NEGATION_WINDOW = 4;
const SENTENCE_BREAKS: readonly string[] = [".", ";", ":", "!", "?", "(", ")"];
const POST_SKIP = " \t:,-";

const STOPWORDS: Readonly<Record<TextLanguage, readonly string[]>> = {
  pt: ["de", "voce", "com", "para", "uma", "experiencia", "nao", "nosso", "nossa", "vaga"],
  en: ["the", "and", "you", "with", "our", "experience", "will", "for", "are", "we"],
  es: ["el", "los", "las", "con", "experiencia", "para", "una", "nuestro", "usted", "y"],
};
const LANGUAGES: readonly TextLanguage[] = ["pt", "en", "es"];

/** Idioma pela contagem de palavras vazias; empate fica com a ordem pt, en, es. */
export function guessLanguage(foldedText: string): TextLanguage {
  const counts = new Map<string, number>();
  for (const t of tokens(foldedText)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const score = (lang: TextLanguage): number => STOPWORDS[lang].reduce((n, w) => n + (counts.get(w) ?? 0), 0);
  let best: TextLanguage = "pt";
  for (const lang of LANGUAGES) if (score(lang) > score(best)) best = lang;
  return best;
}

/** A oração antes do termo, dentro da janela: corta no último sinal de fim de oração. */
export function clauseBefore(before: string): string {
  let clause = before;
  for (const mark of SENTENCE_BREAKS) {
    const i = clause.lastIndexOf(mark);
    // "Node.js" e "ASP.NET": o ponto colado em letra não quebra a oração.
    if (i >= 0 && (mark !== "." || clause.charAt(i + 1) === " " || i === clause.length - 1)) clause = clause.slice(i + 1);
  }
  return clause;
}

function isNegated(lang: TextLanguage, line: Line, pos: number, length: number): boolean {
  const window = tokens(clauseBefore(textBefore(line, pos))).slice(-NEGATION_WINDOW);
  const negators = NEGATORS[lang];
  if (window.some((t) => negators.includes(t))) return true;
  const after = textAfter(line, pos + length);
  let skip = 0;
  while (skip < after.length && POST_SKIP.includes(after.charAt(skip))) skip += 1;
  const rest = after.slice(skip);
  return POST_NEGATIONS.some((p) => rest.startsWith(p));
}

/** Para cada termo ambíguo, as posições (do alias) que caem dentro de uma frase qualificadora. Linear. */
function qualifiedPositions(text: string, spec: AmbiguousSpec): Set<number> {
  const out = new Set<number>();
  for (const phrase of spec.phrases) {
    const offset = phrase.indexOf(spec.alias);
    for (const i of findAll(text, phrase)) out.add(i + offset);
  }
  return out;
}

export interface StackMentionDetail {
  readonly canonical: string;
  readonly context: MentionContext;
  readonly negated: boolean;
  readonly ambiguousUnqualified: boolean;
  readonly mixedScript: boolean;
}

export interface StackDetection {
  /** Um por termo, em ordem alfabética do canônico; `explicita` vence `fraca`. */
  readonly mentions: readonly StackMentionSignal[];
  readonly details: readonly StackMentionDetail[];
}

/** Explícita: não negada, em contexto exigido ou neutro, qualificada se ambígua e sem confundível no termo. */
export function isExplicitMention(d: StackMentionDetail): boolean {
  return !d.negated && !d.ambiguousUnqualified && !d.mixedScript && (d.context === "exigida" || d.context === "desconhecido");
}

export function detectStack(
  folded: FoldedText,
  lines: readonly Line[],
  contexts: readonly MentionContext[],
  lang: TextLanguage,
): StackDetection {
  const covered = new Uint8Array(folded.text.length);
  const details: StackMentionDetail[] = [];
  const qualifiers = new Map<AmbiguousSpec, { positions: Set<number>; cue: (line: Line) => boolean }>();
  for (const entry of DICTIONARY_ALIASES) {
    const { alias, ambiguous } = entry;
    for (const pos of findAll(folded.text, alias)) {
      const end = pos + alias.length;
      // Aliases mais longos vêm antes: um trecho já casado não é casado de novo ("spring boot" e "spring").
      if (covered.subarray(pos, end).includes(1)) continue;
      covered.fill(1, pos, end);
      const line = lineAt(lines, pos);
      let ambiguousUnqualified = false;
      if (ambiguous !== null) {
        let q = qualifiers.get(ambiguous);
        if (q === undefined) {
          const cues = ambiguous.lineCues;
          q = { positions: qualifiedPositions(folded.text, ambiguous), cue: perLine((text) => cues.some((c) => text.includes(c))) };
          qualifiers.set(ambiguous, q);
        }
        ambiguousUnqualified = !q.cue(line) && !q.positions.has(pos);
      }
      let mixedScript = false;
      for (let k = pos; k < end; k += 1) if (folded.confusableAt.has(k)) mixedScript = true;
      details.push({
        canonical: entry.canonical,
        context: itemAt(contexts, line.index),
        negated: isNegated(lang, line, pos, alias.length),
        ambiguousUnqualified,
        mixedScript,
      });
    }
  }
  const byTerm = new Map<string, SignalStrength>();
  for (const d of details) {
    if (byTerm.get(d.canonical) !== "explicita") byTerm.set(d.canonical, isExplicitMention(d) ? "explicita" : "fraca");
  }
  const mentions = [...byTerm.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([term, strength]) => ({ term, strength }));
  return { mentions, details };
}
