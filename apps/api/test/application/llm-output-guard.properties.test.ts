// Propriedades do LlmOutputGuard (fast-check): nunca lança, saída ok passa no contrato e nunca tem URL,
// o saneamento é idempotente e a falha não ecoa a resposta (ADR-008 §4).
import { JobFactsSchema } from "@trampo/contracts/job-facts";
import { INVISIBLE_OR_CONTROL, containsUrlLike } from "@trampo/contracts/primitives";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { LlmOutputGuard, type LlmOutputGuardResult } from "../../src/application/index.js";

const guard = new LlmOutputGuard();

/** Fragmentos hostis e legítimos: montam URLs, esquemas, invisíveis, marcação e combinações NFKC. */
const FRAGMENTS = [
  "https://", "http://evil.example/x", "javascript:", "ｊａｖａｓｃｒｉｐｔ：", "data:", "www.", "ｗｗｗ.",
  "bit.ly/", "golpe.com", ".cn", "z", "rh@", "empresa.com", "[a](b)", "​", "‮", "\u{E0041}", "﻿",
  "\u0000", "<", ">", "́", "e", " ", "\n", "\t", " ", "Dev", "São Paulo", "Node.js", "C#", ".", "/",
  ":", "@", "🚀", "\uD800", "Ｒｅａｃｔ", "a".repeat(90),
] as const;

const hostileText = fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 25 }).map((parts) => parts.join(""));
const anyText = fc.oneof(hostileText, fc.string({ unit: "binary", maxLength: 120 }));
const tags = fc.array(fc.oneof(hostileText, fc.constantFrom("TypeScript", "react", "React", "Go")), { maxLength: 40 });

const seniority = fc.array(fc.constantFrom("estagio", "junior", "pleno", "senior", "especialista", "lideranca"), {
  maxLength: 8,
});

/** Saídas no formato do JobFacts, com texto hostil e às vezes um campo trocado por qualquer JSON. */
const factsLike = fc
  .record({
    title: fc.option(anyText, { nil: null }),
    seniorityLevels: seniority,
    yearsExperienceMin: fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }),
    workModels: fc.array(fc.constantFrom("remoto", "hibrido", "presencial"), { maxLength: 5 }),
    location: fc.option(
      fc.record({
        city: fc.option(anyText, { nil: null }),
        stateUf: fc.option(fc.constantFrom("SP", "RJ"), { nil: null }),
        countryIso2: fc.option(fc.constantFrom("BR", "US"), { nil: null }),
      }),
      { nil: null },
    ),
    salary: fc.constant(null),
    contractTypes: fc.array(fc.constantFrom("clt", "pj"), { maxLength: 4 }),
    stackRequired: tags,
    stackNiceToHave: fc.constant([]),
    benefits: fc.array(fc.constantFrom("plano_saude", "outro"), { maxLength: 4 }),
    languageRequirements: fc.constant([]),
    redFlagSignals: fc.array(fc.constantFrom("salario_omitido", "linguagem_vaga"), { maxLength: 4 }),
    extractionConfidence: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .chain((facts) =>
    fc.oneof(
      { weight: 4, arbitrary: fc.constant(facts) },
      {
        weight: 1,
        arbitrary: fc
          .tuple(fc.constantFrom(...Object.keys(facts)), fc.jsonValue())
          .map(([key, value]) => ({ ...facts, [key]: value })),
      },
    ),
  );

/** Respostas brutas: fatos serializados, JSON qualquer, texto qualquer e JSON cortado no meio. */
const rawResponse = fc.oneof(
  { weight: 4, arbitrary: factsLike.map((facts) => JSON.stringify(facts)) },
  { weight: 1, arbitrary: fc.jsonValue().map((value) => JSON.stringify(value)) },
  { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 200 }) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(factsLike, fc.nat())
      .map(([facts, at]) => {
        const raw = JSON.stringify(facts);
        return raw.slice(0, at % raw.length);
      }),
  },
);

function okFacts(result: LlmOutputGuardResult) {
  return result.ok ? [result.facts] : [];
}

describe("LlmOutputGuard (propriedades)", () => {
  test("nunca lança, para qualquer entrada", () => {
    fc.assert(
      fc.property(fc.oneof(rawResponse, fc.anything()), (raw) => {
        const result = guard.inspect(raw);
        expect(typeof result.ok).toBe("boolean");
      }),
      { numRuns: 1_000 },
    );
  });

  test("saída ok sempre passa no JobFactsSchema", () => {
    let accepted = 0;
    let sanitizedUrls = 0;
    fc.assert(
      fc.property(rawResponse, (raw) => {
        const result = guard.inspect(raw);
        if (!result.ok) return;
        accepted += 1;
        if (result.sanitization.urlsRemoved > 0) sanitizedUrls += 1;
        expect(JobFactsSchema.safeParse(result.facts).success).toBe(true);
      }),
      { numRuns: 1_000 },
    );
    // A propriedade não é vazia: boa parte das entradas chega ao ok, e várias depois de remover URL.
    expect(accepted).toBeGreaterThan(200);
    expect(sanitizedUrls).toBeGreaterThan(50);
  });

  test("saída ok nunca contém URL nem invisível no texto livre e nas tags", () => {
    fc.assert(
      fc.property(rawResponse, (raw) => {
        for (const facts of okFacts(guard.inspect(raw))) {
          const texts = [facts.title, facts.location?.city, ...facts.stackRequired, ...facts.stackNiceToHave];
          for (const text of texts) {
            if (text === null || text === undefined) continue;
            expect(containsUrlLike(text)).toBe(false);
            expect(INVISIBLE_OR_CONTROL.test(text)).toBe(false);
            expect(text).not.toMatch(/[<>]/u);
          }
        }
      }),
      { numRuns: 1_000 },
    );
  });

  test("idempotente: a saída ok, reenviada, volta igual e sem nenhum saneamento", () => {
    fc.assert(
      fc.property(rawResponse, (raw) => {
        for (const facts of okFacts(guard.inspect(raw))) {
          const again = guard.inspect(JSON.stringify(facts));
          expect(again).toStrictEqual({
            ok: true,
            facts,
            sanitization: {
              urlsRemoved: 0,
              hiddenOrMarkupRemoved: 0,
              malformedItemsRemoved: 0,
              duplicatesRemoved: 0,
              itemsCut: 0,
              textTruncated: false,
              injectionSignal: false,
            },
          });
        }
      }),
      { numRuns: 1_000 },
    );
  });

  test("a falha carrega só o motivo: a resposta nunca volta", () => {
    fc.assert(
      fc.property(rawResponse, (raw) => {
        const result = guard.inspect(raw);
        if (!result.ok) expect(Object.keys(result)).toStrictEqual(["ok", "reason"]);
      }),
      { numRuns: 500 },
    );
  });
});
