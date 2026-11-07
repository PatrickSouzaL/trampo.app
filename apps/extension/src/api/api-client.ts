// O único `fetch` da extensão (ADR-004 D10 B9; o lint B2 barra `fetch` no resto de src/). Fala só com a
// origem da API, em caminhos de lista fechada, e o Bearer vai só nas 2 rotas que o exigem: o token nunca
// sai para uma rota pública nem para outra origem. Nada daqui vai a log: status e corpo voltam a quem chamou.
import { type AnalyzeJobRequestInput, AnalyzeJobRequestSchema } from "@trampo/contracts/api";
import {
  AUTH_ROUTES,
  AccessTokenSchema,
  type AuthExchangeRequest,
  AuthExchangeRequestSchema,
  type AuthLogoutRequest,
  AuthLogoutRequestSchema,
  type AuthRefreshRequest,
  AuthRefreshRequestSchema,
} from "@trampo/contracts/auth";
import type { z } from "zod";

/** Caminho do `POST /v1/analyze` (ADR-017 D6). */
export const ANALYZE_PATH = "/v1/analyze";

/** Pior caso legítimo da troca e da renovação: token de 8.192 + envelope de 1.100 + o JSON em volta (< 9,5 KB). */
const AUTH_RESPONSE_MAX_BYTES = 16_384;
/**
 * Teto provisório do stream SSE da análise. O leitor do stream, o prazo e o teto definitivos são da F1-EXT-04
 * parte 2: a análise com o fallback do LLM pode passar dos 10 s (Groq até 3 s e Workers AI até 10 s, ADR-009 §5).
 */
const ANALYZE_RESPONSE_MAX_BYTES = 65_536;

/** Opções fixas de toda chamada (B9): sem cookie, sem seguir redirecionamento, sem cache e sem `Referer`. */
export const API_CLIENT_POLICY = Object.freeze({
  timeoutMs: 10_000,
  init: Object.freeze({
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  } satisfies RequestInit),
});

interface RoutePolicy {
  readonly bearer: boolean;
  readonly body: z.ZodType;
  readonly responseMaxBytes: number;
}

/** A lista fechada. O Bearer vai só em `/v1/analyze` e `/v1/auth/logout`; as rotas públicas nunca o recebem. */
const ROUTES: ReadonlyMap<string, RoutePolicy> = new Map<string, RoutePolicy>([
  [AUTH_ROUTES.exchange, { bearer: false, body: AuthExchangeRequestSchema, responseMaxBytes: AUTH_RESPONSE_MAX_BYTES }],
  [AUTH_ROUTES.refresh, { bearer: false, body: AuthRefreshRequestSchema, responseMaxBytes: AUTH_RESPONSE_MAX_BYTES }],
  [AUTH_ROUTES.logout, { bearer: true, body: AuthLogoutRequestSchema, responseMaxBytes: AUTH_RESPONSE_MAX_BYTES }],
  [ANALYZE_PATH, { bearer: true, body: AnalyzeJobRequestSchema, responseMaxBytes: ANALYZE_RESPONSE_MAX_BYTES }],
]);

export type ApiCall =
  | { readonly path: typeof AUTH_ROUTES.exchange; readonly body: AuthExchangeRequest }
  | { readonly path: typeof AUTH_ROUTES.refresh; readonly body: AuthRefreshRequest }
  | { readonly path: typeof AUTH_ROUTES.logout; readonly body: AuthLogoutRequest; readonly accessToken: string }
  | { readonly path: typeof ANALYZE_PATH; readonly body: AnalyzeJobRequestInput; readonly accessToken: string };

/**
 * - `ok`: houve resposta HTTP, de qualquer status, com o corpo inteiro em UTF-8 válido (vazio no 204);
 * - `pedido_recusado`: nada saiu (caminho fora da lista, Bearer ausente ou indevido, corpo fora do contrato);
 * - `sem_resposta`: rede, redirecionamento ou prazo antes do status;
 * - `resposta_ilegivel`: o status chegou, mas o corpo passou do teto, do prazo ou não é UTF-8.
 */
export type ApiResult =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly reason: "pedido_recusado" | "sem_resposta" | "resposta_ilegivel" };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClient {
  /** Nunca rejeita. */
  post(call: ApiCall): Promise<ApiResult>;
}

export interface ApiClientOptions {
  /** Origem https exata da API (`TRAMPO_API_ORIGIN`, validada no build). */
  readonly apiOrigin: string;
  readonly fetch?: FetchLike;
}

const PEDIDO_RECUSADO: ApiResult = { ok: false, reason: "pedido_recusado" };
const SEM_RESPOSTA: ApiResult = { ok: false, reason: "sem_resposta" };
const RESPOSTA_ILEGIVEL: ApiResult = { ok: false, reason: "resposta_ilegivel" };

interface Prepared {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly responseMaxBytes: number;
}

/**
 * Cada campo da chamada é lido uma vez (um *getter* não troca o caminho entre a checagem e o envio). O corpo
 * vai pelo JSON que foi validado: a cópia por `JSON.parse` é o que o schema da rota confere.
 */
function prepare(call: ApiCall): Prepared | undefined {
  try {
    const { path, body, accessToken } = call as { readonly path: string; readonly body: unknown; readonly accessToken?: unknown };
    const route = ROUTES.get(path);
    if (route === undefined) return undefined;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (route.bearer) {
      const token = AccessTokenSchema.safeParse(accessToken);
      if (!token.success) return undefined;
      headers["authorization"] = `Bearer ${token.data}`;
    } else if (accessToken !== undefined) {
      return undefined;
    }
    const json = JSON.stringify(body);
    if (!route.body.safeParse(JSON.parse(json)).success) return undefined;
    return { path, headers, body: json, responseMaxBytes: route.responseMaxBytes };
  } catch {
    // Chamada que nem é objeto, *getter* que lança, ciclo, BigInt ou corpo `undefined`.
    return undefined;
  }
}

/** O corpo inteiro até o teto, em UTF-8 estrito; `undefined` se passar do teto ou se a leitura falhar. */
async function readBody(response: Response, maxBytes: number): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      total += chunk.value.byteLength;
      if (total > maxBytes) return undefined;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return undefined;
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { apiOrigin } = options;
  if (!URL.canParse(apiOrigin) || new URL(apiOrigin).origin !== apiOrigin || !apiOrigin.startsWith("https://")) {
    throw new Error("TRAMPO_API_ORIGIN fora da forma: precisa ser uma origem https exata");
  }
  const send: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  return {
    async post(call) {
      const prepared = prepare(call);
      if (prepared === undefined) return PEDIDO_RECUSADO;
      // O prazo cobre o pedido e a leitura do corpo; o abort também derruba o stream que passou do teto.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), API_CLIENT_POLICY.timeoutMs);
      try {
        let response: Response;
        try {
          response = await send(`${apiOrigin}${prepared.path}`, {
            method: "POST",
            headers: prepared.headers,
            body: prepared.body,
            ...API_CLIENT_POLICY.init,
            signal: controller.signal,
          });
        } catch {
          return SEM_RESPOSTA;
        }
        const body = await readBody(response, prepared.responseMaxBytes);
        if (body === undefined) return RESPOSTA_ILEGIVEL;
        return { ok: true, status: response.status, body };
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  };
}
