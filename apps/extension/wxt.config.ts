import { defineConfig } from "wxt";

/**
 * Origem da API para o `connect-src` da CSP do build de produção. Definida no S-5 (hospedagem).
 * Sem ela, o build sai com `connect-src 'none'`: fail closed, a extensão não fala com ninguém.
 */
function apiConnectSrc(): string {
  const origin = process.env["TRAMPO_API_ORIGIN"];
  if (origin === undefined || origin === "") return "'none'";
  if (!/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(origin)) {
    throw new Error("TRAMPO_API_ORIGIN deve ser uma origem https exata, sem caminho (ex.: https://api.exemplo.com)");
  }
  return origin;
}

// Manifesto endurecido: ADR-001 §5.0 e §5.0.1; threat-model SR-02.
export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  manifest: ({ mode }) => ({
    name: "Trampo",
    description: "Analisa a vaga aberta contra os seus critérios, sob demanda.",
    // sidePanel.open() com gesto do usuário exige o Chrome 116 (ADR-001 §5.0).
    minimum_chrome_version: "116",
    // activeTab + scripting só sob clique; sem host_permissions e sem <all_urls> (AGENTS §1.3).
    // identity e contextMenus entram só se o S-3 decidir.
    permissions: ["activeTab", "scripting", "sidePanel", "storage"],
    // Sem default_popup: o clique no ícone precisa disparar action.onClicked para conceder activeTab.
    action: { default_title: "Analisar esta vaga com o Trampo" },
    // Declarado de forma explícita e vazio: nenhuma extensão e nenhuma página conecta.
    // Omitir a chave liberaria TODAS as extensões (D-H7).
    externally_connectable: { ids: [], matches: [] },
    // Só no build de loja; a CSP de desenvolvimento (HMR do WXT) nunca chega ao build de produção.
    ...(mode === "production"
      ? {
          content_security_policy: {
            extension_pages: `script-src 'self'; object-src 'self'; default-src 'self'; connect-src ${apiConnectSrc()}`,
          },
        }
      : {}),
  }),
});
