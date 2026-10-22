// preHandler da cota diária (ADR-014 D5 e D8): roda depois da validação do corpo, só na rota de análise
// (F1-API-04), e lê só o `requestId` já validado pelo schema da rota. Sem principal → 401; `requestId` fora da
// forma → 400 (a rota deveria ter barrado); cota esgotada → 429 com `Retry-After`; Redis indisponível → 503.
// Nada do `sub`, do `requestId` ou da contagem vai para o log (SR-12).
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { DailyQuotaGuard } from "../../application/limits/limit-guards.js";
import { sendApiError } from "../api-error.js";
import { unauthenticated } from "./auth.js";

const BodyWithRequestIdSchema = z.object({ requestId: z.uuid() });

export function createDailyQuotaPreHandler(guard: DailyQuotaGuard) {
  return async function dailyQuotaPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const principal = request.principal;
    if (principal === null) return unauthenticated(request, reply);
    const body = BodyWithRequestIdSchema.safeParse(request.body);
    if (!body.success) return sendApiError(reply, request.id, "PAYLOAD_INVALIDO");

    const decision = await guard.consume(principal.userId, body.data.requestId);
    if (decision.ok) return undefined;
    if (decision.reason === "esgotada") {
      return sendApiError(reply, request.id, "COTA_DIARIA_ESGOTADA", { retryAfterSeconds: decision.retryAfterSeconds });
    }
    request.log.warn("cota_indisponivel");
    return sendApiError(reply, request.id, "SERVICO_INDISPONIVEL");
  };
}
