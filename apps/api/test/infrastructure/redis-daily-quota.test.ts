// Cota diária em Redis (ADR-014 D5; SR-06, SR-17) contra o Redis simulado em memória: 50 por dia de Brasília,
// idempotente por requestId, set limitado pelo SREM da negada, falha fechado e chave sem sub em claro.
import { describe, expect, test } from "vitest";

import { DAILY_QUOTA_POLICY } from "../../src/application/index.js";
import { createHmacKeyPseudonymizer } from "../../src/infrastructure/crypto/hmac-key-pseudonymizer.js";
import { createRedisDailyQuota } from "../../src/infrastructure/limits/redis-daily-quota.js";
import type { RedisValue } from "../../src/infrastructure/redis/upstash-rest-client.js";
import { memoryRedis, plainIdentifierLeaks, type MemoryMode } from "./fakes/redis-store.js";

const PEPPER = "q3Jx7W0sY1n2b4V6c8D0e2F4g6H8i0K2m4N6p8R0t2U";
const USER = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const OTHER_USER = "7a1d3b5f-2c4e-4d6f-9a81-0b2c3d4e5f60";
/** 15:00 em Brasília (18:00 UTC): faltam 9 h para a meia-noite. */
const NOON = Date.parse("2026-10-21T18:00:00.000Z");
const LIMIT = DAILY_QUOTA_POLICY.analysesPerDay;
const UNAVAILABLE = { ok: false, reason: "indisponivel" };

const requestId = (n: number): string => `0b1c2d3e-4f50-4a6b-9c7d-${String(n).padStart(12, "0")}`;

function harness(startMs = NOON) {
  const memory = memoryRedis();
  const clock = { now: startMs };
  const pseudonymizer = createHmacKeyPseudonymizer(PEPPER);
  const quota = createRedisDailyQuota({ redis: memory.redis, pseudonymizer, now: () => clock.now });
  const consume = (id: string, userId = USER) => quota.consume(userId, id, new AbortController().signal);
  const key = (userId = USER, day = "2026-10-21") => `quota:${pseudonymizer.pseudonym("sub", userId)}:${day}`;
  return { ...memory, clock, consume, key };
}

/** Espera as compensações em melhor esforço (SREM) terminarem. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("cota de 50 por dia", () => {
  test("as 50 primeiras passam; a 51ª é negada com Retry-After até a meia-noite de Brasília", async () => {
    const h = harness();
    for (let n = 1; n <= LIMIT; n += 1) await expect(h.consume(requestId(n))).resolves.toEqual({ ok: true, repeated: false });
    await expect(h.consume(requestId(51))).resolves.toEqual({ ok: false, reason: "esgotada", retryAfterSeconds: 9 * 3_600 });
  });

  test("a negada sai do set (SREM): o set fica em 50", async () => {
    const h = harness();
    for (let n = 1; n <= LIMIT + 5; n += 1) await h.consume(requestId(n));
    await settle();
    expect(h.store.members(h.key())).toBe(LIMIT);
    expect(h.log.filter((tx) => tx[0]?.[0] === "SREM")).toHaveLength(5);
  });

  test("outro usuário tem a própria cota", async () => {
    const h = harness();
    for (let n = 1; n <= LIMIT; n += 1) await h.consume(requestId(n));
    await expect(h.consume(requestId(99))).resolves.toMatchObject({ ok: false });
    await expect(h.consume(requestId(99), OTHER_USER)).resolves.toEqual({ ok: true, repeated: false });
  });

  test("o dia vira às 03:00 UTC (meia-noite de Brasília) e a cota recomeça", async () => {
    const h = harness(Date.parse("2026-10-22T02:59:59.000Z"));
    for (let n = 1; n <= LIMIT; n += 1) await h.consume(requestId(n));
    await expect(h.consume(requestId(51))).resolves.toEqual({ ok: false, reason: "esgotada", retryAfterSeconds: 1 });
    h.clock.now = Date.parse("2026-10-22T03:00:00.000Z");
    await expect(h.consume(requestId(51))).resolves.toEqual({ ok: true, repeated: false });
    expect(h.store.members(h.key(USER, "2026-10-22"))).toBe(1);
  });
});

describe("idempotência por requestId", () => {
  test("o mesmo requestId passa de novo como repetição, sem cobrar outra vez", async () => {
    const h = harness();
    await expect(h.consume(requestId(1))).resolves.toEqual({ ok: true, repeated: false });
    await expect(h.consume(requestId(1))).resolves.toEqual({ ok: true, repeated: true });
    expect(h.store.members(h.key())).toBe(1);
  });

  test("a repetição de um pedido que já passou continua passando depois que a cota acabou", async () => {
    const h = harness();
    for (let n = 1; n <= LIMIT; n += 1) await h.consume(requestId(n));
    await h.consume(requestId(51));
    await settle();
    await expect(h.consume(requestId(7))).resolves.toEqual({ ok: true, repeated: true });
  });

  test("a repetição de um pedido negado continua negada", async () => {
    const h = harness();
    for (let n = 1; n <= LIMIT; n += 1) await h.consume(requestId(n));
    await h.consume(requestId(51));
    await settle();
    await expect(h.consume(requestId(51))).resolves.toMatchObject({ ok: false, reason: "esgotada" });
  });

  test("se o SREM falhar, a contagem só fica maior (o lado seguro)", async () => {
    const h = harness();
    for (let n = 1; n <= LIMIT; n += 1) await h.consume(requestId(n));
    // A transação da 51ª responde; o SREM seguinte falha.
    h.setMode({ kind: "normal" }, { kind: "rejeita" });
    await expect(h.consume(requestId(51))).resolves.toMatchObject({ ok: false });
    await settle();
    h.setMode({ kind: "normal" });
    expect(h.store.members(h.key())).toBe(LIMIT + 1);
    // Agora até a repetição de um pedido que tinha passado é negada: conservador, nunca libera a mais.
    await expect(h.consume(requestId(7))).resolves.toMatchObject({ ok: false });
  });
});

describe("comandos e chave (SR-17)", () => {
  test("SADD, SCARD e EXPIRE de 2 dias numa transação, na chave do dia com o HMAC do sub", async () => {
    const h = harness();
    await h.consume(requestId(1));
    expect(h.log[0]).toEqual([
      ["SADD", h.key(), requestId(1)],
      ["SCARD", h.key()],
      ["EXPIRE", h.key(), 172_800],
    ]);
    expect(plainIdentifierLeaks(h.log, [USER])).toEqual([]);
  });

  test("o SREM da negada usa um signal próprio (o do guarda já abortou)", async () => {
    const h = harness();
    for (let n = 1; n <= LIMIT + 1; n += 1) await h.consume(requestId(n));
    await settle();
    expect(h.log.at(-1)).toEqual([["SREM", h.key(), requestId(LIMIT + 1)]]);
    expect(h.signals.at(-1)?.aborted).toBe(false);
  });
});

describe("falha fechado (SR-06)", () => {
  test.each<[string, MemoryMode]>([
    ["nulo", { kind: "nulo" }],
    ["lança", { kind: "lanca" }],
    ["rejeita", { kind: "rejeita" }],
  ])("Redis %s → indisponível", async (_name, mode) => {
    const h = harness();
    h.setMode(mode);
    await expect(h.consume(requestId(1))).resolves.toEqual(UNAVAILABLE);
  });

  const alter = (index: number, value: unknown) => (replies: RedisValue[]) => replies.map((r, i) => (i === index ? value : r));
  test.each<[string, (replies: RedisValue[]) => unknown[]]>([
    ["SADD negativo", alter(0, -1)],
    ["SADD maior que 1", alter(0, 2)],
    ["SADD em texto", alter(0, "1")],
    ["SCARD zero", alter(1, 0)],
    ["SCARD nulo", alter(1, null)],
    ["EXPIRE falhou", alter(2, 0)],
    ["resposta curta", (r) => r.slice(0, 2)],
  ])("%s → indisponível", async (_name, change) => {
    const h = harness();
    h.setMode({ kind: "altera", change });
    await expect(h.consume(requestId(1))).resolves.toEqual(UNAVAILABLE);
  });

  test.each([[Number.NaN], [-1], [1.5]])("relógio inválido (%d) → indisponível sem tocar no Redis", async (now) => {
    const h = harness(now);
    await expect(h.consume(requestId(1))).resolves.toEqual(UNAVAILABLE);
    expect(h.log).toHaveLength(0);
  });

  test("pseudonimizador que lança → indisponível", async () => {
    const memory = memoryRedis();
    const quota = createRedisDailyQuota({
      redis: memory.redis,
      pseudonymizer: {
        pseudonym: () => {
          throw new Error("x");
        },
      },
      now: () => NOON,
    });
    await expect(quota.consume(USER, requestId(1), new AbortController().signal)).resolves.toEqual(UNAVAILABLE);
  });
});
