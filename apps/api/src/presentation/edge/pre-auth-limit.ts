// Limitador local de entrada, antes do JWT, das duas rotas públicas de auth (ADR-004 D8 item 4; emenda ao ADR-014,
// D10). Fica em memória do processo: nenhuma requisição anônima gasta comando do Redis (decisão do humano de
// 2026-10-21, ADR-014 §3). Não substitui o rate limit no Redis nem é o *ephemeral cache* do T39: só existe nas rotas
// sem token, e falha para o lado restritivo.
// - Janela deslizante de 60 s com a mesma conta do ADR-014 D4 (janela atual + fração da anterior); a negada também
//   conta, e quem insiste continua bloqueado.
// - Chave `<classe>:HMAC-SHA256(RATE_KEY_PEPPER, "ip:<balde>")`: nem o IP nem o /64 ficam em claro na memória (SR-17
//   por analogia). O balde é o do ADR-014 D4 (IPv4 mapeado vira IPv4, IPv6 pelo /64, não-IP num balde único), sobre o
//   `request.ip`, que só confia no X-Forwarded-For dos saltos do `TRUST_PROXY`.
// - No máximo 10.000 baldes vivos. Cheio, os novos dividem um balde de transbordo por classe, e nenhum balde vivo é
//   despejado (despejar deixaria contornar o limite inundando a tabela). Só sai o balde vencido, que pesa zero.
// O hook entra no `onRequest` da própria rota (07g): depois do CORS e do tipo de mídia, e antes do `bodyLimit` e do Zod.
import type { FastifyReply, FastifyRequest } from "fastify";

import { slidingWindowCount, windowPosition, windowRetryAfterSeconds } from "../../application/limits/windows.js";
import type { Clock } from "../../application/ports/clock.js";
import type { KeyPseudonymizer } from "../../infrastructure/crypto/hmac-key-pseudonymizer.js";
import { sendApiError } from "../api-error.js";
import { clientAddressBucket } from "./client-address.js";

export type PreAuthLimitClass = "auth_troca" | "auth_renovacao";

export const PRE_AUTH_LIMIT_POLICY = {
  windowMs: 60_000,
  limits: { auth_troca: 10, auth_renovacao: 30 },
  maxBuckets: 10_000,
} as const satisfies {
  readonly windowMs: number;
  readonly limits: Readonly<Record<PreAuthLimitClass, number>>;
  readonly maxBuckets: number;
};

export type PreAuthDecision = { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };

export interface PreAuthLimiter {
  /** Conta a requisição de `ip` (o `request.ip` do Fastify) na classe e decide. Nunca lança. */
  check(limitClass: PreAuthLimitClass, ip: string): PreAuthDecision;
}

interface Bucket {
  /** Índice da janela fixa em que `current` foi contado. */
  index: number;
  current: number;
  previous: number;
}

const emptyBucket = (index: number): Bucket => ({ index, current: 0, previous: 0 });

/** Leva o balde até a janela `index`: a atual vira a anterior, ou as duas zeram se passou mais de uma janela. */
function roll(bucket: Bucket, index: number): void {
  if (bucket.index === index) return;
  bucket.previous = bucket.index === index - 1 ? bucket.current : 0;
  bucket.current = 0;
  bucket.index = index;
}

export function createPreAuthLimiter(clock: Clock, pseudonymizer: KeyPseudonymizer): PreAuthLimiter {
  const { windowMs, limits, maxBuckets } = PRE_AUTH_LIMIT_POLICY;
  // Ordem de inserção = ordem do último uso (cada uso reinsere): os vencidos ficam todos no começo.
  const buckets = new Map<string, Bucket>();
  const overflow: Record<PreAuthLimitClass, Bucket> = { auth_troca: emptyBucket(0), auth_renovacao: emptyBucket(0) };

  /** Tira do começo os baldes que já não pesam nada (as duas janelas passaram). Não é despejo: o peso deles é zero. */
  function sweep(index: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.index >= index - 1) return;
      buckets.delete(key);
    }
  }

  function bucketFor(key: string, limitClass: PreAuthLimitClass, index: number): Bucket {
    const found = buckets.get(key);
    if (found !== undefined) {
      buckets.delete(key);
      buckets.set(key, found);
      return found;
    }
    if (buckets.size >= maxBuckets) return overflow[limitClass];
    const created = emptyBucket(index);
    buckets.set(key, created);
    return created;
  }

  return {
    check(limitClass, ip) {
      const { index, elapsedMs } = windowPosition(clock.nowMs(), windowMs);
      sweep(index);
      const key = `${limitClass}:${pseudonymizer.pseudonym("ip", clientAddressBucket(ip))}`;
      const bucket = bucketFor(key, limitClass, index);
      roll(bucket, index);
      bucket.current += 1;
      if (slidingWindowCount(bucket.previous, bucket.current, elapsedMs, windowMs) <= limits[limitClass]) return { ok: true };
      return { ok: false, retryAfterSeconds: windowRetryAfterSeconds(elapsedMs, windowMs) };
    },
  };
}

/**
 * `onRequest` de uma rota pública de auth: 429 `LIMITE_DE_TAXA` com `Retry-After` (ADR-004 D7). Não lê
 * `Authorization` nem o corpo, e nada do IP ou da chave vai para o log (SR-12).
 */
export function createPreAuthLimitHook(limiter: PreAuthLimiter, limitClass: PreAuthLimitClass) {
  return async function preAuthLimitHook(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    const decision = limiter.check(limitClass, request.ip);
    if (decision.ok) return undefined;
    return sendApiError(reply, request.id, "LIMITE_DE_TAXA", { retryAfterSeconds: decision.retryAfterSeconds });
  };
}
