// Adapter do IdGenerator (ADR-017 D1): UUID v4 do node:crypto, sempre no formato que o AnalyzeJob confere.
import { AnalysisReportSchema } from "@trampo/contracts";
import { describe, expect, test } from "vitest";

import { cryptoIdGenerator } from "../../src/infrastructure/ids/crypto-id-generator.js";

describe("cryptoIdGenerator", () => {
  test("UUID v4 válido no AnalysisReportSchema e sem repetição em 1.000 chamadas", () => {
    const ids = Array.from({ length: 1_000 }, () => cryptoIdGenerator.uuid());
    for (const id of ids) {
      expect(AnalysisReportSchema.shape.analysisId.safeParse(id).success).toBe(true);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("congelado", () => {
    expect(Object.isFrozen(cryptoIdGenerator)).toBe(true);
  });
});
