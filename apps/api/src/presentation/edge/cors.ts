// onRequest: CORS com lista EXATA de origens, por hook próprio (ADR-007 D6). Origem fora da lista é
// recusada na borda (403), não só pelo navegador. Sem Allow-Credentials: a autenticação é Bearer.
// A origem da extensão só alcança as rotas de EXTENSION_ROUTES (ADR-021 D8.3, emenda ao ADR-007 D6): os
// critérios, com a pretensão em claro, nunca vão para a extensão.
// As rotas do BFF de autenticação (ADR-004 D8 item 2, F1-API-07 07g) são só da extensão: a origem de web leva 403
// (EXTENSION_ONLY_ROUTES). Nas duas públicas, sem JWT que as proteja, o `Origin` é obrigatório (ORIGIN_REQUIRED_ROUTES):
// é higiene, não controle. As duas listas valem pelo caminho cru e também pelo padrão que o roteador casou, porque o
// roteador decodifica `%61uth` e chegaria à rota com um caminho cru fora da lista.
import { AUTH_ROUTES } from "@trampo/contracts/auth";
import type { FastifyReply, FastifyRequest } from "fastify";

import { sendApiError } from "../api-error.js";

export const CORS_ALLOWED_METHODS = ["GET", "POST", "PUT"] as const;
export const CORS_ALLOWED_HEADERS = ["authorization", "content-type"] as const;
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

export interface CorsRoute {
  readonly method: string;
  readonly path: string;
}

const post = (path: string): CorsRoute => Object.freeze({ method: "POST", path });

/**
 * Lista positiva das rotas que a origem da extensão alcança: método e caminho exatos. O F1-API-06 acrescenta a
 * rota de feedback, se o botão ficar no Side Panel.
 */
export const EXTENSION_ROUTES: readonly CorsRoute[] = Object.freeze([
  post("/v1/analyze"),
  post(AUTH_ROUTES.exchange),
  post(AUTH_ROUTES.refresh),
  post(AUTH_ROUTES.logout),
]);

/** Só a extensão: a origem de web leva 403 (ADR-004 D8 item 2). O portal terá login próprio no servidor. */
export const EXTENSION_ONLY_ROUTES: readonly CorsRoute[] = Object.freeze([
  post(AUTH_ROUTES.exchange),
  post(AUTH_ROUTES.refresh),
  post(AUTH_ROUTES.logout),
]);

/** Sem `Origin`, 403: as rotas públicas de auth (exceção ao "sem Origin segue" do ADR-007 D6). */
export const ORIGIN_REQUIRED_ROUTES: readonly CorsRoute[] = Object.freeze([post(AUTH_ROUTES.exchange), post(AUTH_ROUTES.refresh)]);

const METHODS: ReadonlySet<string> = new Set(CORS_ALLOWED_METHODS);
const HEADERS: ReadonlySet<string> = new Set(CORS_ALLOWED_HEADERS);
const keysOf = (routes: readonly CorsRoute[]): ReadonlySet<string> => new Set(routes.map((route) => `${route.method} ${route.path}`));
const EXTENSION_ROUTE_KEYS = keysOf(EXTENSION_ROUTES);
const EXTENSION_ONLY_KEYS = keysOf(EXTENSION_ONLY_ROUTES);
const ORIGIN_REQUIRED_KEYS = keysOf(ORIGIN_REQUIRED_ROUTES);
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
function rawRouteKey(method: string, url: string): string {
  const query = url.indexOf("?");
  return `${method} ${query === -1 ? url : url.slice(0, query)}`;
}

/** Método e padrão que o roteador casou. Rota inexistente (e todo preflight) não tem padrão. */
function routedKey(request: FastifyRequest): string | null {
  const url = request.routeOptions.url;
  return url === undefined ? null : `${request.method} ${url}`;
}

/** Rota só da extensão, pelo caminho cru ou pelo padrão casado (este pega o `%61uth`). */
function extensionOnly(rawKey: string, routed: string | null): boolean {
  return EXTENSION_ONLY_KEYS.has(rawKey) || (routed !== null && EXTENSION_ONLY_KEYS.has(routed));
}

export function createCorsHook(allowedOrigins: readonly string[]) {
  const origins: ReadonlySet<string> = new Set(allowedOrigins);

  return async function corsHook(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    // A resposta muda conforme a origem: caches intermediários precisam separar.
    void reply.header("vary", "Origin");
    const origin = request.headers.origin;
    const routed = routedKey(request);
    // Sem Origin: não é navegador (ou é sonda da hospedagem). Segue sem CORS e o JWT protege, exceto nas rotas
    // públicas de auth, que não têm JWT: lá o Origin é obrigatório, pelo padrão casado.
    if (origin === undefined) {
      return routed !== null && ORIGIN_REQUIRED_KEYS.has(routed) ? sendApiError(reply, request.id, "PROIBIDO") : undefined;
    }
    if (!origins.has(origin)) return sendApiError(reply, request.id, "PROIBIDO");
    const restricted = restrictedToExtensionRoutes(origin);

    const requestedMethod = request.headers["access-control-request-method"];
    if (request.method === "OPTIONS" && requestedMethod !== undefined) {
      const rawKey = rawRouteKey(requestedMethod, request.url);
      if (
        !METHODS.has(requestedMethod) ||
        !headersAllowed(request.headers["access-control-request-headers"]) ||
        (restricted ? !EXTENSION_ROUTE_KEYS.has(rawKey) : EXTENSION_ONLY_KEYS.has(rawKey))
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
    const rawKey = rawRouteKey(request.method, request.url);
    if (restricted ? !EXTENSION_ROUTE_KEYS.has(rawKey) : extensionOnly(rawKey, routed)) {
      return sendApiError(reply, request.id, "PROIBIDO");
    }

    // Vale também para as respostas de erro: a extensão precisa ler o ApiError.
    void reply.header("access-control-allow-origin", origin);
    return undefined;
  };
}
