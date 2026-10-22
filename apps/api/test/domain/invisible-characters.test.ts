// A cópia do conjunto de invisíveis no domínio é idêntica à do contrato (ADR-005 D3): prova exaustiva.
// E a contagem por classe da emenda do ADR-016 D8.
import { INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE, truncateCodePoints } from "@trampo/contracts/primitives";
import { describe, expect, test } from "vitest";

import { JobTextNormalizer } from "../../src/domain/index.js";
import {
  INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE_SOURCE,
  countInvisibleClasses,
  removeInvisibleCharacters,
} from "../../src/domain/normalization/invisible-characters.js";
import { nodeTextHasher } from "../../src/infrastructure/crypto/node-text-hasher.js";

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
    expect(removeInvisibleCharacters("a​\n\u{E0041}b‮")).toEqual({
      text: "a\nb",
      removed: 3,
      classes: { tags: 1, zeroWidth: 1, bidi: 1, variationSelectors: 0 },
    });
  });
});

// ADR-016 D8 (emenda ao ADR-005): contagem por classe, sem os legítimos de emoji e da bandeira de subdivisão.
const tag = (ascii: string): string => [...ascii].map((c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) as number))).join("");
const ENGLAND = `\u{1F3F4}${tag("gbeng")}\u{E007F}`;
const zero = { tags: 0, zeroWidth: 0, bidi: 0, variationSelectors: 0 };

describe("invisíveis por classe (ADR-016 D8)", () => {
  test.each([
    ["Tags", tag("ignore"), { ...zero, tags: 6 }],
    ["Tag de cancelamento solta", "\u{E007F}", { ...zero, tags: 1 }],
    ["limites da faixa de Tags", "\u{E0000}\u{E007F}", { ...zero, tags: 2 }],
    ["zero-width (200B, 200C, 2060, FEFF)", "a​b‌c⁠d﻿", { ...zero, zeroWidth: 4 }],
    ["ZWJ entre letras", "a‍b", { ...zero, zeroWidth: 1 }],
    ["bidi nas duas faixas", "‪‮⁦⁩", { ...zero, bidi: 4 }],
    ["vizinhos das faixas de bidi", "  ⁥⁪", zero],
    ["variation selector suplementar", "a\u{E0100}\u{E01EF}", { ...zero, variationSelectors: 2 }],
    ["FE00 e FE0F depois de letra", "a︀b️", { ...zero, variationSelectors: 2 }],
    ["vizinhos de FE00–FE0F", "﷿︐", zero],
    ["emoji com FE0F e ZWJ (👩‍💻, ❤️)", "\u{1F469}‍\u{1F4BB} ❤️", zero],
    ["FE0F depois de U+2190 (limite do emoji) e de U+218F", "←️↏️", { ...zero, variationSelectors: 1 }],
    ["Tag não conta como emoji para o FE0F seguinte", `${tag("a")}️`, { ...zero, tags: 1, variationSelectors: 1 }],
    ["seletor suplementar não conta como emoji", "\u{E0100}️", { ...zero, variationSelectors: 2 }],
    ["emoji depois de seletor suplementar volta a valer", "\u{E0100}\u{1F600}️", { ...zero, variationSelectors: 1 }],
    ["texto comum", "Vaga remota, R$ 8.000", zero],
  ])("%s", (_name, text, expected) => {
    expect(countInvisibleClasses(text)).toEqual(expected);
  });

  test("bandeira de subdivisão (🏴 + 2 a 6 tags [a-z0-9] + U+E007F) não é contrabando, e o FE0F depois dela é de emoji", () => {
    expect(countInvisibleClasses(`${ENGLAND}️`)).toEqual(zero);
    expect(countInvisibleClasses(`\u{1F3F4}${tag("us")}\u{E007F}`)).toEqual(zero);
    expect(countInvisibleClasses(`\u{1F3F4}${tag("gb09az")}\u{E007F}`)).toEqual(zero);
    expect(countInvisibleClasses(`${ENGLAND}${ENGLAND}`)).toEqual(zero);
    expect(countInvisibleClasses(`${ENGLAND}${tag("a")}`)).toEqual({ ...zero, tags: 1 });
    expect(countInvisibleClasses(`\u{1F3F4} \u{1F3F4}`)).toEqual(zero);
  });

  test.each([
    ["uma tag só", `\u{1F3F4}${tag("g")}\u{E007F}`, 2],
    ["sete tags", `\u{1F3F4}${tag("gbengxx")}\u{E007F}`, 8],
    ["maiúscula", `\u{1F3F4}${tag("GBENG")}\u{E007F}`, 6],
    ["espaço (U+E0020)", `\u{1F3F4}${tag("gb ng")}\u{E007F}`, 6],
    ["vizinhos de [0-9] e de [a-z]", `\u{1F3F4}${tag("/:")}${tag("`{")}\u{E007F}`, 5],
    ["sem terminador", `\u{1F3F4}${tag("gbeng")}`, 5],
    ["texto acaba no meio", `\u{1F3F4}${tag("gb")}`, 2],
    ["tags depois de outra bandeira", `\u{1F3F3}${tag("gbeng")}\u{E007F}`, 6],
  ])("bandeira malformada conta todas as tags: %s", (_name, text, tags) => {
    expect(countInvisibleClasses(text)).toEqual({ ...zero, tags });
  });

  test("contexto de emoji atravessa invisíveis adjacentes e vem do último visível (inclusive par substituto)", () => {
    expect(countInvisibleClasses("\u{1F600}‍️‍")).toEqual(zero);
    expect(countInvisibleClasses("\u{1F600}​️")).toEqual({ ...zero, zeroWidth: 1, variationSelectors: 1 });
    expect(countInvisibleClasses("\u{1F600}x️")).toEqual({ ...zero, variationSelectors: 1 });
    expect(countInvisibleClasses("️")).toEqual({ ...zero, variationSelectors: 1 });
    expect(countInvisibleClasses("é️❤️")).toEqual({ ...zero, variationSelectors: 1 });
  });

  test("o normalizador expõe as classes somadas nas passadas, e o texto não muda (n1)", () => {
    const normalizer = new JobTextNormalizer({ hasher: nodeTextHasher, truncateCodePoints });
    const out = normalizer.normalize(`Vaga ${tag("hi")} ‮ ​ ${ENGLAND} fim`);
    expect(out.signals.removedInvisibleByClass).toEqual({ tags: 2, zeroWidth: 1, bidi: 1, variationSelectors: 0 });
    expect(out.signals.removedInvisibleCount).toBe(10);
    expect(out.text).toBe("Vaga \u{1F3F4} fim");
  });
});
