// Monta a instância Fastify (camada presentation; ADR-001 §7) com a borda E0 da F1-API-01
// (ADR-007): só o parser JSON, bodyLimit antes do parse, timeouts explícitos, trustProxy fechado e
// CORS com origens exatas, a autenticação por JWT da F1-API-02 (ADR-013) e o rate limit da F1-API-03 (ADR-014),
// no onRequest depois do JWT. A cota diária é um preHandler que a rota de análise usa. A rota POST /v1/analyze
// (F1-API-04, ADR-017 D7) só é registrada com a opção `analysis`, e GET e PUT /v1/criteria (F1-API-05, ADR-021 D2)
// só com a opção `criteria`. As rotas do BFF de autenticação (F1-API-07 07g, ADR-004 D4) só com a opção `auth`.
import { randomUUID } from "node:crypto";

import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "@fastify/type-provider-zod";
import { HTTP_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import Fastify from "fastify";

import type { DailyQuotaGuard, RateLimitGuard } from "../application/limits/limit-guards.js";
import type { AccessTokenVerifier } from "../application/ports/access-token-verifier.js";
import { apiError } from "./api-error.js";
import { createAuthHook } from "./edge/auth.js";
import { edgeClientErrorHandler } from "./edge/client-error.js";
import { createCorsHook } from "./edge/cors.js";
import { createDailyQuotaPreHandler } from "./edge/daily-quota.js";
import { mediaTypeHook } from "./edge/media-type.js";
import { createRateLimitHook } from "./edge/rate-limit.js";
import { EDGE_TIMEOUTS, type EdgeTimeouts } from "./edge/timeouts.js";
import { createLoggerOptions, type LoggerConfig } from "./logging/log-policy.js";
import { type AnalysisRouteOptions, analyzeRoutes } from "./routes/analyze.js";
import { type AuthRouteOptions, authRoutes } from "./routes/auth.js";
import { type CriteriaRouteOptions, criteriaRoutes } from "./routes/criteria.js";
import { healthRoutes } from "./routes/health.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Cota diária idempotente por requestId (ADR-014 D5): o preHandler da rota de análise. */
    dailyQuotaPreHandler: ReturnType<typeof createDailyQuotaPreHandler>;
  }
}

/** Guardas de limite criados uma vez no boot (ADR-014 D8). Obrigatórios: não há padrão que libere tudo. */
export interface EdgeLimits {
  readonly rateLimit: RateLimitGuard;
  readonly dailyQuota: DailyQuotaGuard;
}

export interface BuildAppOptions {
  /** Verificação do access token (ADR-013 D1). Obrigatório: não há padrão que aceite tudo. */
  readonly accessTokenVerifier: AccessTokenVerifier;
  /** Rate limit e cota diária (ADR-014 D1). */
  readonly limits: EdgeLimits;
  /**
   * `false` desliga o log. Senão, vale a lista fechada do ADR-010, que não é configurável: só o nível e o
   * destino mudam (os testes do SR-12 capturam as linhas pelo `stream`).
   */
  readonly logger?: false | LoggerConfig;
  /** Origens exatas de navegador (ADR-007 D6). Padrão: nenhuma. */
  readonly corsAllowedOrigins?: readonly string[];
  /** IPs ou CIDRs dos saltos de proxy reais (ADR-007 D5). Padrão: `false` (ignora X-Forwarded-For). */
  readonly trustProxy?: false | readonly string[];
  /** Só para os testes encurtarem os prazos. Produção usa EDGE_TIMEOUTS. */
  readonly timeouts?: Partial<EdgeTimeouts>;
  /**
   * O AnalyzeJob e os critérios (ADR-017 D7). Sem a opção, POST /v1/analyze é rota inexistente. O main.ts só a
   * passa no F1-API-04b, depois do CriteriaRepository do Supabase (F1-DB-01).
   */
  readonly analysis?: AnalysisRouteOptions;
  /**
   * O CriteriaGuard que lê e grava os critérios do dono (ADR-021 §4). Sem a opção, GET e PUT /v1/criteria são rotas
   * inexistentes (404 PROIBIDO). O composeApp passa o mesmo guarda da análise.
   */
  readonly criteria?: CriteriaRouteOptions;
  /**
   * Os casos de uso do BFF (07f), o limitador local pré-JWT e a amostragem de log (ADR-004 D4 e D8). Sem a opção, as
   * rotas /v1/auth/* são inexistentes. O composeApp monta tudo uma vez por processo.
   */
  readonly auth?: AuthRouteOptions;
}

/** Caminho do texto da vaga no AnalyzeJobRequestSchema: curto demais é 422, não 400 (ADR-017 D6). */
const JOB_TEXT_PATH = "/job/text";

function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

/** Todas as issues da validação são `too_small` no texto da vaga? */
function onlyShortJobText(validation: unknown): boolean {
  if (!Array.isArray(validation) || validation.length === 0) return false;
  return validation.every((issue: unknown) => {
    const fields = fieldsOf(issue);
    return fields["keyword"] === "too_small" && fields["instancePath"] === JOB_TEXT_PATH;
  });
}

/** Qualquer valor pode ser lançado: lê só os campos que importam, sem confiar no tipo. */
function inspectThrown(thrown: unknown): { statusCode: number; isValidation: boolean; isShortText: boolean } {
  const fields = fieldsOf(thrown);
  const status = fields["statusCode"];
  return {
    statusCode: typeof status === "number" && Number.isInteger(status) ? status : 500,
    isValidation: fields["validation"] !== undefined,
    isShortText: onlyShortJobText(fields["validation"]),
  };
}

export function buildApp(options: BuildAppOptions) {
  const timeouts: EdgeTimeouts = { ...EDGE_TIMEOUTS, ...options.timeouts };
  // Conjunto fechado das rotas registradas: só elas aparecem no campo `route` do log (ADR-010 D1).
  const knownRoutes = new Set<string>();
  const app = Fastify({
    logger: options.logger === false ? false : createLoggerOptions(options.logger ?? {}, knownRoutes),
    // O id de correlação é sempre do servidor (UUID): o header do cliente é ignorado.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    // SR-07: recusa pelo Content-Length antes de ler e pela contagem durante o streaming (413).
    bodyLimit: HTTP_BODY_MAX_BYTES,
    // Padrões do Fastify, declarados para não depender deles (threat-model T17).
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
    trustProxy: options.trustProxy === undefined || options.trustProxy === false ? false : [...options.trustProxy],
    connectionTimeout: timeouts.connectionTimeout,
    keepAliveTimeout: timeouts.keepAliveTimeout,
    requestTimeout: timeouts.requestTimeout,
    http: {
      headersTimeout: timeouts.headersTimeout,
      requestTimeout: timeouts.requestTimeout,
      connectionsCheckingInterval: timeouts.connectionsCheckingInterval,
    },
    clientErrorHandler: edgeClientErrorHandler,
  }).withTypeProvider<ZodTypeProvider>();
  app.addHook("onRoute", (route) => {
    knownRoutes.add(route.url);
  });

  // Só o parser JSON (secure-json-parse) fica registrado: text/plain sai (ADR-007 D1).
  app.removeContentTypeParser("text/plain");
  // Ordem do ADR-001 §5.1, da rejeição mais barata à mais cara, sem ler o corpo.
  app.addHook("onRequest", createCorsHook(options.corsAllowedOrigins ?? []));
  app.addHook("onRequest", mediaTypeHook);
  // JWT antes de ler o corpo: sem token, 401 sem parse (ADR-013 D2).
  app.decorateRequest("principal", null);
  app.addHook("onRequest", createAuthHook(options.accessTokenVerifier));
  // Rate limit só depois de um JWT válido: sem token, nenhum comando do Redis é gasto (ADR-014 D4).
  app.addHook("onRequest", createRateLimitHook(options.limits.rateLimit));
  app.decorate("dailyQuotaPreHandler", createDailyQuotaPreHandler(options.limits.dailyQuota));

  // Validação de entrada E de saída com Zod: a resposta também é conferida contra o schema.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setNotFoundHandler((request, reply) => {
    // O contrato v1 não tem código de "não encontrado". Rota inexistente responde 404 com o
    // código genérico PROIBIDO, sem dizer o que existe ou não (anti-enumeração).
    const { status, body } = apiError("PROIBIDO", request.id, { status: 404 });
    return reply.code(status).send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    const e = inspectThrown(error);
    const code =
      e.isShortText
        ? "TEXTO_CURTO_DEMAIS"
        : e.isValidation
        ? "PAYLOAD_INVALIDO"
        : e.statusCode === 413
          ? "PAYLOAD_GRANDE_DEMAIS"
          : e.statusCode >= 400 && e.statusCode < 500
            ? "PAYLOAD_INVALIDO"
            : "ERRO_INTERNO";
    if (code === "ERRO_INTERNO") {
      // Detalhe só no log do servidor (tipo e código do erro, pela lista fechada), nunca na resposta.
      request.log.error({ err: error }, "erro_interno");
    }
    // 413 e 415 mantêm o status HTTP: o contrato v1 não tem código próprio para 415 (ADR-007 D7).
    const keepStatus = e.statusCode === 413 || e.statusCode === 415;
    const { status, body } = apiError(code, request.id, keepStatus ? { status: e.statusCode } : {});
    return reply.code(status).send(body);
  });

  void app.register(healthRoutes);
  if (options.analysis !== undefined) void app.register(analyzeRoutes, options.analysis);
  if (options.criteria !== undefined) void app.register(criteriaRoutes, options.criteria);
  if (options.auth !== undefined) void app.register(authRoutes, options.auth);
  return app;
}
