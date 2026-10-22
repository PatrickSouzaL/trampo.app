// onRequest: rate limit por usuário e por IP (ADR-014 D4 e D8), logo depois do JWT e antes de ler o corpo.
// Rota pública passa sem contar. Rota protegida sem principal é quebra de invariante: 401, nunca liberação.
// Limite excedido → 429 com `Retry-After`; Redis indisponível ou fora do contrato → 503 (SR-06, T39).
// Nada do IP, do `sub` ou da chave vai para o log (SR-12): só a mensagem do catálogo, sem campos.
import type { FastifyReply, FastifyRequest } from "fastify";

import type { RateLimitGuard } from "../../application/limits/limit-guards.js";
import { resolveRateLimitClass } from "../../application/limits/limit-policy.js";
import type { RateLimitClass } from "../../application/ports/rate-limiter.js";
import { sendApiError } from "../api-error.js";
import { isPublicRoute, unauthenticated } from "./auth.js";
import { clientAddressBucket } from "./client-address.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Classe de rate limit da rota (ADR-014 D4). Sem classe: `padrao`. */
    rateLimit?: RateLimitClass;
  }
}

export function createRateLimitHook(guard: RateLimitGuard) {
  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    if (isPublicRoute(request)) return undefined;
    const principal = request.principal;
    if (principal === null) return unauthenticated(request, reply);

    const rateClass = resolveRateLimitClass(request.routeOptions.config.rateLimit);
    const decision = await guard.check(rateClass, {
      userId: principal.userId,
      clientAddress: clientAddressBucket(request.ip),
    });
    if (decision.ok) return undefined;
    if (decision.reason === "limite_excedido") {
      return sendApiError(reply, request.id, "LIMITE_DE_TAXA", { retryAfterSeconds: decision.retryAfterSeconds });
    }
    request.log.warn("limite_indisponivel");
    return sendApiError(reply, request.id, "SERVICO_INDISPONIVEL");
  };
}
