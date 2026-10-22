// Adapter do JobFactsCache em Redis (ADR-015 D1) contra o Redis simulado em memória: GET, SET NX EX e DEL,
// com cada resposta conferida. Nunca rejeita.
import { describe, expect, test } from "vitest";

import { CACHE_CLIENT_LIMITS, createRedisJobFactsStore } from "../../src/infrastructure/cache/redis-job-facts-store.js";
import { memoryRedis, type MemoryMode } from "./fakes/redis-store.js";

const KEY = `jobfacts:v1:jf-p1-s1-n1-sel1-g2-b6000:${"a".repeat(64)}`;
const signal = () => new AbortController().signal;

function harness() {
  const memory = memoryRedis();
  return { ...memory, cache: createRedisJobFactsStore(memory.redis) };
}

describe("createRedisJobFactsStore", () => {
  test("tetos da instância do cliente do cache", () => {
    expect(CACHE_CLIENT_LIMITS).toEqual({ maxStringReplyChars: 16_384, maxResponseBytes: 131_072 });
  });

  test("SET NX EX grava; a segunda escrita não sobrescreve; GET devolve o valor", async () => {
    const h = harness();
    await expect(h.cache.writeIfAbsent(KEY, "primeiro", 864_000, signal())).resolves.toBe("gravado");
    await expect(h.cache.writeIfAbsent(KEY, "segundo", 864_000, signal())).resolves.toBe("ja_existia");
    await expect(h.cache.read(KEY, signal())).resolves.toEqual({ ok: true, value: "primeiro" });
    expect(h.store.ttlMs.get(KEY)).toBe(864_000_000);
    expect(h.log[0]).toEqual([["SET", KEY, "primeiro", "NX", "EX", 864_000]]);
  });

  test("GET de chave ausente → valor nulo", async () => {
    await expect(harness().cache.read(KEY, signal())).resolves.toEqual({ ok: true, value: null });
  });

  test("DEL apaga, e o SET NX volta a ser possível", async () => {
    const h = harness();
    await h.cache.writeIfAbsent(KEY, "velho", 10, signal());
    await h.cache.remove(KEY, signal());
    expect(h.log.at(-1)).toEqual([["DEL", KEY]]);
    await expect(h.cache.writeIfAbsent(KEY, "novo", 10, signal())).resolves.toBe("gravado");
  });

  test("o signal do chamador chega ao Redis", async () => {
    const h = harness();
    const controller = new AbortController();
    await h.cache.read(KEY, controller.signal);
    await h.cache.writeIfAbsent(KEY, "v", 10, controller.signal);
    await h.cache.remove(KEY, controller.signal);
    expect(h.signals).toEqual([controller.signal, controller.signal, controller.signal]);
  });

  test.each<[string, MemoryMode]>([
    ["nulo", { kind: "nulo" }],
    ["lança", { kind: "lanca" }],
    ["rejeita", { kind: "rejeita" }],
    ["GET numérico", { kind: "altera", change: () => [7] }],
    ["resposta vazia", { kind: "altera", change: () => [] }],
  ])("leitura com Redis %s → ok: false", async (_name, mode) => {
    const h = harness();
    h.setMode(mode);
    await expect(h.cache.read(KEY, signal())).resolves.toEqual({ ok: false });
  });

  test.each<[string, MemoryMode]>([
    ["nulo", { kind: "nulo" }],
    ["lança", { kind: "lanca" }],
    ["rejeita", { kind: "rejeita" }],
    ["SET com outra resposta", { kind: "altera", change: () => ["QUEUED"] }],
    ["SET numérico", { kind: "altera", change: () => [1] }],
    ["resposta vazia", { kind: "altera", change: () => [] }],
    ["resposta com dois itens", { kind: "altera", change: () => ["OK", "OK"] }],
  ])("escrita com Redis %s → indisponivel", async (_name, mode) => {
    const h = harness();
    h.setMode(mode);
    await expect(h.cache.writeIfAbsent(KEY, "v", 10, signal())).resolves.toBe("indisponivel");
  });

  test.each<[string, MemoryMode]>([
    ["lança", { kind: "lanca" }],
    ["rejeita", { kind: "rejeita" }],
  ])("DEL com Redis que %s não rejeita", async (_name, mode) => {
    const h = harness();
    h.setMode(mode);
    await expect(h.cache.remove(KEY, signal())).resolves.toBeUndefined();
  });
});
