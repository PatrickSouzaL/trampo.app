// Propriedades do JobTextNormalizer (fast-check): idempotência, saída sem invisíveis e teto de tamanho
// (ADR-005 D4; SR-09; threat-model T2, T15 e T18).
import { JOB_TEXT_MAX_CHARS, JOB_TITLE_MAX_CHARS } from "@trampo/contracts/limits";
import { INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE, truncateCodePoints } from "@trampo/contracts/primitives";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { JobTextNormalizer } from "../../src/domain/index.js";
import { countCodePoints } from "../../src/domain/normalization/job-text-normalizer.js";
import { nodeTextHasher } from "../../src/infrastructure/crypto/node-text-hasher.js";

const normalizer = new JobTextNormalizer({ hasher: nodeTextHasher, truncateCodePoints });

/** Peças que exercitam cada etapa: invisíveis, compatibilidade, marcas, PII, URL, delimitadores. */
const TRICKY = [
  "a", "Z", "1", "9", " ", "\n", "\r", "\t", ".", "-", "/", ":", "@", "(", ")", "+", "#", "*", "[", "]",
  "<", ">", "`", "~", "\u200B", "\u200D", "\u202E", "\u2066", "\uFEFF", "\u00AD", "\u00A0", "\u2028",
  "\u0085", "\u0000", "\u{E0041}", "\u{E0100}", "\uFE0F", "\u3164", "\uFFA0", "\u0301", "\u0338", "\uFDFA",
  "\uFF1C", "\uFF30", "\uFB01", "é", "\u{1F600}", "\uD800", "\uDC00", "system", "Usuário",
  "assistant", "www.", ".com", ".br", ".io", "http://", "mailto:", "(11) ", "98765-4321", "123.456.789-09",
  "12.345.678/0001-95", "joao@x", "<<<", "```",
] as const;

const trickyText = fc.array(fc.constantFrom(...TRICKY), { maxLength: 60 }).map((parts) => parts.join(""));

/** Sequências arbitrárias de UTF-16, inclusive surrogates órfãos. */
const anyUtf16 = fc
  .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 80 })
  .map((units) => String.fromCharCode(...units));

const anyText = fc.oneof(trickyText, anyUtf16, fc.string({ unit: "binary", maxLength: 80 }));

/** Textos grandes: uma peça repetida até passar do teto (inclui a expansão do NFKC). */
const hugeText = fc
  .tuple(fc.constantFrom(...TRICKY), fc.integer({ min: 1, max: 20_000 }))
  .map(([part, times]) => part.repeat(times));

const RUNS = { numRuns: 1_000 };

describe("JobTextNormalizer (propriedades)", () => {
  test("idempotente: normalizar a saída não muda nada, e o ponto fixo é alcançado", () => {
    fc.assert(
      fc.property(anyText, (raw) => {
        const once = normalizer.normalize(raw);
        expect(once.signals.fixedPointReached).toBe(true);
        expect(normalizer.normalize(once.text).text).toBe(once.text);
      }),
      RUNS,
    );
  });

  test("saída sem invisíveis, bem formada e estável no NFKC", () => {
    fc.assert(
      fc.property(anyText, (raw) => {
        const { text } = normalizer.normalize(raw);
        expect(INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE.test(text)).toBe(false);
        expect(text.isWellFormed()).toBe(true);
        expect(text.normalize("NFKC")).toBe(text);
      }),
      RUNS,
    );
  });

  test("nenhum delimitador de envelope sobrevive", () => {
    fc.assert(
      fc.property(anyText, (raw) => {
        const { text } = normalizer.normalize(raw);
        expect(text).not.toMatch(/[<>]|`{3}|~{3}/u);
        expect(text).not.toMatch(/^[ #*›]*(?:system|assistant|user)[*)\]]* ?:/imu);
      }),
      RUNS,
    );
  });

  test("tamanho máximo: nunca passa de JOB_TEXT_MAX_CHARS, inclusive com expansão", () => {
    fc.assert(
      fc.property(hugeText, (raw) => {
        const out = normalizer.normalize(raw);
        expect(countCodePoints(out.text)).toBeLessThanOrEqual(JOB_TEXT_MAX_CHARS);
        expect(out.signals.fixedPointReached).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  test("título: linha única, no teto e idempotente", () => {
    fc.assert(
      fc.property(fc.oneof(anyText, hugeText.map((s) => s.slice(0, 2_000))), (raw) => {
        const { text } = normalizer.normalizeTitle(raw);
        expect(text).not.toContain("\n");
        expect(countCodePoints(text)).toBeLessThanOrEqual(JOB_TITLE_MAX_CHARS);
        expect(normalizer.normalizeTitle(text).text).toBe(text);
      }),
      RUNS,
    );
  });
});
