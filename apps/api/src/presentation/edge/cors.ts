// onRequest: CORS com lista EXATA de origens, por hook próprio (ADR-007 D6). Origem fora da lista é
// recusada na borda (403), não só pelo navegador. Sem Allow-Credentials: a autenticação é Bearer.
// A origem da extensão só alcança as rotas de EXTENSION_ROUTES (ADR-021 D8.3, emenda ao ADR-007 D6): os
// critérios, com a pretensão em claro, nunca vão para a extensão.
import type { FastifyReply, FastifyRequest } from "fastify";

import { sendApiError } from "../api-error.js";

export const CORS_ALLOWED_METHODS = ["GET", "POST", "PUT"] as const;
export const CORS_ALLOWED_HEADERS = ["authorization", "content-type"] as const;
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * Lista positiva das rotas que a origem da extensão alcança: método e caminho exatos. O F1-API-06 acrescenta a
 * rota de feedback, se o botão ficar no Side Panel.
 */
export const EXTENSION_ROUTES: readonly { readonly method: string; readonly path: string }[] = Object.freeze([
  Object.freeze({ method: "POST", path: "/v1/analyze" }),
]);

const METHODS: ReadonlySet<string> = new Set(CORS_ALLOWED_METHODS);
const HEADERS: ReadonlySet<string> = new Set(CORS_ALLOWED_HEADERS);
const EXTENSION_ROUTE_KEYS: ReadonlySet<string> = new Set(EXTENSION_ROUTES.map((route) => `${route.method} ${route.path}`));
/** Origem de web: `https://` ou `http://` (loopback do portal em dev, já validado pelo edge-env). */
const WEB_ORIGIN = /^https?:\/\//;

/** `Access-Control-Request-Headers` só com nomes da lista (vazio é aceito). */
function headersAllowed(requested: string | undefined): boolean {
  if (requested === undefined) return true;
  return requested
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0)
    .every((name) => HEADERS.has(name));
}

/**
 * Só a origem de web alcança qualquer rota. Toda outra (a da extensão, pelo padrão EXTENSION_ORIGIN do edge-env, e
 * qualquer forma que chegue ao `buildApp` sem passar por ele) fica presa a EXTENSION_ROUTES: falha fechado.
 */
function restrictedToExtensionRoutes(origin: string): boolean {
  return !WEB_ORIGIN.test(origin);
}

/**
 * Método e caminho CRU (o `request.url` do Fastify é o `raw.url`) antes do primeiro `?`, sem decodificar nem
 * normalizar: `%61`, barra dupla, barra final, `..` e maiúsculas ficam fora da lista, embora o roteador decodifique
 * o `%61` e chegasse à rota.
 */
function extensionRouteAllowed(method: string, url: string): boolean {
  const query = url.indexOf("?");
  const path = query === -1 ? url : url.slice(0, query);
  return EXTENSION_ROUTE_KEYS.has(`${method} ${path}`);
}

export function createCorsHook(allowedOrigins: readonly string[]) {
  const origins: ReadonlySet<string> = new Set(allowedOrigins);

  return async function corsHook(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    // A resposta muda conforme a origem: caches intermediários precisam separar.
    void reply.header("vary", "Origin");
    const origin = request.headers.origin;
    // Sem Origin: não é navegador (ou é sonda da hospedagem). Segue sem CORS; o JWT protege.
    if (origin === undefined) return undefined;
    if (!origins.has(origin)) return sendApiError(reply, request.id, "PROIBIDO");
    const restricted = restrictedToExtensionRoutes(origin);

    const requestedMethod = request.headers["access-control-request-method"];
    if (request.method === "OPTIONS" && requestedMethod !== undefined) {
      if (
        !METHODS.has(requestedMethod) ||
        !headersAllowed(request.headers["access-control-request-headers"]) ||
        (restricted && !extensionRouteAllowed(requestedMethod, request.url))
      ) {
        return sendApiError(reply, request.id, "PROIBIDO");
      }
      return reply
        .code(204)
        .header("access-control-allow-origin", origin)
        .header("access-control-allow-methods", CORS_ALLOWED_METHODS.join(", "))
        .header("access-control-allow-headers", CORS_ALLOWED_HEADERS.join(", "))
        .header("access-control-max-age", String(CORS_PREFLIGHT_MAX_AGE_SECONDS))
        .send();
    }

    // A requisição real também é conferida: o preflight é do navegador, e quem não o faz não passa por ele.
    if (restricted && !extensionRouteAllowed(request.method, request.url)) return sendApiError(reply, request.id, "PROIBIDO");

    // Vale também para as respostas de erro: a extensão precisa ler o ApiError.
    void reply.header("access-control-allow-origin", origin);
    return undefined;
  };
}
