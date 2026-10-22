// Portas de limite falsas para os testes da presentation (ADR-014 D1): o buildApp exige os guardas. Os
// adapters reais (Redis) são testados em test/infrastructure, contra um Upstash simulado.
import { DailyQuotaGuard, RateLimitGuard } from "../src/application/limits/limit-guards.js";
import type { DailyQuota, DailyQuotaDecision } from "../src/application/ports/daily-quota.js";
import type { RateLimitClass, RateLimiter, RateLimitSubject } from "../src/application/ports/rate-limiter.js";
import { systemClock } from "../src/infrastructure/time/system-clock.js";
import type { EdgeLimits } from "../src/presentation/build-app.js";

/** O que a porta falsa faz: uma decisão (qualquer valor, inclusive lixo) ou um modo de falha. */
export type FakeBehavior = { readonly kind: "valor"; readonly value: unknown } | { readonly kind: "lanca" | "rejeita" | "trava" };

function act(behavior: FakeBehavior): Promise<never> | Promise<unknown> {
  switch (behavior.kind) {
    case "lanca":
      throw new Error("redis fora do ar");
    case "rejeita":
      return Promise.reject(new Error("redis fora do ar"));
    case "trava":
      return new Promise(() => undefined);
    default:
      return Promise.resolve(behavior.value);
  }
}

export function fakeRateLimiter(behavior: FakeBehavior = { kind: "valor", value: { ok: true } }) {
  const calls: { rateClass: RateLimitClass; subject: RateLimitSubject }[] = [];
  const state = { behavior };
  const limiter: RateLimiter = {
    check(rateClass, subject) {
      calls.push({ rateClass, subject });
      return act(state.behavior) as never;
    },
  };
  return { limiter, calls, state };
}

export function fakeDailyQuota(behavior: FakeBehavior = { kind: "valor", value: { ok: true, repeated: false } satisfies DailyQuotaDecision }) {
  const calls: { userId: string; requestId: string }[] = [];
  const state = { behavior };
  const quota: DailyQuota = {
    consume(userId, requestId) {
      calls.push({ userId, requestId });
      return act(state.behavior) as never;
    },
  };
  return { quota, calls, state };
}

/** Guardas reais em volta de portas falsas, com o relógio real e um prazo curto para os testes. */
export function fakeLimits(options: { rate?: FakeBehavior; quota?: FakeBehavior; timeoutMs?: number } = {}) {
  const rate = fakeRateLimiter(options.rate);
  const quota = fakeDailyQuota(options.quota);
  const timeoutMs = options.timeoutMs ?? 100;
  const limits: EdgeLimits = {
    rateLimit: new RateLimitGuard(rate.limiter, systemClock, timeoutMs),
    dailyQuota: new DailyQuotaGuard(quota.quota, systemClock, timeoutMs),
  };
  return { limits, rate, quota };
}

/** Libera tudo: para os testes de borda que não tratam de limite. */
export const openLimits: EdgeLimits = fakeLimits().limits;
