// A contagem da sonda do limite por IP (ADR-004 D8 item 5; F1-API-07 07h), sem Docker. A sonda de verdade roda no
// job db (test/db/auth-rate-limit.db.test.ts), contra o GoTrue local.
import { describe, expect, test } from "vitest";

import { flood, GOTRUE_TOKEN_BUCKET, matchesBucket, onlyRefusals } from "./db/support/rate-limit-probe.js";

/** Respostas roteirizadas e um relógio que anda 10 ms por leitura. */
function scripted(statuses: readonly number[]): { send: () => Promise<number>; now: () => number; calls: () => number } {
  let index = 0;
  let clock = 0;
  return {
    send: () => Promise.resolve(statuses[index++] ?? 400),
    now: () => (clock += 10),
    calls: () => index,
  };
}

describe("flood", () => {
  test("para no primeiro 429 e diz a posição dele", async () => {
    const fake = scripted([400, 400, 429, 400]);
    const result = await flood(fake.send, 10, fake.now);
    expect(result).toEqual({ statuses: [400, 400, 429], firstLimitedAt: 3, elapsedMs: 10 });
    expect(fake.calls()).toBe(3);
  });

  test("sem 429, manda exatamente o máximo", async () => {
    const fake = scripted([]);
    const result = await flood(fake.send, 5, fake.now);
    expect(result.statuses).toEqual([400, 400, 400, 400, 400]);
    expect(result.firstLimitedAt).toBeNull();
    expect(fake.calls()).toBe(5);
  });

  test("o relógio padrão é o Date.now", async () => {
    const result = await flood(() => Promise.resolve(429), 3);
    expect(result.firstLimitedAt).toBe(1);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe("matchesBucket: o balde Token do GoTrue (rajada 30, 0,5 por segundo)", () => {
  const at = (firstLimitedAt: number | null, elapsedMs = 0) => ({ statuses: [], firstLimitedAt, elapsedMs });

  test("o balde é o do apilimiter.go", () => {
    expect(GOTRUE_TOKEN_BUCKET).toEqual({ burst: 30, refillPerSecond: 0.5 });
  });

  test.each([
    ["30 passam e o 31º é limitado", at(31), true],
    ["rajada rápida: até 1 ficha de folga", at(32), true],
    ["acima da folga", at(33), false],
    ["menos que a rajada (balde já usado)", at(30), false],
    ["4 s de rajada repõem 2 fichas, mais a folga", at(34, 4_000), true],
    ["4 s não chegam a 4 fichas", at(35, 4_000), false],
    ["sem 429 não é este balde", at(null), false],
  ])("%s", (_name, result, expected) => {
    expect(matchesBucket(result, GOTRUE_TOKEN_BUCKET)).toBe(expected);
  });
});

describe("onlyRefusals", () => {
  test.each([
    ["só recusas do GoTrue", [400, 404, 401, 403], true],
    ["um 429", [400, 429], false],
    ["um 5xx", [400, 500], false],
    ["um 2xx", [204], false],
    ["um 3xx", [302], false],
    ["nada enviado", [], false],
  ])("%s", (_name, statuses, expected) => {
    expect(onlyRefusals({ statuses, firstLimitedAt: null, elapsedMs: 0 })).toBe(expected);
  });
});
