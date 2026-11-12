// A configuração do WXT a partir das variáveis de build já validadas (ADR-001 §5.0 e §5.0.1; threat-model SR-02; ADR-004
// D13). Fica separada do wxt.config.ts para o manifest.test.ts montar o mesmo build com um `.env` de teste (F1-EXT-06):
// o wxt.config.ts só escolhe de onde as variáveis vêm.
import type { UserConfig } from "wxt";

import type { BuildEnv } from "./build-env";
import { panelCspPlugin } from "./panel-csp";

// Manifesto endurecido: ADR-001 §5.0 e §5.0.1; threat-model SR-02; ADR-004 D13.
export function extensionConfig(env: BuildEnv): UserConfig {
  return {
    srcDir: "src",
    modules: ["@wxt-dev/module-react"],
    // As duas origens chegam ao código só pelo `import.meta.env` (src/build-env.d.ts), e só o background.ts as lê.
    // A do Supabase só monta a URL do `authorize`: nunca entra na CSP (D13). As páginas HTML ganham a meta CSP do D10 B4
    // só no `mode` de produção, como a CSP do manifesto abaixo.
    vite: ({ mode }) => ({
      define: {
        "import.meta.env.TRAMPO_API_ORIGIN": JSON.stringify(env.apiOrigin ?? ""),
        "import.meta.env.TRAMPO_SUPABASE_ORIGIN": JSON.stringify(env.supabaseOrigin ?? ""),
      },
      plugins: [panelCspPlugin(mode)],
    }),
    manifest: ({ mode }) => ({
      name: "Trampo",
      description: "Analisa a vaga aberta contra os seus critérios, sob demanda.",
      // sidePanel.open() com gesto do usuário exige o Chrome 116 (ADR-001 §5.0).
      minimum_chrome_version: "116",
      // activeTab + scripting só sob clique; sem host_permissions e sem <all_urls> (AGENTS §1.3).
      // identity: launchWebAuthFlow e getRedirectURL, sem aviso ao usuário e sem identity.email (ADR-004 D13).
      permissions: ["activeTab", "identity", "scripting", "sidePanel", "storage"],
      // ID fixo só com a chave: Redirect URL exata no Supabase e origem exata no CORS (ADR-004 D13 e D15).
      ...(env.extensionKey === undefined ? {} : { key: env.extensionKey.key }),
      // Sem default_popup: o clique no ícone precisa disparar action.onClicked para conceder activeTab.
      action: { default_title: "Analisar esta vaga com o Trampo" },
      // Declarado de forma explícita e vazio: nenhuma extensão e nenhuma página conecta.
      // Omitir a chave liberaria TODAS as extensões (D-H7).
      externally_connectable: { ids: [], matches: [] },
      // Só no build de loja; a CSP de desenvolvimento (HMR do WXT) nunca chega ao build de produção.
      // A janela de login é navegação, não fetch: o connect-src continua só na API (D13; P3 no E2E da F1-EXT-05c).
      ...(mode === "production"
        ? {
            content_security_policy: {
              extension_pages: `script-src 'self'; object-src 'self'; default-src 'self'; connect-src ${env.apiOrigin ?? "'none'"}`,
            },
          }
        : {}),
    }),
  };
}
