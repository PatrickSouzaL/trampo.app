// Monta a instância Fastify (camada presentation; ADR-001 §7) com a borda E0 da F1-API-01
// (ADR-007): só o parser JSON, bodyLimit antes do parse, timeouts explícitos, trustProxy fechado e
// CORS com origens exatas. JWT (F1-API-02) e rate limit (F1-API-03) entram no onRequest, depois do CORS.
import { randomUUID } from "node:crypto";

import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "@fastify/type-provider-zod";
import { HTTP_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import Fastify, { type FastifyServerOptions } from "fastify";

import { apiError } from "./api-error.js";
import { edgeClientErrorHandler } from "./edge/client-error.js";
import { createCorsHook } from "./edge/cors.js";
import { mediaTypeHook } from "./edge/media-type.js";
import { EDGE_TIMEOUTS, type EdgeTimeouts } from "./edge/timeouts.js";
import { healthRoutes } from "./routes/health.js";

export interface BuildAppOptions {
  /** `false` nos testes; em produção, JSON do pino com os serializers mínimos abaixo. */
  readonly logger?: FastifyServerOptions["logger"];
  /** Origens exatas de navegador (ADR-007 D6). Padrão: nenhuma. */
  readonly corsAllowedOrigins?: readonly string[];
  /** IPs ou CIDRs dos saltos de proxy reais (ADR-007 D5). Padrão: `false` (ignora X-Forwarded-For). */
  readonly trustProxy?: false | readonly string[];
  /** Só para os testes encurtarem os prazos. Produção usa EDGE_TIMEOUTS. */
  readonly timeouts?: Partial<EdgeTimeouts>;
}

/** Log de requisição sem IP, sem query string e sem headers (threat-model T23; ADR-001 §5.9). */
const MINIMAL_SERIALIZERS = {
  req: (req: { id: string; method: string; routeOptions?: { url?: string | undefined } }) => ({
    id: req.id,
    method: req.method,
    route: req.routeOptions?.url ?? "rota_desconhecida",
  }),
  res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
};

/** Qualquer valor pode ser lançado: lê só os campos que importam, sem confiar no tipo. */
function inspectThrown(thrown: unknown): { statusCode: number; isValidation: boolean; name: string; code: string | undefined } {
  const fields: Record<string, unknown> = typeof thrown === "object" && thrown !== null ? { ...thrown } : {};
  const name = thrown instanceof Error ? thrown.name : "nao_error";
  const status = fields["statusCode"];
  return {
    statusCode: typeof status === "number" && Number.isInteger(status) ? status : 500,
    isValidation: fields["validation"] !== undefined,
    name,
    code: typeof fields["code"] === "string" ? fields["code"] : undefined,
  };
}

export function buildApp(options: BuildAppOptions = {}) {
  const timeouts: EdgeTimeouts = { ...EDGE_TIMEOUTS, ...options.timeouts };
  const app = Fastify({
    // base: null tira hostname e pid de toda linha (o nome da máquina não vai para o provedor de logs).
    logger: options.logger ?? { level: "info", base: null, serializers: MINIMAL_SERIALIZERS },
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

  // Só o parser JSON (secure-json-parse) fica registrado: text/plain sai (ADR-007 D1).
  app.removeContentTypeParser("text/plain");
  // Ordem do ADR-001 §5.1, da rejeição mais barata à mais cara, sem ler o corpo.
  app.addHook("onRequest", createCorsHook(options.corsAllowedOrigins ?? []));
  app.addHook("onRequest", mediaTypeHook);

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
      e.isValidation
        ? "PAYLOAD_INVALIDO"
        : e.statusCode === 413
          ? "PAYLOAD_GRANDE_DEMAIS"
          : e.statusCode >= 400 && e.statusCode < 500
            ? "PAYLOAD_INVALIDO"
            : "ERRO_INTERNO";
    if (code === "ERRO_INTERNO") {
      // Detalhe só no log do servidor (nome e código do erro), nunca na resposta.
      request.log.error({ errName: e.name, errCode: e.code }, "erro interno");
    }
    // 413 e 415 mantêm o status HTTP: o contrato v1 não tem código próprio para 415 (ADR-007 D7).
    const keepStatus = e.statusCode === 413 || e.statusCode === 415;
    const { status, body } = apiError(code, request.id, keepStatus ? { status: e.statusCode } : {});
    return reply.code(status).send(body);
  });

  void app.register(healthRoutes);
  return app;
}
