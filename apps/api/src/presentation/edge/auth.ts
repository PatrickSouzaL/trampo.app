// onRequest: autenticação por `Authorization: Bearer` (ADR-013 D2 e D3), depois do CORS e do tipo de mídia e
// antes de ler o corpo. Só as rotas da lista pública passam sem token; qualquer outra, inclusive inexistente,
// exige token (rota nova nasce protegida). Nada do header nem do motivo da recusa vai para o log (SR-12).
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

/** Teto do token compacto, conferido antes de tocar no jose (ADR-013 D3). */
export const ACCESS_TOKEN_MAX_CHARS = 8_192;

// Esquema sem diferenciar caixa (RFC 7235), um espaço e um token compacto JWS (três partes base64url).
const BEARER = /^bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i;

/** Extrai o token do header, ou `null` se a forma estiver errada. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined || header.length > ACCESS_TOKEN_MAX_CHARS + 7) return null;
  return BEARER.exec(header)?.[1] ?? null;
}

function unauthenticated(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  void reply.header("www-authenticate", "Bearer");
  return sendApiError(reply, request.id, "NAO_AUTENTICADO");
}

export function createAuthHook(verifier: AccessTokenVerifier) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    request.principal = null;
    // routeOptions.url é o padrão da rota registrada; rota inexistente não tem e cai na exigência de token.
    if (PUBLIC_ROUTES.has(`${request.method} ${request.routeOptions.url ?? ""}`)) return undefined;

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
