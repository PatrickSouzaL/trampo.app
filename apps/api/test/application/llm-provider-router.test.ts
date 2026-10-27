// LlmProviderRouter (Camada 3): prazo global, orçamento de 2 chamadas, 429 com troca e Retry-After, retry
// com jitter, circuit breaker, cota que falha fechado e guarda de saída no router (ADR-009; T7, T28, T30, T39).
import { JobFactsSchema } from "@trampo/contracts/job-facts";
import { describe, expect, test } from "vitest";

import {
  BREAKER_POLICY,
  type ExtractionOutcome,
  INITIAL_PROVIDER_STATE,
  InMemoryProviderStateStore,
  LlmProviderRouter,
  RATE_LIMIT_COOLDOWN,
  ROUTER_POLICY,
  RouterConfigError,
  admit,
  recordFailure,
  recordRateLimit,
  recordSuccess,
  releaseProbe,
} from "../../src/application/index.js";
import { FakeClock } from "./fakes/fake-clock.js";
import { Harness, PAYLOAD, VALID_FACTS, VALID_RAW } from "./fakes/router-harness.js";
import { ScriptedExtractor, USAGE } from "./fakes/scripted-extractor.js";

const OK = { kind: "ok", raw: VALID_RAW } as const;
const TRANSIENT = { kind: "erro_transitorio" } as const;
const PERMANENT = { kind: "erro_permanente" } as const;

function failed(outcome: ExtractionOutcome): Extract<ExtractionOutcome, { ok: false }> {
  if (outcome.ok) throw new Error("esperava falha");
  return outcome;
}

function succeeded(outcome: ExtractionOutcome): Extract<ExtractionOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`esperava ok, veio ${outcome.reason}`);
  return outcome;
}

describe("política fixada no ADR-009 (D4 a D6 e §5)", () => {
  test("as constantes são as do ADR: mudar exige ADR novo depois do S-1", () => {
    expect(ROUTER_POLICY).toEqual({
      analysisDeadlineMs: 12_000,
      // Tabela inteira do ADR-009 §5.2 (ADR-022 D9).
      attemptTimeoutMaxMs: { groq: 3_000, cloudflare_workers_ai: 10_000, ollama: 10_000, google_ai_studio: 10_000 },
      deadlineReserveMs: 300,
      minAttemptMs: 2_500,
      maxLlmCallsPerAnalysis: 2,
      retryJitterMinMs: 200,
      retryJitterMaxMs: 600,
      ledgerTimeoutMs: 250,
    });
    expect(BREAKER_POLICY).toEqual({ consecutiveFailuresToOpen: 3, window: 10, failureRatioToOpen: 0.5, openMs: 60_000 });
    expect(RATE_LIMIT_COOLDOWN).toEqual({ defaultMs: 60_000, minMs: 1_000, maxMs: 120_000 });
    expect(Object.isFrozen(ROUTER_POLICY.attemptTimeoutMaxMs)).toBe(true);
  });
});

describe("caminho feliz", () => {
  test("primeiro provedor responde: fatos validados, provedor, modelo, uso e trilha", async () => {
    const h = new Harness({ scripts: { groq: [{ ...OK, latencyMs: 1_500 }] } });
    const { outcome, elapsedMs } = await h.analyze();
    const ok = succeeded(outcome);
    expect(ok.facts).toEqual(VALID_FACTS);
    expect(JobFactsSchema.safeParse(ok.facts).success).toBe(true);
    expect(ok.provider).toBe("groq");
    expect(ok.model).toBe("openai/gpt-oss-20b");
    expect(ok.usage).toEqual(USAGE);
    expect(ok.sanitization.injectionSignal).toBe(false);
    expect(ok.trail).toEqual([{ provider: "groq", outcome: "ok", called: true }]);
    expect(elapsedMs).toBe(1_500);
    expect(h.totalCalls).toBe(1);
    expect(h.ledger.reservations).toEqual(["groq"]);
    expect(h.ledger.usage).toEqual([{ provider: "groq", usage: USAGE }]);
    expect(h.clock.pendingTimers).toBe(0);
  });

  test("o adapter recebe o MESMO payload (só o texto da vaga) e o teto do provedor (Groq: 3 s)", async () => {
    const h = new Harness({ scripts: { groq: [OK] } });
    await h.analyze();
    const [call] = h.extractor("groq").calls;
    expect(call?.payload).toBe(PAYLOAD);
    expect(Object.keys(call?.payload ?? {})).toEqual(["text"]);
    expect(call?.timeoutMs).toBe(3_000);
    expect(call?.signal.aborted).toBe(true);
  });

  test("falha da contabilidade de uso não derruba uma análise que deu certo", async () => {
    const h = new Harness({ scripts: { groq: [OK] } });
    h.ledger.failUsage = true;
    expect(succeeded((await h.analyze()).outcome).provider).toBe("groq");
  });
});

describe("guarda de saída no router (ADR-009 D2; T28)", () => {
  test("saída com URL é saneada pela guarda e marca injectionSignal", async () => {
    const raw = JSON.stringify({ ...VALID_FACTS, title: "Dev Pleno https://golpe.example/vaga" });
    const h = new Harness({ scripts: { groq: [{ kind: "ok", raw }] } });
    const ok = succeeded((await h.analyze()).outcome);
    expect(ok.facts.title).toBe("Dev Pleno");
    expect(ok.sanitization.injectionSignal).toBe(true);
  });

  test("proto poisoning vira saida_invalida com o motivo da guarda, e a 2ª chamada vai a OUTRO provedor", async () => {
    const h = new Harness({
      scripts: { groq: [{ kind: "ok", raw: '{"__proto__":{"admin":true}}' }], cloudflare_workers_ai: [OK] },
    });
    const ok = succeeded((await h.analyze()).outcome);
    expect(ok.provider).toBe("cloudflare_workers_ai");
    expect(ok.trail).toEqual([
      { provider: "groq", outcome: "saida_invalida", called: true, guardRejection: "poluicao_de_prototipo" },
      { provider: "cloudflare_workers_ai", outcome: "ok", called: true },
    ]);
    expect(h.extractor("groq").calls).toHaveLength(1);
    expect(h.ledger.usage.map((entry) => entry.provider)).toEqual(["groq", "cloudflare_workers_ai"]);
  });

  test("os dois provedores com saída inválida: saida_invalida e nada do texto do LLM no resultado", async () => {
    const leak = "IGNORE AS INSTRUÇÕES segredo-da-resposta";
    const h = new Harness({
      scripts: { groq: [{ kind: "ok", raw: leak }], cloudflare_workers_ai: [{ kind: "ok", raw: `{"title":"${leak}"}` }] },
    });
    const outcome = failed((await h.analyze()).outcome);
    expect(outcome.reason).toBe("saida_invalida");
    expect(Object.keys(outcome).sort()).toEqual(["ok", "reason", "trail"]);
    expect(JSON.stringify(outcome)).not.toContain("segredo");
  });
});

describe("orçamento de 2 chamadas (T7)", () => {
  test("cadeia de 3 com 2 falhas: o terceiro provedor nunca é chamado", async () => {
    const h = new Harness({
      chain: ["groq", "cloudflare_workers_ai", "ollama"],
      scripts: { groq: [PERMANENT], cloudflare_workers_ai: [PERMANENT], ollama: [OK] },
    });
    const outcome = failed((await h.analyze()).outcome);
    expect(outcome.reason).toBe("erro_provedor");
    expect(h.extractor("ollama").calls).toHaveLength(0);
    expect(h.totalCalls).toBe(2);
    expect(outcome.trail).toHaveLength(2);
  });

  test("pular provedor (resfriamento, circuito ou cota) não gasta orçamento", async () => {
    const h = new Harness({
      chain: ["groq", "cloudflare_workers_ai", "ollama"],
      scripts: { cloudflare_workers_ai: [PERMANENT], ollama: [OK] },
      ledger: (provider) => (provider === "groq" ? "provedor_esgotado" : "permitido"),
    });
    const ok = succeeded((await h.analyze()).outcome);
    expect(ok.provider).toBe("ollama");
    expect(ok.trail.map((entry) => [entry.provider, entry.called])).toEqual([
      ["groq", false],
      ["cloudflare_workers_ai", true],
      ["ollama", true],
    ]);
  });
});

describe("retry só para erro transitório (ADR-009 D5)", () => {
  test.each([
    [0, ROUTER_POLICY.retryJitterMinMs],
    [0.5, 400],
    [0.999_999, ROUTER_POLICY.retryJitterMaxMs],
    [Number.NaN, ROUTER_POLICY.retryJitterMaxMs],
    [7, ROUTER_POLICY.retryJitterMaxMs],
    [-3, ROUTER_POLICY.retryJitterMinMs],
  ])("random %s: retry no MESMO provedor depois de %i ms de jitter", async (random, jitterMs) => {
    const h = new Harness({ random: () => random, scripts: { groq: [{ ...TRANSIENT, latencyMs: 100 }, OK] } });
    const ok = succeeded((await h.analyze()).outcome);
    expect(ok.provider).toBe("groq");
    const [first, second] = h.extractor("groq").calls;
    expect((second?.atMs ?? 0) - (first?.atMs ?? 0)).toBe(100 + jitterMs);
    expect(ok.trail).toEqual([
      { provider: "groq", outcome: "erro_provedor", called: true },
      { provider: "groq", outcome: "ok", called: true },
    ]);
  });

  test("transitório duas vezes: o retry gasta o orçamento e o 2º provedor não é chamado", async () => {
    const h = new Harness({ scripts: { groq: [TRANSIENT, TRANSIENT], cloudflare_workers_ai: [OK] } });
    expect(failed((await h.analyze()).outcome).reason).toBe("erro_provedor");
    expect(h.extractor("groq").calls).toHaveLength(2);
    expect(h.extractor("cloudflare_workers_ai").calls).toHaveLength(0);
  });

  test("transitório no 2º provedor não tem retry: o orçamento acabou", async () => {
    const h = new Harness({ scripts: { groq: [PERMANENT], cloudflare_workers_ai: [TRANSIENT, OK] } });
    expect(failed((await h.analyze()).outcome).reason).toBe("erro_provedor");
    expect(h.totalCalls).toBe(2);
  });

  test("erro permanente (4xx) troca de provedor sem retry e sem jitter", async () => {
    const h = new Harness({ scripts: { groq: [{ ...PERMANENT, latencyMs: 300 }, OK], cloudflare_workers_ai: [OK] } });
    const ok = succeeded((await h.analyze()).outcome);
    expect(ok.provider).toBe("cloudflare_workers_ai");
    expect(h.extractor("groq").calls).toHaveLength(1);
    expect(h.extractor("cloudflare_workers_ai").calls[0]?.atMs).toBe((h.extractor("groq").calls[0]?.atMs ?? 0) + 300);
  });

  test("sem retry se o jitter deixaria menos de 2,5 s", async () => {
    const h = new Harness({
      random: () => 1,
      scripts: { groq: [{ ...TRANSIENT, latencyMs: 400 }, OK], cloudflare_workers_ai: [OK] },
    });
    // 3,5 s − 0,4 s de chamada − 0,6 s de jitter = 2,5 s: ainda dá.
    expect(succeeded((await h.analyze(3_500)).outcome).provider).toBe("groq");
    // 1 ms a mais de chamada: sem tempo para o jitter, a 2ª chamada vai direto ao próximo provedor.
    const tight = new Harness({
      random: () => 1,
      scripts: { groq: [{ ...TRANSIENT, latencyMs: 401 }, OK], cloudflare_workers_ai: [OK] },
    });
    expect(succeeded((await tight.analyze(3_500)).outcome).provider).toBe("cloudflare_workers_ai");
    expect(tight.extractor("groq").calls).toHaveLength(1);
    expect(tight.extractor("cloudflare_workers_ai").calls[0]?.atMs).toBe((tight.extractor("groq").calls[0]?.atMs ?? 0) + 401);
  });

  test("sem retry se a falha abriu o circuito", async () => {
    const states = new InMemoryProviderStateStore();
    states.set("groq", { ...INITIAL_PROVIDER_STATE, consecutiveFailures: 2, recent: [true, true] });
    const h = new Harness({ states, scripts: { groq: [TRANSIENT, OK], cloudflare_workers_ai: [OK] } });
    const ok = succeeded((await h.analyze()).outcome);
    expect(ok.provider).toBe("cloudflare_workers_ai");
    expect(ok.trail).toEqual([
      { provider: "groq", outcome: "erro_provedor", called: true },
      { provider: "groq", outcome: "circuito_aberto", called: false },
      { provider: "cloudflare_workers_ai", outcome: "ok", called: true },
    ]);
  });

  test("exceção síncrona, rejeição ou resposta fora do contrato: erro_provedor sem retry e sem vazar a mensagem", async () => {
    for (const step of [
      { kind: "lanca" },
      { kind: "rejeita" },
      { kind: "lixo", value: null },
      { kind: "lixo", value: { ok: false, failure: "desconhecido" } },
    ] as const) {
      const h = new Harness({ scripts: { groq: [step, OK], cloudflare_workers_ai: [OK] } });
      const ok = succeeded((await h.analyze()).outcome);
      expect(ok.provider).toBe("cloudflare_workers_ai");
      expect(ok.trail[0]).toEqual({ provider: "groq", outcome: "erro_provedor", called: true });
      expect(JSON.stringify(ok)).not.toContain("segredo");
    }
  });
});

describe("HTTP 429 e Retry-After", () => {
  test("429 troca de provedor NA HORA e resfria o provedor pelo Retry-After", async () => {
    const h = new Harness({
      scripts: {
        groq: [{ kind: "limite_de_taxa", retryAfterMs: 30_000, latencyMs: 200 }, OK],
        cloudflare_workers_ai: [OK, OK],
      },
    });
    const first = succeeded((await h.analyze()).outcome);
    expect(first.provider).toBe("cloudflare_workers_ai");
    expect(first.trail[0]).toEqual({ provider: "groq", outcome: "limite_de_taxa", called: true });
    expect(h.extractor("cloudflare_workers_ai").calls[0]?.atMs).toBe((h.extractor("groq").calls[0]?.atMs ?? 0) + 200);
    expect(h.states.get("groq").cooldownUntilMs).toBe((h.extractor("groq").calls[0]?.atMs ?? 0) + 200 + 30_000);

    // Dentro do resfriamento o Groq é pulado sem chamada e sem reserva de cota.
    const second = succeeded((await h.analyze()).outcome);
    expect(second.trail[0]).toEqual({ provider: "groq", outcome: "limite_de_taxa", called: false });
    expect(h.extractor("groq").calls).toHaveLength(1);
    expect(h.ledger.reservations.filter((provider) => provider === "groq")).toHaveLength(1);

    // Depois do resfriamento ele volta. O 429 não conta como falha no breaker.
    await h.clock.run(h.clock.sleep(30_000));
    expect(succeeded((await h.analyze()).outcome).provider).toBe("groq");
    expect(h.states.get("groq").phase).toBe("fechado");
  });

  test("429 nos dois provedores: limite_de_taxa", async () => {
    const h = new Harness({
      scripts: {
        groq: [{ kind: "limite_de_taxa", retryAfterMs: null }],
        cloudflare_workers_ai: [{ kind: "limite_de_taxa", retryAfterMs: 5_000 }],
      },
    });
    expect(failed((await h.analyze()).outcome).reason).toBe("limite_de_taxa");
  });

  test.each([
    [30_000, 30_000],
    [500, RATE_LIMIT_COOLDOWN.minMs],
    [0, RATE_LIMIT_COOLDOWN.minMs],
    [9_999_999, RATE_LIMIT_COOLDOWN.maxMs],
    [null, RATE_LIMIT_COOLDOWN.defaultMs],
    [-5, RATE_LIMIT_COOLDOWN.defaultMs],
    [Number.NaN, RATE_LIMIT_COOLDOWN.defaultMs],
    [Number.POSITIVE_INFINITY, RATE_LIMIT_COOLDOWN.defaultMs],
  ])("Retry-After %s ms vira resfriamento de %i ms", (retryAfterMs, cooldownMs) => {
    expect(recordRateLimit(INITIAL_PROVIDER_STATE, 1_000, retryAfterMs).cooldownUntilMs).toBe(1_000 + cooldownMs);
  });

  test("um 429 mais curto não encurta um resfriamento em curso", () => {
    const long = recordRateLimit(INITIAL_PROVIDER_STATE, 0, 100_000);
    expect(recordRateLimit(long, 10, 2_000).cooldownUntilMs).toBe(100_000);
  });
});

describe("prazo global (ADR-009 D4)", () => {
  test("provedor de 10 s que nunca responde: timeout de 10 s, abort do sinal, e o resto do prazo não dá outra chamada", async () => {
    const h = new Harness({
      chain: ["cloudflare_workers_ai", "groq"],
      scripts: { cloudflare_workers_ai: [{ kind: "trava" }], groq: [OK] },
    });
    const { outcome, elapsedMs } = await h.analyze();
    expect(failed(outcome).reason).toBe("timeout");
    expect(elapsedMs).toBe(ROUTER_POLICY.attemptTimeoutMaxMs.cloudflare_workers_ai);
    expect(h.extractor("cloudflare_workers_ai").calls[0]?.signal.aborted).toBe(true);
    expect(h.extractor("groq").calls).toHaveLength(0);
    expect(failed(outcome).trail).toEqual([{ provider: "cloudflare_workers_ai", outcome: "timeout", called: true }]);
  });

  test("Groq que nunca responde é abortado em 3 s, e a Workers AI recebe 8,7 s (ADR-009 §5.5)", async () => {
    const h = new Harness({
      scripts: { groq: [{ kind: "trava" }], cloudflare_workers_ai: [{ ...OK, latencyMs: 8_000 }] },
    });
    const { outcome, elapsedMs, deadlineAtMs } = await h.analyze();
    expect(succeeded(outcome).provider).toBe("cloudflare_workers_ai");
    expect(h.extractor("groq").calls[0]?.timeoutMs).toBe(3_000);
    expect(h.extractor("groq").calls[0]?.signal.aborted).toBe(true);
    expect(h.extractor("cloudflare_workers_ai").calls[0]?.timeoutMs).toBe(8_700);
    expect(elapsedMs).toBe(11_000);
    expect(h.clock.nowMs()).toBeLessThanOrEqual(deadlineAtMs);
    expect(succeeded(outcome).trail).toEqual([
      { provider: "groq", outcome: "timeout", called: true },
      { provider: "cloudflare_workers_ai", outcome: "ok", called: true },
    ]);
  });

  test("o retry do Groq por erro transitório usa o mesmo teto de 3 s", async () => {
    const h = new Harness({ scripts: { groq: [{ ...TRANSIENT, latencyMs: 100 }, { kind: "trava" }] } });
    const { outcome } = await h.analyze();
    expect(failed(outcome).reason).toBe("timeout");
    expect(h.extractor("groq").calls.map((call) => call.timeoutMs)).toEqual([3_000, 3_000]);
  });

  test("tentativa recebe min(teto do provedor, restante − 300 ms)", async () => {
    const h = new Harness({ scripts: { groq: [{ ...PERMANENT, latencyMs: 1_000 }], cloudflare_workers_ai: [OK] } });
    await h.analyze(8_000);
    expect(h.extractor("groq").calls[0]?.timeoutMs).toBe(3_000);
    expect(h.extractor("cloudflare_workers_ai").calls[0]?.timeoutMs).toBe(6_700);
    const short = new Harness({ scripts: { groq: [OK] } });
    await short.analyze(3_200);
    expect(short.extractor("groq").calls[0]?.timeoutMs).toBe(2_900);
  });

  test("teto injetado substitui a tabela, por provedor", async () => {
    const h = new Harness({
      attemptTimeoutMaxMs: { groq: 4_000, cloudflare_workers_ai: 5_000, ollama: 6_000, google_ai_studio: 7_000 },
      scripts: { groq: [{ ...PERMANENT, latencyMs: 100 }], cloudflare_workers_ai: [OK] },
    });
    await h.analyze();
    expect(h.extractor("groq").calls[0]?.timeoutMs).toBe(4_000);
    expect(h.extractor("cloudflare_workers_ai").calls[0]?.timeoutMs).toBe(5_000);
  });

  test("timeout no 1º provedor com prazo de sobra: a 2ª chamada vai ao próximo, com o que resta", async () => {
    const h = new Harness({
      chain: ["cloudflare_workers_ai", "groq"],
      scripts: { cloudflare_workers_ai: [{ kind: "trava" }], groq: [{ ...OK, latencyMs: 700 }] },
    });
    const { outcome, elapsedMs, deadlineAtMs } = await h.analyze(13_000);
    expect(succeeded(outcome).provider).toBe("groq");
    expect(h.extractor("groq").calls[0]?.timeoutMs).toBe(2_700);
    expect(elapsedMs).toBe(10_700);
    expect(h.clock.nowMs()).toBeLessThanOrEqual(deadlineAtMs);
  });

  test.each([
    [ROUTER_POLICY.minAttemptMs - 1, 0],
    [ROUTER_POLICY.minAttemptMs, 1],
    [0, 0],
    [-5_000, 0],
  ])("com %i ms restantes, %i chamada(s)", async (remainingMs, calls) => {
    const h = new Harness({ scripts: { groq: [OK] } });
    const { outcome } = await h.analyze(remainingMs);
    expect(h.totalCalls).toBe(calls);
    if (calls === 0) {
      expect(failed(outcome).reason).toBe("timeout");
      expect(h.ledger.reservations).toEqual([]);
    }
  });
});

describe("cota e breaker diário global (T7, T39)", () => {
  test("provedor esgotado é pulado ANTES de tomar 429", async () => {
    const h = new Harness({
      scripts: { cloudflare_workers_ai: [OK] },
      ledger: (provider) => (provider === "groq" ? "provedor_esgotado" : "permitido"),
    });
    const ok = succeeded((await h.analyze()).outcome);
    expect(ok.trail[0]).toEqual({ provider: "groq", outcome: "cota_esgotada", called: false });
    expect(h.extractor("groq").calls).toHaveLength(0);
  });

  test("todos os provedores esgotados: cota_esgotada sem chamada", async () => {
    const h = new Harness({ ledger: () => "provedor_esgotado" });
    expect(failed((await h.analyze()).outcome).reason).toBe("cota_esgotada");
    expect(h.totalCalls).toBe(0);
  });

  test.each([
    ["global_esgotado", "global_esgotado"],
    ["lança", { kind: "lanca" }],
    ["rejeita", { kind: "rejeita" }],
    ["trava", { kind: "trava" }],
    ["valor desconhecido", { kind: "lixo", value: "sim" }],
    ["lento demais", { kind: "lento", latencyMs: ROUTER_POLICY.ledgerTimeoutMs + 1, decision: "permitido" }],
  ] as const)("ledger %s: falha FECHADO, encerra a cadeia sem nenhuma chamada", async (_label, behavior) => {
    const h = new Harness({ scripts: { groq: [OK], cloudflare_workers_ai: [OK] }, ledger: () => behavior });
    const { outcome, elapsedMs } = await h.analyze();
    expect(failed(outcome).reason).toBe("cota_esgotada");
    expect(h.totalCalls).toBe(0);
    expect(h.ledger.reservations).toEqual(["groq"]);
    expect(elapsedMs).toBeLessThanOrEqual(ROUTER_POLICY.ledgerTimeoutMs);
    expect(h.clock.pendingTimers).toBe(0);
  });

  test("ledger lento mas dentro do teto: a chamada segue", async () => {
    const h = new Harness({
      scripts: { groq: [OK] },
      ledger: () => ({ kind: "lento", latencyMs: ROUTER_POLICY.ledgerTimeoutMs - 1, decision: "permitido" }),
    });
    expect(succeeded((await h.analyze()).outcome).provider).toBe("groq");
  });

  test("reserva aprovada, mas o prazo acabou durante ela: timeout, sem chamada, e a sonda é devolvida", async () => {
    const states = new InMemoryProviderStateStore();
    states.set("groq", { ...INITIAL_PROVIDER_STATE, phase: "meio_aberto" });
    const h = new Harness({
      states,
      scripts: { groq: [OK] },
      ledger: () => ({ kind: "lento", latencyMs: 200, decision: "permitido" }),
    });
    const { outcome } = await h.analyze(ROUTER_POLICY.minAttemptMs + 100);
    expect(failed(outcome).reason).toBe("timeout");
    expect(h.totalCalls).toBe(0);
    expect(states.get("groq")).toEqual({ ...INITIAL_PROVIDER_STATE, phase: "meio_aberto", probeInFlight: false });
  });

  test("cota negada no meio-aberto devolve a sonda", async () => {
    const states = new InMemoryProviderStateStore();
    states.set("groq", { ...INITIAL_PROVIDER_STATE, phase: "meio_aberto" });
    const h = new Harness({
      states,
      scripts: { cloudflare_workers_ai: [OK] },
      ledger: (provider) => (provider === "groq" ? "provedor_esgotado" : "permitido"),
    });
    await h.analyze();
    expect(states.get("groq").probeInFlight).toBe(false);
  });
});

describe("circuit breaker por provedor", () => {
  test("3 falhas seguidas abrem por 60 s; meio-aberto com sonda única; sonda ok fecha", async () => {
    const h = new Harness({
      chain: ["groq"],
      scripts: { groq: [PERMANENT, PERMANENT, PERMANENT, { ...OK, latencyMs: 1_000 }, OK] },
    });
    for (let i = 0; i < 3; i += 1) await h.analyze();
    expect(h.states.get("groq").phase).toBe("aberto");

    const skipped = failed((await h.analyze()).outcome);
    expect(skipped).toEqual({
      ok: false,
      reason: "circuito_aberto",
      trail: [{ provider: "groq", outcome: "circuito_aberto", called: false }],
    });
    expect(h.extractor("groq").calls).toHaveLength(3);

    await h.clock.run(h.clock.sleep(BREAKER_POLICY.openMs));
    // Duas análises concorrentes: só uma leva a sonda; a outra pula o provedor.
    const deadline = { atMs: h.clock.nowMs() + ROUTER_POLICY.analysisDeadlineMs };
    const [probe, concurrent] = await h.clock.run(
      Promise.all([h.router.extract(PAYLOAD, deadline), h.router.extract(PAYLOAD, deadline)]),
    );
    expect(succeeded(probe).provider).toBe("groq");
    expect(failed(concurrent).reason).toBe("circuito_aberto");
    expect(h.states.get("groq")).toEqual(INITIAL_PROVIDER_STATE);
    expect(succeeded((await h.analyze()).outcome).provider).toBe("groq");
  });

  test("sonda com falha reabre por mais 60 s", async () => {
    const states = new InMemoryProviderStateStore();
    const clock = new FakeClock();
    states.set("groq", { ...INITIAL_PROVIDER_STATE, phase: "aberto", openUntilMs: clock.nowMs() });
    const h = new Harness({ clock, states, chain: ["groq"], scripts: { groq: [{ ...PERMANENT, latencyMs: 10 }] } });
    expect(failed((await h.analyze()).outcome).reason).toBe("erro_provedor");
    expect(states.get("groq")).toEqual({
      ...INITIAL_PROVIDER_STATE,
      phase: "aberto",
      openUntilMs: clock.nowMs() + BREAKER_POLICY.openMs,
    });
  });

  test("timeout e saída inválida contam como falha do breaker; 429 não", async () => {
    const h = new Harness({
      chain: ["groq"],
      scripts: {
        groq: [{ kind: "trava" }, { kind: "ok", raw: "não é json" }, { kind: "limite_de_taxa", retryAfterMs: 1_000 }],
      },
    });
    await h.analyze();
    await h.analyze();
    expect(h.states.get("groq").consecutiveFailures).toBe(2);
    await h.analyze();
    expect(h.states.get("groq").consecutiveFailures).toBe(2);
    expect(h.states.get("groq").phase).toBe("fechado");
  });

  test("com a janela incompleta, 5 falhas em 9 chamadas não abrem pela fração", () => {
    let state = INITIAL_PROVIDER_STATE;
    for (let i = 0; i < 9; i += 1) state = i % 2 === 0 ? recordFailure(state, 0) : recordSuccess(state);
    expect(state.recent).toHaveLength(9);
    expect(state.recent.filter(Boolean)).toHaveLength(5);
    expect(state.phase).toBe("fechado");
  });

  test("janela cheia com exatamente 5 falhas em 10 abre o circuito", () => {
    let state = INITIAL_PROVIDER_STATE;
    for (const failure of [true, false, true, false, true, false, true, false, false]) {
      state = failure ? recordFailure(state, 0) : recordSuccess(state);
    }
    expect(state.recent).toHaveLength(9);
    const opened = recordFailure(state, 5);
    expect(opened).toEqual({ ...INITIAL_PROVIDER_STATE, phase: "aberto", openUntilMs: 5 + BREAKER_POLICY.openMs });
    // 4 falhas em 10 não abrem, nem quando a 10ª é falha.
    expect(recordSuccess(state).phase).toBe("fechado");
    let fewer = INITIAL_PROVIDER_STATE;
    for (const failure of [true, false, true, false, false, false, true, false, false]) {
      fewer = failure ? recordFailure(fewer, 0) : recordSuccess(fewer);
    }
    expect(recordFailure(fewer, 0).phase).toBe("fechado");
  });

  test("a janela guarda só as últimas 10 chamadas", () => {
    let state = INITIAL_PROVIDER_STATE;
    for (let i = 0; i < 25; i += 1) state = recordSuccess(state);
    expect(state.recent).toHaveLength(BREAKER_POLICY.window);
  });

  test("admit: resfriamento vence o circuito; aberto antes do fim recusa; meio-aberto livre aceita uma sonda", () => {
    expect(admit({ ...INITIAL_PROVIDER_STATE, cooldownUntilMs: 10 }, 9)).toEqual({
      admitted: false,
      reason: "limite_de_taxa",
    });
    expect(admit({ ...INITIAL_PROVIDER_STATE, phase: "aberto", openUntilMs: 10 }, 9)).toEqual({
      admitted: false,
      reason: "circuito_aberto",
    });
    const halfOpen = { ...INITIAL_PROVIDER_STATE, phase: "meio_aberto" } as const;
    expect(admit(halfOpen, 0)).toEqual({ admitted: true, state: { ...halfOpen, probeInFlight: true } });
    expect(admit({ ...halfOpen, probeInFlight: true }, 0)).toEqual({ admitted: false, reason: "circuito_aberto" });
    expect(releaseProbe(INITIAL_PROVIDER_STATE)).toBe(INITIAL_PROVIDER_STATE);
  });

  test("abrir e fechar preserva um resfriamento de 429 em curso", () => {
    const cooling = { ...INITIAL_PROVIDER_STATE, cooldownUntilMs: 500, phase: "meio_aberto" } as const;
    expect(recordSuccess(cooling).cooldownUntilMs).toBe(500);
    expect(recordFailure(cooling, 0).cooldownUntilMs).toBe(500);
  });

  test("429 durante a sonda devolve a sonda sem fechar nem abrir", () => {
    const probing = { ...INITIAL_PROVIDER_STATE, phase: "meio_aberto", probeInFlight: true } as const;
    const after = recordRateLimit(probing, 0, 2_000);
    expect(after.phase).toBe("meio_aberto");
    expect(after.probeInFlight).toBe(false);
  });
});

describe("nunca lança", () => {
  test("store que lança: erro_provedor, com a trilha até ali", async () => {
    const h = new Harness({
      states: {
        get: () => {
          throw new Error("store quebrado");
        },
        set: () => undefined,
      },
    });
    expect(failed((await h.analyze()).outcome)).toEqual({ ok: false, reason: "erro_provedor", trail: [] });
  });
});

describe("configuração do router (ADR-009 D7)", () => {
  const clock = new FakeClock();
  const base = {
    clock,
    random: { next: () => 0.5 },
    ledger: { reserve: () => Promise.resolve("permitido" as const), recordUsage: () => Promise.resolve() },
    states: new InMemoryProviderStateStore(),
  };
  const groq = new ScriptedExtractor("groq", clock, []);

  test("cadeia vazia lança no boot", () => {
    expect(() => new LlmProviderRouter({ ...base, chain: [], extractors: [groq] })).toThrow(RouterConfigError);
  });

  test("provedor da cadeia sem adapter, ou com dois, lança no boot", () => {
    expect(() => new LlmProviderRouter({ ...base, chain: ["groq", "cloudflare_workers_ai"], extractors: [groq] })).toThrow(
      /cloudflare_workers_ai, há 0/u,
    );
    expect(() => new LlmProviderRouter({ ...base, chain: ["groq"], extractors: [groq, groq] })).toThrow(/há 2/u);
  });

  test.each([
    "",
    "modelo com espaço",
    "-começa-com-hífen",
    "a".repeat(81),
    // F1-LLM-02: só o prefixo estrito `@cf/` no início.
    "@CF/meta/llama",
    "@cf",
    "@cfmeta/llama",
    "@cf//meta",
    "@cf/",
    "x@cf/meta",
    "meta/@cf/llama",
    `@cf/${"a".repeat(77)}`,
  ])("modelo %j inválido lança no boot", (model) => {
    const bad = new ScriptedExtractor("cloudflare_workers_ai", clock, [], model);
    expect(() => new LlmProviderRouter({ ...base, chain: ["cloudflare_workers_ai"], extractors: [bad] })).toThrow(/modelo inválido/u);
  });

  test("id da Workers AI com @cf/ sobe, e o resultado leva o id exato", async () => {
    const model = "@cf/openai/gpt-oss-120b";
    const h = new Harness({ chain: ["cloudflare_workers_ai"], models: { cloudflare_workers_ai: model }, scripts: { cloudflare_workers_ai: [OK] } });
    const ok = succeeded((await h.analyze()).outcome);
    expect(ok.provider).toBe("cloudflare_workers_ai");
    expect(ok.model).toBe(model);
  });

  test("adapters fora da cadeia são ignorados, e a ordem é a da cadeia", async () => {
    const h = new Harness({ chain: ["cloudflare_workers_ai", "groq"], scripts: { cloudflare_workers_ai: [OK] } });
    expect(succeeded((await h.analyze()).outcome).provider).toBe("cloudflare_workers_ai");
    expect(h.extractor("groq").calls).toHaveLength(0);
    const ollama = new ScriptedExtractor("ollama", clock, []);
    expect(() => new LlmProviderRouter({ ...base, chain: ["groq"], extractors: [ollama, groq] })).not.toThrow();
  });
});
