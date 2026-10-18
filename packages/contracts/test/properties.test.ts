// Testes de propriedade (fast-check) para as duas funções que sustentam os limites e a
// política de texto seguro (BACKLOG M3; contratos-zod §6, "A acrescentar na M3").
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  INVISIBLE_OR_CONTROL,
  INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE,
  containsUrlLike,
  safeText,
  truncateCodePoints,
} from '../src/primitives.js';

const RUNS = { numRuns: 500 };

/** Qualquer sequência de unidades UTF-16, inclusive surrogates órfãos (o pior caso real). */
const anyUtf16 = fc
  .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 80 })
  .map((units) => String.fromCharCode(...units));

/** Qualquer sequência de code points válidos (inclui astrais, emoji, Tag characters). */
const anyCodePoints = fc.string({ unit: 'binary', maxLength: 80 });

const anyString = fc.oneof(anyUtf16, anyCodePoints);

const codePointLength = (s: string): number => [...s].length;

describe('truncateCodePoints (propriedades)', () => {
  test('a saída é sempre bem formada (nenhum surrogate órfão sobrevive)', () => {
    fc.assert(
      fc.property(anyString, fc.nat({ max: 100 }), (s, max) => truncateCodePoints(s, max).isWellFormed()),
      RUNS,
    );
  });

  test('o tamanho em code points é min(max, tamanho da entrada bem formada)', () => {
    fc.assert(
      fc.property(anyString, fc.nat({ max: 100 }), (s, max) => {
        const out = truncateCodePoints(s, max);
        return codePointLength(out) === Math.min(max, codePointLength(s.toWellFormed()));
      }),
      RUNS,
    );
  });

  test('a saída é prefixo da entrada bem formada (corta, nunca altera o meio)', () => {
    fc.assert(
      fc.property(anyString, fc.nat({ max: 100 }), (s, max) => s.toWellFormed().startsWith(truncateCodePoints(s, max))),
      RUNS,
    );
  });

  test('é idempotente e não mexe no que já cabe', () => {
    fc.assert(
      fc.property(anyString, fc.nat({ max: 100 }), (s, max) => {
        const once = truncateCodePoints(s, max);
        const fits = codePointLength(s.toWellFormed()) <= max;
        return truncateCodePoints(once, max) === once && (!fits || once === s.toWellFormed());
      }),
      RUNS,
    );
  });
});

/**
 * Um representante de cada faixa do INVISIBLE_OR_CONTROL (as duas pontas de cada intervalo).
 * Escritos como escape para que este arquivo não contenha caracteres invisíveis literais.
 */
const INVISIBLES = [
  0x0000, 0x0009, 0x000b, 0x001f, 0x007f, 0x009f, 0x00ad, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e,
  0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x206f, 0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xffa0,
  0xfff9, 0xfffb, 0xe0000, 0xe0041, 0xe007f, 0xe0100, 0xe01ef,
].map((cp) => String.fromCodePoint(cp));

/** Texto inocente: palavras alfanuméricas em pt-BR, sem ponto (não forma domínio). */
const plainWords = fc
  .array(fc.stringMatching(/^[a-zà-ú0-9]{1,8}$/), { minLength: 1, maxLength: 6 })
  .map((ws) => ws.join(' '));

/** Insere `needle` numa posição qualquer de `base`. */
const withInserted = (needle: fc.Arbitrary<string>) =>
  fc
    .tuple(plainWords, needle, fc.nat())
    .map(([base, n, at]) => {
      const i = at % (base.length + 1);
      return `${base.slice(0, i)}${n}${base.slice(i)}`;
    });

describe('safeText (propriedades)', () => {
  test('tudo que é aceito respeita a política: aparado, 1..max, sem invisível, sem <>, sem link', () => {
    const schema = safeText(60);
    fc.assert(
      fc.property(anyString, (s) => {
        const r = schema.safeParse(s);
        if (!r.success) return true;
        const out = r.data;
        const n = codePointLength(out);
        return (
          out === out.trim() &&
          n >= 1 &&
          n <= 60 &&
          !INVISIBLE_OR_CONTROL.test(out) &&
          !/[<>]/.test(out) &&
          !containsUrlLike(out)
        );
      }),
      { numRuns: 2000 },
    );
  });

  test('texto inocente passa', () => {
    fc.assert(fc.property(plainWords, (s) => safeText(200).safeParse(s).success), RUNS);
  });

  test('qualquer caractere invisível ou de controle, em qualquer posição interna, é rejeitado', () => {
    // No começo ou no fim, `.trim()` remove parte deles antes da checagem; o risco real é o meio.
    const inner = fc
      .tuple(plainWords, fc.constantFrom(...INVISIBLES), plainWords)
      .map(([a, c, b]) => `${a}${c}${b}`);
    fc.assert(fc.property(inner, (s) => !safeText(200).safeParse(s).success), RUNS);
    fc.assert(
      fc.property(inner, (s) => {
        const ok = safeText(200, { multiline: true }).safeParse(s).success;
        return INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE.test(s) ? !ok : ok;
      }),
      RUNS,
    );
  });

  test('< ou > em qualquer posição é rejeitado', () => {
    fc.assert(fc.property(withInserted(fc.constantFrom('<', '>')), (s) => !safeText(200).safeParse(s).success), RUNS);
  });

  test('esquema de link em qualquer posição é rejeitado', () => {
    const link = fc
      .tuple(fc.constantFrom('https://', 'http://', 'javascript:', 'data:', 'www.', 'ftp://'), fc.stringMatching(/^[a-z]{1,10}$/))
      .map(([scheme, host]) => ` ${scheme}${host} `);
    fc.assert(fc.property(withInserted(link), (s) => !safeText(200).safeParse(s).success), RUNS);
  });

  test('quebra de linha interna só passa com multiline', () => {
    const twoLines = fc.tuple(plainWords, plainWords).map(([a, b]) => `${a}\n${b}`);
    fc.assert(fc.property(twoLines, (s) => !safeText(200).safeParse(s).success), RUNS);
    fc.assert(fc.property(twoLines, (s) => safeText(200, { multiline: true }).safeParse(s).success), RUNS);
  });

  test('o limite é em code points: max emojis passam, max + 1 não', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (max) => {
        const schema = safeText(max);
        return schema.safeParse('😀'.repeat(max)).success && !schema.safeParse('😀'.repeat(max + 1)).success;
      }),
      RUNS,
    );
  });
});

describe('safeText e truncateCodePoints juntos', () => {
  test('truncar texto aceito no limite do schema mantém o texto aceito', () => {
    fc.assert(
      fc.property(plainWords, fc.integer({ min: 1, max: 40 }), (s, max) => {
        const cut = truncateCodePoints(s, max).trim();
        return cut.length === 0 || safeText(max).safeParse(cut).success;
      }),
      RUNS,
    );
  });

  test('sanidade das regexes: sem flags g/y (sem estado entre chamadas)', () => {
    expect(INVISIBLE_OR_CONTROL.flags).not.toMatch(/[gy]/);
    expect(INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE.flags).not.toMatch(/[gy]/);
  });
});
