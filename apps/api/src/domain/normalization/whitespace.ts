// Fins de linha e espaços (ADR-001 §5.2, item 3; ADR-005 D4, etapas 3 e 6).

/**
 * Converte os fins de linha para `\n` e o TAB para espaço ANTES da remoção de controles: sem isso,
 * "a\rb" e "React\tNode" grudariam palavras, e U+2028 (fim de linha para o `^` do JavaScript)
 * esconderia um marcador de papel no início de uma "linha".
 */
export function canonicalizeLineBreaks(text: string): string {
  return text.replace(/\r\n?|[\v\f\u0085\u2028\u2029]/gu, "\n").replace(/\t/gu, " ");
}

/**
 * Colapsa os espaços, apara as linhas, deixa no máximo 2 quebras seguidas e apara as pontas.
 * `singleLine` (titleHint) troca as quebras por espaço.
 */
export function collapseWhitespace(text: string, singleLine: boolean): string {
  const lines = singleLine ? text.replace(/\n/gu, " ") : text;
  return lines
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ ?\n ?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
