// Cliente da API do Trampo no servidor do portal (ADR-028 D2): só o `GET` e o `PUT /v1/criteria`, servidor a servidor,
// com o Bearer do access da sessão. Molde do `gotrue.ts` (ADR-027 D1), sem SDK e sem importar a API.
//
// - Destino fixo: `API_ORIGIN` (validado no boot) mais o caminho constante. Nada do pedido vira URL (sem SSRF).
// - Lista fechada de cabeçalhos: `authorization` e `accept`, e o `content-type` no `PUT`. Nunca o cookie do navegador,
//   `origin`, `referer` ou `x-forwarded-for`: a interface nem recebe cabeçalho. Sem `Origin`, a borda da API deixa
//   passar sem CORS, e o JWT protege (ADR-007 D6).
// - `redirect: "error"` (o Bearer nunca segue um 3xx), prazo de 5 s, teto de 32 KiB, UTF-8 estrito, JSON sem chave de
//   protótipo e `cache: "no-store"`.
// - Classificação pelo `code` do corpo da API (ADR-021 D2), nunca pelo status sozinho (T30). No `PUT`, o que não prova
//   que nada foi gravado é `pode_ter_gravado` (o 503 do guarda pode vir depois da escrita, ADR-021 D5). Sem nova
//   tentativa. Nunca rejeita, e nada do token, do corpo ou da resposta sai daqui.
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

export interface ApiClient {
  /** `criteria: null` quando o usuário nunca salvou (409 `CRITERIOS_NAO_CONFIGURADOS`). */
  readCriteria(accessToken: string, signal?: AbortSignal): Promise<CriteriaReadResult>;
  /** Uma chamada só: o documento inteiro, que a API substitui (ADR-021 D7). */
  writeCriteria(accessToken: string, criteria: UserCriteria, signal?: AbortSignal): Promise<CriteriaWriteResult>;
}

export const API_CLIENT_POLICY = Object.freeze({ timeoutMs: 5_000, maxResponseBytes: 32 * 1024 });

export interface ApiClientConfig {
  readonly apiOrigin: string;
  /** Só para os testes encurtarem o prazo. */
  readonly timeoutMs?: number;
}

const ACCESS_TOKEN = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const CRITERIA_PATH = "/v1/criteria";

const READ_REFUSED = Object.freeze({ ok: false, reason: "recusado" } as const);
const READ_NOT_RECEIVED = Object.freeze({ ok: false, reason: "nao_recebido" } as const);
const NOT_CONFIGURED = Object.freeze({ ok: true, criteria: null } as const);
const WRITTEN = Object.freeze({ ok: true } as const);
const writeFailure = (reason: CriteriaWriteFailure): CriteriaWriteResult => ({ ok: false, reason });

const validToken = (token: string): boolean => token.length <= ACCESS_TOKEN_MAX_CHARS && ACCESS_TOKEN.test(token);

export function createApiClient(config: ApiClientConfig): ApiClient {
  if (!isExactOrigin(config.apiOrigin)) throw new Error("API_ORIGIN precisa ser uma origem exata");
  const endpoint = new URL(CRITERIA_PATH, config.apiOrigin);
  const timeoutMs = config.timeoutMs ?? API_CLIENT_POLICY.timeoutMs;

  const call = async (method: "GET" | "PUT", headers: Readonly<Record<string, string>>, body: string | null, signal: AbortSignal | undefined): Promise<Response | "nao_conectou" | "talvez"> => {
    if (signal?.aborted === true) return "nao_conectou";
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await fetch(endpoint, {
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
  };
}
