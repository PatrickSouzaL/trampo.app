import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      // 100% no pacote de contratos (ADR-001 §10.2; BACKLOG M3).
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
