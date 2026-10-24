// Gerador do perfil mais pesado do test:db (ADR-021 D10 e §3, critério 9). Roda no `pnpm test`, sem Docker: prova
// que o perfil tem exatamente o teto de 12.288 bytes, que o contrato o aceita e de que alfabeto ele é feito. O
// check de 16 KiB e a compressão (pglz ou lz4, que só procuram repetição) são medidos no banco real, no `test:db`.
import { USER_CRITERIA_MAX_JSON_BYTES, UserCriteriaSchema, userCriteriaJsonBytes } from "@trampo/contracts";
import { describe, expect, test } from "vitest";

import { HEAVIEST_CRITERIA_SEED, IDEOGRAPH_COUNT, IDEOGRAPH_FIRST, heaviestCriteria } from "./db/support/heaviest-criteria.js";

const SEEDS = [HEAVIEST_CRITERIA_SEED, 0, 1, 0xffff_ffff, 0x1234_5678];

/** Todo o texto livre do perfil: tags, cidades e notas. */
function freeText(seed: number): string[] {
  const value = heaviestCriteria(seed);
  return [
    ...value.stack.mustHave,
    ...value.stack.niceToHave,
    ...value.stack.dealBreakers,
    ...(value.location?.acceptedCities ?? []),
    value.notes ?? "",
  ];
}

describe("heaviestCriteria", () => {
  test.each(SEEDS)("semente %d: exatamente 12.288 bytes e válido pelo contrato", (seed) => {
    const value = heaviestCriteria(seed);
    expect(userCriteriaJsonBytes(value)).toBe(USER_CRITERIA_MAX_JSON_BYTES);
    expect(UserCriteriaSchema.parse(value)).toEqual(value);
  });

  test("é determinístico pela semente, e a semente muda o texto", () => {
    expect(heaviestCriteria()).toEqual(heaviestCriteria(HEAVIEST_CRITERIA_SEED));
    expect(freeText(1)).not.toEqual(freeText(2));
  });

  test("o texto livre é de ideogramas da Ext. B, com no máximo 3 letras ASCII no fim das notas", () => {
    const value = heaviestCriteria();
    const notes = value.notes ?? "";
    const ascii = [...notes].filter((char) => char === "x").length;
    expect(ascii).toBeLessThanOrEqual(3);
    expect(notes.endsWith("x".repeat(ascii))).toBe(true);
    const ideographs = [...freeText(HEAVIEST_CRITERIA_SEED).join("")].slice(0, -ascii || undefined);
    expect(ideographs.length).toBeGreaterThan(2_500);
    for (const char of ideographs) {
      const codePoint = char.codePointAt(0) ?? 0;
      expect(codePoint >= IDEOGRAPH_FIRST && codePoint < IDEOGRAPH_FIRST + IDEOGRAPH_COUNT).toBe(true);
    }
  });

  test("as listas enchem antes das notas: o grosso do peso está em tags de 40 ideogramas", () => {
    const value = heaviestCriteria();
    const tags = [...value.stack.mustHave, ...value.stack.niceToHave, ...value.stack.dealBreakers];
    expect(tags.length).toBeGreaterThanOrEqual(50);
    expect(tags.every((tag) => [...tag].length === 40)).toBe(true);
    expect([...(value.notes ?? "")].length).toBeLessThanOrEqual(500);
  });
});
