// Cota diária em Redis, idempotente por `requestId` (ADR-014 D5). Um set por usuário e dia de Brasília:
// `SADD` marca o pedido (0 = repetição), `SCARD` conta e `EXPIRE` limpa. Passa se a contagem couber na cota.
// O pedido novo e negado sai do set em melhor esforço (`SREM`): se isso falhar, a contagem só fica MAIOR.
import { DAILY_QUOTA_POLICY } from "../../application/limits/limit-policy.js";
import { isEpochMs, quotaDay } from "../../application/limits/windows.js";
import type { DailyQuota, DailyQuotaDecision } from "../../application/ports/daily-quota.js";
import { asInteger, bestEffort, isOne } from "./redis-replies.js";
import type { RedisLimitDeps } from "./redis-rate-limiter.js";

const UNAVAILABLE = { ok: false, reason: "indisponivel" } as const;

export function createRedisDailyQuota(deps: RedisLimitDeps): DailyQuota {
  return {
    async consume(userId, requestId, signal): Promise<DailyQuotaDecision> {
      try {
        const now = deps.now();
        if (!isEpochMs(now)) return UNAVAILABLE;
        const { day, secondsUntilNextDay } = quotaDay(now, DAILY_QUOTA_POLICY.utcOffsetMinutes);
        const key = `quota:${deps.pseudonymizer.pseudonym("sub", userId)}:${day}`;
        const replies = await deps.redis.exec(
          [
            ["SADD", key, requestId],
            ["SCARD", key],
            ["EXPIRE", key, DAILY_QUOTA_POLICY.keyTtlSeconds],
          ],
          signal,
        );
        if (replies === null) return UNAVAILABLE;
        const added = asInteger(replies[0], 0);
        const count = asInteger(replies[1], 1);
        if (added === null || added > 1 || count === null || !isOne(replies[2])) return UNAVAILABLE;
        if (count <= DAILY_QUOTA_POLICY.analysesPerDay) return { ok: true, repeated: added === 0 };
        if (added === 1) bestEffort(deps.redis, [["SREM", key, requestId]]);
        return { ok: false, reason: "esgotada", retryAfterSeconds: secondsUntilNextDay };
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}
