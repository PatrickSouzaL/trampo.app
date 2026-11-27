// POST /v1/analyses/:analysisId/feedback (ADR-031 D4). Registrada só com a opção `feedback` do buildApp.
//
// Ordem na borda, da rejeição mais barata à mais cara: hooks globais (CORS por rota, com a extensão pelo padrão
// roteado e pela regex do caminho cru; tipo de mídia; JWT; rate limit da classe `feedback`), o bodyLimit de 256 bytes
// (413 sem parse), o parâmetro e o corpo pelos schemas do contrato (400), e só então o serviço.
//
// O dono vem só do principal, e o token é o bearer já verificado: ele segue ao PostgREST para a RLS valer. Respostas:
// 204 na gravação; 404 PROIBIDO, igual ao da rota inexistente, para a análise que não existe e para a de outro dono
// (sem oráculo); 503 para o resto, com `feedback_gravacao_indisponivel` sem campo. `no-store` em toda resposta.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import {
  ANALYSIS_FEEDBACK_ROUTE,
  type AnalysisFeedbackParams,
  AnalysisFeedbackParamsSchema,
  type AnalysisFeedbackRequest,
  AnalysisFeedbackRequestSchema,
} from "@trampo/contracts/api";
import { ANALYSIS_FEEDBACK_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AnalysisFeedbackService } from "../../application/feedback/analysis-feedback-service.js";
import type { FeedbackSaveOutcome } from "../../application/ports/analysis-feedback-store.js";
import { apiError, sendApiError } from "../api-error.js";
import { bearerToken, unauthenticated } from "../edge/auth.js";

export interface FeedbackRouteOptions {
  /** O AnalysisFeedbackService (prazo e telemetria). */
  readonly service: Pick<AnalysisFeedbackService, "save">;
}

/** O log nunca derruba a resposta (um destino que lança, por exemplo). */
function safely(write: () => void): void {
  try {
    write();
  } catch {
    // Sem log possível: o próprio log falhou.
  }
}

/** O serviço nunca rejeita pelo contrato; se rejeitar ou lançar, é indisponível. */
async function save(service: FeedbackRouteOptions["service"], request: FastifyRequest, params: AnalysisFeedbackParams, body: AnalysisFeedbackRequest): Promise<FeedbackSaveOutcome | null> {
  const principal = request.principal;
  const accessToken = bearerToken(request.headers.authorization);
  if (principal === null || accessToken === null) return null;
  try {
    return await service.save({ userId: principal.userId, accessToken }, params.analysisId, body);
  } catch {
    return "indisponivel";
  }
}

export function createFeedbackHandler(service: FeedbackRouteOptions["service"]) {
  return async function feedbackHandler(
    request: FastifyRequest,
    params: AnalysisFeedbackParams,
    body: AnalysisFeedbackRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const outcome = await save(service, request, params, body);
    if (outcome === null) return unauthenticated(request, reply);
    if (outcome === "gravada") return reply.code(204).send();
    if (outcome === "negada") {
      // O mesmo par da rota inexistente (build-app.ts): nada diz se a análise existe.
      const { status, body: error } = apiError("PROIBIDO", request.id, { status: 404 });
      return reply.code(status).send(error);
    }
    safely(() => request.log.warn("feedback_gravacao_indisponivel"));
    return sendApiError(reply, request.id, "SERVICO_INDISPONIVEL");
  };
}

/** onSend da rota: vale para o sucesso, para o erro do handler e para o erro dos hooks globais (401, 403, 413, 429). */
async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  void reply.header("cache-control", "no-store");
  return payload;
}

export const feedbackRoutes: FastifyPluginAsyncZod<FeedbackRouteOptions> = async (app, options) => {
  const handler = createFeedbackHandler(options.service);
  app.post(
    ANALYSIS_FEEDBACK_ROUTE,
    {
      config: { rateLimit: "feedback" },
      bodyLimit: ANALYSIS_FEEDBACK_BODY_MAX_BYTES,
      schema: { params: AnalysisFeedbackParamsSchema, body: AnalysisFeedbackRequestSchema },
      onSend: noStore,
    },
    async (request, reply) => handler(request, request.params, request.body, reply),
  );
};
