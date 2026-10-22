// F1-CACHE-01 de ponta a ponta (ADR-015; SR-08): JobFactsCache + adapter + cliente REST com os tetos do cache,
// contra o Upstash simulado em socket real. Também prova os tetos por instância do cliente (ADR-015 D1): a
// instância padrão (rate limit) continua recusando strings longas. Nenhuma chamada ao Upstash real.
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { JobFactsCache, LlmOutputGuard, type CacheWriteCandidate } from "../../src/application/index.js";
import { CACHE_CLIENT_LIMITS, createRedisJobFactsStore } from "../../src/infrastructure/cache/redis-job-facts-store.js";
import { createUpstashRestClient } from "../../src/infrastructure/redis/upstash-rest-client.js";
import { systemClock } from "../../src/infrastructure/time/system-clock.js";
import { VALID_RAW } from "../application/fakes/router-harness.js";
import { startFakeUpstash, type FakeUpstash, type UpstashMode } from "./fakes/fake-upstash.js";

const TOKEN = "AXcache_token-de-teste.42";
const HASH = "d".repeat(64);
const VERSION = "jf-p1-s1-n1-sel1-g2-b6000";
const GROQ = { provider: "groq", model: "openai/gpt-oss-20b" } as const;
const inspected = new LlmOutputGuard().inspect(VALID_RAW);
if (!inspected.ok) throw new Error("fixture inválida");
const CANDIDATE: CacheWriteCandidate = {
  textHash: HASH,
  facts: inspected.facts,
  sanitization: inspected.sanitization,
  injectionLevel: "baixa",
  effectiveConfidence: 0.9,
  degraded: false,
  ...GROQ,
};

let upstash: FakeUpstash;
beforeEach(async () => {
  upstash = await startFakeUpstash(TOKEN);
});
afterEach(async () => {
  await upstash.close();
});

function stack() {
  const redis = createUpstashRestClient({ url: upstash.url, token: TOKEN, ...CACHE_CLIENT_LIMITS });
  return new JobFactsCache({
    store: createRedisJobFactsStore(redis),
    clock: systemClock,
    now: () => Date.now(),
    extractorVersion: VERSION,
    acceptedModels: [GROQ],
  });
}

describe("pilha do cache contra o Upstash simulado", () => {
  test("grava com SET NX EX de 10 dias e volta como hit", async () => {
    const cache = stack();
    await expect(cache.store(CANDIDATE)).resolves.toEqual({ written: true });
    const key = cache.keyFor(HASH);
    expect(upstash.requests.at(-1)?.commands).toEqual([["SET", key, expect.any(String), "NX", "EX", 864_000]]);
    const lookup = await cache.lookup(HASH);
    expect(lookup.hit && lookup.entry.facts).toEqual(inspected.facts);
    expect(upstash.requests).toHaveLength(2);
  });

  test("a instância padrão do cliente (rate limit) recusa a mesma entrada: os tetos são por instância", async () => {
    await stack().store(CANDIDATE);
    const narrow = createUpstashRestClient({ url: upstash.url, token: TOKEN });
    const wide = createUpstashRestClient({ url: upstash.url, token: TOKEN, ...CACHE_CLIENT_LIMITS });
    const key = stack().keyFor(HASH);
    await expect(narrow.exec([["GET", key]], new AbortController().signal)).resolves.toBeNull();
    const replies = await wide.exec([["GET", key]], new AbortController().signal);
    expect(typeof replies?.[0]).toBe("string");
  });

  test("resposta entre 16 KiB e 128 KiB (10.000 \"ç\" = 20.000 bytes) só passa no cliente do cache", async () => {
    const key = stack().keyFor(HASH);
    upstash.store.values.set(key, "ç".repeat(10_000));
    const narrow = createUpstashRestClient({ url: upstash.url, token: TOKEN, maxStringReplyChars: CACHE_CLIENT_LIMITS.maxStringReplyChars });
    const wide = createUpstashRestClient({ url: upstash.url, token: TOKEN, ...CACHE_CLIENT_LIMITS });
    await expect(narrow.exec([["GET", key]], new AbortController().signal)).resolves.toBeNull();
    await expect(wide.exec([["GET", key]], new AbortController().signal)).resolves.toEqual(["ç".repeat(10_000)]);
  });

  test("entrada adulterada direto no Redis: miss corrompido, e o DEL chega ao servidor", async () => {
    const cache = stack();
    const key = cache.keyFor(HASH);
    upstash.store.values.set(key, '{"schemaVersion":1,"__proto__":{"x":1}}');
    await expect(cache.lookup(HASH)).resolves.toEqual({ hit: false, reason: "corrompido" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstash.requests.at(-1)?.commands).toEqual([["DEL", key]]);
    expect(upstash.store.values.has(key)).toBe(false);
  });

  test("entrada gigante (acima de 16.384 caracteres) no Redis: miss, nunca hit", async () => {
    const cache = stack();
    upstash.store.values.set(cache.keyFor(HASH), "x".repeat(20_000));
    await expect(cache.lookup(HASH)).resolves.toMatchObject({ hit: false });
  });

  test.each<[string, UpstashMode]>([
    ["travado", { kind: "trava" }],
    ["lento", { kind: "lento", delayMs: 1_000 }],
    ["com 500", { kind: "status", status: 500 }],
    ["com erro no comando", { kind: "erro_em", index: 0 }],
    ["com lixo", { kind: "corpo", body: "<html>" }],
  ])("Upstash %s: leitura é miss e escrita é indisponivel, dentro do prazo", async (_name, mode) => {
    const cache = stack();
    upstash.mode = mode;
    const start = performance.now();
    await expect(cache.lookup(HASH)).resolves.toEqual({ hit: false, reason: "indisponivel" });
    await expect(cache.store(CANDIDATE)).resolves.toEqual({ written: false, reason: "indisponivel" });
    expect(performance.now() - start).toBeLessThan(1_500);
  });
});
