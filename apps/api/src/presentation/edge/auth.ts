// onRequest: autenticação por `Authorization: Bearer` (ADR-013 D2 e D3), depois do CORS e do tipo de mídia e
// antes de ler o corpo. Só as rotas da lista pública passam sem token; qualquer outra, inclusive inexistente,
// exige token (rota nova nasce protegida). Nada do header nem do motivo da recusa vai para o log (SR-12).
import { ACCESS_TOKEN_MAX_CHARS } from "@trampo/contracts/limits";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AccessTokenVerifier, Principal } from "../../application/ports/access-token-verifier.js";
import { sendApiError } from "../api-error.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Preenchido pelo hook de autenticação; `null` só nas rotas públicas. */
    principal: Principal | null;
  }
}

/** Rotas que respondem sem token, por método e caminho exato (ADR-013 D2). */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set(["GET /health"]);

// Esquema sem diferenciar caixa (RFC 7235), um espaço e um token compacto JWS (três partes base64url). O teto do
// token (ADR-013 D3) vem do contrato e é conferido antes de tocar no jose. Sem a flag `u`: com ela, o `i` faria o
// `\w` aceitar U+017F e U+212A (ADR-004 D7).
const BEARER = /^bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i;

/** Extrai o token do header, ou `null` se a forma estiver errada. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined || header.length > ACCESS_TOKEN_MAX_CHARS + 7) return null;
  return BEARER.exec(header)?.[1] ?? null;
}

/** 401 com `WWW-Authenticate: Bearer` (ADR-013 D5). */
export function unauthenticated(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  void reply.header("www-authenticate", "Bearer");
  return sendApiError(reply, request.id, "NAO_AUTENTICADO");
}

/** Rota da lista pública? routeOptions.url é o padrão registrado; rota inexistente não tem e exige token. */
export function isPublicRoute(request: FastifyRequest): boolean {
  return PUBLIC_ROUTES.has(`${request.method} ${request.routeOptions.url ?? ""}`);
}

export function createAuthHook(verifier: AccessTokenVerifier) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    request.principal = null;
    if (isPublicRoute(request)) return undefined;

    const token = bearerToken(request.headers.authorization);
    if (token === null) return unauthenticated(request, reply);

    const result = await verifier.verify(token);
    if (result.ok) {
      request.principal = result.principal;
      return undefined;
    }
    if (result.reason === "chaves_indisponiveis") {
      // Sinal operacional do T30 (Supabase pausado ou JWKS fora): só a mensagem do catálogo, sem campos.
      request.log.warn("autenticacao_indisponivel");
      return sendApiError(reply, request.id, "SERVICO_INDISPONIVEL");
    }
    return unauthenticated(request, reply);
  };
}
