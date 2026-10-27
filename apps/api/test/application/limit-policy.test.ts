// Política e algoritmos puros do rate limit, da cota e do ledger (ADR-014 D4 a D6). As constantes ficam
// fixadas contra o ADR: mudar exige ADR novo.
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import {
  DAILY_QUOTA_POLICY,
  LEDGER_POLICY,
  LIMIT_GUARD_POLICY,
  RATE_LIMIT_POLICY,
  STRICTEST_RATE_LIMIT_CLASS,
  WORKERS_AI_NEURON_BUDGET,
  effectiveLimit,
  isEpochMs,
  workersAiCallsPerDay,
  providerLimits,
  quotaDay,
  resolveRateLimitClass,
  slidingWindowCount,
  utcDayAndMinute,
  windowPosition,
  windowRetryAfterSeconds,
} from "../../src/application/index.js";

const MINUTE = 60_000;
const DAY = 86_400_000;

describe("política fixada no ADR-014 (D4 a D6)", () => {
  test("rate limit: janela de 60 s, padrao 60/120, analise 5/20 e criterios 10/30 (ADR-021 D8.2)", () => {
    expect(RATE_LIMIT_POLICY).toEqual({
      windowMs: 60_000,
      classes: {
        padrao: { user: 60, address: 120 },
        analise: { user: 5, address: 20 },
        criterios: { user: 10, address: 30 },
      },
    });
    expect(STRICTEST_RATE_LIMIT_CLASS).toBe("analise");
  });

  test("a classe mais estrita é a menor nas duas dimensões, contra todas as outras", () => {
    const strictest = RATE_LIMIT_POLICY.classes[STRICTEST_RATE_LIMIT_CLASS];
    for (const [name, limits] of Object.entries(RATE_LIMIT_POLICY.classes)) {
      if (name === STRICTEST_RATE_LIMIT_CLASS) continue;
      expect(strictest.user, name).toBeLessThan(limits.user);
      expect(strictest.address, name).toBeLessThan(limits.address);
    }
  });

  test("cota: 50 por dia, dia de Brasília (UTC−03:00), set com TTL de 2 dias", () => {
    expect(DAILY_QUOTA_POLICY).toEqual({ analysesPerDay: 50, utcOffsetMinutes: -180, keyTtlSeconds: 172_800 });
  });

  test("ledger: folga de 15%, breaker global de 400 por dia e limites publicados por provedor", () => {
    expect(LEDGER_POLICY).toEqual({
      headroom: 0.85,
      globalCallsPerDay: 400,
      providers: {
        // Reserva pessimista de 3.000 só no Groq (ADR-022 D7.2).
        groq: { rpm: 30, rpd: 1_000, tpm: 8_000, tpd: 200_000, reservedTokensPerCall: 3_000 },
        cloudflare_workers_ai: { rpm: 60, rpd: 54, tpm: null, tpd: null, reservedTokensPerCall: null },
        ollama: { rpm: null, rpd: null, tpm: null, tpd: null, reservedTokensPerCall: null },
      },
      minuteTtlSeconds: 120,
      dayTtlSeconds: 172_800,
      maxTokensPerCall: 1_000_000,
      // Bloqueio por Retry-After compartilhado (ADR-022 D7.3).
      rateLimitBlock: { defaultMs: 60_000, minMs: 1_000, maxMs: 3_600_000 },
    });
    expect(LIMIT_GUARD_POLICY).toEqual({ timeoutMs: 250 });
  });

  test("Workers AI: rpd pela fórmula de neurons do ADR-020 D9, com a folga aplicada uma vez só", () => {
    expect(WORKERS_AI_NEURON_BUDGET).toEqual({
      neuronsPerDay: 10_000,
      inputTokens: 2_200,
      outputTokens: 600,
      inputNeuronsPerMillion: 26_668,
      outputNeuronsPerMillion: 204_805,
    });
    // 2.200 × 26.668 / 1e6 = 58,67 e 600 × 204.805 / 1e6 = 122,88: 181,55 → 182 neurons por chamada.
    const perCall = Math.ceil((2_200 * 26_668 + 600 * 204_805) / 1_000_000);
    expect(perCall).toBe(182);
    expect(workersAiCallsPerDay()).toBe(Math.floor(10_000 / perCall));
    expect(workersAiCallsPerDay()).toBe(54);
    expect(LEDGER_POLICY.providers.cloudflare_workers_ai.rpd).toBe(workersAiCallsPerDay());
    // Teto efetivo de 45 por dia, abaixo dos 10.000 × 0,85 ÷ 182 ≈ 46,7 do ADR: a folga não entra duas vezes.
    expect(effectiveLimit(LEDGER_POLICY.providers.cloudflare_workers_ai.rpd)).toBe(45);
  });

  test("todo provedor com limite de tokens tem reserva (o ledger só conta tokens pela reserva, ADR-022 D7.2)", () => {
    for (const limits of Object.values(LEDGER_POLICY.providers)) {
      if (limits.tpm !== null || limits.tpd !== null) expect(limits.reservedTokensPerCall).not.toBeNull();
    }
  });

  test("o Gemini não tem política (HITL-012): o ledger o trata como esgotado", () => {
    expect(providerLimits("google_ai_studio")).toBeNull();
    expect(providerLimits("groq")).toEqual(LEDGER_POLICY.providers.groq);
  });

  test("limite efetivo = floor(publicado × 0,85)", () => {
    expect(effectiveLimit(30)).toBe(25);
    expect(effectiveLimit(1_000)).toBe(850);
    expect(effectiveLimit(8_000)).toBe(6_800);
    expect(effectiveLimit(200_000)).toBe(170_000);
    expect(effectiveLimit(60)).toBe(51);
  });
});

describe("resolveRateLimitClass", () => {
  test("sem classe vale padrao; classe conhecida vale ela mesma", () => {
    expect(resolveRateLimitClass(undefined)).toBe("padrao");
    expect(resolveRateLimitClass("padrao")).toBe("padrao");
    expect(resolveRateLimitClass("analise")).toBe("analise");
    expect(resolveRateLimitClass("criterios")).toBe("criterios");
  });

  test.each([["outra"], [null], [""], ["ANALISE"], ["CRITERIOS"], ["criterio"], [" criterios"], [1], [{}], ["__proto__"], ["constructor"]])(
    "valor fora do conjunto (%j) vale a classe mais estrita",
    (value) => {
      expect(resolveRateLimitClass(value)).toBe("analise");
    },
  );
});

describe("isEpochMs", () => {
  test.each([
    [0, true],
    [1_761_000_000_000, true],
    [Number.MAX_SAFE_INTEGER, true],
    [-1, false],
    [1.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
  ])("%d → %s", (value, expected) => {
    expect(isEpochMs(value)).toBe(expected);
  });
});

describe("janela deslizante", () => {
  test("posição na janela", () => {
    expect(windowPosition(0, MINUTE)).toEqual({ index: 0, elapsedMs: 0 });
    expect(windowPosition(MINUTE - 1, MINUTE)).toEqual({ index: 0, elapsedMs: MINUTE - 1 });
    expect(windowPosition(5 * MINUTE + 1_234, MINUTE)).toEqual({ index: 5, elapsedMs: 1_234 });
  });

  test("a janela anterior pesa pela fração restante, com floor", () => {
    expect(slidingWindowCount(10, 3, 0, MINUTE)).toBe(13);
    expect(slidingWindowCount(10, 3, 30_000, MINUTE)).toBe(8);
    expect(slidingWindowCount(10, 3, 45_000, MINUTE)).toBe(5);
    expect(slidingWindowCount(9, 1, 40_000, MINUTE)).toBe(4);
    expect(slidingWindowCount(10, 3, MINUTE - 1, MINUTE)).toBe(3);
  });

  test("Retry-After até o fim da janela, em [1, 60]", () => {
    expect(windowRetryAfterSeconds(0, MINUTE)).toBe(60);
    expect(windowRetryAfterSeconds(30_000, MINUTE)).toBe(30);
    expect(windowRetryAfterSeconds(30_001, MINUTE)).toBe(30);
    expect(windowRetryAfterSeconds(59_999, MINUTE)).toBe(1);
    expect(windowRetryAfterSeconds(MINUTE, MINUTE)).toBe(1);
    expect(windowRetryAfterSeconds(-MINUTE, MINUTE)).toBe(60);
  });

  test("propriedade: o peso fica entre a janela atual e a soma das duas, e o Retry-After em [1, 60]", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: MINUTE - 1 }),
        (previous, current, elapsed) => {
          const weight = slidingWindowCount(previous, current, elapsed, MINUTE);
          expect(weight).toBeGreaterThanOrEqual(current);
          expect(weight).toBeLessThanOrEqual(previous + current);
          expect(Number.isInteger(weight)).toBe(true);
          const retry = windowRetryAfterSeconds(elapsed, MINUTE);
          expect(retry).toBeGreaterThanOrEqual(1);
          expect(retry).toBeLessThanOrEqual(60);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe("dia da cota e dos provedores", () => {
  const at = (iso: string): number => Date.parse(iso);

  test("o dia de Brasília vira às 03:00 UTC", () => {
    expect(quotaDay(at("2026-10-21T02:59:59.999Z"), -180).day).toBe("2026-10-20");
    expect(quotaDay(at("2026-10-21T03:00:00.000Z"), -180).day).toBe("2026-10-21");
    expect(quotaDay(at("2026-10-22T02:59:59.999Z"), -180).day).toBe("2026-10-21");
  });

  test("segundos até a meia-noite de Brasília, em [1, 86.400]", () => {
    expect(quotaDay(at("2026-10-21T03:00:00.000Z"), -180).secondsUntilNextDay).toBe(86_400);
    expect(quotaDay(at("2026-10-22T02:59:59.999Z"), -180).secondsUntilNextDay).toBe(1);
    expect(quotaDay(at("2026-10-22T02:59:00.000Z"), -180).secondsUntilNextDay).toBe(60);
    expect(quotaDay(at("2026-10-21T15:00:00.000Z"), -180).secondsUntilNextDay).toBe(12 * 3_600);
  });

  test("dia e minuto UTC dos provedores", () => {
    expect(utcDayAndMinute(at("2026-10-21T23:59:59.999Z"))).toEqual({
      day: "2026-10-21",
      minute: Math.floor(at("2026-10-21T23:59:00.000Z") / MINUTE),
    });
    expect(utcDayAndMinute(at("2026-10-22T00:00:00.000Z")).day).toBe("2026-10-22");
  });

  test("propriedade: o dia muda exatamente na meia-noite do fuso e o Retry-After nunca passa de 86.400", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_000_000_000_000 }), (epoch) => {
        const { day, secondsUntilNextDay } = quotaDay(epoch, -180);
        expect(secondsUntilNextDay).toBeGreaterThanOrEqual(1);
        expect(secondsUntilNextDay).toBeLessThanOrEqual(86_400);
        // A próxima virada é a próxima meia-noite de Brasília (03:00 UTC).
        const boundary = (Math.floor((epoch - 180 * MINUTE) / DAY) + 1) * DAY + 180 * MINUTE;
        expect(secondsUntilNextDay).toBe(Math.ceil((boundary - epoch) / 1_000));
        // Um milissegundo antes da virada ainda é o mesmo dia; na virada já é o seguinte.
        expect(quotaDay(boundary - 1, -180).day).toBe(day);
        expect(quotaDay(boundary, -180).day > day).toBe(true);
      }),
      { numRuns: 1_000 },
    );
  });
});
