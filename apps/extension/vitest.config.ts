import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  // Troca `wxt/browser` pelo fake-browser do WXT (imports da extensão são relativos, sem aliases).
  plugins: [WxtVitest()],
  test: {
    include: ["test/**/*.test.ts"],
    // O E2E e o extrator rodam à parte (vitest.e2e.config.ts e vitest.browser.config.ts): precisam de navegador.
    exclude: ["test/e2e/**", "test/browser/**"],
    coverage: {
      provider: "v8",
      // A lógica do Service Worker e a do painel (estado e textos) vivem aqui e são testadas sem navegador. O extrator tem a cobertura de
      // bloco do V8 no próprio navegador (test:browser), e background e os .tsx do painel são cola provada no E2E.
      include: ["build-env.ts", "panel-csp.ts", "src/auth/**", "src/api/**", "src/capture/**", "src/consent/**", "src/messaging/**", "src/panel/**"],
      reporter: ["text"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
