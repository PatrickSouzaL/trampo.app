// A cópia do conjunto de invisíveis no domínio é idêntica à do contrato (ADR-005 D3): prova exaustiva.
import { INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE } from "@trampo/contracts/primitives";
import { describe, expect, test } from "vitest";

import {
  INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE_SOURCE,
  removeInvisibleCharacters,
} from "../../src/domain/normalization/invisible-characters.js";

describe("conjunto de invisíveis do domínio", () => {
  test("casa exatamente os mesmos code points do contrato, de U+0000 a U+10FFFF", () => {
    const domain = new RegExp(INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE_SOURCE, "u");
    const divergent: number[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      const char = String.fromCodePoint(codePoint);
      if (domain.test(char) !== INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE.test(char)) divergent.push(codePoint);
    }
    expect(divergent).toEqual([]);
  });

  test("remove e conta; preserva \\n", () => {
    expect(removeInvisibleCharacters("a\u200B\n\u{E0041}b\u202E")).toEqual({ text: "a\nb", removed: 3 });
  });
});
