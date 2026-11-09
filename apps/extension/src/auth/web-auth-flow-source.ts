// Adapter de produção da porta AuthCodeSource (ADR-004 D3 passos 4 e 6): o ÚNICO arquivo da extensão com
// `browser.identity` (lint B2, D10). O navegador intercepta o retorno no chromiumapp.org da própria extensão;
// não há página de callback (B8). A mensagem de erro do navegador muda entre o Chrome e o Edge e nunca é lida.
import { browser } from "wxt/browser";

import type { AuthCodeResult, AuthCodeSource } from "./auth-code-source";
import { AUTH_REDIRECT_PATH } from "./authorize-url";

// O ID de extensão do Chromium tem 32 letras de a a p. Qualquer outra forma (outro host, caminho, porta,
// query) não vai ao `redirect_to`: o preparo do login falha fechado, com `auth_sem_configuracao` (P2).
const CHROMIUMAPP_REDIRECT = new RegExp(`^https://[a-p]{32}\\.chromiumapp\\.org/${AUTH_REDIRECT_PATH}$`);

const FALHOU: AuthCodeResult = { ok: false };

export function webAuthFlowSource(): AuthCodeSource {
  return {
    redirectUri() {
      const uri = browser.identity.getRedirectURL(AUTH_REDIRECT_PATH);
      if (!CHROMIUMAPP_REDIRECT.test(uri)) {
        throw new Error(`getRedirectURL fora da forma https://<id>.chromiumapp.org/${AUTH_REDIRECT_PATH}`);
      }
      return uri;
    },
    async obtainRedirect({ authorizeUrl }) {
      try {
        const url = await browser.identity.launchWebAuthFlow({ url: authorizeUrl, interactive: true });
        return typeof url === "string" ? { ok: true, url } : FALHOU;
      } catch {
        return FALHOU;
      }
    },
  };
}
