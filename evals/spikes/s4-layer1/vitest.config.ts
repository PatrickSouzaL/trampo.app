import { defineConfig } from "vitest/config";

// S-4: a medição roda à parte do `pnpm test` do pacote (protótipo descartável, sem limiar de cobertura).
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["*.spike.ts"],
    testTimeout: 120_000,
  },
});
