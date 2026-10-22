// Rate limit em Redis (ADR-014 D4; SR-06, SR-17) contra o Redis simulado em memória: janela deslizante por
// usuário e por IP, classes, Retry-After, falha fechado em qualquer resposta inesperada e chaves sem IP nem sub.
import { describe, expect, test } from "vitest";

import { RATE_LIMIT_POLICY, type RateLimitClass } from "../../src/application/index.js";
import { createHmacKeyPseudonymizer } from "../../src/infrastructure/crypto/hmac-key-pseudonymizer.js";
import { createRedisRateLimiter } from "../../src/infrastructure/limits/redis-rate-limiter.js";
import type { RedisValue } from "../../src/infrastructure/redis/upstash-rest-client.js";
import { memoryRedis, plainIdentifierLeaks, type MemoryMode } from "./fakes/redis-store.js";

const PEPPER = "q3Jx7W0sY1n2b4V6c8D0e2F4g6H8i0K2m4N6p8R0t2U";
const USER = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const OTHER_USER = "7a1d3b5f-2c4e-4d6f-9a81-0b2c3d4e5f60";
const ADDRESS = "v4:203.0.113.7";
const WINDOW = RATE_LIMIT_POLICY.windowMs;
/** Início de uma janela (múltiplo de 60 s). */
const T0 = 1_761_000_000_000 - (1_761_000_000_000 % WINDOW);

function harness(startMs = T0) {
  const memory = memoryRedis();
  const clock = { now: startMs };
  const pseudonymizer = createHmacKeyPseudonymizer(PEPPER);
  const limiter = createRedisRateLimiter({ redis: memory.redis, pseudonymizer, now: () => clock.now });
  const check = (rateClass: RateLimitClass = "analise", userId = USER, clientAddress = ADDRESS) =>
    limiter.check(rateClass, { userId, clientAddress }, new AbortController().signal);
  return { ...memory, clock, check, pseudonymizer };
}

async function repeat(times: number, fn: () => Promise<unknown>): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let i = 0; i < times; i += 1) results.push(await fn());
  return results;
}

describe("contagem por usuário", () => {
  test("analise: 5 passam na janela e a 6ª dá 429 com Retry-After até o fim da janela", async () => {
    const h = harness(T0 + 15_000);
    const results = await repeat(5, () => h.check());
    expect(results).toEqual(Array(5).fill({ ok: true }));
    await expect(h.check()).resolves.toEqual({ ok: false, reason: "limite_excedido", retryAfterSeconds: 45 });
  });

  test("padrao: 60 passam e a 61ª é negada", async () => {
    const h = harness();
    await repeat(60, () => h.check("padrao"));
    await expect(h.check("padrao")).resolves.toMatchObject({ ok: false, reason: "limite_excedido" });
  });

  test("as classes têm contadores separados", async () => {
    const h = harness();
    await repeat(5, () => h.check("analise"));
    await expect(h.check("analise")).resolves.toMatchObject({ ok: false });
    await expect(h.check("padrao")).resolves.toEqual({ ok: true });
  });

  test("outro usuário no mesmo IP tem a própria cota de usuário", async () => {
    const h = harness();
    await repeat(5, () => h.check("analise", USER, "v4:10.0.0.1"));
    await expect(h.check("analise", USER, "v4:10.0.0.2")).resolves.toMatchObject({ ok: false });
    await expect(h.check("analise", OTHER_USER, "v4:10.0.0.1")).resolves.toEqual({ ok: true });
  });

  test("a negada também conta: quem insiste continua bloqueado na janela seguinte", async () => {
    const h = harness(T0 + 59_000);
    let i = 0;
    await repeat(20, () => h.check("analise", USER, `v4:10.0.1.${String((i += 1))}`));
    // Na janela seguinte, no começo, a anterior (20) ainda pesa quase inteira.
    h.clock.now = T0 + WINDOW + 1_000;
    await expect(h.check("analise", USER, "v4:10.9.9.9")).resolves.toMatchObject({ ok: false });
  });
});

describe("janela deslizante", () => {
  test("a janela anterior pesa pela fração restante", async () => {
    const h = harness(T0 + 50_000);
    await repeat(5, () => h.check());
    // 30 s depois (10 s na janela nova): a anterior pesa floor(5 × 50/60) = 4; a 1ª nova soma 5 → passa.
    h.clock.now = T0 + WINDOW + 10_000;
    await expect(h.check()).resolves.toEqual({ ok: true });
    // A 2ª soma 6 → negada.
    await expect(h.check()).resolves.toMatchObject({ ok: false, retryAfterSeconds: 50 });
    // No fim da janela nova, a anterior quase não pesa: floor(5 × 1/60) = 0, atual 3 → passa.
    h.clock.now = T0 + 2 * WINDOW - 1_000;
    await expect(h.check()).resolves.toEqual({ ok: true });
  });

  test("duas janelas depois, a contagem recomeça", async () => {
    const h = harness();
    await repeat(6, () => h.check());
    h.clock.now = T0 + 2 * WINDOW;
    await expect(h.check()).resolves.toEqual({ ok: true });
  });
});

describe("contagem por IP", () => {
  test("analise: 20 por IP somando usuários; o 21º é negado mesmo para um usuário novo", async () => {
    const h = harness();
    const users = Array.from({ length: 20 }, (_, i) => `6f0c2a4e-1b3d-4c5e-8f70-${String(i).padStart(12, "0")}`);
    for (const user of users) await expect(h.check("analise", user)).resolves.toEqual({ ok: true });
    await expect(h.check("analise", OTHER_USER)).resolves.toMatchObject({ ok: false, reason: "limite_excedido" });
    await expect(h.check("analise", OTHER_USER, "v4:198.51.100.1")).resolves.toEqual({ ok: true });
  });
});

describe("comandos e chaves (SR-17)", () => {
  test("uma transação com 6 comandos: INCR, PEXPIRE de 2 janelas + 1 s e GET da anterior, por usuário e por IP", async () => {
    const h = harness(T0 + 1);
    await h.check("padrao");
    expect(h.log).toHaveLength(1);
    const index = T0 / WINDOW;
    const u = `rl:padrao:u:${h.pseudonymizer.pseudonym("sub", USER)}`;
    const ip = `rl:padrao:ip:${h.pseudonymizer.pseudonym("ip", ADDRESS)}`;
    expect(h.log[0]).toEqual([
      ["INCR", `${u}:${index}`],
      ["PEXPIRE", `${u}:${index}`, 2 * WINDOW + 1_000],
      ["GET", `${u}:${index - 1}`],
      ["INCR", `${ip}:${index}`],
      ["PEXPIRE", `${ip}:${index}`, 2 * WINDOW + 1_000],
      ["GET", `${ip}:${index - 1}`],
    ]);
  });

  test("nenhum argumento contém o sub (com ou sem hífens) nem o IP", async () => {
    const h = harness();
    await repeat(7, () => h.check("analise", USER, "v4:203.0.113.7"));
    await h.check("padrao", OTHER_USER, "v6:2001:db8:85a3:0::/64");
    expect(plainIdentifierLeaks(h.log, [USER, OTHER_USER, "203.0.113.7", "2001:db8"])).toEqual([]);
  });
});

describe("falha fechado (SR-06, T39)", () => {
  const UNAVAILABLE = { ok: false, reason: "indisponivel" };

  test.each<[string, MemoryMode]>([
    ["Redis devolve nulo (erro no cliente)", { kind: "nulo" }],
    ["Redis lança", { kind: "lanca" }],
    ["Redis rejeita", { kind: "rejeita" }],
  ])("%s → indisponível", async (_name, mode) => {
    const h = harness();
    h.setMode(mode);
    await expect(h.check()).resolves.toEqual(UNAVAILABLE);
  });

  const alter = (index: number, value: unknown) => (replies: RedisValue[]) => replies.map((r, i) => (i === index ? value : r));
  test.each<[string, (replies: RedisValue[]) => unknown[]]>([
    ["INCR do usuário zerado", alter(0, 0)],
    ["INCR do usuário em texto", alter(0, "1")],
    ["PEXPIRE do usuário falhou", alter(1, 0)],
    ["GET do usuário com lixo", alter(2, "abc")],
    ["INCR do IP nulo", alter(3, null)],
    ["PEXPIRE do IP em texto", alter(4, "1")],
    ["GET do IP numérico", alter(5, 7)],
    ["resposta curta", (r) => r.slice(0, 5)],
    ["resposta vazia", () => []],
  ])("%s → indisponível, nunca liberado", async (_name, change) => {
    const h = harness();
    h.setMode({ kind: "altera", change });
    await expect(h.check()).resolves.toEqual(UNAVAILABLE);
  });

  test("Redis com erro de tipo numa chave (WRONGTYPE) → indisponível", async () => {
    const h = harness(T0);
    await h.check("padrao");
    const key = `rl:padrao:u:${h.pseudonymizer.pseudonym("sub", USER)}:${T0 / WINDOW}`;
    h.store.values.set(key, new Set(["x"]));
    await expect(h.check("padrao")).resolves.toEqual(UNAVAILABLE);
  });

  test.each([[Number.NaN], [-1], [1.5], [Number.POSITIVE_INFINITY]])("relógio inválido (%d) → indisponível sem tocar no Redis", async (now) => {
    const h = harness(now);
    await expect(h.check()).resolves.toEqual(UNAVAILABLE);
    expect(h.log).toHaveLength(0);
  });

  test("pseudonimizador que lança → indisponível", async () => {
    const memory = memoryRedis();
    const limiter = createRedisRateLimiter({
      redis: memory.redis,
      pseudonymizer: {
        pseudonym: () => {
          throw new Error("x");
        },
      },
      now: () => T0,
    });
    await expect(limiter.check("padrao", { userId: USER, clientAddress: ADDRESS }, new AbortController().signal)).resolves.toEqual(
      UNAVAILABLE,
    );
  });

  test("o signal do chamador chega ao Redis", async () => {
    const h = harness();
    const controller = new AbortController();
    const limiter = createRedisRateLimiter({ redis: h.redis, pseudonymizer: h.pseudonymizer, now: () => T0 });
    await limiter.check("padrao", { userId: USER, clientAddress: ADDRESS }, controller.signal);
    expect(h.signals[0]).toBe(controller.signal);
  });
});
