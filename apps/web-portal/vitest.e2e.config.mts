import { defineConfig } from "vitest/config";

// E2E do portal no navegador real (ADR-027 §7). Fora do `test` padrão e do CI porque exige o Edge ou o Chrome instalado
// e o portal construído. Cada arquivo sobe a própria pilha (GoTrue simulado, `next start` e navegador) no `beforeAll`.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    globalSetup: ["test/e2e/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Nenhum teste lê o ambiente do desenvolvedor: o `next start` recebe um ambiente fechado (ADR-027 D9).
    env: {
      PORTAL_ORIGIN: "",
      SUPABASE_URL: "",
      SUPABASE_PUBLISHABLE_KEY: "",
      PORTAL_SEAL_KEYS: "",
      PORTAL_SEAL_ACTIVE_KEY: "",
    },
  },
});
