// Armazenamento do JobFactsCache no Upstash (ADR-015 D1): um comando por operação, sobre o cliente REST do
// ADR-014, com cada resposta conferida. A política e a revalidação são do JobFactsCache da aplicação.
// Nunca rejeita. A instância do cliente é própria (strings e respostas maiores que as do rate limit).
import type { CacheStoreRead, CacheStoreWrite, JobFactsCacheStore } from "../../application/ports/job-facts-cache-store.js";
import type { RedisTransactions } from "../redis/upstash-rest-client.js";

/** Tetos da instância do cliente REST do cache (ADR-015 D1): a entrada tem até 16.384 caracteres. */
export const CACHE_CLIENT_LIMITS = { maxStringReplyChars: 16_384, maxResponseBytes: 128 * 1024 } as const;

const UNAVAILABLE: CacheStoreRead = { ok: false };

export function createRedisJobFactsStore(redis: RedisTransactions): JobFactsCacheStore {
  return {
    async read(key, signal): Promise<CacheStoreRead> {
      try {
        const replies = await redis.exec([["GET", key]], signal);
        const value = replies?.[0];
        if (value === null) return { ok: true, value: null };
        return typeof value === "string" ? { ok: true, value } : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async writeIfAbsent(key, value, ttlSeconds, signal): Promise<CacheStoreWrite> {
      try {
        const replies = await redis.exec([["SET", key, value, "NX", "EX", ttlSeconds]], signal);
        if (replies === null || replies.length !== 1) return "indisponivel";
        if (replies[0] === "OK") return "gravado";
        return replies[0] === null ? "ja_existia" : "indisponivel";
      } catch {
        return "indisponivel";
      }
    },

    async remove(key, signal): Promise<void> {
      try {
        await redis.exec([["DEL", key]], signal);
      } catch {
        // Melhor esforço: uma entrada ruim que sobra só volta a ser recusada na próxima leitura.
      }
    },
  };
}
