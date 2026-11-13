import { defineConfig } from "vitest/config";

// Testes do servidor do portal (ADR-027 §4). O núcleo de `src/server` tem 100% nas 4 métricas; as páginas e as
// rotas finas do App Router são cobertas pela integração e pelo E2E.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // Nenhum teste lê o ambiente do desenvolvedor: a configuração entra sempre por objeto (ADR-027 D9).
    env: {
      PORTAL_ORIGIN: "",
      SUPABASE_URL: "",
      SUPABASE_PUBLISHABLE_KEY: "",
      PORTAL_SEAL_KEYS: "",
      PORTAL_SEAL_ACTIVE_KEY: "",
    },
    coverage: {
      provider: "v8",
      include: ["src/server/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
