// Rate limit em Redis (ADR-014 D4): janela deslizante aproximada por usuário E por IP, numa transação só.
// O Redis só guarda contadores (INCR, PEXPIRE, GET); a decisão é dos algoritmos puros da aplicação. As chaves
// levam o HMAC do `sub` e do endereço, nunca o valor em claro (SR-17). Qualquer falha → `indisponivel`.
import { RATE_LIMIT_POLICY } from "../../application/limits/limit-policy.js";
import {
  isEpochMs,
  slidingWindowCount,
  windowPosition,
  windowRetryAfterSeconds,
} from "../../application/limits/windows.js";
import type { RateLimitDecision, RateLimiter } from "../../application/ports/rate-limiter.js";
import type { KeyPseudonymizer } from "../crypto/hmac-key-pseudonymizer.js";
import type { RedisCommand, RedisTransactions, RedisValue } from "../redis/upstash-rest-client.js";
import { asInteger, asStoredCount, isOne } from "./redis-replies.js";

export interface RedisLimitDeps {
  readonly redis: RedisTransactions;
  readonly pseudonymizer: KeyPseudonymizer;
  /** Relógio de parede em ms (Date.now em produção): define a janela e o dia. */
  readonly now: () => number;
}

const UNAVAILABLE = { ok: false, reason: "indisponivel" } as const;
const ALLOWED = { ok: true } as const;

/** Três comandos por contador: INCR da janela atual, PEXPIRE dela e GET da anterior. */
function counterCommands(prefix: string, index: number, ttlMs: number): RedisCommand[] {
  return [
    ["INCR", `${prefix}:${index}`],
    ["PEXPIRE", `${prefix}:${index}`, ttlMs],
    ["GET", `${prefix}:${index - 1}`],
  ];
}

/** As três respostas de um contador, na ordem de `counterCommands`. */
function readCounter([incr, pexpire, get]: readonly RedisValue[]): { current: number; previous: number } | null {
  const current = asInteger(incr, 1);
  const previous = asStoredCount(get);
  if (current === null || previous === null || !isOne(pexpire)) return null;
  return { current, previous };
}

export function createRedisRateLimiter(deps: RedisLimitDeps): RateLimiter {
  const { windowMs } = RATE_LIMIT_POLICY;
  // Duas janelas e um segundo: a janela anterior ainda pesa durante toda a janela atual.
  const ttlMs = windowMs * 2 + 1_000;

  return {
    async check(rateClass, subject, signal): Promise<RateLimitDecision> {
      try {
        const now = deps.now();
        if (!isEpochMs(now)) return UNAVAILABLE;
        const limits = RATE_LIMIT_POLICY.classes[rateClass];
        const position = windowPosition(now, windowMs);
        const userPrefix = `rl:${rateClass}:u:${deps.pseudonymizer.pseudonym("sub", subject.userId)}`;
        const addressPrefix = `rl:${rateClass}:ip:${deps.pseudonymizer.pseudonym("ip", subject.clientAddress)}`;
        const replies = await deps.redis.exec(
          [...counterCommands(userPrefix, position.index, ttlMs), ...counterCommands(addressPrefix, position.index, ttlMs)],
          signal,
        );
        if (replies === null) return UNAVAILABLE;
        const user = readCounter(replies.slice(0, 3));
        const address = readCounter(replies.slice(3, 6));
        if (user === null || address === null) return UNAVAILABLE;
        const weigh = (c: { current: number; previous: number }): number =>
          slidingWindowCount(c.previous, c.current, position.elapsedMs, windowMs);
        if (weigh(user) <= limits.user && weigh(address) <= limits.address) return ALLOWED;
        return {
          ok: false,
          reason: "limite_excedido",
          retryAfterSeconds: windowRetryAfterSeconds(position.elapsedMs, windowMs),
        };
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}
