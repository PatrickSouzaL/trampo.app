import { defineConfig } from "vitest/config";

// test:db (ADR-018 D7; ADR-019 D8): o SR-15 contra o Supabase local, só no job db do CI. Fora do `pnpm test`
// (o vitest.config.ts não inclui test/db/**): o portão padrão não exige Docker. Em série, porque os testes de cada
// arquivo dependem da ordem e falam com o mesmo banco.
export default defineConfig({
  test: {
    name: "db",
    include: ["test/db/**/*.db.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      // O acesso à pilha local e as consultas de catálogo. O guarda do ambiente (local-stack-env) tem os casos
      // negativos e a cobertura no `pnpm test`.
      include: ["test/db/support/local-stack.ts", "test/db/support/catalog-sql.ts"],
      reportsDirectory: "coverage/db",
      reporter: ["text"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
