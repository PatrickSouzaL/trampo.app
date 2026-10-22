// InjectionHeuristics (ADR-001 §5.3; ADR-016 D7; threat-model T1, T2 e H10). Padrões que SE DIRIGEM ao
// modelo, e não o assunto "prompt injection": uma vaga de AppSec que cita a técnica não pode virar `alta`.
// Custo linear (SR-09): parágrafo por linha pré-calculado e trecho citado por busca binária.
import type { InjectionLevel } from "../ports/deterministic-signals.js";
import type { JobTextSignals } from "../normalization/job-text-normalizer.js";
import { findAll, itemAt, lineAt, type Line } from "./folding.js";

/** Família A: vocativo ao leitor-máquina. */
const ADDRESSEE: readonly string[] = [
  "se voce e uma ia", "se voce for uma ia", "se voce e um modelo", "se voce for um modelo", "se voce e um assistente",
  "caso voce seja uma ia", "caso voce seja um modelo", "if you are an ai", "if you are a language model",
  "if you're an ai", "if you are an llm", "if you are a bot", "assistente de ia que", "modelo de linguagem que",
  "instrucao para o modelo", "instrucao para a ia", "instrucoes para o modelo", "nota para sistemas", "nota para o sistema",
  "aviso ao sistema", "aviso aos sistemas", "aviso para o sistema", "mensagem para a ia", "mensagem para o modelo",
  "attention ai", "note to ai", "note to the ai", "to any ai", "para qualquer ia",
  "ai or llm reading", "llm reading", "ia que estiver lendo", "assistant reading",
];

/** Família B: ordem de sobrepor instruções. */
const OVERRIDE: readonly string[] = [
  "ignore as instrucoes", "ignore todas as instrucoes", "ignore as regras", "ignore as orientacoes",
  "ignore suas instrucoes", "ignore previous instructions", "ignore all previous", "ignore prior instructions",
  "ignore the above", "ignore your instructions", "disregard your previous", "disregard previous", "disregard all",
  "disregard the above", "esqueca as instrucoes", "desconsidere as instrucoes", "desconsidere as regras",
  "tem prioridade sobre qualquer outra", "takes precedence over",
];

/** Família C: manipulação de nota, de fato ou da saída. */
const MANIPULATION: readonly string[] = [
  "atribua nota", "de nota maxima", "de nota 100", "nota maxima", "nota 100", "score 100", "score of 100", "rate this job",
  "give this job", "veredito", "report the salary as", "report the work model",
  "inclua o codigo", "informe o codigo", "registre o codigo", "include the reference", "include the code",
  "nao mencione esta", "do not mention this", "inclua ao final", "apresentado como link", "responda apenas",
  "respond only", "output only",
];

/**
 * Tokens de chat que sobrevivem à neutralização do ADR-005 (`<>` chegam como `‹›`). São específicos o
 * bastante para casar como substring, sem fronteira ("‹|im_start|›system").
 */
const CHAT_TOKENS: readonly string[] = [
  "‹|im_start|›", "‹|im_end|›", "‹|system|›", "‹|user|›", "‹|assistant|›", "‹|endoftext|›", "‹|begin_of_text|›",
  "‹|start_header_id|›", "‹|eot_id|›", "[inst]", "[/inst]", "‹‹sys››", "‹‹/sys››",
];

/**
 * Cabeçalho de papel em markdown só como linha inteira: "### System Design" é título de vaga legítimo.
 * O "system:" no começo de linha já virou "system -" no normalizador (e conta como delimitador).
 */
const ROLE_HEADING_LINES: ReadonlySet<string> = new Set([
  "### instruction", "### instruction -", "### system", "### system -", "### response", "### response -",
]);

/** Pares de aspas: um ataque CITADO como exemplo é assunto, não ordem (syn-08). */
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [["\"", "\""], ["“", "”"], ["«", "»"]];
const MAX_QUOTE_CHARS = 300;

/** Limiares por classe de invisível (S-4 §5.5): contrabando forte. */
const HIDDEN_STRONG = { tags: 4, variationSelectors: 8, zeroWidth: 20, bidi: 2 } as const;
const MEDIA_SCORE = 2;

export type InjectionReason =
  | "familias_no_mesmo_trecho"
  | "marcador_de_chat"
  | "invisiveis_fortes"
  | "estrutural"
  | "sinal_isolado"
  | "invisiveis"
  | "delimitadores";

export interface InjectionAssessment {
  readonly level: InjectionLevel;
  /** Só enums: nenhum trecho da vaga (ADR-016 §3). */
  readonly reasons: readonly InjectionReason[];
}

type Range = readonly [number, number];

/** Trechos citados de um par de aspas, em ordem e sem sobreposição. Aspa sem par, ou longe demais, encerra. */
export function quotedRanges(text: string, open: string, close: string): Range[] {
  const ranges: Range[] = [];
  let from = 0;
  for (;;) {
    const a = text.indexOf(open, from);
    if (a < 0) return ranges;
    const b = text.indexOf(close, a + 1);
    if (b < 0 || b - a > MAX_QUOTE_CHARS) return ranges;
    ranges.push([a, b]);
    from = b + 1;
  }
}

/** Índice do trecho (ordenado) que contém `pos` estritamente por dentro, ou -1. */
function rangeContaining(ranges: readonly Range[], pos: number): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = itemAt(ranges, mid);
    if (pos <= a) hi = mid - 1;
    else if (pos >= b) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Segmento de cada ocorrência: o trecho citado que a contém (por par de aspas, na ordem de QUOTE_PAIRS) ou,
 * fora de aspas, o parágrafo. Duas famílias só somam `alta` no mesmo segmento.
 */
function segmenter(text: string, lines: readonly Line[]): (pos: number) => string {
  const quotes = QUOTE_PAIRS.map(([open, close]) => quotedRanges(text, open, close));
  const paragraph: number[] = [];
  let blank = 0;
  for (const line of lines) {
    if (line.text.trim() === "") blank += 1;
    paragraph.push(blank);
  }
  return (pos) => {
    for (const [pair, ranges] of quotes.entries()) {
      const r = rangeContaining(ranges, pos);
      if (r >= 0) return `q${pair}:${r}`;
    }
    return `p:${itemAt(paragraph, lineAt(lines, pos).index)}`;
  };
}

export function assessInjection(folded: string, lines: readonly Line[], normalizer: JobTextSignals): InjectionAssessment {
  const segmentOf = segmenter(folded, lines);
  const familySegments = (patterns: readonly string[]): Set<string> => {
    const keys = new Set<string>();
    for (const pattern of patterns) for (const pos of findAll(folded, pattern)) keys.add(segmentOf(pos));
    return keys;
  };
  const families = [familySegments(ADDRESSEE), familySegments(OVERRIDE), familySegments(MANIPULATION)];
  const [a, o, m] = families as [Set<string>, Set<string>, Set<string>];
  const meet = (x: ReadonlySet<string>, y: ReadonlySet<string>): boolean => [...x].some((key) => y.has(key));

  const reasons: InjectionReason[] = [];
  if (meet(a, o) || meet(a, m) || meet(o, m)) reasons.push("familias_no_mesmo_trecho");
  const chat = CHAT_TOKENS.some((token) => folded.includes(token)) || lines.some((l) => ROLE_HEADING_LINES.has(l.text.trim()));
  if (chat) reasons.push("marcador_de_chat");
  const hidden = normalizer.removedInvisibleByClass;
  if (
    hidden.tags >= HIDDEN_STRONG.tags ||
    hidden.variationSelectors >= HIDDEN_STRONG.variationSelectors ||
    hidden.zeroWidth >= HIDDEN_STRONG.zeroWidth ||
    hidden.bidi >= HIDDEN_STRONG.bidi
  ) {
    reasons.push("invisiveis_fortes");
  }
  if (!normalizer.fixedPointReached || normalizer.suspiciousNfkcExpansion) reasons.push("estrutural");
  const alta = reasons.length > 0;

  let score = 0;
  // Uma família isolada, citada ou não, só pesa para `media` (o syn-08 cita um ataque como exemplo).
  if (families.some((f) => f.size > 0)) {
    reasons.push("sinal_isolado");
    score += 2;
  }
  if (hidden.tags + hidden.variationSelectors + hidden.zeroWidth + hidden.bidi > 0) {
    reasons.push("invisiveis");
    score += 1;
  }
  if (normalizer.neutralizedDelimiterCount > 0) {
    reasons.push("delimitadores");
    score += 1;
  }
  const level: InjectionLevel = alta ? "alta" : score >= MEDIA_SCORE ? "media" : "baixa";
  return { level, reasons };
}
