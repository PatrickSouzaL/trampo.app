import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "json-summary"],
      // A política é o portão do próprio CI (ADR-019 §3): cada regra tem teste negativo.
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
