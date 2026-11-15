// A DAL de exportar e excluir a conta no portal (ADR-029 D9), sem Next.js. Recebe o que o pedido traz (cookies,
// `Origin`, `Sec-Fetch-Site`, o corpo) e devolve a vista da página ou a intenção HTTP (destino, cookies ou o arquivo),
// que as páginas e as rotas só traduzem.
//
// - Nenhum destino sai do pedido: só `/conta/dados` e `/conta/dados/excluir` com um aviso do catálogo, ou a página
//   inicial.
// - As duas rotas conferem o `Origin` e o `Sec-Fetch-Site` antes de qualquer coisa e chamam a API uma vez só.
// - A exclusão exige a frase digitada, conferida aqui e de novo na API, e o login recente: o portal só espelha a regra
//   pelo início da sessão do cookie, para avisar antes; quem decide é a função do banco (ADR-029 D6).
// - "Conta excluída" só com o 204 da API. O que não confirma tem aviso próprio e nunca promete (T30). O 401 da API só
//   apaga a sessão depois de o GoTrue recusar a renovação forçada, e o pedido não se repete.
// - Os dados exportados nunca passam por URL, cookie, aviso ou log.
import { ACCOUNT_DELETE_CONFIRMATION } from "@trampo/contracts/account";
import { ACCOUNT_RECENT_LOGIN_SECONDS } from "@trampo/contracts/limits";

import type { ApiClient } from "./api-client";
import type { PortalConfig } from "./config";
import { COOKIE_NAMES, cookieClear, type CookieWrite } from "./cookies";
import { readFormBody } from "./criteria-form";
import { parseAccountNotice, type AccountNotice } from "./notices";
import type { ApiAccess, Forbidden, PortalAuth, Redirect } from "./session";

export const ACCOUNT_POLICY = Object.freeze({
  /** O corpo do formulário de confirmação é um campo só. */
  confirmationBodyMaxBytes: 1_024,
  confirmationField: "confirmacao",
  exportFilename: "trampo-meus-dados.json",
});

/** O arquivo da exportação: o corpo já revalidado e os cookies (a sessão renovada, se houve). */
export interface Download {
  readonly kind: "download";
  readonly filename: string;
  readonly body: string;
  readonly cookies: readonly CookieWrite[];
}

export type AccountPageView = { readonly kind: "sem_sessao" } | { readonly kind: "pagina"; readonly notice: AccountNotice | null };

export type AccountConfirmView =
  | { readonly kind: "sem_sessao" }
  /** `recent: false`: a página mostra o aviso do login recente no lugar do formulário. */
  | { readonly kind: "confirmar"; readonly recent: boolean; readonly notice: AccountNotice | null };

export interface AccountPageInput {
  readonly sessionCookie: string | undefined;
  /** O `?aviso=` da página: só escolhe um texto do catálogo. */
  readonly aviso: unknown;
}

export interface AccountExportInput {
  readonly origin: string | null;
  readonly secFetchSite: string | null;
  readonly sessionCookie: string | undefined;
}

export interface AccountDeleteInput extends AccountExportInput {
  readonly contentType: string | null;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface AccountDal {
  page(input: AccountPageInput): Promise<AccountPageView>;
  confirmPage(input: AccountPageInput): Promise<AccountConfirmView>;
  exportData(input: AccountExportInput): Promise<Download | Redirect | Forbidden>;
  deleteAccount(input: AccountDeleteInput): Promise<Redirect | Forbidden>;
}

export interface AccountDalDeps {
  readonly config: PortalConfig;
  readonly auth: PortalAuth;
  readonly api: ApiClient;
  /** Relógio em milissegundos. */
  readonly now: () => number;
}

export function createAccountDal(deps: AccountDalDeps): AccountDal {
  const { config, auth, api } = deps;
  const nowSeconds = (): number => Math.floor(deps.now() / 1_000);
  const dataPage = (notice: AccountNotice): string => `${config.portalOrigin}/conta/dados?aviso=${notice}`;
  const confirmPage = (notice: AccountNotice): string => `${config.portalOrigin}/conta/dados/excluir?aviso=${notice}`;
  const redirect = (location: string, cookies: ReadonlyArray<CookieWrite | undefined>): Redirect => ({
    kind: "redirect",
    location,
    cookies: cookies.filter((cookie): cookie is CookieWrite => cookie !== undefined),
  });
  /** Sem sessão: a página inicial, com o aviso do estado (o mesmo destino dos critérios). */
  const home = (access: ApiAccess & { readonly ok: false }): Redirect =>
    redirect(access.state === "expirada" ? `${config.portalOrigin}/?aviso=sessao_expirada` : `${config.portalOrigin}/`, [access.cookie]);
  /** O espelho da regra do banco: a sessão do cookie começou há no máximo 600 s (e não no futuro). */
  const recentLogin = (startedAt: number): boolean => {
    const age = nowSeconds() - startedAt;
    return age >= 0 && age <= ACCOUNT_RECENT_LOGIN_SECONDS;
  };
  /**
   * O 401 da API: a renovação forçada decide, a partir do cookie mais novo. Sessão que o GoTrue recusou vira a página
   * inicial; qualquer outro desfecho é "indisponível", e o pedido à API não se repete.
   */
  const afterRefusal = async (access: ApiAccess & { readonly ok: true }, sessionCookie: string | undefined, notice: AccountNotice): Promise<Redirect> => {
    const forced = await auth.apiAccess(access.cookie?.value ?? sessionCookie, "forcada");
    if (!forced.ok && forced.state !== "indisponivel") return home(forced);
    return redirect(dataPage(notice), [forced.cookie ?? access.cookie]);
  };

  return {
    async page({ sessionCookie, aviso }) {
      const access = await auth.apiAccess(sessionCookie, "leitura");
      return access.ok ? { kind: "pagina", notice: parseAccountNotice(aviso) } : { kind: "sem_sessao" };
    },

    async confirmPage({ sessionCookie, aviso }) {
      const access = await auth.apiAccess(sessionCookie, "leitura");
      if (!access.ok) return { kind: "sem_sessao" };
      return { kind: "confirmar", recent: recentLogin(access.startedAt), notice: parseAccountNotice(aviso) };
    },

    async exportData({ origin, secFetchSite, sessionCookie }) {
      if (origin !== config.portalOrigin || secFetchSite !== "same-origin") return { kind: "forbidden" };
      const access = await auth.apiAccess(sessionCookie, "gravacao");
      if (!access.ok) return access.state === "indisponivel" ? redirect(dataPage("exportacao_indisponivel"), [access.cookie]) : home(access);
      const exported = await api.exportAccount(access.accessToken);
      if (exported.ok) {
        // O documento já passou pelo AccountExportSchema no cliente: só o que é do contrato vira arquivo.
        const body = `${JSON.stringify(exported.document, null, 2)}\n`;
        return { kind: "download", filename: ACCOUNT_POLICY.exportFilename, body, cookies: access.cookie === undefined ? [] : [access.cookie] };
      }
      if (exported.reason === "recusado") return afterRefusal(access, sessionCookie, "exportacao_indisponivel");
      return redirect(dataPage("exportacao_indisponivel"), [access.cookie]);
    },

    async deleteAccount({ origin, secFetchSite, contentType, body, sessionCookie }) {
      if (origin !== config.portalOrigin || secFetchSite !== "same-origin") return { kind: "forbidden" };
      const pairs = await readFormBody(contentType, body, ACCOUNT_POLICY.confirmationBodyMaxBytes);
      // Exatamente o campo da frase, uma vez; a frase, sem as pontas e em minúsculas, igual à do contrato.
      const typed = pairs?.length === 1 && pairs[0]?.[0] === ACCOUNT_POLICY.confirmationField ? pairs[0][1].trim().toLowerCase() : null;
      if (typed !== ACCOUNT_DELETE_CONFIRMATION) return redirect(confirmPage("exclusao_frase_errada"), []);

      const access = await auth.apiAccess(sessionCookie, "gravacao");
      if (!access.ok) return access.state === "indisponivel" ? redirect(dataPage("exclusao_indisponivel"), [access.cookie]) : home(access);
      // Sem rede: o banco recusaria de qualquer jeito.
      if (!recentLogin(access.startedAt)) return redirect(dataPage("exclusao_pede_login"), [access.cookie]);

      const deleted = await api.deleteAccount(access.accessToken);
      if (deleted.ok) {
        // Só o 204 chega aqui: a sessão e o rascunho somem do navegador, e nada mais os reescreve.
        return redirect(`${config.portalOrigin}/?aviso=conta_excluida`, [cookieClear(COOKIE_NAMES.sessao), cookieClear(COOKIE_NAMES.rascunho)]);
      }
      if (deleted.reason === "recusado") return afterRefusal(access, sessionCookie, "exclusao_indisponivel");
      if (deleted.reason === "login_antigo") return redirect(dataPage("exclusao_pede_login"), [access.cookie]);
      if (deleted.reason === "nao_recebido") return redirect(dataPage("exclusao_indisponivel"), [access.cookie]);
      // Prazo, 5xx ou resposta cortada: a conta pode ter sido excluída. A sessão fica; se a conta sumiu, ela cai sozinha.
      return redirect(dataPage("exclusao_nao_confirmada"), [access.cookie]);
    },
  };
}
