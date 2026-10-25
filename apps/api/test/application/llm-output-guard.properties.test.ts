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

/** Valores fora de todo enum que o S-1 viu ou que um ataque tentaria (g3: saem sem virar outro valor). */
const OFF_ENUM = ["vale_transporte", "gympass", "auxilio_refeicao", "CLT", "tempo_integral", "", "__proto__", "toString"];

/** Array de enum com valores válidos, valores fora do enum e, às vezes, `null` no lugar do array (g3). */
function enumArray(valid: readonly string[], maxLength: number) {
  return fc.oneof(
    { weight: 6, arbitrary: fc.array(fc.constantFrom(...valid, ...OFF_ENUM), { maxLength }) },
    { weight: 1, arbitrary: fc.constant(null) },
  );
}

const ENUM_ARRAY_KEYS = ["seniorityLevels", "workModels", "contractTypes", "benefits", "redFlagSignals"] as const;
const ENUM_VALUES: Record<string, ReadonlySet<string>> = Object.fromEntries(
  ENUM_ARRAY_KEYS.map((key) => [key, new Set<string>(JobFactsSchema.shape[key].element.options)]),
);

/** Saídas no formato do JobFacts, com texto hostil e às vezes um campo trocado por qualquer JSON. */
const factsLike = fc
  .record({
    title: fc.option(anyText, { nil: null }),
    seniorityLevels: enumArray(["estagio", "junior", "pleno", "senior", "especialista", "lideranca"], 8),
    yearsExperienceMin: fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }),
    workModels: enumArray(["remoto", "hibrido", "presencial"], 5),
    location: fc.oneof(
      {
        weight: 6,
        arbitrary: fc.option(
          fc.record({
            city: fc.option(anyText, { nil: null }),
            stateUf: fc.option(fc.constantFrom("SP", "RJ"), { nil: null }),
            countryIso2: fc.option(fc.constantFrom("BR", "US"), { nil: null }),
          }),
          { nil: null },
        ),
      },
      { weight: 1, arbitrary: fc.constant({ city: null, stateUf: null, countryIso2: null }) },
    ),
    salary: fc.constant(null),
    contractTypes: enumArray(["clt", "pj"], 4),
    stackRequired: tags,
    stackNiceToHave: fc.constantFrom([], null),
    benefits: enumArray(["plano_saude", "outro", "vale_refeicao"], 6),
    languageRequirements: fc.constantFrom([], null),
    redFlagSignals: enumArray(["salario_omitido", "linguagem_vaga"], 4),
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
              offEnumItemsRemoved: 0,
              absentValuesNormalized: 0,
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

  test("g3: cada array de enum da saída é subsequência da entrada (nunca acrescenta nem troca valor)", () => {
    let removed = 0;
    fc.assert(
      fc.property(factsLike, (input) => {
        const result = guard.inspect(JSON.stringify(input));
        if (!result.ok) return;
        removed += result.sanitization.offEnumItemsRemoved;
        for (const key of ENUM_ARRAY_KEYS) {
          const before: unknown = (input as Record<string, unknown>)[key];
          const source = Array.isArray(before) ? (before as readonly unknown[]) : [];
          let at = 0;
          for (const item of result.facts[key]) {
            while (at < source.length && source[at] !== item) at += 1;
            expect(at).toBeLessThan(source.length);
            at += 1;
          }
        }
      }),
      { numRuns: 1_000 },
    );
    // Não é vazia: os valores fora do enum chegam ao guard e saem.
    expect(removed).toBeGreaterThan(200);
  });

  test("g3: offEnumItemsRemoved conta exatamente as strings fora do enum da entrada", () => {
    fc.assert(
      fc.property(factsLike, (input) => {
        const result = guard.inspect(JSON.stringify(input));
        if (!result.ok) return;
        let expected = 0;
        for (const key of ENUM_ARRAY_KEYS) {
          const before: unknown = (input as Record<string, unknown>)[key];
          if (!Array.isArray(before)) continue;
          expected += before.filter((item) => typeof item === "string" && !ENUM_VALUES[key]?.has(item)).length;
        }
        expect(result.sanitization.offEnumItemsRemoved).toBe(expected);
      }),
      { numRuns: 1_000 },
    );
  });

  test("o sinal de injection é sempre URL ou oculto removido, e nunca os contadores do g3", () => {
    let quietRemovals = 0;
    fc.assert(
      fc.property(rawResponse, (raw) => {
        const result = guard.inspect(raw);
        if (!result.ok) return;
        const { urlsRemoved, hiddenOrMarkupRemoved, offEnumItemsRemoved, absentValuesNormalized, injectionSignal } =
          result.sanitization;
        expect(injectionSignal).toBe(urlsRemoved + hiddenOrMarkupRemoved > 0);
        if (!injectionSignal && offEnumItemsRemoved + absentValuesNormalized > 0) quietRemovals += 1;
      }),
      { numRuns: 1_000 },
    );
    // Não é vazia: em 40 sementes, de 45 a 75 saídas tiveram remoção do g3 sem sinal de injection.
    expect(quietRemovals).toBeGreaterThan(20);
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
