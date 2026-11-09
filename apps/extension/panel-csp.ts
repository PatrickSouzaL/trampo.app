// Meta CSP das páginas HTML da extensão (ADR-004 D10 B4; P16), lida pelo wxt.config.ts no Node. Hoje a única página
// é o Side Panel. A política se soma à do manifesto: a página perde todo egress de rede (fetch, XHR, WebSocket,
// EventSource e sendBeacon, inclusive para a API), não envia formulário, não troca a base e só aceita sink de HTML
// por política de Trusted Types, que não existe. O painel fala só pela porta (runtime.connect), que não é rede.
import type { Plugin } from "vite";

export const PANEL_CSP = "connect-src 'none'; form-action 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types 'none'";

/**
 * Só no `mode` de produção, que é o do build de loja e o do E2E. O `wxt` de desenvolvimento roda em outro `mode`, e
 * o HMR, que fala por WebSocket com o servidor local, não recebe a meta. A meta entra no início do `<head>`, antes
 * de qualquer script e de qualquer `modulepreload` que o Vite acrescente.
 */
export function panelCspPlugin(mode: string): Plugin {
  return {
    name: "trampo:panel-csp",
    transformIndexHtml() {
      if (mode !== "production") return [];
      return [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: PANEL_CSP }, injectTo: "head-prepend" }];
    },
  };
}
