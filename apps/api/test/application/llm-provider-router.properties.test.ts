// Propriedades do LlmProviderRouter (fast-check; ADR-009 §4): para qualquer cadeia, sequência de respostas
// (inclusive exceções e chamadas que nunca respondem), latências, ledger, jitter, prazo inicial e estado de
// breaker herdado de análises anteriores, o router nunca faz mais de 2 chamadas, nunca passa do prazo,
// nunca lança, não deixa timer pendurado, e o resultado ok passou pelo contrato.
import type { LlmProviderId } from "@trampo/contracts";
import { JobFactsSchema } from "@trampo/contracts/job-facts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { InMemoryProviderStateStore, ROUTER_POLICY } from "../../src/application/index.js";
import { FakeClock } from "./fakes/fake-clock.js";
import type { LedgerBehavior } from "./fakes/fake-quota-ledger.js";
import { Harness, VALID_FACTS, VALID_RAW } from "./fakes/router-harness.js";
import type { Step } from "./fakes/scripted-extractor.js";

const PROVIDERS: readonly LlmProviderId[] = ["groq", "cloudflare_workers_ai", "ollama"];

const latency = fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 3_000 }), fc.integer({ min: 0, max: 15_000 }));

const raw = fc.oneof(
  { weight: 4, arbitrary: fc.constant(VALID_RAW) },
  fc.constant(JSON.stringify({ ...VALID_FACTS, title: "Dev https://golpe.example/x" })),
  fc.constant('{"__proto__":{"x":1}}'),
  fc.constant("segredo-da-resposta não é json"),
  fc.string({ maxLength: 40 }),
);

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("ok" as const), raw, latencyMs: latency }) },
  fc.record({
    kind: fc.constant("limite_de_taxa" as const),
    retryAfterMs: fc.oneof(fc.constant(null), fc.integer({ min: -10, max: 300_000 }), fc.constant(Number.NaN)),
    latencyMs: latency,
  }),
  fc.record({ kind: fc.constantFrom("erro_transitorio" as const, "erro_permanente" as const), latencyMs: latency }),
  fc.constant({ kind: "trava" as const }),
  fc.constant({ kind: "lanca" as const }),
  fc.record({ kind: fc.constant("rejeita" as const), latencyMs: latency }),
  fc.record({ kind: fc.constant("lixo" as const), value: fc.oneof(fc.constant(null), fc.anything()), latencyMs: latency }),
);

const ledgerBehavior: fc.Arbitrary<LedgerBehavior> = fc.oneof(
  { weight: 6, arbitrary: fc.constant("permitido" as const) },
  { weight: 1, arbitrary: fc.constantFrom("provedor_esgotado" as const, "global_esgotado" as const) },
  { weight: 1, arbitrary: fc.constantFrom({ kind: "lanca" as const }, { kind: "rejeita" as const }, { kind: "trava" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("lento" as const),
      latencyMs: fc.integer({ min: 0, max: 600 }),
      decision: fc.constant("permitido" as const),
    }),
  },
);

const scenario = fc.record({
  chain: fc.shuffledSubarray([...PROVIDERS], { minLength: 1 }),
  scripts: fc.record({
    groq: fc.array(step, { maxLength: 8 }),
    cloudflare_workers_ai: fc.array(step, { maxLength: 8 }),
    ollama: fc.array(step, { maxLength: 8 }),
  }),
  ledger: fc.array(ledgerBehavior, { minLength: 1, maxLength: 10 }),
  random: fc.oneof(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), fc.constant(Number.NaN)),
  analyses: fc.array(
    fc.record({ remainingMs: fc.integer({ min: -1_000, max: 20_000 }), gapMs: fc.integer({ min: 0, max: 70_000 }) }),
    { minLength: 1, maxLength: 5 },
  ),
});

describe("propriedades do router", () => {
  test("nunca > 2 chamadas, nunca passa do prazo, nunca lança, sem timer pendurado, ok no contrato", async () => {
    let oks = 0;
    let failures = 0;
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const clock = new FakeClock();
        const states = new InMemoryProviderStateStore();
        const h = new Harness({
          clock,
          states,
          chain: s.chain,
          scripts: s.scripts,
          random: () => s.random,
          ledger: (_provider, nth) => s.ledger[nth % s.ledger.length] ?? "permitido",
        });
        for (const analysis of s.analyses) {
          await clock.run(clock.sleep(analysis.gapMs));
          const callsBefore = h.totalCalls;
          const startedAt = clock.nowMs();
          const { outcome, deadlineAtMs } = await h.analyze(analysis.remainingMs);

          expect(h.totalCalls - callsBefore).toBeLessThanOrEqual(ROUTER_POLICY.maxLlmCallsPerAnalysis);
          expect(clock.nowMs()).toBeLessThanOrEqual(Math.max(deadlineAtMs, startedAt));
          expect(clock.pendingTimers).toBe(0);
          if (outcome.ok) {
            oks += 1;
            expect(JobFactsSchema.safeParse(outcome.facts).success).toBe(true);
            expect(outcome.trail.at(-1)).toEqual({ provider: outcome.provider, outcome: "ok", called: true });
          } else {
            failures += 1;
            // A falha só carrega enums: nem a resposta do provedor nem a mensagem de exceção do adapter.
            expect(Object.keys(outcome).sort()).toEqual(["ok", "reason", "trail"]);
            expect(JSON.stringify(outcome)).not.toContain("segredo");
          }
          expect(outcome.trail.filter((entry) => entry.called)).toHaveLength(h.totalCalls - callsBefore);
        }
      }),
      { numRuns: 1_000 },
    );
    // Prova de que a propriedade não é vazia: os dois lados aparecem com frequência.
    expect(oks).toBeGreaterThan(150);
    expect(failures).toBeGreaterThan(500);
    // A propriedade é lógica (relógio falso), não de tempo de parede: ~0,4 s sozinha, mas cada passo do relógio
    // cede ao event loop, e sob CPU disputada (turbo em paralelo) passou dos 5 s padrão do Vitest.
  }, 60_000);
});
