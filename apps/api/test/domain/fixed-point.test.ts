// Ponto fixo com teto de passadas (ADR-001 §5.2, item 2; ADR-005 D4).
import { describe, expect, test } from "vitest";

import { iterateToFixedPoint } from "../../src/domain/normalization/fixed-point.js";

describe("iterateToFixedPoint", () => {
  test("para quando a saída não muda e marca stable", () => {
    const step = (value: string) => ({ value: value.replace(/aa/u, "a"), stats: value.length });
    const result = iterateToFixedPoint("aaaa", step, 10);
    expect(result).toEqual({ value: "a", passes: 4, stable: true, history: [4, 3, 2, 1] });
  });

  test("entrada já estável: uma passada só", () => {
    const result = iterateToFixedPoint("x", (value) => ({ value, stats: 0 }), 4);
    expect(result).toMatchObject({ value: "x", passes: 1, stable: true });
  });

  test("não estabiliza no teto: devolve a última saída com stable false", () => {
    const result = iterateToFixedPoint("", (value) => ({ value: `${value}x`, stats: null }), 4);
    expect(result).toMatchObject({ value: "xxxx", passes: 4, stable: false });
  });

  test("teto 1 com mudança: não confirma a estabilidade", () => {
    const result = iterateToFixedPoint("a", () => ({ value: "b", stats: null }), 1);
    expect(result).toMatchObject({ value: "b", passes: 1, stable: false });
  });
});
