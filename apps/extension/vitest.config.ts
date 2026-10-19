import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // O E2E roda à parte (vitest.e2e.config.ts), porque precisa de navegador.
    exclude: ["test/e2e/**"],
  },
});
