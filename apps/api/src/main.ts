// Ponto de entrada: valida o ambiente, sobe o servidor e encerra limpo em SIGINT/SIGTERM.
import { z } from "zod";

import { buildApp } from "./presentation/build-app.js";
import { EdgeEnvSchema } from "./presentation/edge/edge-env.js";

const EnvSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  ...EdgeEnvSchema.shape,
});

// Ambiente inválido derruba o processo na subida (falha fechado), antes de abrir a porta.
const env = EnvSchema.parse(process.env);
const app = buildApp({ corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS, trustProxy: env.TRUST_PROXY });

const shutdown = (signal: string): void => {
  app.log.info({ signal }, "encerrando");
  void app.close().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ host: env.HOST, port: env.PORT });
