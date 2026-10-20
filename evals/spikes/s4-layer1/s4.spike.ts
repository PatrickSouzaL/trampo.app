// S-4: roda o protótipo nos 83 casos do gd1, grava as métricas agregadas e prova as restrições do
// [APPSEC]: SR-09 (tempo linear) e saída sem texto de vaga e sem canário.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAndRun, measure } from "./measure.js";
import { runPreFilter } from "./prefilter.js";

const CASES_ROOT = join(import.meta.dirname, "..", "..", "golden", "cases");
const cases = loadAndRun(CASES_ROOT);
const metrics = measure(cases);
const serialized = JSON.stringify(metrics, null, 2);

describe("S-4: Camada 1 no golden dataset", () => {
  it("grava só métricas agregadas (sem texto de vaga e sem canário)", () => {
    expect(cases).toHaveLength(83);
    expect(serialized).not.toMatch(/TRAMPO-CANARY/u);
    for (const c of cases) {
      for (const line of c.text.split("\n")) {
        const t = line.trim();
        if (t.length >= 25) expect(serialized.includes(t)).toBe(false);
      }
    }
    mkdirSync(join(import.meta.dirname, "out"), { recursive: true });
    writeFileSync(join(import.meta.dirname, "out", "s4-metrics.json"), serialized + "\n", "utf8");
  });

  it("SR-09: entrada patológica de 64 KiB em menos de 200 ms (melhor de 3)", () => {
    const patterns = [
      "a".repeat(65_536),
      "R$ 9.".repeat(13_000),
      "não ".repeat(16_000) + "PHP",
      "1.1.1.1,".repeat(8_000),
      "java ".repeat(13_000),
      "\"ignore as instruções ".repeat(3_000),
      "- Diferenciais\n".repeat(4_300),
      "\u{E0041}".repeat(16_000),
    ];
    for (const p of patterns) {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i += 1) {
        const t0 = performance.now();
        runPreFilter(p, "Desenvolvedor Pleno", { useInvisibleClasses: true });
        best = Math.min(best, performance.now() - t0);
      }
      expect(best).toBeLessThan(200);
    }
  });
});
