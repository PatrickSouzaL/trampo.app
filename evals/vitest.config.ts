import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      // O validador é o portão do dataset (golden-dataset-spec §9): cada regra tem teste negativo.
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
