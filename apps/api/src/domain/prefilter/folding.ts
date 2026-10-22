// Dobra e casamento da Camada 1 (ADR-016 D2). A dobra é só para comparar: o texto que vai ao LLM nunca é
// dobrado (ADR-005 D4). Nenhuma regex aqui tem quantificador aninhado ou alternância (SR-09): o casamento
// de termos é por indexOf com fronteira de palavra.

/** Confundíveis latinos (T15, mitigação 3): cirílico e grego minúsculos que se passam por letra latina. */
const CONFUSABLES: ReadonlyMap<string, string> = new Map([
  ["а", "a"], ["в", "b"], ["е", "e"], ["к", "k"], ["м", "m"], ["н", "h"], ["о", "o"], ["р", "p"],
  ["с", "c"], ["т", "t"], ["у", "y"], ["х", "x"], ["і", "i"], ["ј", "j"], ["ѕ", "s"], ["һ", "h"],
  ["α", "a"], ["β", "b"], ["ε", "e"], ["ι", "i"], ["κ", "k"], ["ν", "v"], ["ο", "o"], ["ρ", "p"],
  ["τ", "t"], ["υ", "u"], ["χ", "x"],
]);

const COMBINING_MARKS = /\p{M}/gu;
const TOKEN = /[\p{L}\p{N}]+/gu;

export interface FoldedText {
  /** Minúsculas, sem diacríticos e com confundíveis dobrados. */
  readonly text: string;
  /** Posições (no `text`) que vieram de um confundível: o sinal de mistura de scripts (T15, mitigação 4). */
  readonly confusableAt: ReadonlySet<number>;
}

/** Minúsculas, sem acento e com confundíveis → latim. */
export function fold(input: string): FoldedText {
  const base = input.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
  const parts: string[] = [];
  const confusableAt = new Set<number>();
  let length = 0;
  for (const ch of base) {
    const mapped = CONFUSABLES.get(ch);
    if (mapped !== undefined) confusableAt.add(length);
    const out = mapped ?? ch;
    parts.push(out);
    length += out.length;
  }
  return { text: parts.join(""), confusableAt };
}

const NON_ASCII_WORD = /[\p{L}\p{N}]/u;

/**
 * Letra ou dígito (o texto já está dobrado: ASCII em minúsculas). Pontuação não ASCII NÃO é palavra: no S-4,
 * qualquer não ASCII contava como letra, e um ataque colado em aspas curvas ou em "‹" (o "<" neutralizado)
 * escapava do detector ("‹ignore as instruções›"). `""` (fora do texto) não é palavra.
 */
export function isWordChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if (c <= 0x7f) return (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
  return NON_ASCII_WORD.test(ch);
}

/**
 * A próxima ocorrência de `needle` a partir de `from`, com fronteira de palavra nas pontas que são letra ou
 * dígito, ou -1. Agulha vazia faria o indexOf girar para sempre: falha fechado (nenhuma ocorrência).
 */
function nextMatch(hay: string, needle: string, from: number): number {
  if (needle.length === 0) return -1;
  const needWordStart = isWordChar(needle.charAt(0));
  const needWordEnd = isWordChar(needle.charAt(needle.length - 1));
  for (let i = hay.indexOf(needle, from); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const okStart = !needWordStart || !isWordChar(hay.charAt(i - 1));
    if (okStart && (!needWordEnd || !isWordChar(hay.charAt(i + needle.length)))) return i;
  }
  return -1;
}

/** Todas as ocorrências de `needle` com fronteira de palavra. */
export function findAll(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = nextMatch(hay, needle, 0); i >= 0; i = nextMatch(hay, needle, i + 1)) out.push(i);
  return out;
}

/** Alguma agulha ocorre com fronteira (para na primeira, sem alocar lista: SR-09 em textos com muitas linhas). */
export function containsAny(hay: string, needles: readonly string[]): boolean {
  for (const needle of needles) if (nextMatch(hay, needle, 0) >= 0) return true;
  return false;
}

/** Tokens (letras e dígitos) de uma janela curta de texto. */
export function tokens(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** Janela de busca antes e depois de uma ocorrência (ADR-016 D2): o custo por ocorrência é constante. */
export const LOOK_AROUND_CHARS = 80;

export interface Line {
  readonly text: string;
  readonly start: number;
  readonly index: number;
}

export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl;
    lines.push({ text: text.slice(start, end), start, index: lines.length });
    if (nl < 0) return lines;
    start = nl + 1;
  }
}

/** Item de um array que o chamador garante existir; se não existir, falha fechado. */
export function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError("Índice fora do intervalo na Camada 1.");
  return item;
}

/** A linha que contém a posição `pos` (busca binária; `lines` vem de `splitLines`). */
export function lineAt(lines: readonly Line[], pos: number): Line {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (itemAt(lines, mid).start <= pos) lo = mid;
    else hi = mid - 1;
  }
  return itemAt(lines, lo);
}

/**
 * Até LOOK_AROUND_CHARS caracteres da linha antes da posição absoluta `pos`. Se a janela cortou uma palavra
 * no começo, o pedaço sai: "canao" cortado não pode virar o negador "nao".
 */
export function textBefore(line: Line, pos: number): string {
  const rel = pos - line.start;
  let from = Math.max(0, rel - LOOK_AROUND_CHARS);
  if (from > 0) while (from < rel && isWordChar(line.text.charAt(from - 1)) && isWordChar(line.text.charAt(from))) from += 1;
  return line.text.slice(from, rel);
}

/** Até LOOK_AROUND_CHARS caracteres da linha a partir da posição absoluta `pos`. */
export function textAfter(line: Line, pos: number): string {
  const rel = pos - line.start;
  return line.text.slice(rel, rel + LOOK_AROUND_CHARS);
}

/** Memo por linha: cada pista é calculada uma vez por linha, não uma vez por ocorrência (SR-09). */
export function perLine(predicate: (text: string) => boolean): (line: Line) => boolean {
  const cache = new Map<number, boolean>();
  return (line) => {
    const hit = cache.get(line.index);
    if (hit !== undefined) return hit;
    const value = predicate(line.text);
    cache.set(line.index, value);
    return value;
  };
}
