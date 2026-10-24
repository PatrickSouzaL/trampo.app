// Guardas de limite (ADR-014 D1; SR-06, T39): a porta que lança, rejeita, trava, demora ou devolve lixo dá
// `indisponivel`, nunca liberação. A entrada é conferida antes de tocar na porta. Nunca rejeitam.
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import {
  DailyQuotaGuard,
  LIMIT_GUARD_POLICY,
  RATE_LIMIT_POLICY,
  RateLimitGuard,
  type DailyQuota,
  type RateLimitClass,
  type RateLimiter,
} from "../../src/application/index.js";
import { FakeClock } from "./fakes/fake-clock.js";

const USER = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const REQUEST = "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3";
const SUBJECT = { userId: USER, clientAddress: "v4:203.0.113.7" };
const UNAVAILABLE = { ok: false, reason: "indisponivel" };

type Behavior =
  | { readonly kind: "valor"; readonly value: unknown; readonly latencyMs?: number }
  | { readonly kind: "lanca" | "rejeita" | "trava" }
  | { readonly kind: "rejeita_tarde"; readonly latencyMs: number };

function run(clock: FakeClock, behavior: Behavior, signal: AbortSignal): Promise<never> {
  switch (behavior.kind) {
    case "lanca":
      throw new Error("redis fora do ar");
    case "rejeita":
      return Promise.reject(new Error("redis fora do ar"));
    case "trava":
      return new Promise<never>(() => undefined);
    case "rejeita_tarde":
      // Ignora o signal de propósito: a rejeição chega depois do prazo e precisa ser absorvida.
      return clock.sleep(behavior.latencyMs).then(() => Promise.reject(new Error("tarde")));
    default:
      return clock.sleep(behavior.latencyMs ?? 0, signal).then(() => behavior.value as never);
  }
}

function rateHarness(behavior: Behavior) {
  const clock = new FakeClock();
  const calls: { rateClass: RateLimitClass; signal: AbortSignal }[] = [];
  const limiter: RateLimiter = {
    check: (rateClass, _subject, signal) => {
      calls.push({ rateClass, signal });
      return run(clock, behavior, signal);
    },
  };
  return { clock, calls, guard: new RateLimitGuard(limiter, clock) };
}

function quotaHarness(behavior: Behavior) {
  const clock = new FakeClock();
  const calls: { userId: string; requestId: string; signal: AbortSignal }[] = [];
  const quota: DailyQuota = {
    consume: (userId, requestId, signal) => {
      calls.push({ userId, requestId, signal });
      return run(clock, behavior, signal);
    },
  };
  return { clock, calls, guard: new DailyQuotaGuard(quota, clock) };
}

const GARBAGE: readonly unknown[] = [
  undefined,
  null,
  "permitido",
  true,
  [],
  {},
  { ok: "true" },
  { ok: true, extra: 1 },
  { ok: true, repeated: "nao" },
  { ok: false },
  { ok: false, reason: "outro" },
  { ok: false, reason: "limite_excedido", retryAfterSeconds: 0 },
  { ok: false, reason: "limite_excedido", retryAfterSeconds: 86_401 },
  { ok: false, reason: "limite_excedido", retryAfterSeconds: 1.5 },
  { ok: false, reason: "limite_excedido" },
  { ok: false, reason: "esgotada", retryAfterSeconds: -1 },
  { ok: false, reason: "indisponivel", detalhe: "x" },
];

describe("RateLimitGuard", () => {
  test.each([
    [{ ok: true }],
    [{ ok: false, reason: "limite_excedido", retryAfterSeconds: 1 }],
    [{ ok: false, reason: "limite_excedido", retryAfterSeconds: 86_400 }],
    [{ ok: false, reason: "indisponivel" }],
  ])("decisão válida passa como veio: %j", async (value) => {
    const h = rateHarness({ kind: "valor", value });
    await expect(h.clock.run(h.guard.check("analise", SUBJECT))).resolves.toEqual(value);
    expect(h.calls.map((c) => c.rateClass)).toEqual(["analise"]);
  });

  test.each(GARBAGE.filter((g) => !(typeof g === "object" && g !== null && "repeated" in g)).map((g) => [g]))(
    "resposta fora do contrato (%j) vira indisponível",
    async (value) => {
      const h = rateHarness({ kind: "valor", value });
      await expect(h.clock.run(h.guard.check("padrao", SUBJECT))).resolves.toEqual(UNAVAILABLE);
    },
  );

  test("a decisão de cota não serve como decisão de rate limit", async () => {
    const h = rateHarness({ kind: "valor", value: { ok: true, repeated: false } });
    await expect(h.clock.run(h.guard.check("padrao", SUBJECT))).resolves.toEqual(UNAVAILABLE);
  });

  test.each([["lanca"], ["rejeita"]] as const)("porta que %s vira indisponível", async (kind) => {
    const h = rateHarness({ kind });
    await expect(h.clock.run(h.guard.check("padrao", SUBJECT))).resolves.toEqual(UNAVAILABLE);
  });

  test("porta travada: indisponível exatamente no prazo, e o signal da porta é abortado", async () => {
    const h = rateHarness({ kind: "trava" });
    const start = h.clock.nowMs();
    await expect(h.clock.run(h.guard.check("padrao", SUBJECT))).resolves.toEqual(UNAVAILABLE);
    expect(h.clock.nowMs() - start).toBe(LIMIT_GUARD_POLICY.timeoutMs);
    expect(h.calls[0]?.signal.aborted).toBe(true);
    expect(h.clock.pendingTimers).toBe(0);
  });

  test("porta lenta: acima do prazo vira indisponível; abaixo, a decisão vale", async () => {
    const slow = rateHarness({ kind: "valor", value: { ok: true }, latencyMs: LIMIT_GUARD_POLICY.timeoutMs + 1 });
    await expect(slow.clock.run(slow.guard.check("padrao", SUBJECT))).resolves.toEqual(UNAVAILABLE);
    const fast = rateHarness({ kind: "valor", value: { ok: true }, latencyMs: LIMIT_GUARD_POLICY.timeoutMs - 1 });
    await expect(fast.clock.run(fast.guard.check("padrao", SUBJECT))).resolves.toEqual({ ok: true });
    expect(fast.calls[0]?.signal.aborted).toBe(true);
    expect(fast.clock.pendingTimers).toBe(0);
  });

  test("rejeição que chega depois do prazo é absorvida", async () => {
    const h = rateHarness({ kind: "rejeita_tarde", latencyMs: LIMIT_GUARD_POLICY.timeoutMs + 50 });
    await expect(h.clock.run(h.guard.check("padrao", SUBJECT))).resolves.toEqual(UNAVAILABLE);
    await h.clock.run(h.clock.sleep(100));
  });

  test("prazo configurável no construtor", async () => {
    const clock = new FakeClock();
    const guard = new RateLimitGuard({ check: () => new Promise(() => undefined) }, clock, 40);
    const start = clock.nowMs();
    await clock.run(guard.check("padrao", SUBJECT));
    expect(clock.nowMs() - start).toBe(40);
  });

  test.each([
    ["userId fora de UUID", "padrao", { userId: "admin", clientAddress: "v4:1.2.3.4" }],
    ["clientAddress vazio", "padrao", { userId: USER, clientAddress: "" }],
    ["clientAddress longo demais", "padrao", { userId: USER, clientAddress: "x".repeat(65) }],
    ["classe fora do conjunto", "outra", SUBJECT],
    ["classe com outra caixa", "CRITERIOS", SUBJECT],
  ])("entrada inválida (%s) dá indisponível sem tocar na porta", async (_name, rateClass, subject) => {
    const h = rateHarness({ kind: "valor", value: { ok: true } });
    await expect(h.guard.check(rateClass as RateLimitClass, subject)).resolves.toEqual(UNAVAILABLE);
    expect(h.calls).toHaveLength(0);
  });

  test("toda classe da política passa pelo guarda e chega à porta como veio", async () => {
    const classes = Object.keys(RATE_LIMIT_POLICY.classes) as RateLimitClass[];
    expect(classes).toEqual(["padrao", "analise", "criterios"]);
    for (const rateClass of classes) {
      const h = rateHarness({ kind: "valor", value: { ok: true } });
      await expect(h.clock.run(h.guard.check(rateClass, SUBJECT))).resolves.toEqual({ ok: true });
      expect(h.calls.map((c) => c.rateClass)).toEqual([rateClass]);
    }
  });

  test("o endereço de 64 caracteres ainda é aceito", async () => {
    const h = rateHarness({ kind: "valor", value: { ok: true } });
    await expect(h.clock.run(h.guard.check("padrao", { userId: USER, clientAddress: "x".repeat(64) }))).resolves.toEqual({
      ok: true,
    });
  });

  test("propriedade: qualquer valor da porta dá uma decisão do contrato, e só o ok exato libera", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.anything(), fc.constantFrom(...GARBAGE), fc.constant({ ok: true })), async (value) => {
        const h = rateHarness({ kind: "valor", value });
        const decision = await h.clock.run(h.guard.check("padrao", SUBJECT));
        const exactOk = typeof value === "object" && value !== null && Object.keys(value).length === 1 && (value as { ok?: unknown }).ok === true;
        if (decision.ok) expect(exactOk).toBe(true);
        else expect(["limite_excedido", "indisponivel"]).toContain(decision.reason);
      }),
      { numRuns: 1_000 },
    );
  });
});

describe("DailyQuotaGuard", () => {
  test.each([
    [{ ok: true, repeated: false }],
    [{ ok: true, repeated: true }],
    [{ ok: false, reason: "esgotada", retryAfterSeconds: 1 }],
    [{ ok: false, reason: "esgotada", retryAfterSeconds: 86_400 }],
    [{ ok: false, reason: "indisponivel" }],
  ])("decisão válida passa como veio: %j", async (value) => {
    const h = quotaHarness({ kind: "valor", value });
    await expect(h.clock.run(h.guard.consume(USER, REQUEST))).resolves.toEqual(value);
    expect(h.calls.map(({ userId, requestId }) => ({ userId, requestId }))).toEqual([{ userId: USER, requestId: REQUEST }]);
  });

  test.each([...GARBAGE, { ok: true }, { ok: false, reason: "limite_excedido", retryAfterSeconds: 5 }].map((g) => [g]))(
    "resposta fora do contrato (%j) vira indisponível",
    async (value) => {
      const h = quotaHarness({ kind: "valor", value });
      await expect(h.clock.run(h.guard.consume(USER, REQUEST))).resolves.toEqual(UNAVAILABLE);
    },
  );

  test.each([["lanca"], ["rejeita"], ["trava"]] as const)("porta que %s vira indisponível", async (kind) => {
    const h = quotaHarness({ kind });
    await expect(h.clock.run(h.guard.consume(USER, REQUEST))).resolves.toEqual(UNAVAILABLE);
    expect(h.clock.pendingTimers).toBe(0);
  });

  test("porta lenta acima do prazo vira indisponível e tem o signal abortado", async () => {
    const h = quotaHarness({ kind: "valor", value: { ok: true, repeated: false }, latencyMs: 10_000 });
    await expect(h.clock.run(h.guard.consume(USER, REQUEST))).resolves.toEqual(UNAVAILABLE);
    expect(h.calls[0]?.signal.aborted).toBe(true);
  });

  test("prazo configurável no construtor", async () => {
    const clock = new FakeClock();
    const guard = new DailyQuotaGuard({ consume: () => new Promise(() => undefined) }, clock, 30);
    const start = clock.nowMs();
    await clock.run(guard.consume(USER, REQUEST));
    expect(clock.nowMs() - start).toBe(30);
  });

  test.each([
    ["userId fora de UUID", "u1", REQUEST],
    ["requestId fora de UUID", USER, "1"],
    ["requestId vazio", USER, ""],
  ])("entrada inválida (%s) dá indisponível sem tocar na porta", async (_name, userId, requestId) => {
    const h = quotaHarness({ kind: "valor", value: { ok: true, repeated: false } });
    await expect(h.guard.consume(userId, requestId)).resolves.toEqual(UNAVAILABLE);
    expect(h.calls).toHaveLength(0);
  });
});
