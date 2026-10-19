import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Domínio inteiro (AGENTS §1.5) e o adapter de hash que a chave de cache usa (ADR-005 D1).
      include: ["src/domain/**/*.ts", "src/infrastructure/crypto/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
