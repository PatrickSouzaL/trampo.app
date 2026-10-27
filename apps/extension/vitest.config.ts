import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  // Troca `wxt/browser` pelo fake-browser do WXT (imports da extensão são relativos, sem aliases).
  plugins: [WxtVitest()],
  test: {
    include: ["test/**/*.test.ts"],
    // O E2E e o extrator rodam à parte (vitest.e2e.config.ts e vitest.browser.config.ts): precisam de navegador.
    exclude: ["test/e2e/**", "test/browser/**"],
  },
});
