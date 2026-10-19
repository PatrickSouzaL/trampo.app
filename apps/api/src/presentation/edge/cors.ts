// onRequest: CORS com lista EXATA de origens, por hook próprio (ADR-007 D6). Origem fora da lista é
// recusada na borda (403), não só pelo navegador. Sem Allow-Credentials: a autenticação é Bearer.
import type { FastifyReply, FastifyRequest } from "fastify";

import { sendApiError } from "../api-error.js";

export const CORS_ALLOWED_METHODS = ["GET", "POST", "PUT"] as const;
export const CORS_ALLOWED_HEADERS = ["authorization", "content-type"] as const;
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

const METHODS: ReadonlySet<string> = new Set(CORS_ALLOWED_METHODS);
const HEADERS: ReadonlySet<string> = new Set(CORS_ALLOWED_HEADERS);

/** `Access-Control-Request-Headers` só com nomes da lista (vazio é aceito). */
function headersAllowed(requested: string | undefined): boolean {
  if (requested === undefined) return true;
  return requested
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0)
    .every((name) => HEADERS.has(name));
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

    const requestedMethod = request.headers["access-control-request-method"];
    if (request.method === "OPTIONS" && requestedMethod !== undefined) {
      if (!METHODS.has(requestedMethod) || !headersAllowed(request.headers["access-control-request-headers"])) {
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

    // Vale também para as respostas de erro: a extensão precisa ler o ApiError.
    void reply.header("access-control-allow-origin", origin);
    return undefined;
  };
}
