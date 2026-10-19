import { defineConfig } from "vitest/config";

// E2E num navegador real (F1-EXT-01). Fora do `test` padrão porque exige Edge/Chrome instalado.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    globalSetup: ["test/e2e/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
