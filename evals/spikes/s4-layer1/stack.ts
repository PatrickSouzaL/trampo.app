// S-4: menções de stack (ADR-001 §5.3): dicionário com aliases, janela de negação, contexto de
// diferencial e termos ambíguos. Sobre o texto dobrado; sem regex de backtracking (SR-09).
import type { SignalStrength } from "../../../apps/api/src/domain/index.js";
import type { LineContext, MentionContext } from "./sections.js";
import { dictionaryAliases, type DictionaryAlias } from "./tech-dictionary.js";
import { findAll, lineAt, tokens, type FoldedText, type Line } from "./text-tools.js";

export type TextLanguage = "pt" | "en" | "es";

const NEGATORS: Readonly<Record<TextLanguage, readonly string[]>> = {
  // "no" em português é preposição ("experiência no React"): só vale em en e es.
  pt: ["nao", "sem", "nenhum", "nenhuma", "dispensa", "dispensamos", "nem", "deixamos", "deixou", "deixaram", "abandonamos", "jamais"],
  en: ["not", "no", "without", "never", "dont", "don", "isn", "aren"],
  es: ["no", "sin", "ningun", "ninguna", "ni"],
};

/** Negação depois do termo ("PHP não é necessário"). */
const POST_NEGATIONS = [
  "nao e necessario", "nao e obrigatorio", "nao e requisito", "nao e preciso", "nao sera necessario",
  "is not required", "not required", "is not needed", "no es necesario", "no es requisito",
];

export const NEGATION_WINDOW = 4;
const SENTENCE_BREAKS = [".", ";", ":", "!", "?", "(", ")"];

export interface MentionDetail {
  readonly canonical: string;
  readonly context: MentionContext;
  readonly negated: boolean;
  readonly ambiguousUnqualified: boolean;
  readonly mixedScript: boolean;
  readonly strength: SignalStrength;
}

export interface StackResult {
  readonly mentions: readonly { term: string; strength: SignalStrength }[];
  readonly details: readonly MentionDetail[];
}

const ALIASES: readonly DictionaryAlias[] = dictionaryAliases();

function clauseBefore(line: Line, posInText: number): string {
  let s = line.text.slice(0, posInText - line.start);
  for (const b of SENTENCE_BREAKS) {
    const i = s.lastIndexOf(b);
    // "Node.js" e "C#": o ponto colado em letra não quebra a frase.
    if (i >= 0 && (b !== "." || s.charAt(i + 1) === " " || i === s.length - 1)) s = s.slice(i + 1);
  }
  return s;
}

function isNegated(lang: TextLanguage, line: Line, pos: number, len: number): boolean {
  const before = tokens(clauseBefore(line, pos)).slice(-NEGATION_WINDOW);
  const negators = NEGATORS[lang];
  if (before.some((t) => negators.includes(t))) return true;
  // Até um sinal de pontuação entre o termo e a negação ("PHP: não é necessário").
  const after = line.text.slice(pos - line.start + len, pos - line.start + len + 40).replace(/^[\s:,-]+/u, "");
  return POST_NEGATIONS.some((p) => after.startsWith(p));
}

function isQualified(alias: DictionaryAlias, line: Line, pos: number): boolean {
  const spec = alias.ambiguous;
  if (spec === null) return true;
  if (spec.lineCues.some((c) => line.text.includes(c))) return true;
  return spec.phrases.some((phrase) => {
    const offset = phrase.indexOf(spec.alias);
    if (offset < 0) return false;
    return findAll(line.text, phrase).some((i) => line.start + i + offset === pos);
  });
}

export function detectStack(
  folded: FoldedText,
  lines: readonly Line[],
  contexts: readonly LineContext[],
  lang: TextLanguage,
): StackResult {
  const covered: boolean[] = [];
  const details: MentionDetail[] = [];
  for (const alias of ALIASES) {
    for (const pos of findAll(folded.text, alias.alias)) {
      let overlap = false;
      for (let k = pos; k < pos + alias.alias.length; k += 1) if (covered[k] === true) overlap = true;
      if (overlap) continue;
      for (let k = pos; k < pos + alias.alias.length; k += 1) covered[k] = true;
      const line = lineAt(lines, pos);
      const ctx = contexts[line.index];
      const context: MentionContext = ctx === undefined ? "desconhecido" : ctx.context;
      const negated = isNegated(lang, line, pos, alias.alias.length);
      const ambiguousUnqualified = !isQualified(alias, line, pos);
      let mixedScript = false;
      for (let k = pos; k < pos + alias.alias.length; k += 1) if (folded.confusableAt.has(k)) mixedScript = true;
      const explicit =
        !negated && !ambiguousUnqualified && !mixedScript && (context === "exigida" || context === "desconhecido");
      details.push({
        canonical: alias.canonical,
        context,
        negated,
        ambiguousUnqualified,
        mixedScript,
        strength: explicit ? "explicita" : "fraca",
      });
    }
  }
  const byTerm = new Map<string, SignalStrength>();
  for (const d of details) {
    if (byTerm.get(d.canonical) !== "explicita") byTerm.set(d.canonical, d.strength);
  }
  const mentions = [...byTerm.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([term, strength]) => ({ term, strength }));
  return { mentions, details };
}
