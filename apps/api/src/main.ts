// Ponto de entrada: valida o ambiente, sobe o servidor e encerra limpo em SIGINT/SIGTERM.
import { z } from "zod";

import { DailyQuotaGuard, RateLimitGuard } from "./application/limits/limit-guards.js";
import { createJoseAccessTokenVerifier } from "./infrastructure/auth/jose-access-token-verifier.js";
import { createHmacKeyPseudonymizer } from "./infrastructure/crypto/hmac-key-pseudonymizer.js";
import { LimitsEnvSchema } from "./infrastructure/limits/limits-env.js";
import { createRedisDailyQuota } from "./infrastructure/limits/redis-daily-quota.js";
import { createRedisRateLimiter } from "./infrastructure/limits/redis-rate-limiter.js";
import { createUpstashRestClient } from "./infrastructure/redis/upstash-rest-client.js";
import { systemClock } from "./infrastructure/time/system-clock.js";
import { buildApp } from "./presentation/build-app.js";
import { AuthEnvSchema } from "./presentation/edge/auth-env.js";
import { EdgeEnvSchema } from "./presentation/edge/edge-env.js";

const EnvSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  ...EdgeEnvSchema.shape,
});

// Ambiente inválido derruba o processo na subida (falha fechado), antes de abrir a porta.
const env = EnvSchema.parse(process.env);
const auth = AuthEnvSchema.parse(process.env);
const limitsEnv = LimitsEnvSchema.parse(process.env);

// Instâncias de limite criadas UMA vez no boot e compartilhadas por todas as requisições (ADR-014 D8; T39).
// O QuotaLedger em Redis (createRedisQuotaLedger) entra com o router no AnalyzeJob (F1-API-04).
const limitDeps = {
  redis: createUpstashRestClient({ url: limitsEnv.restUrl, token: limitsEnv.restToken }),
  pseudonymizer: createHmacKeyPseudonymizer(limitsEnv.pepper),
  now: () => Date.now(),
};
const app = buildApp({
  accessTokenVerifier: createJoseAccessTokenVerifier(auth),
  limits: {
    rateLimit: new RateLimitGuard(createRedisRateLimiter(limitDeps), systemClock),
    dailyQuota: new DailyQuotaGuard(createRedisDailyQuota(limitDeps), systemClock),
  },
  corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
  trustProxy: env.TRUST_PROXY,
});

const shutdown = (signal: string): void => {
  app.log.info({ signal }, "encerrando");
  void app.close().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ host: env.HOST, port: env.PORT });
