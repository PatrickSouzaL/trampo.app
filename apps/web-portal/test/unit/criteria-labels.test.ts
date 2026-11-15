// Rótulos do formulário de critérios (ADR-028 D7): um texto fixo para cada opção dos enums do contrato e um título por
// campo. Nenhum rótulo com link ou marcação; nenhuma opção sem rótulo (um enum novo no contrato derruba este teste).
import { describe, expect, it } from "vitest";

import { FIELD_LABELS, OPTION_LABELS } from "../../src/server/criteria-labels";
import { CRITERIA_FIELDS, FORM_OPTIONS } from "../../src/server/criteria-form";

describe("rótulos do formulário de critérios", () => {
  it("toda opção de cada lista fechada tem rótulo, e nenhum rótulo sobra", () => {
    for (const [list, labels] of Object.entries(OPTION_LABELS)) {
      const options = FORM_OPTIONS[list as keyof typeof FORM_OPTIONS] as readonly string[];
      expect(Object.keys(labels).sort(), list).toEqual([...options].sort());
    }
    // Os estados e os pesos da stack se mostram pelo próprio valor.
    expect(Object.keys(OPTION_LABELS).sort()).toEqual(Object.keys(FORM_OPTIONS).filter((list) => list !== "ufs" && list !== "niceToHaveWeight").sort());
  });

  it("um título por campo do contrato", () => {
    expect(Object.keys(FIELD_LABELS)).toEqual([...CRITERIA_FIELDS]);
  });

  it("nenhum rótulo com link ou marcação", () => {
    const texts = [...Object.values(FIELD_LABELS), ...Object.values(OPTION_LABELS).flatMap((labels) => Object.values(labels))];
    for (const text of texts) {
      expect(text).not.toMatch(/[<>]|https?:/);
      expect(text.trim()).toBe(text);
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
