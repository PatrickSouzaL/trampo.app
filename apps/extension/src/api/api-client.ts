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
 * Prazos e tetos do `analyze` (F1-EXT-04 parte 2; ADR-025 §6 D9). Até o status, os 10 s do B9 (o Chrome encerra o SW
 * se a resposta do `fetch` passar de 30 s). Entre pedaços, 20 s: o maior silêncio do servidor é a extração (o router
 * tem 12 s e o cache, tetos próprios; ~12,5 s, ADR-017 D2). No total, 45 s. O stream 200 cabe em 64 KiB e o erro, em 16.
 */
export const ANALYZE_STREAM_POLICY = Object.freeze({
  statusMs: 10_000,
  idleMs: 20_000,
  totalMs: 45_000,
  streamMaxBytes: 65_536,
  errorMaxBytes: 16_384,
});
const ANALYZE_RESPONSE_MAX_BYTES = ANALYZE_STREAM_POLICY.streamMaxBytes;

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

/** O envio da vaga: o corpo do contrato e o access capturado por quem envia (D11.4). */
export interface AnalyzeCall {
  readonly body: AnalyzeJobRequestInput;
  readonly accessToken: string;
}

/** O leitor do stream responde a cada pedaço: `parar` derruba o `fetch`. */
export type StreamControl = "seguir" | "parar";

/**
 * - `stream: true`: o 200 em `text/event-stream`, com o fim `completo` (o servidor fechou), `parado` (o leitor pediu),
 *   `queda` (rede ou prazo depois do status) ou `ilegivel` (teto ou UTF-8);
 * - `stream: false`: outro status, com o corpo inteiro até 16 KiB (o `ApiError`);
 * - os motivos do `post`; o 200 em outro tipo de conteúdo é `resposta_ilegivel`;
 * - `cancelado`: quem chamou abortou (ADR-025 §6.3 D15), antes do status, durante o stream ou durante o corpo de erro.
 *   Depois do abort, é sempre este o resultado, mesmo que a resposta já tivesse chegado.
 */
export type AnalyzeResult =
  | { readonly ok: true; readonly stream: true; readonly fim: "completo" | "parado" | "queda" | "ilegivel" }
  | { readonly ok: true; readonly stream: false; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly reason: "pedido_recusado" | "sem_resposta" | "resposta_ilegivel" | "cancelado" };

export interface ApiClient {
  /** Nunca rejeita. */
  post(call: ApiCall): Promise<ApiResult>;
  /**
   * O `POST /v1/analyze` em SSE, com os prazos e tetos do D9. O `signal` de quem chama derruba o `fetch` na hora
   * (D15); depois dele, o `onText` não é mais chamado. Nunca rejeita.
   */
  analyze(call: AnalyzeCall, onText: (text: string) => StreamControl, signal?: AbortSignal): Promise<AnalyzeResult>;
}

export interface ApiClientOptions {
  /** Origem https exata da API (`TRAMPO_API_ORIGIN`, validada no build). */
  readonly apiOrigin: string;
  readonly fetch?: FetchLike;
}

// Valem para o `post` e para o `analyze`: os três motivos têm a mesma forma nos dois resultados.
const PEDIDO_RECUSADO = Object.freeze({ ok: false, reason: "pedido_recusado" } as const);
const SEM_RESPOSTA = Object.freeze({ ok: false, reason: "sem_resposta" } as const);
const RESPOSTA_ILEGIVEL = Object.freeze({ ok: false, reason: "resposta_ilegivel" } as const);
const CANCELADO = Object.freeze({ ok: false, reason: "cancelado" } as const);

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
async function readBody(response: Response, maxBytes: number, onChunk: () => void = () => undefined): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      onChunk();
      total += chunk.value.byteLength;
      if (total > maxBytes) return undefined;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return undefined;
  }
}

/** O tipo do conteúdo sem parâmetros e sem caixa: só `text/event-stream` é stream (ADR-017 D6). */
function isEventStream(contentType: string | null): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
}

type StreamEnd = Extract<AnalyzeResult, { stream: true }>["fim"];

/** Cada pedaço do 200, decodificado em UTF-8 estrito, vai ao leitor até o teto. Depois do `stopped`, nenhum vai. */
async function pumpStream(body: ReadableStream<Uint8Array>, onText: (text: string) => StreamControl, onChunk: () => void, stopped: () => boolean): Promise<StreamEnd> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      // Rede, ou o abort de um prazo.
      return "queda";
    }
    // O pedaço lido antes do abort de quem chama e entregue depois dele não chega ao leitor (D15).
    if (stopped()) return "queda";
    let text: string;
    try {
      if (chunk.done) {
        decoder.decode();
        return "completo";
      }
      onChunk();
      total += chunk.value.byteLength;
      if (total > ANALYZE_STREAM_POLICY.streamMaxBytes) return "ilegivel";
      text = decoder.decode(chunk.value, { stream: true });
    } catch {
      return "ilegivel";
    }
    if (text === "") continue;
    try {
      if (onText(text) === "parar") return "parado";
    } catch {
      return "parado";
    }
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

    async analyze(call, onText, signal) {
      let prepared: Prepared | undefined;
      try {
        prepared = prepare({ path: ANALYZE_PATH, body: call.body, accessToken: call.accessToken });
      } catch {
        prepared = undefined;
      }
      if (prepared === undefined) return PEDIDO_RECUSADO;
      if (signal?.aborted === true) return CANCELADO;
      const { path, headers, body: payload } = prepared;
      const policy = ANALYZE_STREAM_POLICY;
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      // O abort de quem chama (D15) cai no mesmo controlador dos prazos; o `fetch` só conhece o sinal interno.
      let cancelled = false;
      const cancel = (): void => {
        cancelled = true;
        controller.abort();
      };
      signal?.addEventListener("abort", cancel);
      const total = setTimeout(abort, policy.totalMs);
      // O primeiro prazo é o do status; cada pedaço do corpo troca por um prazo de inatividade novo.
      let idle = setTimeout(abort, policy.statusMs);
      const touch = (): void => {
        clearTimeout(idle);
        idle = setTimeout(abort, policy.idleMs);
      };
      const attempt = async (): Promise<AnalyzeResult> => {
        let response: Response;
        try {
          response = await send(`${apiOrigin}${path}`, {
            method: "POST",
            headers,
            body: payload,
            ...API_CLIENT_POLICY.init,
            signal: controller.signal,
          });
        } catch {
          return SEM_RESPOSTA;
        }
        // A resposta que chega depois do abort não é lida.
        if (cancelled) return CANCELADO;
        touch();
        if (response.status !== 200) {
          const body = await readBody(response, policy.errorMaxBytes, touch);
          if (body === undefined) return RESPOSTA_ILEGIVEL;
          return { ok: true, stream: false, status: response.status, body };
        }
        if (!isEventStream(response.headers.get("content-type"))) return RESPOSTA_ILEGIVEL;
        if (response.body === null) return { ok: true, stream: true, fim: "completo" };
        return { ok: true, stream: true, fim: await pumpStream(response.body, onText, touch, () => cancelled) };
      };
      try {
        const result = await attempt();
        // Depois do abort de quem chama, o resultado é sempre `cancelado`, em qualquer fase.
        return cancelled ? CANCELADO : result;
      } finally {
        clearTimeout(total);
        clearTimeout(idle);
        controller.abort();
        signal?.removeEventListener("abort", cancel);
      }
    },
  };
}
