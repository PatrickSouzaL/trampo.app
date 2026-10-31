// QuotaLedger em Redis (ADR-009 D6; ADR-014 D6; T7, T39) contra o Redis simulado em memória: folga de 15%
// por provedor, breaker diário global, compensação na negação, falha fechado, reserva pessimista de tokens com
// reconciliação (ADR-022 D7.2), bloqueio por Retry-After (ADR-022 D7.3) e recordUsage/recordRateLimit em
// melhor esforço.
// No fim, o router real com este ledger: Redis fora do ar → `cota_esgotada`, sem chamada ao LLM.
import type { LlmProviderId } from "@trampo/contracts";
import { describe, expect, test } from "vitest";

import {
  InMemoryProviderStateStore,
  LEDGER_POLICY,
  LlmProviderRouter,
  ROUTER_POLICY,
  deadlineAfter,
} from "../../src/application/index.js";
import { createRedisQuotaLedger } from "../../src/infrastructure/limits/redis-quota-ledger.js";
import type { RedisValue } from "../../src/infrastructure/redis/upstash-rest-client.js";
import { FakeClock } from "../application/fakes/fake-clock.js";
import { PAYLOAD, VALID_RAW } from "../application/fakes/router-harness.js";
import { ScriptedExtractor, type Step } from "../application/fakes/scripted-extractor.js";
import { memoryRedis, type MemoryMode } from "./fakes/redis-store.js";

const NOW = Date.parse("2026-10-21T18:30:15.000Z");
const DAY = "2026-10-21";
const MINUTE = Math.floor(NOW / 60_000);

function harness(now = NOW) {
  const memory = memoryRedis();
  const clock = { now };
  const ledger = createRedisQuotaLedger({ redis: memory.redis, now: () => clock.now });
  const reserve = (provider: LlmProviderId = "groq") => ledger.reserve(provider, new AbortController().signal);
  return { ...memory, clock, ledger, reserve };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const RESERVED = 3_000;

describe("reserve", () => {
  test("sem limite de tokens (Workers AI): global, RPM, RPD e o bloqueio, em 7 comandos", async () => {
    const h = harness();
    await expect(h.reserve("cloudflare_workers_ai")).resolves.toBe("permitido");
    expect(h.log[0]).toEqual([
      ["INCR", `llm:global:${DAY}`],
      ["EXPIRE", `llm:global:${DAY}`, 172_800],
      ["INCR", `llm:rpm:cloudflare_workers_ai:${MINUTE}`],
      ["EXPIRE", `llm:rpm:cloudflare_workers_ai:${MINUTE}`, 120],
      ["INCR", `llm:rpd:cloudflare_workers_ai:${DAY}`],
      ["EXPIRE", `llm:rpd:cloudflare_workers_ai:${DAY}`, 172_800],
      ["EXISTS", "llm:block:cloudflare_workers_ai"],
    ]);
    expect(h.store.counter(`llm:global:${DAY}`)).toBe(1);
  });

  test("Groq: o bloqueio e a reserva de 3.000 tokens no TPM e no TPD, na mesma transação de 11 comandos", async () => {
    const h = harness();
    await expect(h.reserve()).resolves.toBe("permitido");
    expect(h.log[0]).toEqual([
      ["INCR", `llm:global:${DAY}`],
      ["EXPIRE", `llm:global:${DAY}`, 172_800],
      ["INCR", `llm:rpm:groq:${MINUTE}`],
      ["EXPIRE", `llm:rpm:groq:${MINUTE}`, 120],
      ["INCR", `llm:rpd:groq:${DAY}`],
      ["EXPIRE", `llm:rpd:groq:${DAY}`, 172_800],
      ["EXISTS", "llm:block:groq"],
      ["INCRBY", `llm:tpm:groq:${MINUTE}`, RESERVED],
      ["EXPIRE", `llm:tpm:groq:${MINUTE}`, 120],
      ["INCRBY", `llm:tpd:groq:${DAY}`, RESERVED],
      ["EXPIRE", `llm:tpd:groq:${DAY}`, 172_800],
    ]);
    expect(h.store.counter(`llm:tpm:groq:${MINUTE}`)).toBe(RESERVED);
    expect(h.store.counter(`llm:tpd:groq:${DAY}`)).toBe(RESERVED);
  });

  test("Groq: 25 por minuto (85% de 30); a 26ª é provedor_esgotado e é compensada", async () => {
    const h = harness();
    // Cada reserva é reconciliada a zero: só o RPM decide aqui.
    for (let i = 0; i < 25; i += 1) {
      await expect(h.reserve()).resolves.toBe("permitido");
      h.store.values.set(`llm:tpm:groq:${MINUTE}`, "0");
      h.store.values.set(`llm:tpd:groq:${DAY}`, "0");
    }
    await expect(h.reserve()).resolves.toBe("provedor_esgotado");
    await settle();
    expect(h.store.counter(`llm:rpm:groq:${MINUTE}`)).toBe(25);
    expect(h.store.counter(`llm:global:${DAY}`)).toBe(25);
    expect(h.store.counter(`llm:rpd:groq:${DAY}`)).toBe(25);
    // No minuto seguinte, volta a permitir.
    h.clock.now = NOW + 60_000;
    await expect(h.reserve()).resolves.toBe("permitido");
  });

  test("Groq: 850 por dia (85% de 1.000)", async () => {
    const h = harness();
    h.store.values.set(`llm:rpd:groq:${DAY}`, "849");
    await expect(h.reserve()).resolves.toBe("permitido");
    await expect(h.reserve()).resolves.toBe("provedor_esgotado");
  });

  test.each([
    ["tpm", `llm:tpm:groq:${MINUTE}`, 6_800],
    ["tpd", `llm:tpd:groq:${DAY}`, 170_000],
  ])("Groq: %s com a reserva chegando ao efetivo passa; 1 token acima é negado e compensado", async (_name, key, cap) => {
    const h = harness();
    h.store.values.set(key, String(cap - RESERVED));
    await expect(h.reserve()).resolves.toBe("permitido");
    expect(h.store.counter(key)).toBe(cap);
    h.store.values.set(key, String(cap - RESERVED + 1));
    await expect(h.reserve()).resolves.toBe("provedor_esgotado");
    await settle();
    expect(h.log.at(-1)).toEqual([
      ["DECR", `llm:global:${DAY}`],
      ["DECR", `llm:rpm:groq:${MINUTE}`],
      ["DECR", `llm:rpd:groq:${DAY}`],
      ["DECRBY", `llm:tpm:groq:${MINUTE}`, RESERVED],
      ["DECRBY", `llm:tpd:groq:${DAY}`, RESERVED],
    ]);
    expect(h.store.counter(key)).toBe(cap - RESERVED + 1);
  });

  test("Groq: N reservas simultâneas não passam pelo mesmo saldo (a 3ª estoura os 6.800 do TPM)", async () => {
    const h = harness();
    const decisions = await Promise.all([h.reserve(), h.reserve(), h.reserve(), h.reserve()]);
    expect(decisions).toEqual(["permitido", "permitido", "provedor_esgotado", "provedor_esgotado"]);
    await settle();
    expect(h.store.counter(`llm:tpm:groq:${MINUTE}`)).toBe(2 * RESERVED);
    expect(h.store.counter(`llm:tpd:groq:${DAY}`)).toBe(2 * RESERVED);
    expect(h.store.counter(`llm:rpm:groq:${MINUTE}`)).toBe(2);
  });

  test("sem limite de tokens: gasto acumulado no TPM não nega, e nada é escrito nele", async () => {
    const h = harness();
    h.store.values.set(`llm:tpd:ollama:${DAY}`, "999999999");
    await expect(h.reserve("ollama")).resolves.toBe("permitido");
    expect(h.store.values.has(`llm:tpm:ollama:${MINUTE}`)).toBe(false);
  });

  test("Cloudflare: 51 por minuto e 84 por dia (p95 de neurons do S-1, emenda ao ADR-020 D9), sem limite de tokens", async () => {
    const h = harness();
    h.store.values.set(`llm:tpd:cloudflare_workers_ai:${DAY}`, "999999999");
    for (let i = 0; i < 51; i += 1) await h.reserve("cloudflare_workers_ai");
    await expect(h.reserve("cloudflare_workers_ai")).resolves.toBe("provedor_esgotado");
    const day = harness();
    day.store.values.set(`llm:rpd:cloudflare_workers_ai:${DAY}`, "83");
    await expect(day.reserve("cloudflare_workers_ai")).resolves.toBe("permitido");
    await expect(day.reserve("cloudflare_workers_ai")).resolves.toBe("provedor_esgotado");
  });

  test("Ollama: sem limite de provedor, mas conta no global", async () => {
    const h = harness();
    h.store.values.set(`llm:rpm:ollama:${MINUTE}`, "100000");
    await expect(h.reserve("ollama")).resolves.toBe("permitido");
    expect(h.store.counter(`llm:global:${DAY}`)).toBe(1);
  });

  test("Gemini (HITL-012): provedor_esgotado sem tocar no Redis", async () => {
    const h = harness();
    await expect(h.reserve("google_ai_studio")).resolves.toBe("provedor_esgotado");
    expect(h.log).toHaveLength(0);
  });

  test("breaker diário global: a 401ª chamada do dia é global_esgotado, para qualquer provedor", async () => {
    const h = harness();
    h.store.values.set(`llm:global:${DAY}`, "399");
    await expect(h.reserve("ollama")).resolves.toBe("permitido");
    await expect(h.reserve("groq")).resolves.toBe("global_esgotado");
    await expect(h.reserve("ollama")).resolves.toBe("global_esgotado");
    await settle();
    expect(h.store.counter(`llm:global:${DAY}`)).toBe(LEDGER_POLICY.globalCallsPerDay);
  });

  test("o global e os provedores usam o dia UTC (o Cloudflare zera às 00:00 UTC)", async () => {
    const h = harness(Date.parse("2026-10-21T23:59:59.999Z"));
    h.store.values.set(`llm:global:2026-10-21`, "400");
    await expect(h.reserve()).resolves.toBe("global_esgotado");
    h.clock.now = Date.parse("2026-10-22T00:00:00.000Z");
    await expect(h.reserve()).resolves.toBe("permitido");
  });

  test("a compensação usa um signal próprio e, se falhar, a contagem só fica maior", async () => {
    const h = harness();
    h.store.values.set(`llm:global:${DAY}`, "400");
    h.setMode({ kind: "normal" }, { kind: "rejeita" });
    await expect(h.reserve("cloudflare_workers_ai")).resolves.toBe("global_esgotado");
    await settle();
    expect(h.log.at(-1)).toEqual([
      ["DECR", `llm:global:${DAY}`],
      ["DECR", `llm:rpm:cloudflare_workers_ai:${MINUTE}`],
      ["DECR", `llm:rpd:cloudflare_workers_ai:${DAY}`],
    ]);
    expect(h.signals.at(-1)?.aborted).toBe(false);
    expect(h.store.counter(`llm:global:${DAY}`)).toBe(401);
  });
});

describe("reserve falha fechado (T39)", () => {
  test.each<[string, MemoryMode]>([
    ["nulo", { kind: "nulo" }],
    ["lança", { kind: "lanca" }],
    ["rejeita", { kind: "rejeita" }],
  ])("Redis %s → global_esgotado", async (_name, mode) => {
    const h = harness();
    h.setMode(mode);
    await expect(h.reserve()).resolves.toBe("global_esgotado");
  });

  const alter = (index: number, value: unknown) => (replies: RedisValue[]) => replies.map((r, i) => (i === index ? value : r));
  test.each<[string, LlmProviderId, (replies: RedisValue[]) => unknown[]]>([
    ["INCR global zerado", "groq", alter(0, 0)],
    ["EXPIRE global falhou", "groq", alter(1, 0)],
    ["INCR do RPM em texto", "groq", alter(2, "1")],
    ["EXPIRE do RPM falhou", "groq", alter(3, 0)],
    ["INCR do RPD nulo", "groq", alter(4, null)],
    ["EXPIRE do RPD falhou", "groq", alter(5, 0)],
    ["EXISTS do bloqueio com 2", "groq", alter(6, 2)],
    ["EXISTS do bloqueio em texto", "cloudflare_workers_ai", alter(6, "1")],
    ["EXISTS do bloqueio nulo", "cloudflare_workers_ai", alter(6, null)],
    ["INCRBY do TPM em texto", "groq", alter(7, "3000")],
    ["EXPIRE do TPM falhou", "groq", alter(8, 0)],
    ["INCRBY do TPD fracionário", "groq", alter(9, 3000.5)],
    ["EXPIRE do TPD falhou", "groq", alter(10, 0)],
    ["resposta curta (Groq)", "groq", (r) => r.slice(0, 10)],
    ["resposta curta (Workers AI)", "cloudflare_workers_ai", (r) => r.slice(0, 6)],
  ])("%s (%s) → global_esgotado", async (_name, provider, change) => {
    const h = harness();
    h.setMode({ kind: "altera", change });
    await expect(h.reserve(provider)).resolves.toBe("global_esgotado");
  });

  test("Groq: INCRBY negativo (reconciliação que cruzou a virada) é inteiro válido, não falha fechado", async () => {
    const h = harness();
    h.store.values.set(`llm:tpm:groq:${MINUTE}`, "-3600");
    await expect(h.reserve()).resolves.toBe("permitido");
    expect(h.store.counter(`llm:tpm:groq:${MINUTE}`)).toBe(-600);
  });

  test("relógio inválido → global_esgotado sem tocar no Redis", async () => {
    const h = harness(-5);
    await expect(h.reserve()).resolves.toBe("global_esgotado");
    expect(h.log).toHaveLength(0);
  });

  test("o signal do router chega ao Redis", async () => {
    const h = harness();
    const controller = new AbortController();
    await h.ledger.reserve("groq", controller.signal);
    expect(h.signals[0]).toBe(controller.signal);
  });
});

describe("bloqueio por Retry-After (ADR-022 D7.3)", () => {
  test.each<[number | null, number]>([
    [887_000, 887_000],
    [46_000, 46_000],
    [null, 60_000],
    [500, 1_000],
    [0, 1_000],
    [1_000.2, 1_001],
    [3_600_000, 3_600_000],
    [9_999_999, 3_600_000],
    [-1, 60_000],
    [Number.NaN, 60_000],
    [Number.POSITIVE_INFINITY, 60_000],
  ])("Retry-After %s ms → SET llm:block PX %i", async (retryAfterMs, ms) => {
    const h = harness();
    await h.ledger.recordRateLimit("groq", retryAfterMs);
    expect(h.log).toEqual([[["SET", "llm:block:groq", 1, "PX", ms]]]);
    expect(h.store.ttlMs.get("llm:block:groq")).toBe(ms);
    expect(h.signals[0]?.aborted).toBe(false);
  });

  test("provedor bloqueado: provedor_esgotado, com a compensação das chamadas e da reserva", async () => {
    const h = harness();
    await h.ledger.recordRateLimit("groq", 417_000);
    await expect(h.reserve()).resolves.toBe("provedor_esgotado");
    await settle();
    expect(h.log.at(-1)).toEqual([
      ["DECR", `llm:global:${DAY}`],
      ["DECR", `llm:rpm:groq:${MINUTE}`],
      ["DECR", `llm:rpd:groq:${DAY}`],
      ["DECRBY", `llm:tpm:groq:${MINUTE}`, RESERVED],
      ["DECRBY", `llm:tpd:groq:${DAY}`, RESERVED],
    ]);
    expect(h.store.counter(`llm:global:${DAY}`)).toBe(0);
    expect(h.store.counter(`llm:tpd:groq:${DAY}`)).toBe(0);
  });

  test("o bloqueio é por provedor: a Workers AI continua permitida", async () => {
    const h = harness();
    await h.ledger.recordRateLimit("groq", null);
    await expect(h.reserve("cloudflare_workers_ai")).resolves.toBe("permitido");
  });

  test("o bloqueio vale para outra instância do ledger sobre o mesmo Redis (sobrevive a um restart)", async () => {
    const h = harness();
    await h.ledger.recordRateLimit("groq", 887_000);
    const restarted = createRedisQuotaLedger({ redis: h.redis, now: () => NOW });
    await expect(restarted.reserve("groq", new AbortController().signal)).resolves.toBe("provedor_esgotado");
  });

  test("a cota global esgotada continua sendo global_esgotado, mesmo bloqueado", async () => {
    const h = harness();
    h.store.values.set(`llm:global:${DAY}`, "400");
    await h.ledger.recordRateLimit("groq", null);
    await expect(h.reserve()).resolves.toBe("global_esgotado");
  });

  test("a chave só leva o id do provedor (enum fechado)", async () => {
    const h = harness();
    await h.ledger.recordRateLimit("cloudflare_workers_ai", 5_000);
    expect(h.store.values.get("llm:block:cloudflare_workers_ai")).toBe("1");
  });

  test.each<[string, MemoryMode]>([
    ["lança", { kind: "lanca" }],
    ["rejeita", { kind: "rejeita" }],
    ["nulo", { kind: "nulo" }],
  ])("Redis que %s não derruba nada", async (_name, mode) => {
    const h = harness();
    h.setMode(mode);
    await expect(h.ledger.recordRateLimit("groq", 1_000)).resolves.toBeUndefined();
  });
});

describe("recordUsage (melhor esforço)", () => {
  test("sem reserva (Workers AI): soma entrada e saída no minuto e no dia do provedor", async () => {
    const h = harness();
    await h.ledger.recordUsage("cloudflare_workers_ai", { inputTokens: 1_200, outputTokens: 300 });
    await h.ledger.recordUsage("cloudflare_workers_ai", { inputTokens: 100, outputTokens: 0 });
    expect(h.store.counter(`llm:tpm:cloudflare_workers_ai:${MINUTE}`)).toBe(1_600);
    expect(h.store.counter(`llm:tpd:cloudflare_workers_ai:${DAY}`)).toBe(1_600);
    expect(h.log[0]).toEqual([
      ["INCRBY", `llm:tpm:cloudflare_workers_ai:${MINUTE}`, 1_500],
      ["EXPIRE", `llm:tpm:cloudflare_workers_ai:${MINUTE}`, 120],
      ["INCRBY", `llm:tpd:cloudflare_workers_ai:${DAY}`, 1_500],
      ["EXPIRE", `llm:tpd:cloudflare_workers_ai:${DAY}`, 172_800],
    ]);
    expect(h.signals[0]?.aborted).toBe(false);
  });

  test("Groq: reconciliação negativa ajusta a reserva ao uso real (2.400 de 3.000)", async () => {
    const h = harness();
    await h.reserve();
    await h.ledger.recordUsage("groq", { inputTokens: 2_000, outputTokens: 400 });
    expect(h.log[1]).toEqual([
      ["INCRBY", `llm:tpm:groq:${MINUTE}`, -600],
      ["EXPIRE", `llm:tpm:groq:${MINUTE}`, 120],
      ["INCRBY", `llm:tpd:groq:${DAY}`, -600],
      ["EXPIRE", `llm:tpd:groq:${DAY}`, 172_800],
    ]);
    expect(h.store.counter(`llm:tpm:groq:${MINUTE}`)).toBe(2_400);
    expect(h.store.counter(`llm:tpd:groq:${DAY}`)).toBe(2_400);
  });

  test("Groq: reconciliação positiva quando o uso passa da reserva", async () => {
    const h = harness();
    await h.reserve();
    await h.ledger.recordUsage("groq", { inputTokens: 3_000, outputTokens: 704 });
    expect(h.store.counter(`llm:tpd:groq:${DAY}`)).toBe(3_704);
  });

  test("Groq: uso igual à reserva não manda comando", async () => {
    const h = harness();
    await h.ledger.recordUsage("groq", { inputTokens: 2_600, outputTokens: 400 });
    expect(h.log).toHaveLength(0);
  });

  test("Groq: chamada sem 200 (sem recordUsage) e uso zero mantêm a reserva cheia", async () => {
    const h = harness();
    await h.reserve();
    await h.ledger.recordUsage("groq", { inputTokens: 0, outputTokens: 0 });
    expect(h.store.counter(`llm:tpm:groq:${MINUTE}`)).toBe(RESERVED);
    expect(h.store.counter(`llm:tpd:groq:${DAY}`)).toBe(RESERVED);
  });

  test("Groq: os tokens reconciliados alimentam o reserve seguinte", async () => {
    const h = harness();
    await h.reserve();
    await h.ledger.recordUsage("groq", { inputTokens: 3_000, outputTokens: 900 });
    // 3.900 reais + 3.000 da nova reserva = 6.900 > 6.800.
    await expect(h.reserve()).resolves.toBe("provedor_esgotado");
  });

  test("Gemini (fora da tabela): soma o uso inteiro, sem reserva", async () => {
    const h = harness();
    await h.ledger.recordUsage("google_ai_studio", { inputTokens: 10, outputTokens: 5 });
    expect(h.store.counter(`llm:tpd:google_ai_studio:${DAY}`)).toBe(15);
  });

  test.each([
    ["zero", { inputTokens: 0, outputTokens: 0 }],
    ["negativo", { inputTokens: -1, outputTokens: 10 }],
    ["fracionário", { inputTokens: 1, outputTokens: 0.5 }],
    ["acima de 10⁶", { inputTokens: 1_000_001, outputTokens: 0 }],
    ["NaN", { inputTokens: Number.NaN, outputTokens: 0 }],
  ])("uso fora da forma (%s) é ignorado, sem comando", async (_name, usage) => {
    const h = harness();
    await h.ledger.recordUsage("groq", usage);
    expect(h.log).toHaveLength(0);
  });

  test("10⁶ ainda é aceito", async () => {
    const h = harness();
    await h.ledger.recordUsage("ollama", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(h.store.counter(`llm:tpd:ollama:${DAY}`)).toBe(2_000_000);
  });

  test.each([[Number.NaN], [-5], [2.5]])("relógio inválido (%d): ignorado, sem comando", async (now) => {
    const h = harness(now);
    await h.ledger.recordUsage("groq", { inputTokens: 1, outputTokens: 1 });
    expect(h.log).toHaveLength(0);
  });

  test.each<[string, MemoryMode]>([
    ["lança", { kind: "lanca" }],
    ["rejeita", { kind: "rejeita" }],
    ["nulo", { kind: "nulo" }],
  ])("Redis que %s não derruba nada", async (_name, mode) => {
    const h = harness();
    h.setMode(mode);
    await expect(h.ledger.recordUsage("groq", { inputTokens: 1, outputTokens: 1 })).resolves.toBeUndefined();
  });
});

describe("router real com o ledger em Redis (ADR-009 D6)", () => {
  function routerWith(mode: MemoryMode) {
    const clock = new FakeClock();
    const memory = memoryRedis();
    memory.setMode(mode);
    const ledger = createRedisQuotaLedger({ redis: memory.redis, now: () => NOW });
    const groq = new ScriptedExtractor("groq", clock, [{ kind: "ok", raw: VALID_RAW, latencyMs: 100 }]);
    const cloudflare = new ScriptedExtractor("cloudflare_workers_ai", clock, [{ kind: "ok", raw: VALID_RAW }]);
    const router = new LlmProviderRouter({
      chain: ["groq", "cloudflare_workers_ai"],
      extractors: [groq, cloudflare],
      clock,
      random: { next: () => 0.5 },
      ledger,
      states: new InMemoryProviderStateStore(),
    });
    const analyze = () => clock.run(router.extract(PAYLOAD, deadlineAfter(clock, ROUTER_POLICY.analysisDeadlineMs)));
    return { memory, analyze, groq, cloudflare };
  }

  test("Redis saudável: a chamada sai, e a reserva é reconciliada com o uso real", async () => {
    const h = routerWith({ kind: "normal" });
    const outcome = await h.analyze();
    expect(outcome.ok).toBe(true);
    await settle();
    expect(h.memory.store.counter(`llm:tpd:groq:${DAY}`)).toBe(1_500);
  });

  test("Groq que não volta 200 fica com a reserva cheia (o gasto que o ledger não via)", async () => {
    const clock = new FakeClock();
    const memory = memoryRedis();
    const ledger = createRedisQuotaLedger({ redis: memory.redis, now: () => NOW });
    const groq = new ScriptedExtractor("groq", clock, [{ kind: "erro_permanente", latencyMs: 100 }]);
    const cloudflare = new ScriptedExtractor("cloudflare_workers_ai", clock, [{ kind: "ok", raw: VALID_RAW }]);
    const router = new LlmProviderRouter({
      chain: ["groq", "cloudflare_workers_ai"],
      extractors: [groq, cloudflare],
      clock,
      random: { next: () => 0.5 },
      ledger,
      states: new InMemoryProviderStateStore(),
    });
    const outcome = await clock.run(router.extract(PAYLOAD, deadlineAfter(clock, ROUTER_POLICY.analysisDeadlineMs)));
    expect(outcome).toMatchObject({ ok: true, provider: "cloudflare_workers_ai" });
    await settle();
    expect(memory.store.counter(`llm:tpd:groq:${DAY}`)).toBe(RESERVED);
  });

  test.each<[string, MemoryMode]>([
    ["travado", { kind: "trava" }],
    ["com erro", { kind: "rejeita" }],
    ["com resposta inesperada", { kind: "altera", change: () => ["lixo"] }],
  ])("Redis %s: cota_esgotada e nenhuma chamada ao LLM", async (_name, mode) => {
    const h = routerWith(mode);
    const outcome = await h.analyze();
    expect(outcome).toMatchObject({ ok: false, reason: "cota_esgotada" });
    expect(h.groq.calls).toHaveLength(0);
    expect(h.cloudflare.calls).toHaveLength(0);
  });

  test("429 do Groq grava o bloqueio, e o router de outra instância pula o Groq sem chamada", async () => {
    const memory = memoryRedis();
    const build = (groqSteps: Step[]) => {
      const clock = new FakeClock();
      const groq = new ScriptedExtractor("groq", clock, groqSteps);
      const cloudflare = new ScriptedExtractor("cloudflare_workers_ai", clock, [{ kind: "ok", raw: VALID_RAW }]);
      const router = new LlmProviderRouter({
        chain: ["groq", "cloudflare_workers_ai"],
        extractors: [groq, cloudflare],
        clock,
        random: { next: () => 0.5 },
        ledger: createRedisQuotaLedger({ redis: memory.redis, now: () => NOW }),
        states: new InMemoryProviderStateStore(),
      });
      const analyze = () => clock.run(router.extract(PAYLOAD, deadlineAfter(clock, ROUTER_POLICY.analysisDeadlineMs)));
      return { analyze, groq };
    };
    const first = build([{ kind: "limite_de_taxa", retryAfterMs: 887_000 }]);
    expect(await first.analyze()).toMatchObject({ ok: true, provider: "cloudflare_workers_ai" });
    await settle();
    expect(memory.store.ttlMs.get("llm:block:groq")).toBe(887_000);

    const second = build([{ kind: "ok", raw: VALID_RAW }]);
    const outcome = await second.analyze();
    expect(outcome).toMatchObject({ ok: true, provider: "cloudflare_workers_ai" });
    expect(outcome.trail[0]).toEqual({ provider: "groq", outcome: "cota_esgotada", called: false });
    expect(second.groq.calls).toHaveLength(0);
  });

  test("Groq esgotado no Redis: o router pula para o Cloudflare antes de tomar 429", async () => {
    const h = routerWith({ kind: "normal" });
    h.memory.store.values.set(`llm:rpd:groq:${DAY}`, "850");
    const outcome = await h.analyze();
    expect(outcome).toMatchObject({ ok: true, provider: "cloudflare_workers_ai" });
    expect(h.groq.calls).toHaveLength(0);
  });
});
