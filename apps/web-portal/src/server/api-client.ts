// Cliente da API do Trampo no servidor do portal (ADR-028 D2; a conta, ADR-029 D9): o `GET` e o `PUT /v1/criteria`, o
// `GET /v1/account/export` e o `POST /v1/account/delete`, servidor a servidor, com o Bearer do access da sessão. Molde do `gotrue.ts` (ADR-027 D1), sem SDK e sem importar a API.
//
// - Destino fixo: `API_ORIGIN` (validado no boot) mais o caminho constante. Nada do pedido vira URL (sem SSRF).
// - Lista fechada de cabeçalhos: `authorization` e `accept`, e o `content-type` no `PUT`. Nunca o cookie do navegador,
//   `origin`, `referer` ou `x-forwarded-for`: a interface nem recebe cabeçalho. Sem `Origin`, a borda da API deixa
//   passar sem CORS, e o JWT protege (ADR-007 D6).
// - `redirect: "error"` (o Bearer nunca segue um 3xx), prazo de 5 s, teto de 32 KiB, UTF-8 estrito, JSON sem chave de
//   protótipo e `cache: "no-store"`. A exportação tem 15 s e 4 MiB próprios (ADR-031 D5).
// - Classificação pelo `code` do corpo da API (ADR-021 D2), nunca pelo status sozinho (T30). No `PUT`, o que não prova
//   que nada foi gravado é `pode_ter_gravado` (o 503 do guarda pode vir depois da escrita, ADR-021 D5). Sem nova
//   tentativa. Nunca rejeita, e nada do token, do corpo ou da resposta sai daqui.
// - Conta: a exportação só sai revalidada pelo `AccountExportSchema`. Na exclusão, só o 204 é sucesso; o 403 `PROIBIDO`
//   é o login antigo (nada foi apagado), e o que não prova que nada foi apagado é `pode_ter_excluido`.
import { ACCOUNT_DELETE_CONFIRMATION, ACCOUNT_ROUTES, ACCOUNT_SCHEMA_VERSION, AccountExportSchema, type AccountExport } from "@trampo/contracts/account";
import { ApiErrorSchema } from "@trampo/contracts/api";
import { ACCESS_TOKEN_MAX_CHARS, CRITERIA_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import { UserCriteriaSchema, type UserCriteria } from "@trampo/contracts/user-criteria";

import { isExactOrigin } from "./config";
import { discard, fetchFailure, readJson } from "./http";

export type CriteriaReadResult =
  | { readonly ok: true; readonly criteria: UserCriteria | null }
  | { readonly ok: false; readonly reason: "recusado" | "nao_recebido" };

export type CriteriaWriteFailure = "recusado" | "invalido" | "nao_recebido" | "pode_ter_gravado";
export type CriteriaWriteResult = { readonly ok: true } | { readonly ok: false; readonly reason: CriteriaWriteFailure };

export type AccountExportResult =
  | { readonly ok: true; readonly document: AccountExport }
  | { readonly ok: false; readonly reason: "recusado" | "nao_recebido" };

/**
 * - `recusado`: 401 da API (a sessão decide pela renovação forçada);
 * - `login_antigo`: 403 `PROIBIDO`, a sessão tem mais de 10 minutos e nada foi apagado;
 * - `nao_recebido`: a API não chegou a tentar (conexão recusada, redirecionamento, 429, corpo recusado);
 * - `pode_ter_excluido`: prazo, 5xx, resposta cortada ou fora da tabela. Não prova nada.
 */
export type AccountDeleteFailure = "recusado" | "login_antigo" | "nao_recebido" | "pode_ter_excluido";
export type AccountDeleteResult = { readonly ok: true } | { readonly ok: false; readonly reason: AccountDeleteFailure };

export interface ApiClient {
  /** `criteria: null` quando o usuário nunca salvou (409 `CRITERIOS_NAO_CONFIGURADOS`). */
  readCriteria(accessToken: string, signal?: AbortSignal): Promise<CriteriaReadResult>;
  /** Uma chamada só: o documento inteiro, que a API substitui (ADR-021 D7). */
  writeCriteria(accessToken: string, criteria: UserCriteria, signal?: AbortSignal): Promise<CriteriaWriteResult>;
  /** Os dados do dono do token, já revalidados pelo contrato. Uma chamada só. */
  exportAccount(accessToken: string, signal?: AbortSignal): Promise<AccountExportResult>;
  /** Apaga a conta do dono do token. Uma chamada só, com o corpo fixo do contrato. */
  deleteAccount(accessToken: string, signal?: AbortSignal): Promise<AccountDeleteResult>;
}

export const API_CLIENT_POLICY = Object.freeze({
  timeoutMs: 5_000,
  maxResponseBytes: 32 * 1024,
  /** A exportação: os critérios e duas listas de até 10.000 linhas (ADR-029 D4; ADR-031 D5), cerca de 3 MiB no pior caso. */
  exportMaxResponseBytes: 4 * 1024 * 1024,
  /** A API lê as duas listas em até 10 páginas cada, com 10 s de prazo próprio (ADR-031 D5): a exportação espera mais. */
  exportTimeoutMs: 15_000,
});

export interface ApiClientConfig {
  readonly apiOrigin: string;
  /** Só para os testes encurtarem o prazo. */
  readonly timeoutMs?: number;
  /** Só para os testes encurtarem o prazo da exportação. */
  readonly exportTimeoutMs?: number;
}

const ACCESS_TOKEN = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const CRITERIA_PATH = "/v1/criteria";

const READ_REFUSED = Object.freeze({ ok: false, reason: "recusado" } as const);
const READ_NOT_RECEIVED = Object.freeze({ ok: false, reason: "nao_recebido" } as const);
const NOT_CONFIGURED = Object.freeze({ ok: true, criteria: null } as const);
const WRITTEN = Object.freeze({ ok: true } as const);
const writeFailure = (reason: CriteriaWriteFailure): CriteriaWriteResult => ({ ok: false, reason });
const DELETED = Object.freeze({ ok: true } as const);
const deleteFailure = (reason: AccountDeleteFailure): AccountDeleteResult => ({ ok: false, reason });
/** O corpo fixo da exclusão: quem conferiu a frase digitada foi a DAL; nada do pedido do navegador entra aqui. */
const DELETE_BODY = JSON.stringify({ schemaVersion: ACCOUNT_SCHEMA_VERSION, confirmation: ACCOUNT_DELETE_CONFIRMATION });

const validToken = (token: string): boolean => token.length <= ACCESS_TOKEN_MAX_CHARS && ACCESS_TOKEN.test(token);

export function createApiClient(config: ApiClientConfig): ApiClient {
  if (!isExactOrigin(config.apiOrigin)) throw new Error("API_ORIGIN precisa ser uma origem exata");
  const endpoint = new URL(CRITERIA_PATH, config.apiOrigin);
  const exportEndpoint = new URL(ACCOUNT_ROUTES.export, config.apiOrigin);
  const deleteEndpoint = new URL(ACCOUNT_ROUTES.delete, config.apiOrigin);
  const timeoutMs = config.timeoutMs ?? API_CLIENT_POLICY.timeoutMs;
  const exportTimeoutMs = config.exportTimeoutMs ?? API_CLIENT_POLICY.exportTimeoutMs;

  const call = async (
    method: "GET" | "PUT" | "POST",
    headers: Readonly<Record<string, string>>,
    body: string | null,
    signal: AbortSignal | undefined,
    target: URL = endpoint,
    deadlineMs: number = timeoutMs,
  ): Promise<Response | "nao_conectou" | "talvez"> => {
    if (signal?.aborted === true) return "nao_conectou";
    const timeout = AbortSignal.timeout(deadlineMs);
    try {
      return await fetch(target, {
        method,
        headers,
        body,
        // Seguir um redirecionamento levaria o Bearer para outro host.
        redirect: "error",
        cache: "no-store",
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      return fetchFailure(error);
    }
  };

  /** O `code` do `ApiError` da API, ou `undefined` sem esse corpo. Nunca sai daqui. */
  const apiErrorCode = async (response: Response): Promise<string | undefined> => {
    try {
      const parsed = ApiErrorSchema.safeParse(await readJson(response, API_CLIENT_POLICY.maxResponseBytes));
      return parsed.success ? parsed.data.code : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    async readCriteria(accessToken, signal) {
      if (!validToken(accessToken)) return READ_NOT_RECEIVED;
      const response = await call("GET", { authorization: `Bearer ${accessToken}`, accept: "application/json" }, null, signal);
      // A leitura não tem efeito: prazo, aborto e socket cortado são só "não recebido".
      if (!(response instanceof Response)) return READ_NOT_RECEIVED;
      if (response.status === 200) {
        try {
          const parsed = UserCriteriaSchema.safeParse(await readJson(response, API_CLIENT_POLICY.maxResponseBytes));
          return parsed.success ? { ok: true, criteria: parsed.data } : READ_NOT_RECEIVED;
        } catch {
          return READ_NOT_RECEIVED;
        }
      }
      const code = await apiErrorCode(response);
      if (response.status === 409 && code === "CRITERIOS_NAO_CONFIGURADOS") return NOT_CONFIGURED;
      if (response.status === 401 && code === "NAO_AUTENTICADO") return READ_REFUSED;
      return READ_NOT_RECEIVED;
    },

    async writeCriteria(accessToken, criteria, signal) {
      if (!validToken(accessToken)) return writeFailure("nao_recebido");
      const body = JSON.stringify(criteria);
      if (Buffer.byteLength(body, "utf8") > CRITERIA_BODY_MAX_BYTES) return writeFailure("invalido");
      const headers = { authorization: `Bearer ${accessToken}`, accept: "application/json", "content-type": "application/json" } as const;
      const response = await call("PUT", headers, body, signal);
      if (!(response instanceof Response)) return writeFailure(response === "nao_conectou" ? "nao_recebido" : "pode_ter_gravado");
      if (response.status === 204) {
        await discard(response);
        return WRITTEN;
      }
      const code = await apiErrorCode(response);
      // A borda da API responde estes antes de ler o corpo ou de gravar (ADR-021 D8.1): nada foi gravado.
      if (response.status === 401 && code === "NAO_AUTENTICADO") return writeFailure("recusado");
      if ((response.status === 400 || response.status === 415) && code === "PAYLOAD_INVALIDO") return writeFailure("invalido");
      if (response.status === 413 && code === "PAYLOAD_GRANDE_DEMAIS") return writeFailure("invalido");
      if (response.status === 429 && code === "LIMITE_DE_TAXA") return writeFailure("nao_recebido");
      return writeFailure("pode_ter_gravado");
    },

    async exportAccount(accessToken, signal) {
      if (!validToken(accessToken)) return READ_NOT_RECEIVED;
      const response = await call("GET", { authorization: `Bearer ${accessToken}`, accept: "application/json" }, null, signal, exportEndpoint, exportTimeoutMs);
      // A leitura não tem efeito: prazo, aborto e socket cortado são só "não recebido".
      if (!(response instanceof Response)) return READ_NOT_RECEIVED;
      if (response.status === 200) {
        try {
          const parsed = AccountExportSchema.safeParse(await readJson(response, API_CLIENT_POLICY.exportMaxResponseBytes));
          return parsed.success ? { ok: true, document: parsed.data } : READ_NOT_RECEIVED;
        } catch {
          return READ_NOT_RECEIVED;
        }
      }
      return response.status === 401 && (await apiErrorCode(response)) === "NAO_AUTENTICADO" ? READ_REFUSED : READ_NOT_RECEIVED;
    },

    async deleteAccount(accessToken, signal) {
      if (!validToken(accessToken)) return deleteFailure("nao_recebido");
      const headers = { authorization: `Bearer ${accessToken}`, accept: "application/json", "content-type": "application/json" } as const;
      const response = await call("POST", headers, DELETE_BODY, signal, deleteEndpoint);
      if (!(response instanceof Response)) return deleteFailure(response === "nao_conectou" ? "nao_recebido" : "pode_ter_excluido");
      if (response.status === 204) {
        await discard(response);
        return DELETED;
      }
      const code = await apiErrorCode(response);
      // A borda da API responde estes antes de chegar ao banco, e o 403 é a função dizendo que não apagou (ADR-029 D3).
      if (response.status === 401 && code === "NAO_AUTENTICADO") return deleteFailure("recusado");
      if (response.status === 403 && code === "PROIBIDO") return deleteFailure("login_antigo");
      if ((response.status === 400 || response.status === 415) && code === "PAYLOAD_INVALIDO") return deleteFailure("nao_recebido");
      if (response.status === 413 && code === "PAYLOAD_GRANDE_DEMAIS") return deleteFailure("nao_recebido");
      if (response.status === 429 && code === "LIMITE_DE_TAXA") return deleteFailure("nao_recebido");
      return deleteFailure("pode_ter_excluido");
    },
  };
}
