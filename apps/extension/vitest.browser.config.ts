import { defineConfig } from "vitest/config";

// Extrator de DOM no navegador real (S-2, ADR-023 D10). Fora do `test` padrão e do CI, como o E2E,
// porque exige Edge/Chrome instalado. Não faz build da extensão: avalia a função serializada.
export default defineConfig({
  test: {
    include: ["test/browser/**/*.browser.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
