// QuotaLedger em Redis (ADR-009 D6; ADR-014 D6): cota por provedor com 15% de folga e breaker diário global
// de LLM. `reserve` conta a chamada numa transação (global do dia, RPM e RPD do provedor) e lê os tokens do
// minuto e do dia; a decisão é em TypeScript. Na negação, os contadores voltam em melhor esforço.
// Redis com erro, lento ou fora do contrato → `global_esgotado` (encerra a cadeia com `cota_esgotada`).
// `recordUsage` é melhor esforço. Nenhum dos dois rejeita. As chaves só levam o id do provedor (sem PII).
import type { LlmProviderId } from "@trampo/contracts";

import { LEDGER_POLICY, effectiveLimit, providerLimits } from "../../application/limits/limit-policy.js";
import { isEpochMs, utcDayAndMinute } from "../../application/limits/windows.js";
import type { TokenUsage } from "../../application/ports/job-facts-extractor.js";
import type { QuotaDecision, QuotaLedger } from "../../application/ports/quota-ledger.js";
import type { RedisTransactions } from "../redis/upstash-rest-client.js";
import { asInteger, asStoredCount, bestEffort, isOne } from "./redis-replies.js";

export interface RedisQuotaLedgerDeps {
  readonly redis: RedisTransactions;
  /** Relógio de parede em ms: os dias e minutos dos provedores são UTC. */
  readonly now: () => number;
}

interface LedgerKeys {
  readonly global: string;
  readonly rpm: string;
  readonly rpd: string;
  readonly tpm: string;
  readonly tpd: string;
}

function ledgerKeys(provider: LlmProviderId, epochMs: number): LedgerKeys {
  const { day, minute } = utcDayAndMinute(epochMs);
  return {
    global: `llm:global:${day}`,
    rpm: `llm:rpm:${provider}:${minute}`,
    rpd: `llm:rpd:${provider}:${day}`,
    tpm: `llm:tpm:${provider}:${minute}`,
    tpd: `llm:tpd:${provider}:${day}`,
  };
}

/** Chamadas: o contador já inclui esta reserva, então estoura quando passa do efetivo. */
function callsExceeded(count: number, published: number | null): boolean {
  return published !== null && count > effectiveLimit(published);
}

/** Tokens: gastos antes desta chamada, então bloqueia quando já chegaram ao efetivo. */
function tokensExhausted(spent: number, published: number | null): boolean {
  return published !== null && spent >= effectiveLimit(published);
}

function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= LEDGER_POLICY.maxTokensPerCall;
}

export function createRedisQuotaLedger(deps: RedisQuotaLedgerDeps): QuotaLedger {
  const { dayTtlSeconds, minuteTtlSeconds } = LEDGER_POLICY;

  return {
    async reserve(provider, signal): Promise<QuotaDecision> {
      try {
        const limits = providerLimits(provider);
        if (limits === null) return "provedor_esgotado";
        const now = deps.now();
        if (!isEpochMs(now)) return "global_esgotado";
        const keys = ledgerKeys(provider, now);
        const replies = await deps.redis.exec(
          [
            ["INCR", keys.global],
            ["EXPIRE", keys.global, dayTtlSeconds],
            ["INCR", keys.rpm],
            ["EXPIRE", keys.rpm, minuteTtlSeconds],
            ["INCR", keys.rpd],
            ["EXPIRE", keys.rpd, dayTtlSeconds],
            ["GET", keys.tpm],
            ["GET", keys.tpd],
          ],
          signal,
        );
        if (replies === null) return "global_esgotado";
        const global = asInteger(replies[0], 1);
        const rpm = asInteger(replies[2], 1);
        const rpd = asInteger(replies[4], 1);
        const tpm = asStoredCount(replies[6]);
        const tpd = asStoredCount(replies[7]);
        const expiresOk = isOne(replies[1]) && isOne(replies[3]) && isOne(replies[5]);
        if (global === null || rpm === null || rpd === null || tpm === null || tpd === null || !expiresOk) {
          return "global_esgotado";
        }
        const decision: QuotaDecision =
          global > LEDGER_POLICY.globalCallsPerDay
            ? "global_esgotado"
            : callsExceeded(rpm, limits.rpm) ||
                callsExceeded(rpd, limits.rpd) ||
                tokensExhausted(tpm, limits.tpm) ||
                tokensExhausted(tpd, limits.tpd)
              ? "provedor_esgotado"
              : "permitido";
        if (decision !== "permitido") {
          // A chamada não vai sair: ela não pode gastar o teto global nem o do provedor.
          bestEffort(deps.redis, [
            ["DECR", keys.global],
            ["DECR", keys.rpm],
            ["DECR", keys.rpd],
          ]);
        }
        return decision;
      } catch {
        return "global_esgotado";
      }
    },

    async recordUsage(provider, usage: TokenUsage): Promise<void> {
      try {
        if (!isTokenCount(usage.inputTokens) || !isTokenCount(usage.outputTokens)) return;
        const total = usage.inputTokens + usage.outputTokens;
        const now = deps.now();
        if (total === 0 || !isEpochMs(now)) return;
        const keys = ledgerKeys(provider, now);
        await deps.redis.exec(
          [
            ["INCRBY", keys.tpm, total],
            ["EXPIRE", keys.tpm, minuteTtlSeconds],
            ["INCRBY", keys.tpd, total],
            ["EXPIRE", keys.tpd, dayTtlSeconds],
          ],
          new AbortController().signal,
        );
      } catch {
        // Melhor esforço (ADR-009 D6): a contabilidade não derruba uma análise que já deu certo.
      }
    },
  };
}
