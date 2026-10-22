// Leitura estrita das respostas do Redis (ADR-014 D3). O cliente REST já confere a forma do JSON; aqui cada
// adapter confere o tipo de CADA resultado. Qualquer surpresa vira `null`, e o adapter falha fechado.
import type { RedisCommand, RedisTransactions, RedisValue } from "../redis/upstash-rest-client.js";

const STORED_COUNT = /^\d{1,15}$/;

/** Resposta de `INCR`/`INCRBY`/`SADD`/`SCARD` que precisa ser um inteiro ≥ `min`. */
export function asInteger(value: RedisValue | undefined, min: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : null;
}

/** Resposta de `GET` de um contador: ausente vale 0; senão, só dígitos (o Upstash devolve string). */
export function asStoredCount(value: RedisValue | undefined): number | null {
  if (value === null) return 0;
  return typeof value === "string" && STORED_COUNT.test(value) ? Number(value) : null;
}

/** `PEXPIRE`/`EXPIRE` numa chave que acabou de ser escrita: precisa responder 1. */
export function isOne(value: RedisValue | undefined): boolean {
  return value === 1;
}

/**
 * Compensação em melhor esforço, depois que a decisão já saiu: sinal próprio (o do guarda já abortou), sem
 * esperar e sem deixar rejeição solta. Se falhar, a contagem só fica maior (o lado seguro).
 */
export function bestEffort(redis: RedisTransactions, commands: readonly RedisCommand[]): void {
  Promise.resolve()
    .then(() => redis.exec(commands, new AbortController().signal))
    .catch(() => undefined);
}
