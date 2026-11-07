import { defineConfig } from "vitest/config";

// test:db (ADR-018 D7; ADR-019 D8): o SR-15 contra o Supabase local, só no job db do CI. Fora do `pnpm test`
// (o vitest.config.ts não inclui test/db/**): o portão padrão não exige Docker. Em série, porque os testes de cada
// arquivo dependem da ordem e falam com o mesmo banco.
//
// Dois grupos (07h, ADR-004 §4.3): a sonda do limite por IP (D8 item 5) roda sozinha, porque em modo ativo esvazia o
// balde do `/token` do GoTrue. O `groupOrder` não segurou a ordem no 1º run do CI (a sonda rodou antes), então a
// própria sonda devolve o balde cheio ao terminar.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "db",
          include: ["test/db/**/*.db.test.ts"],
          exclude: ["test/db/auth-rate-limit.db.test.ts"],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: { name: "db-limite", include: ["test/db/auth-rate-limit.db.test.ts"], sequence: { groupOrder: 1 } },
      },
    ],
    coverage: {
      provider: "v8",
      // O acesso à pilha local e as consultas de catálogo. O guarda do ambiente (local-stack-env) tem os casos
      // negativos e a cobertura no `pnpm test`. O gerador do perfil mais pesado (F1-API-05 commit 6) também.
      // As sessões do contrato de auth (07h); a contagem da sonda (rate-limit-probe) fecha no `pnpm test`, porque o
      // job roda só um dos ramos dela.
      include: [
        "test/db/support/local-stack.ts",
        "test/db/support/catalog-sql.ts",
        "test/db/support/heaviest-criteria.ts",
        "test/db/support/auth-stack.ts",
      ],
      reportsDirectory: "coverage/db",
      reporter: ["text"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
