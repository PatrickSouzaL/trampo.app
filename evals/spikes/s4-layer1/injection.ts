// S-4: InjectionHeuristics (ADR-001 §5.3; threat-model T1, T2 e H10). Padrões que SE DIRIGEM ao modelo,
// e não o assunto "prompt injection": uma vaga de AppSec que cita a técnica não pode virar `alta`.
import type { InjectionLevel, JobTextSignals } from "../../../apps/api/src/domain/index.js";
import { findAll, type Line } from "./text-tools.js";

/** Família A: vocativo ao leitor-máquina. */
const ADDRESSEE = [
  "se voce e uma ia", "se voce for uma ia", "se voce e um modelo", "se voce for um modelo", "se voce e um assistente",
  "caso voce seja uma ia", "caso voce seja um modelo", "if you are an ai", "if you are a language model",
  "if you're an ai", "if you are an llm", "if you are a bot", "assistente de ia que", "modelo de linguagem que",
  "instrucao para o modelo", "instrucao para a ia", "instrucoes para o modelo", "nota para sistemas", "nota para o sistema",
  "aviso ao sistema", "aviso aos sistemas", "aviso para o sistema", "mensagem para a ia", "mensagem para o modelo",
  "attention ai", "note to ai", "note to the ai", "to any ai", "para qualquer ia",
  "ai or llm reading", "llm reading", "ia que estiver lendo", "assistant reading",
];

/** Família B: ordem de sobrepor instruções. */
const OVERRIDE = [
  "ignore as instrucoes", "ignore todas as instrucoes", "ignore as regras", "ignore as orientacoes",
  "ignore suas instrucoes", "ignore previous instructions", "ignore all previous", "ignore prior instructions",
  "ignore the above", "ignore your instructions", "disregard your previous", "disregard previous", "disregard all",
  "disregard the above", "esqueca as instrucoes", "desconsidere as instrucoes", "desconsidere as regras",
  "tem prioridade sobre qualquer outra", "takes precedence over",
];

/** Família C: manipulação de nota, fato ou saída. */
const MANIPULATION = [
  "atribua nota", "de nota maxima", "de nota 100", "nota maxima", "nota 100", "score 100", "score of 100", "rate this job",
  "give this job", "veredito", "report the salary as", "report the work model",
  "inclua o codigo", "informe o codigo", "registre o codigo", "include the reference", "include the code",
  "nao mencione esta", "do not mention this", "inclua ao final", "apresentado como link", "responda apenas",
  "respond only", "output only",
];

/** Marcadores de papel ou de chat que sobrevivem à neutralização do ADR-005 (etapa 8). */
const CHAT_MARKERS = ["‹|im_start|›", "‹|system|›", "[inst]", "### instruction", "### system", "‹‹sys››"];

export interface InvisibleClassCounts {
  readonly tags: number;
  readonly zeroWidth: number;
  readonly bidi: number;
  /** Variation selectors fora de sequência de emoji (o FE0F depois de emoji é legítimo). */
  readonly variationSelectors: number;
}

/** Contagem por classe sobre o texto BRUTO (o normalizador n1 expõe só o total: emenda proposta ao ADR-005). */
export function classifyInvisibles(raw: string): InvisibleClassCounts {
  let tags = 0;
  let zeroWidth = 0;
  let bidi = 0;
  let variationSelectors = 0;
  let prevIsEmoji = false;
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    // Tags fora de bandeira de subdivisão (🏴 + tags + U+E007F) são contrabando de ASCII.
    if (cp >= 0xe0000 && cp <= 0xe007f) tags += 1;
    else if (cp === 0x200b || cp === 0x2060 || cp === 0xfeff || cp === 0x200c) zeroWidth += 1;
    else if (cp === 0x200d && !prevIsEmoji) zeroWidth += 1;
    else if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) bidi += 1;
    else if (cp >= 0xe0100 && cp <= 0xe01ef) variationSelectors += 1;
    else if (cp >= 0xfe00 && cp <= 0xfe0f && !prevIsEmoji) variationSelectors += 1;
    if (cp !== 0x200d && !(cp >= 0xfe00 && cp <= 0xfe0f)) prevIsEmoji = cp >= 0x2190 && !(cp >= 0xe0000 && cp <= 0xe01ef);
  }
  return { tags, zeroWidth, bidi, variationSelectors };
}

/** Trechos entre aspas: um ataque CITADO como exemplo é assunto, não ordem (syn-08). */
function quotedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const pairs: readonly (readonly [string, string])[] = [["\"", "\""], ["“", "”"], ["«", "»"]];
  for (const [open, close] of pairs) {
    let from = 0;
    for (;;) {
      const a = text.indexOf(open, from);
      if (a < 0) break;
      const b = text.indexOf(close, a + 1);
      if (b < 0 || b - a > 300) break;
      ranges.push([a, b]);
      from = b + 1;
    }
  }
  return ranges;
}

export interface InjectionResult {
  readonly level: InjectionLevel;
  readonly score: number;
  readonly families: { readonly addressee: number; readonly override: number; readonly manipulation: number; readonly quoted: number; readonly chat: number };
  readonly hidden: InvisibleClassCounts;
}

export interface InjectionOptions {
  /** true: usa as classes de invisíveis (emenda proposta); false: só o total do normalizador n1. */
  readonly useInvisibleClasses: boolean;
}

/**
 * Pontuação: alta se duas famílias diferentes aparecem no MESMO parágrafo fora de aspas, se há marcador
 * de chat, ou se há contrabando invisível forte; média se há um sinal isolado; baixa caso contrário.
 */
export function scoreInjection(
  folded: string,
  lines: readonly Line[],
  raw: string,
  normalizer: JobTextSignals,
  options: InjectionOptions,
): InjectionResult {
  const quoted = quotedRanges(folded);
  const inQuote = (pos: number): boolean => quoted.some(([a, b]) => pos > a && pos < b);
  let quotedHits = 0;
  const paragraphOf = (pos: number): number => {
    let p = 0;
    for (const l of lines) {
      if (l.start > pos) break;
      if (l.text.trim().length === 0) p += 1;
    }
    return p;
  };
  const familyHits = (patterns: readonly string[]): number[] => {
    const paragraphs: number[] = [];
    for (const pattern of patterns) {
      for (const pos of findAll(folded, pattern)) {
        if (inQuote(pos)) quotedHits += 1;
        else paragraphs.push(paragraphOf(pos));
      }
    }
    return paragraphs;
  };
  const a = familyHits(ADDRESSEE);
  const o = familyHits(OVERRIDE);
  const m = familyHits(MANIPULATION);
  const chat = CHAT_MARKERS.reduce((n, marker) => n + findAll(folded, marker).length, 0);

  const coOccur = (x: readonly number[], y: readonly number[]): boolean => x.some((p) => y.includes(p));
  const visibleAlta = coOccur(a, o) || coOccur(a, m) || coOccur(o, m) || chat > 0;
  const visibleSingle = a.length + o.length + m.length > 0 || quotedHits > 0;

  const hidden = classifyInvisibles(raw);
  let hiddenAlta: boolean;
  let hiddenMedia: boolean;
  if (options.useInvisibleClasses) {
    hiddenAlta = hidden.tags >= 4 || hidden.variationSelectors >= 8 || hidden.zeroWidth >= 20 || hidden.bidi >= 2;
    hiddenMedia = hidden.tags + hidden.variationSelectors + hidden.zeroWidth + hidden.bidi > 0;
  } else {
    hiddenAlta = normalizer.removedInvisibleCount >= 50;
    hiddenMedia = normalizer.removedInvisibleCount >= 10;
  }
  const structural = !normalizer.fixedPointReached || normalizer.suspiciousNfkcExpansion;
  const roleMarkers = normalizer.neutralizedDelimiterCount > 0;

  const score =
    (visibleAlta ? 6 : 0) + (visibleSingle ? 2 : 0) + (hiddenAlta ? 6 : 0) + (hiddenMedia ? 1 : 0) + (structural ? 6 : 0) + (roleMarkers ? 1 : 0);
  const level: InjectionLevel = visibleAlta || hiddenAlta || structural ? "alta" : score >= 2 ? "media" : "baixa";
  return {
    level,
    score,
    families: { addressee: a.length, override: o.length, manipulation: m.length, quoted: quotedHits, chat },
    hidden,
  };
}
