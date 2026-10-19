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

/** Remove os invisíveis e conta quantos code points saíram (sinal de injection para a Camada 1). */
export function removeInvisibleCharacters(text: string): { readonly text: string; readonly removed: number } {
  let removed = 0;
  const cleaned = text.replace(INVISIBLE_OR_CONTROL, () => {
    removed += 1;
    return "";
  });
  return { text: cleaned, removed };
}
