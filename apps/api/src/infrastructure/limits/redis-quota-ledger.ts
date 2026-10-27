// QuotaLedger em Redis (ADR-009 D6; ADR-014 D6): cota por provedor com 15% de folga e breaker diário global
// de LLM. `reserve` conta a chamada numa transação (global do dia, RPM e RPD do provedor), lê o bloqueio por
// `Retry-After` (ADR-022 D7.3) e soma a reserva pessimista de tokens no minuto e no dia (ADR-022 D7.2), só no
// provedor que tem limite de tokens (e, por isso, reserva: invariante fixado no teste da política). A decisão é
// em TypeScript. Na negação, os contadores (e a reserva) voltam em melhor esforço.
// `recordUsage` reconcilia a reserva com o uso real; a chamada que não volta 200 não o chama, e a reserva cheia
// fica. `recordRateLimit` grava `llm:block:{provider}` pelo `Retry-After`.
// Redis com erro, lento ou fora do contrato → `global_esgotado` (encerra a cadeia com `cota_esgotada`).
// `recordUsage` e `recordRateLimit` são melhor esforço. Nenhum dos três rejeita. As chaves só levam o id do
// provedor (sem PII).
import type { LlmProviderId } from "@trampo/contracts";

import {
  LEDGER_POLICY,
  type ProviderLimits,
  effectiveLimit,
  providerLimits,
} from "../../application/limits/limit-policy.js";
import { isEpochMs, utcDayAndMinute } from "../../application/limits/windows.js";
import type { TokenUsage } from "../../application/ports/job-facts-extractor.js";
import type { QuotaDecision, QuotaLedger } from "../../application/ports/quota-ledger.js";
import type { RedisCommand, RedisTransactions, RedisValue } from "../redis/upstash-rest-client.js";
import { asInteger, bestEffort, isOne } from "./redis-replies.js";

export interface RedisQuotaLedgerDeps {
  readonly redis: RedisTransactions;
  /** Relógio de parede em ms: os dias e minutos dos provedores são UTC. */
  readonly now: () => number;
}

interface LedgerKeys {
  readonly global: string;
  readonly block: string;
  readonly rpm: string;
  readonly rpd: string;
  readonly tpm: string;
  readonly tpd: string;
}

function blockKey(provider: LlmProviderId): string {
  return `llm:block:${provider}`;
}

/** `null`, não finito ou negativo vira 60 s; o resto fica em [1 s, 1 h], inteiro (o `PX` exige). */
function blockMs(retryAfterMs: number | null): number {
  const { defaultMs, minMs, maxMs } = LEDGER_POLICY.rateLimitBlock;
  if (retryAfterMs === null || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return defaultMs;
  return Math.min(maxMs, Math.max(minMs, Math.ceil(retryAfterMs)));
}

function ledgerKeys(provider: LlmProviderId, epochMs: number): LedgerKeys {
  const { day, minute } = utcDayAndMinute(epochMs);
  return {
    global: `llm:global:${day}`,
    // O id do provedor é um enum fechado, sem dado de usuário: a chave não leva HMAC (o SR-17 é para usuário e IP).
    block: blockKey(provider),
    rpm: `llm:rpm:${provider}:${minute}`,
    rpd: `llm:rpd:${provider}:${day}`,
    tpm: `llm:tpm:${provider}:${minute}`,
    tpd: `llm:tpd:${provider}:${day}`,
  };
}

/** O contador já inclui esta chamada (ou a reserva dela), então estoura quando passa do efetivo. */
function exceeded(count: number, published: number | null): boolean {
  return published !== null && count > effectiveLimit(published);
}

/**
 * Resposta do `INCRBY` da reserva: inteiro com sinal. A reconciliação que cruza a virada do minuto ou do dia UTC
 * cai na janela nova e pode deixá-la negativa; o desvio é de no máximo (reserva − uso) por chamada, e a soma das
 * duas janelas fica exata (ADR-022 §5).
 */
function asReservedCount(value: RedisValue | undefined): number | null {
  return asInteger(value, Number.MIN_SAFE_INTEGER);
}

function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= LEDGER_POLICY.maxTokensPerCall;
}

/** Resposta do `EXISTS` de uma chave: 0 ou 1; o resto é `null` (falha fechado). */
function asFlag(value: RedisValue | undefined): boolean | null {
  return value === 0 || value === 1 ? value === 1 : null;
}

/** Com reserva: `INCRBY`, `EXPIRE`, `INCRBY`, `EXPIRE`. `null` se alguma resposta está fora da forma. */
function reservedTokens(replies: readonly RedisValue[], limits: ProviderLimits): boolean | null {
  const tpm = asReservedCount(replies[0]);
  const tpd = asReservedCount(replies[2]);
  if (tpm === null || tpd === null || !isOne(replies[1]) || !isOne(replies[3])) return null;
  return exceeded(tpm, limits.tpm) || exceeded(tpd, limits.tpd);
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
        const reserved = limits.reservedTokensPerCall;
        const tokens: RedisCommand[] =
          reserved === null
            ? []
            : [
                ["INCRBY", keys.tpm, reserved],
                ["EXPIRE", keys.tpm, minuteTtlSeconds],
                ["INCRBY", keys.tpd, reserved],
                ["EXPIRE", keys.tpd, dayTtlSeconds],
              ];
        const replies = await deps.redis.exec(
          [
            ["INCR", keys.global],
            ["EXPIRE", keys.global, dayTtlSeconds],
            ["INCR", keys.rpm],
            ["EXPIRE", keys.rpm, minuteTtlSeconds],
            ["INCR", keys.rpd],
            ["EXPIRE", keys.rpd, dayTtlSeconds],
            ["EXISTS", keys.block],
            ...tokens,
          ],
          signal,
        );
        if (replies === null) return "global_esgotado";
        const global = asInteger(replies[0], 1);
        const rpm = asInteger(replies[2], 1);
        const rpd = asInteger(replies[4], 1);
        const blocked = asFlag(replies[6]);
        const callsOk = isOne(replies[1]) && isOne(replies[3]) && isOne(replies[5]);
        // O contador de tokens já inclui esta reserva: estoura acima do efetivo, como as chamadas.
        const tokensOver = reserved === null ? false : reservedTokens(replies.slice(7), limits);
        if (global === null || rpm === null || rpd === null || blocked === null || tokensOver === null || !callsOk) {
          return "global_esgotado";
        }
        const decision: QuotaDecision =
          global > LEDGER_POLICY.globalCallsPerDay
            ? "global_esgotado"
            : blocked || exceeded(rpm, limits.rpm) || exceeded(rpd, limits.rpd) || tokensOver
              ? "provedor_esgotado"
              : "permitido";
        if (decision !== "permitido") {
          // A chamada não vai sair: ela não pode gastar o teto global, o do provedor nem a reserva de tokens.
          bestEffort(deps.redis, [
            ["DECR", keys.global],
            ["DECR", keys.rpm],
            ["DECR", keys.rpd],
            ...(reserved === null
              ? []
              : ([
                  ["DECRBY", keys.tpm, reserved],
                  ["DECRBY", keys.tpd, reserved],
                ] satisfies RedisCommand[])),
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
        // Uso zero (ausente ou fora da forma no adapter) não reconcilia: a reserva cheia fica, o lado seguro.
        if (total === 0 || !isEpochMs(now)) return;
        // Ajusta a reserva ao uso real; o valor pode ser negativo (ADR-022 D7.2).
        const delta = total - (providerLimits(provider)?.reservedTokensPerCall ?? 0);
        if (delta === 0) return;
        const keys = ledgerKeys(provider, now);
        await deps.redis.exec(
          [
            ["INCRBY", keys.tpm, delta],
            ["EXPIRE", keys.tpm, minuteTtlSeconds],
            ["INCRBY", keys.tpd, delta],
            ["EXPIRE", keys.tpd, dayTtlSeconds],
          ],
          new AbortController().signal,
        );
      } catch {
        // Melhor esforço (ADR-009 D6): a contabilidade não derruba uma análise que já deu certo.
      }
    },

    async recordRateLimit(provider, retryAfterMs): Promise<void> {
      try {
        await deps.redis.exec([["SET", blockKey(provider), 1, "PX", blockMs(retryAfterMs)]], new AbortController().signal);
      } catch {
        // Melhor esforço (ADR-022 D7.3): o resfriamento por processo do router já cobre esta instância.
      }
    },
  };
}
