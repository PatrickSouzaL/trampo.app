import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

/**
 * As variáveis de build da extensão (build-env.ts), vazias nos testes. O WxtVitest carrega o `.env` da pasta da extensão
 * no process.env (o do build real, F1-EXT-06), e o teste que importa o wxt.config.ts leria o valor do desenvolvedor:
 * nenhum teste depende dele, e vazio é "ausente" para o build-env.ts. Quem precisa de um valor o passa explícito.
 * Desde a F1-EXT-06, o wxt.config.ts também lê o `.env` por conta própria: o `TRAMPO_IGNORE_DOTENV=1` desliga essa
 * leitura nos testes, e a variável vazia (definida) já venceria o arquivo.
 */
const BUILD_ENV_UNSET = {
  ...Object.fromEntries(["TRAMPO_API_ORIGIN", "TRAMPO_SUPABASE_ORIGIN", "TRAMPO_EXTENSION_KEY", "TRAMPO_E2E", "TRAMPO_E2E_FAKE_IDENTITY"].map((name) => [name, ""])),
  TRAMPO_IGNORE_DOTENV: "1",
};

export default defineConfig({
  // Troca `wxt/browser` pelo fake-browser do WXT (imports da extensão são relativos, sem aliases).
  plugins: [WxtVitest()],
  test: {
    include: ["test/**/*.test.ts"],
    // O E2E e o extrator rodam à parte (vitest.e2e.config.ts e vitest.browser.config.ts): precisam de navegador.
    exclude: ["test/e2e/**", "test/browser/**"],
    env: BUILD_ENV_UNSET,
    coverage: {
      provider: "v8",
      // A lógica do Service Worker e a do painel (estado e textos) vivem aqui e são testadas sem navegador. O extrator tem a cobertura de
      // bloco do V8 no próprio navegador (test:browser), e background e os .tsx do painel são cola provada no E2E.
      // Os falsos do E2E com IdP falso (F1-EXT-05c) também são lógica: o que o E2E prova depende deles.
      include: ["build-env.ts", "panel-csp.ts", "src/auth/**", "src/api/**", "src/capture/**", "src/consent/**", "src/messaging/**", "src/panel/**", "test/e2e/support/**"],
      reporter: ["text"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
