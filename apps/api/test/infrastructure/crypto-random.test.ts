// Adapter da porta Random (ADR-009 D1) com o CSPRNG: sempre em [0, 1) e não constante.
import { describe, expect, test } from "vitest";

import { cryptoRandom } from "../../src/infrastructure/random/crypto-random.js";

describe("cryptoRandom", () => {
  test("10.000 sorteios em [0, 1), com valores distintos", () => {
    const draws = Array.from({ length: 10_000 }, () => cryptoRandom.next());
    for (const value of draws) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(new Set(draws).size).toBeGreaterThan(9_990);
    // Espalha pelo intervalo: as duas metades aparecem.
    expect(draws.some((value) => value < 0.5) && draws.some((value) => value >= 0.5)).toBe(true);
  });

  test("é imutável", () => {
    expect(Object.isFrozen(cryptoRandom)).toBe(true);
  });
});
