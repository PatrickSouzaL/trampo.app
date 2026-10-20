// S-4 (protótipo descartável): ferramentas de texto da Camada 1. Nenhuma regex aqui tem quantificador
// aninhado nem alternância ambígua (SR-09): o casamento de termos é por indexOf com fronteira.

/** Confundíveis latinos (T15, mitigação 3): cirílico e grego que se passam por letra latina. */
const CONFUSABLES: ReadonlyMap<string, string> = new Map([
  ["а", "a"], ["в", "b"], ["е", "e"], ["к", "k"], ["м", "m"], ["н", "h"], ["о", "o"], ["р", "p"],
  ["с", "c"], ["т", "t"], ["у", "y"], ["х", "x"], ["і", "i"], ["ј", "j"], ["ѕ", "s"], ["һ", "h"],
  ["α", "a"], ["β", "b"], ["ε", "e"], ["ι", "i"], ["κ", "k"], ["ν", "v"], ["ο", "o"], ["ρ", "p"],
  ["τ", "t"], ["υ", "u"], ["χ", "x"],
]);

const COMBINING_MARKS = /\p{M}/gu;

export interface FoldedText {
  /** Minúsculas, sem diacríticos e com confundíveis dobrados. */
  readonly text: string;
  /** Posições (no `text`) que vieram de um confundível: servem ao sinal de mistura de scripts. */
  readonly confusableAt: ReadonlySet<number>;
}

/** Dobra para comparação: minúsculas, sem acento, confundíveis → latim (T15, mitigação 3). */
export function fold(input: string): FoldedText {
  const base = input.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
  let text = "";
  const confusableAt = new Set<number>();
  for (const ch of base) {
    const mapped = CONFUSABLES.get(ch);
    if (mapped === undefined) {
      text += ch;
    } else {
      confusableAt.add(text.length);
      text += mapped;
    }
  }
  return { text, confusableAt };
}

export function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c > 0x7f;
}

/** Todas as ocorrências de `needle` em `hay` com fronteira de palavra nas duas pontas. */
export function findAll(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  const needWordStart = isWordChar(needle[0]);
  const needWordEnd = isWordChar(needle[needle.length - 1]);
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    const before = hay.charAt(i - 1);
    const after = hay.charAt(i + needle.length);
    const okStart = !needWordStart || !isWordChar(before);
    // "node.js." no fim da frase: o ponto final não cola na palavra seguinte.
    const okEnd = !needWordEnd || !isWordChar(after);
    if (okStart && okEnd) out.push(i);
    from = i + 1;
  }
  return out;
}

export function containsAny(hay: string, needles: readonly string[]): boolean {
  return needles.some((n) => findAll(hay, n).length > 0);
}

const TOKEN = /[\p{L}\p{N}]+/gu;

/** Tokens de uma janela de texto (para a janela de negação). */
export function tokens(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

export interface Line {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly index: number;
}

export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let index = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl;
    lines.push({ text: text.slice(start, end), start, end, index });
    index += 1;
    if (nl < 0) break;
    start = nl + 1;
  }
  return lines;
}

export function lineAt(lines: readonly Line[], pos: number): Line {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const line = lines[mid];
    if (line !== undefined && line.start <= pos) lo = mid;
    else hi = mid - 1;
  }
  const found = lines[lo];
  if (found === undefined) throw new RangeError("texto sem linhas");
  return found;
}
