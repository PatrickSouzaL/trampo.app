// POST /v1/analyze (ADR-017 D6 e D7). Registrada só com a opção `analysis` do buildApp.
//
// Ordem na borda, da rejeição mais barata à mais cara: hooks globais (CORS, tipo de mídia, JWT e rate limit
// `analise`), 64 KiB e o AnalyzeJobRequestSchema, o preHandler dos critérios e, por último, a cota diária. Os
// critérios vêm antes da cota: uma requisição que não pode ser analisada não gasta a cota do dia.
//
// Depois que o stream abre, qualquer falha vira um único evento `error` com ERRO_INTERNO e a mensagem do
// catálogo. Nada do erro sai no stream; o log recebe só o tipo, pela lista fechada do ADR-010.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import { type AnalyzeJobRequest, AnalyzeJobRequestSchema, type UserCriteria } from "@trampo/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AnalysisAlert, AnalysisStage, AnalyzeJob } from "../../application/analysis/analyze-job.js";
import type {
  CriteriaLookup,
  CriteriaRepository,
  CriteriaSubject,
} from "../../application/ports/criteria-repository.js";
import { apiError, sendApiError } from "../api-error.js";
import { bearerToken, unauthenticated } from "../edge/auth.js";
import { SSE_CONTENT_TYPE, SSE_HEADERS, SseStream } from "../streaming/sse-stream.js";

export const ANALYZE_ROUTE = "/v1/analyze";

export interface AnalysisRouteOptions {
  readonly job: Pick<AnalyzeJob, "run">;
  readonly criteria: CriteriaRepository;
}

/**
 * Critérios carregados pelo preHandler, por requisição. Fora do objeto da requisição: nada os serializa. A entrada
 * some com a requisição (WeakMap).
 */
export type LoadedCriteria = WeakMap<FastifyRequest, UserCriteria>;

/** O log nunca derruba a análise nem o stream (um destino que lança, por exemplo). */
function safely(write: () => void): void {
  try {
    write();
  } catch {
    // Sem log possível: o próprio log falhou.
  }
}

/** A porta nunca rejeita (ADR-017 D1). Se rejeitar ou lançar, é banco fora do ar: falha fechado. */
async function loadCriteria(repository: CriteriaRepository, subject: CriteriaSubject): Promise<CriteriaLookup> {
  try {
    return await repository.load(subject);
  } catch {
    return { found: false, unavailable: true };
  }
}

/**
 * preHandler dos critérios (ADR-017 D6, passo 3). Sem principal ou sem token → 401; não configurados → 409; banco
 * fora do ar → 503. O token é o que o hook de autenticação já verificou nesta requisição: ele segue ao adapter para
 * a RLS valer (ADR-018 D6). Nada do `sub`, do token nem dos critérios vai para o log (SR-12).
 */
export function createCriteriaPreHandler(repository: CriteriaRepository, loaded: LoadedCriteria) {
  return async function criteriaPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    const principal = request.principal;
    const accessToken = bearerToken(request.headers.authorization);
    if (principal === null || accessToken === null) return unauthenticated(request, reply);
    const lookup = await loadCriteria(repository, { userId: principal.userId, accessToken });
    if (lookup.found) {
      loaded.set(request, lookup.criteria);
      return undefined;
    }
    if (lookup.unavailable === true) {
      safely(() => request.log.warn("criterios_indisponiveis"));
      return sendApiError(reply, request.id, "SERVICO_INDISPONIVEL");
    }
    return sendApiError(reply, request.id, "CRITERIOS_NAO_CONFIGURADOS");
  };
}

/**
 * Roda a análise e escreve o stream. Nunca rejeita: termina sempre com exatamente um `result` ou um `error`,
 * a menos que o cliente tenha ido embora (aí nada mais é escrito).
 */
async function streamAnalysis(
  job: AnalysisRouteOptions["job"],
  request: FastifyRequest,
  body: AnalyzeJobRequest,
  criteria: UserCriteria,
  sse: SseStream,
): Promise<void> {
  const onStage = (stage: AnalysisStage, elapsedMs: number): void => {
    try {
      sse.write({ type: "stage", stage, elapsedMs });
    } catch (error) {
      // Um estágio fora do contrato não interrompe a análise: o evento é descartado e o defeito vai ao log.
      safely(() => request.log.error({ err: error }, "erro_interno"));
    }
  };
  const onAlert = (alert: AnalysisAlert): void => {
    safely(() => request.log.warn(alert));
  };
  try {
    // Dentro do `try`, um `run` que lança de forma síncrona cai no mesmo `catch` que uma rejeição.
    const report = await job.run({ request: body, criteria, onStage, onAlert });
    sse.write({ type: "result", report });
  } catch (error) {
    safely(() => request.log.error({ err: error }, "erro_interno"));
    sse.write({ type: "error", error: apiError("ERRO_INTERNO", request.id).body });
  } finally {
    sse.end();
  }
}

/**
 * O handler da rota, com o corpo já validado pelo AnalyzeJobRequestSchema. Exportado para provar que, sem o
 * preHandler dos critérios, a rota falha fechado (500).
 */
export function createAnalyzeHandler(job: AnalysisRouteOptions["job"], loaded: LoadedCriteria) {
  return async function analyzeHandler(request: FastifyRequest, body: AnalyzeJobRequest, reply: FastifyReply): Promise<FastifyReply> {
    const criteria = loaded.get(request);
    if (criteria === undefined) throw new Error("Rota de análise sem o preHandler dos critérios.");
    const sse = new SseStream();
    void streamAnalysis(job, request, body, criteria, sse);
    // Sem hijack: os cabeçalhos que os hooks já puseram (CORS, vary) e o log de resposta continuam valendo.
    return reply.code(200).headers(SSE_HEADERS).type(SSE_CONTENT_TYPE).send(sse.readable);
  };
}

export const analyzeRoutes: FastifyPluginAsyncZod<AnalysisRouteOptions> = async (app, options) => {
  const loaded: LoadedCriteria = new WeakMap();
  const handler = createAnalyzeHandler(options.job, loaded);
  app.post(
    ANALYZE_ROUTE,
    {
      config: { rateLimit: "analise" },
      schema: { body: AnalyzeJobRequestSchema },
      // Critérios antes da cota (ADR-017 D6).
      preHandler: [createCriteriaPreHandler(options.criteria, loaded), app.dailyQuotaPreHandler],
    },
    async (request, reply) => handler(request, request.body, reply),
  );
};
