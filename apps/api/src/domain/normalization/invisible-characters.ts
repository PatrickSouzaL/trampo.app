// Remoção de code points invisíveis e de controle (ADR-001 §5.2, item 2; threat-model T2 e T15).
//
// Cópia de INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE de @trampo/contracts/primitives. Aquele módulo importa zod
// e não pode rodar no domínio (ADR-005 D3). Um teste exaustivo compara os dois conjuntos code point a
// code point (U+0000 a U+10FFFF): se o contrato mudar, o teste quebra.
export const INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE_SOURCE =
  "[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u200B-\\u200F" +
  "\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFB" +
  "\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]";

const INVISIBLE_OR_CONTROL = new RegExp(INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE_SOURCE, "gu");

/** Invisíveis por classe (ADR-016 D8, emenda ao ADR-005): o total sozinho confunde emoji com contrabando. */
export interface InvisibleClassCounts {
  /** Tag characters (U+E0000–U+E007F) fora de bandeira de subdivisão: "ASCII smuggling". */
  readonly tags: number;
  /** U+200B, U+200C, U+2060, U+FEFF e o ZWJ que não vem depois de emoji. */
  readonly zeroWidth: number;
  /** Embeddings, overrides e isolates (U+202A–U+202E, U+2066–U+2069): Trojan Source. */
  readonly bidi: number;
  /** U+E0100–U+E01EF e U+FE00–U+FE0F que não vêm depois de emoji (o FE0F do emoji é legítimo). */
  readonly variationSelectors: number;
}

export interface InvisibleRemoval {
  readonly text: string;
  /** Total de code points removidos (sinal de injection para a Camada 1). */
  readonly removed: number;
  readonly classes: InvisibleClassCounts;
}

const BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
const ZWJ = 0x200d;

const isVs16Range = (cp: number): boolean => cp >= 0xfe00 && cp <= 0xfe0f;
const isTagSpec = (cp: number): boolean => (cp >= 0xe0030 && cp <= 0xe0039) || (cp >= 0xe0061 && cp <= 0xe007a);
/** Base de emoji, para o FE0F e o ZWJ seguintes (heurística do S-4): a partir de U+2190, fora de Tags e seletores. */
const isEmojiContext = (cp: number): boolean => cp >= 0x2190 && !(cp >= 0xe0000 && cp <= 0xe01ef);

/**
 * Comprimento em code units da bandeira de subdivisão que começa em `index` (🏴 + 2 a 6 tags [a-z0-9] +
 * U+E007F, como 🏴󠁧󠁢󠁥󠁮󠁧󠁿), ou 0. A busca olha no máximo 8 code points à frente: custo constante.
 */
function subdivisionFlagLength(text: string, index: number): number {
  let cursor = index + 2;
  let specs = 0;
  while (specs < 7) {
    const cp = text.codePointAt(cursor);
    if (cp === CANCEL_TAG) return specs >= 2 ? cursor + 2 - index : 0;
    if (cp === undefined || !isTagSpec(cp)) return 0;
    specs += 1;
    cursor += 2;
  }
  return 0;
}

/** O code point que termina logo antes de `offset` (o texto é bem formado: `toWellFormed` no início). */
function codePointBefore(text: string, offset: number): number {
  const pair = text.codePointAt(offset - 2);
  return pair !== undefined && pair > 0xffff ? pair : text.charCodeAt(offset - 1);
}

/**
 * Remove os invisíveis, conta o total e conta por classe (ADR-016 D8). A contagem acontece no callback da
 * remoção: o custo é proporcional ao número de invisíveis, sem uma segunda passada sobre o texto (que, depois
 * do NFKC, pode ter 18× o tamanho da entrada). O texto de saída é o mesmo de antes: o normalizador continua `n1`.
 */
export function removeInvisibleCharacters(text: string): InvisibleRemoval {
  let removed = 0;
  let tags = 0;
  let zeroWidth = 0;
  let bidi = 0;
  let variationSelectors = 0;
  let previousEnd = 0;
  let afterEmoji = false;
  let flagEnd = -1;
  const cleaned = text.replace(INVISIBLE_OR_CONTROL, (match: string, offset: number) => {
    removed += 1;
    if (offset > previousEnd) {
      // Há texto visível antes: o contexto de emoji vem do último code point visível.
      const before = codePointBefore(text, offset);
      afterEmoji = isEmojiContext(before);
      const flag = before === BLACK_FLAG ? subdivisionFlagLength(text, offset - 2) : 0;
      flagEnd = flag > 0 ? offset - 2 + flag : -1;
    }
    previousEnd = offset + match.length;
    const cp = match.codePointAt(0) as number;
    if (offset < flagEnd) {
      // Tag da bandeira de subdivisão (inclui o terminador): legítima, e o que vem depois é emoji.
      afterEmoji = true;
      return "";
    }
    if (cp >= 0xe0000 && cp <= 0xe007f) tags += 1;
    else if (cp === 0x200b || cp === 0x200c || cp === 0x2060 || cp === 0xfeff || (cp === ZWJ && !afterEmoji)) zeroWidth += 1;
    else if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) bidi += 1;
    else if ((cp >= 0xe0100 && cp <= 0xe01ef) || (isVs16Range(cp) && !afterEmoji)) variationSelectors += 1;
    // ZWJ e FE0x não quebram a sequência de emoji; o resto decide se o próximo vem "depois de emoji".
    if (cp !== ZWJ && !isVs16Range(cp)) afterEmoji = isEmojiContext(cp);
    return "";
  });
  return { text: cleaned, removed, classes: { tags, zeroWidth, bidi, variationSelectors } };
}

/** Só a contagem por classe (para os testes e para quem não precisa do texto). */
export function countInvisibleClasses(text: string): InvisibleClassCounts {
  return removeInvisibleCharacters(text).classes;
}
