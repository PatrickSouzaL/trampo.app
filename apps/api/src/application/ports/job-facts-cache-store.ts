// Armazenamento das entradas do JobFactsCache (ADR-015 D1). A porta só guarda strings: a política de escrita,
// a serialização e a revalidação ficam no JobFactsCache da aplicação. O adapter em Redis fica em
// infrastructure/cache.

/** `ok: false`: Redis com erro, lento ou fora do contrato. `value: null`: a chave não existe. */
export type CacheStoreRead = { readonly ok: true; readonly value: string | null } | { readonly ok: false };

/** `ja_existia`: o SET NX não sobrescreveu. `indisponivel`: Redis com erro ou fora do contrato. */
export type CacheStoreWrite = "gravado" | "ja_existia" | "indisponivel";

export interface JobFactsCacheStore {
  /** GET. Nunca deveria rejeitar; o cache trata a rejeição como `indisponivel` (miss). */
  read(key: string, signal: AbortSignal): Promise<CacheStoreRead>;
  /** SET key value NX EX ttl: o primeiro que escreve ganha. */
  writeIfAbsent(key: string, value: string, ttlSeconds: number, signal: AbortSignal): Promise<CacheStoreWrite>;
  /** DEL em melhor esforço (entrada corrompida ou obsoleta). */
  remove(key: string, signal: AbortSignal): Promise<void>;
}
