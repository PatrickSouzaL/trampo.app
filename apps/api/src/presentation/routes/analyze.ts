// POST /v1/analyze (ADR-017 D6 e D7). Registrada só com a opção `analysis` do buildApp.
//
// Ordem na borda, da rejeição mais barata à mais cara: hooks globais (CORS, tipo de mídia, JWT e rate limit
// `analise`), 64 KiB e o AnalyzeJobRequestSchema, o preHandler dos critérios e, por último, a cota diária. Os
// critérios vêm antes da cota: uma requisição que não pode ser analisada não gasta a cota do dia.
//
// Depois que o stream abre, qualquer falha vira um único evento `error` com ERRO_INTERNO e a mensagem do
// catálogo. Nada do erro sai no stream; o log recebe só o tipo, pela lista fechada do ADR-010.
//
// Histórico (ADR-031 D1): com a opção `recorder`, a análise é gravada só depois de o `result` sair (o `write`
// devolveu `true`), sem `await`: o fim do stream não espera a gravação, e nada do que o gravador faz (lançar,
// rejeitar, travar, devolver lixo) muda o que o cliente recebe. A falha vira só `analise_gravacao_falhou`.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import { type AnalysisReport, type AnalyzeJobRequest, AnalyzeJobRequestSchema, type UserCriteria } from "@trampo/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AnalysisRecorder } from "../../application/analysis/analysis-recorder.js";
import type { AnalysisAlert, AnalysisStage, AnalyzeJob } from "../../application/analysis/analyze-job.js";
import type {
  CriteriaLookup,
  CriteriaReader,
  CriteriaSubject,
} from "../../application/ports/criteria-repository.js";
import { apiError, sendApiError } from "../api-error.js";
import { bearerToken, unauthenticated } from "../edge/auth.js";
import { SSE_CONTENT_TYPE, SSE_HEADERS, SseStream } from "../streaming/sse-stream.js";

export const ANALYZE_ROUTE = "/v1/analyze";

export interface AnalysisRouteOptions {
  readonly job: Pick<AnalyzeJob, "run">;
  readonly criteria: CriteriaReader;
  /**
   * O gravador do histórico (ADR-031 D1). Padrão: nenhum. O composeApp não o liga até o consentimento (D6 e §7.2).
   */
  readonly recorder?: Pick<AnalysisRecorder, "record"> | null;
}

/** O que o preHandler carregou: os critérios e o dono (o `sub` verificado e o token desta requisição). */
export interface LoadedRequest {
  readonly criteria: UserCriteria;
  readonly subject: CriteriaSubject;
}

/**
 * Critérios carregados pelo preHandler, por requisição, com o dono. Fora do objeto da requisição: nada os serializa.
 * A entrada some com a requisição (WeakMap).
 */
export type LoadedCriteria = WeakMap<FastifyRequest, LoadedRequest>;

/** O log nunca derruba a análise nem o stream (um destino que lança, por exemplo). */
function safely(write: () => void): void {
  try {
    write();
  } catch {
    // Sem log possível: o próprio log falhou.
  }
}

/** A porta nunca rejeita (ADR-017 D1). Se rejeitar ou lançar, é banco fora do ar: falha fechado. */
async function loadCriteria(repository: CriteriaReader, subject: CriteriaSubject): Promise<CriteriaLookup> {
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
export function createCriteriaPreHandler(repository: CriteriaReader, loaded: LoadedCriteria) {
  return async function criteriaPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    const principal = request.principal;
    const accessToken = bearerToken(request.headers.authorization);
    if (principal === null || accessToken === null) return unauthenticated(request, reply);
    const subject: CriteriaSubject = { userId: principal.userId, accessToken };
    const lookup = await loadCriteria(repository, subject);
    if (lookup.found) {
      loaded.set(request, { criteria: lookup.criteria, subject });
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
 * Dispara a gravação sem esperar (ADR-031 D1). O gravador nunca rejeita pelo contrato; mesmo assim, o que ele lançar,
 * rejeitar ou devolver fora de `gravada` vira só a linha de log sem campo.
 */
function recordInBackground(recorder: Pick<AnalysisRecorder, "record">, request: FastifyRequest, subject: CriteriaSubject, report: AnalysisReport): void {
  const failed = (): void => safely(() => request.log.warn("analise_gravacao_falhou"));
  let pending: Promise<unknown>;
  try {
    pending = Promise.resolve(recorder.record(subject, report));
  } catch {
    pending = Promise.resolve(null);
  }
  void pending.then((outcome) => {
    if (outcome !== "gravada") failed();
  }, failed);
}

/**
 * Roda a análise e escreve o stream. Nunca rejeita: termina sempre com exatamente um `result` ou um `error`,
 * a menos que o cliente tenha ido embora (aí nada mais é escrito).
 */
async function streamAnalysis(
  options: Pick<AnalysisRouteOptions, "job" | "recorder">,
  request: FastifyRequest,
  body: AnalyzeJobRequest,
  loaded: LoadedRequest,
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
    const report = await options.job.run({ request: body, criteria: loaded.criteria, onStage, onAlert });
    // Só o que saiu: com o cliente fora (o `write` devolve `false`), ninguém viu o `analysisId`.
    const delivered = sse.write({ type: "result", report });
    if (delivered && options.recorder !== undefined && options.recorder !== null) {
      recordInBackground(options.recorder, request, loaded.subject, report);
    }
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
export function createAnalyzeHandler(
  job: AnalysisRouteOptions["job"],
  loaded: LoadedCriteria,
  recorder: AnalysisRouteOptions["recorder"] = null,
) {
  const options = { job, recorder };
  return async function analyzeHandler(request: FastifyRequest, body: AnalyzeJobRequest, reply: FastifyReply): Promise<FastifyReply> {
    const entry = loaded.get(request);
    if (entry === undefined) throw new Error("Rota de análise sem o preHandler dos critérios.");
    const sse = new SseStream();
    void streamAnalysis(options, request, body, entry, sse);
    // Sem hijack: os cabeçalhos que os hooks já puseram (CORS, vary) e o log de resposta continuam valendo.
    return reply.code(200).headers(SSE_HEADERS).type(SSE_CONTENT_TYPE).send(sse.readable);
  };
}

export const analyzeRoutes: FastifyPluginAsyncZod<AnalysisRouteOptions> = async (app, options) => {
  const loaded: LoadedCriteria = new WeakMap();
  const handler = createAnalyzeHandler(options.job, loaded, options.recorder);
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
