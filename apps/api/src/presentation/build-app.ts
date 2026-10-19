// Monta a instância Fastify (camada presentation; ADR-001 §7). Os limites da borda (bodyLimit,
// timeouts, CORS, só o parser JSON) são a F1-API-01.
import { randomUUID } from "node:crypto";

import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "@fastify/type-provider-zod";
import Fastify, { type FastifyServerOptions } from "fastify";

import { apiError } from "./api-error.js";
import { healthRoutes } from "./routes/health.js";

export interface BuildAppOptions {
  /** `false` nos testes; em produção, JSON do pino com os serializers mínimos abaixo. */
  readonly logger?: FastifyServerOptions["logger"];
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
  const app = Fastify({
    // base: null tira hostname e pid de toda linha (o nome da máquina não vai para o provedor de logs).
    logger: options.logger ?? { level: "info", base: null, serializers: MINIMAL_SERIALIZERS },
    // O id de correlação é sempre do servidor (UUID): o header do cliente é ignorado.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  }).withTypeProvider<ZodTypeProvider>();

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
    const { status, body } = apiError(code, request.id);
    return reply.code(status).send(body);
  });

  void app.register(healthRoutes);
  return app;
}
