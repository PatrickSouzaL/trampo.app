// API do Trampo simulada em socket real (127.0.0.1) para o portal (ADR-028 §4.2): só o `GET` e o `PUT /v1/criteria`,
// com a borda que importa ao portal (ADR-021 D2, D7 e D8.1; ADR-007 D6). Reescrita aqui: o portal não importa a API.
//
// - Bearer conferido pelo `owner` dado pelo teste (os access emitidos pelo GoTrue simulado); sem ele, 401
//   `NAO_AUTENTICADO` com `WWW-Authenticate`, antes de ler o corpo (A3);
// - `GET`: 200 com a linha do dono, ou 409 `CRITERIOS_NAO_CONFIGURADOS`;
// - `PUT`: 415 sem `application/json`, 413 acima de 16.384 bytes, 400 fora do `UserCriteriaSchema` e 204 gravando;
// - toda resposta com `Cache-Control: no-store` e o corpo de erro do `ApiErrorSchema` (4 chaves, texto fixo);
// - os modos `responde`, `trava`, `lento`, `corta` e `redireciona` agem depois da borda, como os do GoTrue simulado;
// - cada pedido fica registrado com os cabeçalhos (a lista fechada do portal, condição 2).
import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { CRITERIA_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import { UserCriteriaSchema } from "@trampo/contracts/user-criteria";

export type FakeApiMode =
  | { readonly kind: "normal" }
  /** Responde com o status e o `code` dados, no corpo do `ApiError`; `body` troca o corpo inteiro. */
  | {
      readonly kind: "responde";
      readonly status: number;
      readonly code?: string;
      readonly body?: string;
      readonly contentType?: string | null;
      readonly retryAfter?: number;
    }
  | { readonly kind: "trava" }
  /** Processa (grava, no `PUT`) e só responde depois do atraso. */
  | { readonly kind: "lento"; readonly delayMs: number }
  /** Processa e corta a resposta no meio do corpo. */
  | { readonly kind: "corta" }
  | { readonly kind: "redireciona"; readonly location: string };

export interface FakeApiRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface FakeApiOptions {
  /** O dono do access (o `sub`), ou `null` para um Bearer que a API recusaria. */
  readonly owner: (accessToken: string) => string | null;
}

export interface FakeApi {
  readonly url: URL;
  readonly requests: FakeApiRequest[];
  mode: FakeApiMode;
  /** As linhas gravadas, por dono (o valor que o `GET` devolve, com a pretensão em claro). */
  readonly rows: Map<string, unknown>;
  close(): Promise<void>;
}

const MESSAGES: Readonly<Record<string, string>> = {
  NAO_AUTENTICADO: "Sessão expirada. Entre de novo para continuar.",
  PAYLOAD_INVALIDO: "Os dados enviados estão fora do formato esperado.",
  PAYLOAD_GRANDE_DEMAIS: "Os dados enviados passaram do tamanho máximo.",
  LIMITE_DE_TAXA: "Muitas análises seguidas. Tente de novo em instantes.",
  SERVICO_INDISPONIVEL: "Serviço indisponível. Tente de novo em instantes.",
  CRITERIOS_NAO_CONFIGURADOS: "Configure seus critérios no portal antes de analisar.",
  PROIBIDO: "Acesso proibido.",
  ERRO_INTERNO: "Erro interno.",
};

export function apiErrorBody(code: string, retryAfterSeconds: number | null = null): string {
  return JSON.stringify({ code, message: MESSAGES[code] ?? "Erro.", requestId: randomUUID(), retryAfterSeconds });
}

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly contentType?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
}

const BEARER = /^bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i;

export async function startFakeApi(options: FakeApiOptions): Promise<FakeApi> {
  const requests: FakeApiRequest[] = [];
  const rows = new Map<string, unknown>();
  const state = { mode: { kind: "normal" } as FakeApiMode };

  const error = (status: number, code: string, extra: Readonly<Record<string, string>> = {}): Reply => ({ status, body: apiErrorBody(code), headers: extra });

  const handle = (method: string, path: string, headers: IncomingHttpHeaders, body: Buffer): Reply => {
    if (path !== "/v1/criteria" || (method !== "GET" && method !== "PUT")) return error(404, "PROIBIDO");
    const token = BEARER.exec(headers.authorization ?? "")?.[1];
    const owner = token === undefined ? null : options.owner(token);
    if (owner === null) return error(401, "NAO_AUTENTICADO", { "www-authenticate": "Bearer" });
    if (method === "GET") {
      const row = rows.get(owner);
      return row === undefined ? error(409, "CRITERIOS_NAO_CONFIGURADOS") : { status: 200, body: JSON.stringify(row) };
    }
    const type = headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") return error(415, "PAYLOAD_INVALIDO");
    if (body.length > CRITERIA_BODY_MAX_BYTES) return error(413, "PAYLOAD_GRANDE_DEMAIS");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return error(400, "PAYLOAD_INVALIDO");
    }
    const criteria = UserCriteriaSchema.safeParse(parsed);
    if (!criteria.success) return error(400, "PAYLOAD_INVALIDO");
    rows.set(owner, criteria.data);
    return { status: 204, body: "", contentType: null };
  };

  const send = (response: ServerResponse, reply: Reply): void => {
    response.writeHead(reply.status, {
      "cache-control": "no-store",
      ...(reply.contentType === null ? {} : { "content-type": reply.contentType ?? "application/json; charset=utf-8" }),
      ...reply.headers,
    });
    response.end(reply.body);
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const method = request.method ?? "";
      const path = new URL(request.url ?? "/", "http://api.invalid").pathname;
      requests.push({ method, url: request.url ?? "", headers: request.headers, body: body.toString("utf8") });
      const mode = state.mode;
      switch (mode.kind) {
        case "normal":
          send(response, handle(method, path, request.headers, body));
          return;
        case "responde":
          send(response, {
            status: mode.status,
            body: mode.body ?? (mode.code === undefined ? "" : apiErrorBody(mode.code, mode.retryAfter ?? null)),
            contentType: mode.contentType === undefined ? "application/json; charset=utf-8" : mode.contentType,
            headers: mode.retryAfter === undefined ? {} : { "retry-after": String(mode.retryAfter) },
          });
          return;
        case "trava":
          return;
        case "lento": {
          const reply = handle(method, path, request.headers, body);
          setTimeout(() => send(response, reply), mode.delayMs);
          return;
        }
        case "corta": {
          const reply = handle(method, path, request.headers, body);
          const full = reply.body.length > 0 ? reply.body : "{}";
          response.writeHead(reply.status === 204 ? 200 : reply.status, { "content-type": "application/json", "content-length": String(full.length + 100) });
          response.write(full.slice(0, Math.max(1, Math.floor(full.length / 2))));
          setTimeout(() => response.socket?.destroy(), 20);
          return;
        }
        case "redireciona":
          response.writeHead(307, { location: mode.location });
          response.end();
          return;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: new URL(`http://127.0.0.1:${port}`),
    requests,
    get mode() {
      return state.mode;
    },
    set mode(value: FakeApiMode) {
      state.mode = value;
    },
    rows,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
