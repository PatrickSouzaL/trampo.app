// Propriedades do JobFactsCache (ADR-015 §4). (1) A saída da guarda é ponto fixo dela mesma: sem isso, uma
// entrada boa nunca daria hit. (2) Ida e volta: o que a política aceita volta igual. (3) Para qualquer string
// no Redis, inclusive uma entrada válida com um campo trocado, a leitura só dá hit se a entrada passa no schema,
// bate com a chave e é ponto fixo da guarda.
import { JobFactsCacheEntrySchema } from "@trampo/contracts/job-facts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { JobFactsCache, LlmOutputGuard, type JobFactsCacheStore } from "../../src/application/index.js";
import { FakeClock } from "./fakes/fake-clock.js";
import { VALID_FACTS } from "./fakes/router-harness.js";

const guard = new LlmOutputGuard();
const HASH = "c".repeat(64);
const VERSION = "jf-p1-s1-n1-sel1-g2-b6000";
const NOW = Date.parse("2026-10-21T18:00:00.000Z");
const MODEL = { provider: "groq", model: "openai/gpt-oss-20b" } as const;

const FRAGMENTS = [
  "Dev", "São Paulo", "Node.js", "C#", "Ｒｅａｃｔ", "ｊａｖａ", " ", "  ", "\n", "\t", "https://x.example", "www.", "rh@", "a.b",
  "​", "‮", "<", ">", "é", "🚀", "ﬁ", ".", "/", "-", "a".repeat(45),
] as const;
const text = fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 12 }).map((parts) => parts.join(""));
const tags = fc.array(fc.oneof(text, fc.constantFrom("TypeScript", "react", "React", "Go", "C++")), { maxLength: 35 });

/** Saídas brutas no formato do JobFacts, com texto hostil: a guarda saneia, e o que sai tem que ser estável. */
const rawFacts = fc
  .record({
    title: fc.option(text, { nil: null }),
    stackRequired: tags,
    stackNiceToHave: tags,
    location: fc.option(fc.record({ city: fc.option(text, { nil: null }), stateUf: fc.constant("SP"), countryIso2: fc.constant(null) }), {
      nil: null,
    }),
    extractionConfidence: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map((patch) => JSON.stringify({ ...VALID_FACTS, ...patch }));

function memoryStore() {
  const values = new Map<string, string>();
  const store: JobFactsCacheStore = {
    read: (key) => Promise.resolve({ ok: true, value: values.get(key) ?? null }),
    writeIfAbsent: (key, value) => {
      if (values.has(key)) return Promise.resolve("ja_existia");
      values.set(key, value);
      return Promise.resolve("gravado");
    },
    remove: (key) => Promise.resolve(void values.delete(key)),
  };
  return { values, store };
}

function makeCache() {
  const clock = new FakeClock();
  const memory = memoryStore();
  const cache = new JobFactsCache({ store: memory.store, clock, now: () => NOW, extractorVersion: VERSION, acceptedModels: [MODEL] });
  return { clock, cache, ...memory, key: cache.keyFor(HASH) };
}

describe("JobFactsCache (propriedades)", () => {
  test("a saída da guarda é ponto fixo dela mesma", () => {
    let accepted = 0;
    fc.assert(
      fc.property(rawFacts, (raw) => {
        const first = guard.inspect(raw);
        if (!first.ok) return;
        accepted += 1;
        const again = guard.inspect(JSON.stringify(first.facts));
        expect(again.ok).toBe(true);
        expect(again.ok && JSON.stringify(again.facts)).toBe(JSON.stringify(first.facts));
      }),
      { numRuns: 1_000 },
    );
    // A propriedade não pode passar vazia: boa parte das saídas tem que ser aceita.
    expect(accepted).toBeGreaterThan(300);
  });

  test("ida e volta: toda saída da guarda que a política aceita volta igual como hit", async () => {
    await fc.assert(
      fc.asyncProperty(rawFacts, async (raw) => {
        const result = guard.inspect(raw);
        if (!result.ok || result.sanitization.injectionSignal) return;
        const h = makeCache();
        const outcome = await h.clock.run(
          h.cache.store({
            textHash: HASH,
            facts: result.facts,
            sanitization: result.sanitization,
            injectionLevel: "baixa",
            effectiveConfidence: 0.8,
            degraded: false,
            ...MODEL,
          }),
        );
        expect(outcome).toEqual({ written: true });
        const lookup = await h.clock.run(h.cache.lookup(HASH));
        expect(lookup.hit && lookup.entry.facts).toEqual(result.facts);
      }),
      { numRuns: 500 },
    );
  });

  test("qualquer string no Redis: hit só com entrada válida, coerente com a chave e ponto fixo da guarda", async () => {
    const valid = JSON.stringify({
      schemaVersion: 1,
      extractorVersion: VERSION,
      textHash: HASH,
      ...MODEL,
      extractedAt: new Date(NOW - 1_000).toISOString(),
      facts: VALID_FACTS,
    });
    const tampered = fc
      .tuple(fc.constantFrom("schemaVersion", "extractorVersion", "textHash", "provider", "model", "extractedAt", "facts", "extra"), fc.jsonValue())
      .map(([field, value]) => JSON.stringify({ ...(JSON.parse(valid) as object), [field]: value }));
    const factTampered = fc
      .tuple(fc.constantFrom(...Object.keys(VALID_FACTS)), fc.oneof(fc.jsonValue(), text))
      .map(([field, value]) => {
        const parsed = JSON.parse(valid) as { facts: Record<string, unknown> };
        return JSON.stringify({ ...parsed, facts: { ...parsed.facts, [field]: value } });
      });
    const sliced = fc.nat({ max: valid.length - 1 }).map((at) => valid.slice(0, at));
    await fc.assert(
      fc.asyncProperty(fc.oneof(tampered, factTampered, sliced, fc.string(), fc.jsonValue().map((v) => JSON.stringify(v)), fc.constant(valid)), async (raw) => {
        const h = makeCache();
        h.values.set(h.key, raw);
        const result = await h.clock.run(h.cache.lookup(HASH));
        if (!result.hit) return;
        const entry = JobFactsCacheEntrySchema.parse(JSON.parse(raw));
        expect(entry.textHash).toBe(HASH);
        expect(entry.extractorVersion).toBe(VERSION);
        const again = guard.inspect(JSON.stringify(entry.facts));
        expect(again.ok && JSON.stringify(again.facts)).toBe(JSON.stringify(entry.facts));
      }),
      { numRuns: 1_000 },
    );
  });
});
