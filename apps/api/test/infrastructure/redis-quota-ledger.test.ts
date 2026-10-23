// QuotaLedger em Redis (ADR-009 D6; ADR-014 D6; T7, T39) contra o Redis simulado em memória: folga de 15%
// por provedor, breaker diário global, compensação na negação, falha fechado e recordUsage em melhor esforço.
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
import { ScriptedExtractor } from "../application/fakes/scripted-extractor.js";
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

describe("reserve", () => {
  test("permite e conta global, RPM e RPD numa transação de 8 comandos", async () => {
    const h = harness();
    await expect(h.reserve()).resolves.toBe("permitido");
    expect(h.log[0]).toEqual([
      ["INCR", `llm:global:${DAY}`],
      ["EXPIRE", `llm:global:${DAY}`, 172_800],
      ["INCR", `llm:rpm:groq:${MINUTE}`],
      ["EXPIRE", `llm:rpm:groq:${MINUTE}`, 120],
      ["INCR", `llm:rpd:groq:${DAY}`],
      ["EXPIRE", `llm:rpd:groq:${DAY}`, 172_800],
      ["GET", `llm:tpm:groq:${MINUTE}`],
      ["GET", `llm:tpd:groq:${DAY}`],
    ]);
    expect(h.store.counter(`llm:global:${DAY}`)).toBe(1);
  });

  test("Groq: 25 por minuto (85% de 30); a 26ª é provedor_esgotado e é compensada", async () => {
    const h = harness();
    for (let i = 0; i < 25; i += 1) await expect(h.reserve()).resolves.toBe("permitido");
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
  ])("Groq: tokens do %s no teto efetivo bloqueiam; um abaixo ainda passa", async (_name, key, cap) => {
    const h = harness();
    h.store.values.set(key, String(cap - 1));
    await expect(h.reserve()).resolves.toBe("permitido");
    h.store.values.set(key, String(cap));
    await expect(h.reserve()).resolves.toBe("provedor_esgotado");
  });

  test("Cloudflare: 51 por minuto e 45 por dia (neurons do ADR-020 D9), sem limite de tokens", async () => {
    const h = harness();
    h.store.values.set(`llm:tpd:cloudflare_workers_ai:${DAY}`, "999999999");
    for (let i = 0; i < 51; i += 1) await h.reserve("cloudflare_workers_ai");
    await expect(h.reserve("cloudflare_workers_ai")).resolves.toBe("provedor_esgotado");
    const day = harness();
    day.store.values.set(`llm:rpd:cloudflare_workers_ai:${DAY}`, "44");
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
    await expect(h.reserve()).resolves.toBe("global_esgotado");
    await settle();
    expect(h.log.at(-1)).toEqual([
      ["DECR", `llm:global:${DAY}`],
      ["DECR", `llm:rpm:groq:${MINUTE}`],
      ["DECR", `llm:rpd:groq:${DAY}`],
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
  test.each<[string, (replies: RedisValue[]) => unknown[]]>([
    ["INCR global zerado", alter(0, 0)],
    ["EXPIRE global falhou", alter(1, 0)],
    ["INCR do RPM em texto", alter(2, "1")],
    ["EXPIRE do RPM falhou", alter(3, 0)],
    ["INCR do RPD nulo", alter(4, null)],
    ["EXPIRE do RPD falhou", alter(5, 0)],
    ["GET do TPM com lixo", alter(6, "x")],
    ["GET do TPD numérico", alter(7, 5)],
    ["resposta curta", (r) => r.slice(0, 7)],
  ])("%s → global_esgotado", async (_name, change) => {
    const h = harness();
    h.setMode({ kind: "altera", change });
    await expect(h.reserve()).resolves.toBe("global_esgotado");
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

describe("recordUsage (melhor esforço)", () => {
  test("soma entrada e saída no minuto e no dia do provedor", async () => {
    const h = harness();
    await h.ledger.recordUsage("groq", { inputTokens: 1_200, outputTokens: 300 });
    await h.ledger.recordUsage("groq", { inputTokens: 100, outputTokens: 0 });
    expect(h.store.counter(`llm:tpm:groq:${MINUTE}`)).toBe(1_600);
    expect(h.store.counter(`llm:tpd:groq:${DAY}`)).toBe(1_600);
    expect(h.log[0]).toEqual([
      ["INCRBY", `llm:tpm:groq:${MINUTE}`, 1_500],
      ["EXPIRE", `llm:tpm:groq:${MINUTE}`, 120],
      ["INCRBY", `llm:tpd:groq:${DAY}`, 1_500],
      ["EXPIRE", `llm:tpd:groq:${DAY}`, 172_800],
    ]);
    expect(h.signals[0]?.aborted).toBe(false);
  });

  test("os tokens gastos alimentam o reserve seguinte", async () => {
    const h = harness();
    await h.ledger.recordUsage("groq", { inputTokens: 6_000, outputTokens: 800 });
    await expect(h.reserve()).resolves.toBe("provedor_esgotado");
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
    await h.ledger.recordUsage("groq", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(h.store.counter(`llm:tpd:groq:${DAY}`)).toBe(2_000_000);
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

  test("Redis saudável: a chamada sai, e o uso é contabilizado", async () => {
    const h = routerWith({ kind: "normal" });
    const outcome = await h.analyze();
    expect(outcome.ok).toBe(true);
    await settle();
    expect(h.memory.store.counter(`llm:tpd:groq:${DAY}`)).toBe(1_500);
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

  test("Groq esgotado no Redis: o router pula para o Cloudflare antes de tomar 429", async () => {
    const h = routerWith({ kind: "normal" });
    h.memory.store.values.set(`llm:rpd:groq:${DAY}`, "850");
    const outcome = await h.analyze();
    expect(outcome).toMatchObject({ ok: true, provider: "cloudflare_workers_ai" });
    expect(h.groq.calls).toHaveLength(0);
  });
});
