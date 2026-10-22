// Guardas em volta das portas de rate limit e de cota (ADR-014 D1). O hook da presentation só fala com eles.
// Cada guarda confere a entrada, dá um prazo à porta (withDeadline, como o router do ADR-009 D4) e
// confere a forma da resposta. Exceção, rejeição, demora ou resposta fora do contrato viram `indisponivel`:
// nunca liberam (SR-06, T39). Nunca rejeitam.
import { z } from "zod";

import type { Clock } from "../ports/clock.js";
import type { DailyQuota, DailyQuotaDecision } from "../ports/daily-quota.js";
import type { RateLimitClass, RateLimitDecision, RateLimiter, RateLimitSubject } from "../ports/rate-limiter.js";
import { withDeadline } from "../shared/with-deadline.js";
import { LIMIT_GUARD_POLICY } from "./limit-policy.js";

const RETRY_AFTER_SECONDS = z.int().min(1).max(86_400);

const RateLimitDecisionSchema = z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), reason: z.literal("limite_excedido"), retryAfterSeconds: RETRY_AFTER_SECONDS }),
  z.strictObject({ ok: z.literal(false), reason: z.literal("indisponivel") }),
]);

const DailyQuotaDecisionSchema = z.union([
  z.strictObject({ ok: z.literal(true), repeated: z.boolean() }),
  z.strictObject({ ok: z.literal(false), reason: z.literal("esgotada"), retryAfterSeconds: RETRY_AFTER_SECONDS }),
  z.strictObject({ ok: z.literal(false), reason: z.literal("indisponivel") }),
]);

const RateLimitInputSchema = z.strictObject({
  rateClass: z.enum(["padrao", "analise"]),
  userId: z.uuid(),
  clientAddress: z.string().min(1).max(64),
});
const DailyQuotaInputSchema = z.strictObject({ userId: z.uuid(), requestId: z.uuid() });

const UNAVAILABLE = { ok: false, reason: "indisponivel" } as const;

/** Prazo na porta e forma conferida na resposta: o que sair do contrato vira `fallback`. */
function guarded<T>(
  clock: Clock,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<unknown>,
  schema: z.ZodType<T>,
  fallback: T,
): Promise<T> {
  return withDeadline(
    clock,
    timeoutMs,
    (signal) =>
      operation(signal).then((value) => {
        const parsed = schema.safeParse(value);
        return parsed.success ? parsed.data : fallback;
      }),
    fallback,
  );
}

export class RateLimitGuard {
  readonly #limiter: RateLimiter;
  readonly #clock: Clock;
  readonly #timeoutMs: number;

  constructor(limiter: RateLimiter, clock: Clock, timeoutMs: number = LIMIT_GUARD_POLICY.timeoutMs) {
    this.#limiter = limiter;
    this.#clock = clock;
    this.#timeoutMs = timeoutMs;
  }

  check(rateClass: RateLimitClass, subject: RateLimitSubject): Promise<RateLimitDecision> {
    const input = RateLimitInputSchema.safeParse({ rateClass, ...subject });
    if (!input.success) return Promise.resolve(UNAVAILABLE);
    const { userId, clientAddress } = input.data;
    return guarded<RateLimitDecision>(
      this.#clock,
      this.#timeoutMs,
      (signal) => this.#limiter.check(input.data.rateClass, { userId, clientAddress }, signal),
      RateLimitDecisionSchema,
      UNAVAILABLE,
    );
  }
}

export class DailyQuotaGuard {
  readonly #quota: DailyQuota;
  readonly #clock: Clock;
  readonly #timeoutMs: number;

  constructor(quota: DailyQuota, clock: Clock, timeoutMs: number = LIMIT_GUARD_POLICY.timeoutMs) {
    this.#quota = quota;
    this.#clock = clock;
    this.#timeoutMs = timeoutMs;
  }

  consume(userId: string, requestId: string): Promise<DailyQuotaDecision> {
    const input = DailyQuotaInputSchema.safeParse({ userId, requestId });
    if (!input.success) return Promise.resolve(UNAVAILABLE);
    return guarded<DailyQuotaDecision>(
      this.#clock,
      this.#timeoutMs,
      (signal) => this.#quota.consume(input.data.userId, input.data.requestId, signal),
      DailyQuotaDecisionSchema,
      UNAVAILABLE,
    );
  }
}
