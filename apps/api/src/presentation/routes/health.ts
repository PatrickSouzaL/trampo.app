// GET /health: só diz que o processo responde. Não revela versão, dependências nem ambiente.
// Schema local: é operacional (sonda da hospedagem), não é contrato com a extensão ou o portal.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import { z } from "zod";

export const HealthResponseSchema = z.strictObject({ status: z.literal("ok") });

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/health", { schema: { response: { 200: HealthResponseSchema } } }, async () => ({ status: "ok" as const }));
};
