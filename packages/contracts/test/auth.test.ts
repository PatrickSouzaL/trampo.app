// F1-AUTH-00: contratos do BFF de autenticação da extensão e teto do access token, com bordas exatas (ADR-004 D7,
// D4, D5, D9 e §4; ADR-013 D3). Cada limite é provado pelo valor na borda (passa) e pelo vizinho de fora (recusado).
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import type { z } from 'zod';
import {
  AUTH_BODY_MAX_BYTES,
  AUTH_ROUTES,
  AUTH_SCHEMA_VERSION,
  AccessTokenSchema,
  AuthCodeSchema,
  AuthExchangeRequestSchema,
  AuthLogoutRequestSchema,
  AuthRefreshRequestSchema,
  AuthSessionResponseSchema,
  PkceVerifierSchema,
  SealedRefreshSchema,
  type AuthExchangeRequest,
  type AuthLogoutRequest,
  type AuthRefreshRequest,
  type AuthSessionResponse,
} from '../src/auth.js';
import * as root from '../src/index.js';
import * as limits from '../src/limits.js';

// ---------------------------------------------------------------------------------------------------------------
// Fixtures. Nenhuma começa com `eyJ`: não são JWTs reais e não devem parecer um para a varredura de segredos.
// ---------------------------------------------------------------------------------------------------------------

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** `n` caracteres do alfabeto base64url em rodízio: a partir de 64, os 64 símbolos aparecem (inclusive `-` e `_`). */
const b64 = (n: number): string => B64URL_ALPHABET.repeat(Math.ceil(n / 64)).slice(0, n);

/** `bytes` octetos codificados em base64url pelo próprio Node (sem padding). O 0xfb gera `-` e `_`. */
const encoded = (bytes: number): string => Buffer.alloc(bytes, 0xfb).toString('base64url');

/** JWS compacto (cabeçalho.payload.assinatura) com exatamente `total` caracteres; a assinatura completa o tamanho. */
const jws = (total: number): string => {
  const head = `${b64(24)}.${b64(96)}.`;
  return head + b64(total - head.length);
};

interface EnvelopeParts {
  readonly prefix: string;
  readonly kid: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

/** Envelope típico do D5: IV de 12 bytes, tag de 16 e 600 bytes de texto claro (o pior caso ASCII, ver abaixo). */
const DEFAULT_PARTS: EnvelopeParts = {
  prefix: 'r1',
  kid: 'k1',
  iv: encoded(12),
  ciphertext: encoded(600),
  tag: encoded(16),
};

/** `r1.<kid>.<iv>.<cifrado>.<tag>` (ADR-004 D5), trocando só as partes pedidas. */
const envelope = (parts: Partial<EnvelopeParts> = {}): string => {
  const p = { ...DEFAULT_PARTS, ...parts };
  return [p.prefix, p.kid, p.iv, p.ciphertext, p.tag].join('.');
};

/** O maior envelope possível: kid de 16 e 768 bytes de texto claro (1.024 caracteres de cifrado). */
const WORST_KID = 'k0123456789abcde';
const WORST_ENVELOPE = envelope({ kid: WORST_KID, ciphertext: encoded(768) });

/** Os alfabetos inteiros: [A-Za-z0-9-] do código (63 símbolos) e os unreserved do RFC 7636 §4.1 (66). */
const CODE_ALPHABET = `${B64URL_ALPHABET.slice(0, 62)}-`;
const UNRESERVED = `${B64URL_ALPHABET.slice(0, 62)}-._~`;

/** Código no teto (128) e verifier no teto (128), cada um com todos os símbolos do seu alfabeto. */
const CODE_128 = CODE_ALPHABET.repeat(3).slice(0, 128);
const VERIFIER_128 = UNRESERVED.repeat(2).slice(0, 128);

/** Vetor do RFC 7636, Apêndice B: os 32 octetos e o verifier que eles geram em base64url. */
const RFC7636_OCTETS = [
  116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91,
  88, 5, 88, 83, 132, 141, 121,
];
const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

const UUID_CODE = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

const EXCHANGE_OK: AuthExchangeRequest = { schemaVersion: 1, authCode: UUID_CODE, codeVerifier: RFC7636_VERIFIER };
const REFRESH_OK: AuthRefreshRequest = { schemaVersion: 1, refreshToken: envelope() };
const LOGOUT_OK: AuthLogoutRequest = { schemaVersion: 1 };
const SESSION_OK: AuthSessionResponse = {
  schemaVersion: 1,
  accessToken: jws(900),
  refreshToken: envelope(),
  expiresIn: 900,
};

const EXCHANGE_WORST: AuthExchangeRequest = { schemaVersion: 1, authCode: CODE_128, codeVerifier: VERIFIER_128 };
const REFRESH_WORST: AuthRefreshRequest = { schemaVersion: 1, refreshToken: WORST_ENVELOPE };
const SESSION_WORST: AuthSessionResponse = {
  schemaVersion: 1,
  accessToken: jws(limits.ACCESS_TOKEN_MAX_CHARS),
  refreshToken: WORST_ENVELOPE,
  expiresIn: 900,
};

/** Códigos das issues do zod (vazio quando passa): mostram QUAL regra recusou. */
const issueCodes = (schema: z.ZodType, value: unknown): string[] => {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.code);
};

const utf8Bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

const without = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

/** Valores que não são string: o zod não converte nenhum (sem coerção). */
const NOT_STRINGS: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['número', 12_345_678],
  ['booleano', true],
  ['bigint', 12_345_678n],
  ['objeto', {}],
  ['array com string válida', ['a.b.c']],
  ['objeto com toString', { toString: () => 'a.b.c' }],
];

/** ASCII imprimível (0x20 a 0x7e) de fora da classe, como tuplas [nome, caractere]: o complemento do alfabeto. */
const asciiFora = (classe: RegExp): Array<[string, string]> =>
  Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))
    .filter((c) => !classe.test(c))
    .map((c): [string, string] => [JSON.stringify(c), c]);

/** Cada caractere de `asciiFora(classe)` em cada posição dada: tuplas [nome, valor] para o test.each. */
const emCadaPosicao = (
  classe: RegExp,
  posicoes: Array<[string, (c: string) => string]>,
): Array<[string, string]> =>
  posicoes.flatMap(([onde, montar]) =>
    asciiFora(classe).map(([nome, c]): [string, string] => [`${nome} ${onde}`, montar(c)]),
  );

/**
 * Os 2 caracteres de fora do ASCII que o case folding do Unicode leva para dentro de [A-Za-z0-9_] (ſ → s, K → k):
 * com as flags `iu` num desses regex, eles passariam. Por escape, porque o K de Kelvin é idêntico ao K latino.
 */
const CASE_FOLDING: Array<[string, string]> = [
  ['ſ (U+017F, s longo)', 'ſ'],
  ['K (U+212A, sinal de Kelvin)', 'K'],
];

/** Cada caractere de CASE_FOLDING em cada posição dada: tuplas [nome, valor] para o test.each. */
const dobraEmCadaPosicao = (posicoes: Array<[string, (c: string) => string]>): Array<[string, string]> =>
  posicoes.flatMap(([onde, montar]) =>
    CASE_FOLDING.map(([nome, c]): [string, string] => [`${nome} ${onde}`, montar(c)]),
  );

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

describe('fixtures: conferem os geradores do próprio teste, não o src', () => {
  test('base64url do Node sem padding (12 → 16, 15 → 20, 16 → 22, 768 → 1.024, 769 → 1.026; 0xfb dá -_v7)', () => {
    expect(Buffer.alloc(12).toString('base64url')).toHaveLength(16);
    expect(Buffer.alloc(16).toString('base64url')).toHaveLength(22);
    expect(Buffer.alloc(768).toString('base64url')).toHaveLength(1_024);
    expect(Buffer.alloc(15).toString('base64url')).toHaveLength(20);
    expect(Buffer.alloc(769).toString('base64url')).toHaveLength(1_026);
    for (const bytes of [12, 15, 16, 768, 769]) {
      expect(encoded(bytes)).not.toContain('=');
    }
    expect(encoded(3)).toBe('-_v7');
  });

  test('os alfabetos têm 63 e 66 símbolos distintos, e os piores casos de 128 usam todos', () => {
    expect(new Set(CODE_ALPHABET).size).toBe(63);
    expect(new Set(UNRESERVED).size).toBe(66);
    expect(CODE_128).toHaveLength(128);
    expect(VERIFIER_128).toHaveLength(128);
    expect(new Set(CODE_128)).toEqual(new Set(CODE_ALPHABET));
    expect(new Set(VERIFIER_128)).toEqual(new Set(UNRESERVED));
  });

  test('asciiFora devolve as 95 menos o alfabeto, sem nenhum símbolo dele', () => {
    expect(asciiFora(/[A-Za-z0-9._~-]/)).toHaveLength(95 - 66);
    expect(asciiFora(/[A-Za-z0-9-]/)).toHaveLength(95 - 63);
    expect(asciiFora(/[\w.-]/)).toHaveLength(95 - 65);
    expect(asciiFora(/[\w-]/)).toHaveLength(95 - 64);
    expect(asciiFora(/[a-z0-9]/)).toHaveLength(95 - 36);
    const fora = asciiFora(/[\w-]/).map(([, c]) => c);
    expect(fora).toEqual(expect.arrayContaining([' ', '!', '%', '+', '.', '/', ':', '=', '~']));
    expect(fora.filter((c) => B64URL_ALPHABET.includes(c))).toEqual([]);
  });

  test('CASE_FOLDING: fora do ASCII, recusados pelas classes sem flag (e só com i) e aceitos por elas com iu', () => {
    const classes: Array<[RegExp, RegExp, RegExp]> = [
      [/^[\w-]$/, /^[\w-]$/i, /^[\w-]$/iu],
      [/^[A-Za-z0-9._~-]$/, /^[A-Za-z0-9._~-]$/i, /^[A-Za-z0-9._~-]$/iu],
      [/^[A-Za-z0-9-]$/, /^[A-Za-z0-9-]$/i, /^[A-Za-z0-9-]$/iu],
    ];
    for (const [semFlag, soI, comIu] of classes) {
      for (const [, c] of CASE_FOLDING) {
        expect(c.codePointAt(0)).toBeGreaterThan(0x7f);
        expect(semFlag.test(c)).toBe(false);
        expect(soI.test(c)).toBe(false);
        expect(comIu.test(c)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------------------------------------------

describe('constantes (ADR-004 D7 e D4; ADR-013 D3)', () => {
  test('AUTH_SCHEMA_VERSION é 1 e AUTH_BODY_MAX_BYTES é 2.048', () => {
    expect(AUTH_SCHEMA_VERSION).toBe(1);
    expect(AUTH_BODY_MAX_BYTES).toBe(2_048);
  });

  test('ACCESS_TOKEN_MAX_CHARS é 8.192 (ADR-013 D3), mora em limits e sai também pela raiz', () => {
    expect(limits.ACCESS_TOKEN_MAX_CHARS).toBe(8_192);
    expect(root.ACCESS_TOKEN_MAX_CHARS).toBe(8_192);
  });

  test('a raiz reexporta os contratos de auth (os mesmos objetos, não cópias)', () => {
    expect(root.AUTH_SCHEMA_VERSION).toBe(AUTH_SCHEMA_VERSION);
    expect(root.AUTH_BODY_MAX_BYTES).toBe(AUTH_BODY_MAX_BYTES);
    expect(root.AUTH_ROUTES).toBe(AUTH_ROUTES);
    expect(root.AccessTokenSchema).toBe(AccessTokenSchema);
    expect(root.PkceVerifierSchema).toBe(PkceVerifierSchema);
    expect(root.AuthCodeSchema).toBe(AuthCodeSchema);
    expect(root.SealedRefreshSchema).toBe(SealedRefreshSchema);
    expect(root.AuthExchangeRequestSchema).toBe(AuthExchangeRequestSchema);
    expect(root.AuthRefreshRequestSchema).toBe(AuthRefreshRequestSchema);
    expect(root.AuthLogoutRequestSchema).toBe(AuthLogoutRequestSchema);
    expect(root.AuthSessionResponseSchema).toBe(AuthSessionResponseSchema);
  });

  test('o subpath @trampo/contracts/auth aponta para o build de auth.ts (ADR-004 D7)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports['./auth']).toEqual({ types: './dist/auth.d.ts', default: './dist/auth.js' });
  });

  test('AUTH_ROUTES: exatamente os 3 caminhos do D4, nessa ordem', () => {
    expect(AUTH_ROUTES).toStrictEqual({
      exchange: '/v1/auth/exchange',
      refresh: '/v1/auth/refresh',
      logout: '/v1/auth/logout',
    });
    expect(Object.keys(AUTH_ROUTES)).toEqual(['exchange', 'refresh', 'logout']);
  });

  test('AUTH_ROUTES: congelado em runtime; atribuir, acrescentar, apagar ou redefinir falha e nada muda', () => {
    expect(Object.isFrozen(AUTH_ROUTES)).toBe(true);
    // O Reflect devolve false em vez de lançar: prova o congelamento sem cast e sem depender do modo estrito.
    expect(Reflect.set(AUTH_ROUTES, 'exchange', '/v1/auth/exchange/')).toBe(false);
    expect(Reflect.set(AUTH_ROUTES, 'outra', '/v1/auth/outra')).toBe(false);
    expect(Reflect.deleteProperty(AUTH_ROUTES, 'logout')).toBe(false);
    expect(Reflect.defineProperty(AUTH_ROUTES, 'refresh', { value: '/v1/auth' })).toBe(false);
    expect(AUTH_ROUTES).toStrictEqual({
      exchange: '/v1/auth/exchange',
      refresh: '/v1/auth/refresh',
      logout: '/v1/auth/logout',
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// AccessTokenSchema
// ---------------------------------------------------------------------------------------------------------------

describe('AccessTokenSchema: JWS compacto, 3 partes base64url não vazias, até 8.192 (ADR-004 D7; ADR-013 D3)', () => {
  test.each([
    ['3 partes de 1 caractere', 'a.b.c'],
    ['os 64 símbolos do base64url em cada parte', `${b64(64)}.${b64(64)}.${b64(64)}`],
    ['partes só com - e _', '-_.__.--'],
    ['900 caracteres', jws(900)],
  ])('aceita %s', (_name, token) => {
    expect(AccessTokenSchema.safeParse(token).success).toBe(true);
  });

  test('borda: 8.192 passa e 8.193 é recusado só pelo teto de ACCESS_TOKEN_MAX_CHARS', () => {
    expect(jws(limits.ACCESS_TOKEN_MAX_CHARS)).toHaveLength(8_192);
    expect(jws(limits.ACCESS_TOKEN_MAX_CHARS + 1)).toHaveLength(8_193);
    expect(issueCodes(AccessTokenSchema, jws(limits.ACCESS_TOKEN_MAX_CHARS))).toEqual([]);
    expect(issueCodes(AccessTokenSchema, jws(limits.ACCESS_TOKEN_MAX_CHARS + 1))).toEqual(['too_big']);
  });

  test('o teto vem de limits.ts, a fonte única (ADR-004 D7): outro valor lá move a borda aqui', async () => {
    vi.resetModules();
    vi.doMock('../src/limits.js', () => ({ ACCESS_TOKEN_MAX_CHARS: 16 }));
    try {
      const comTetoDe16 = await import('../src/auth.js');
      expect(issueCodes(comTetoDe16.AccessTokenSchema, `${b64(4)}.${b64(4)}.${b64(6)}`)).toEqual([]);
      expect(issueCodes(comTetoDe16.AccessTokenSchema, `${b64(4)}.${b64(4)}.${b64(7)}`)).toEqual(['too_big']);
    } finally {
      vi.doUnmock('../src/limits.js');
      vi.resetModules();
    }
  });

  test.each([
    ['vazio', ''],
    ['uma parte', 'abc'],
    ['2 partes', 'a.b'],
    ['4 partes', 'a.b.c.d'],
    ['5 partes (forma do JWE)', 'a.b.c.d.e'],
    ['cabeçalho vazio', '.b.c'],
    ['payload vazio', 'a..c'],
    ['assinatura vazia (alg: none)', 'a.b.'],
    ['só pontos', '..'],
    ['ponto no fim', 'a.b.c.'],
    ['ponto no início', '.a.b.c'],
    ['= de padding', 'a.b.c='],
    ['= no meio', 'a=.b.c'],
    ['+ do base64 padrão', 'a+b.c.d'],
    ['/ do base64 padrão', 'a.b/c.d'],
    ['espaço no meio', 'a.b c.d'],
    ['espaço no início', ' a.b.c'],
    ['espaço no fim', 'a.b.c '],
    ['\\n no fim', 'a.b.c\n'],
    ['\\n no início', '\na.b.c'],
    ['\\r\\n no fim', 'a.b.c\r\n'],
    ['tab no fim', 'a.b.c\t'],
    ['NUL no fim', 'a.b.c\u0000'],
    ['esquema Bearer junto', 'Bearer a.b.c'],
    ['letra acentuada', 'a.bé.c'],
    ['dígito arábico-índico', 'a.b.c٣'],
    ['homoglifo cirílico (а)', 'а.b.c'],
    ['ponto de largura total', 'a．b．c'],
    ['dois-pontos no lugar do 1º ponto', 'a:b.c'],
    ['dois-pontos no lugar do 2º ponto', 'a.b:c'],
    ['emoji', 'a.b.c\u{1f600}'],
  ])('recusa %s', (_name, token) => {
    expect(AccessTokenSchema.safeParse(token).success).toBe(false);
  });

  test.each(
    emCadaPosicao(/[\w.-]/, [
      ['na 1ª parte', (c) => `a${c}a.b.c`],
      ['na 2ª parte', (c) => `a.b${c}b.c`],
      ['na 3ª parte', (c) => `a.b.c${c}c`],
    ]),
  )('recusa o ASCII de fora do base64url %s', (_name, token) => {
    expect(AccessTokenSchema.safeParse(token).success).toBe(false);
  });

  test.each(
    dobraEmCadaPosicao([
      ['na 1ª parte', (c) => `a${c}a.b.c`],
      ['na 2ª parte', (c) => `a.b${c}b.c`],
      ['na 3ª parte', (c) => `a.b.c${c}c`],
    ]),
  )('recusa o que o case folding do Unicode levaria ao ASCII: %s', (_name, token) => {
    expect(AccessTokenSchema.safeParse(token).success).toBe(false);
  });

  test.each(NOT_STRINGS)('recusa não-string: %s', (_name, value) => {
    expect(AccessTokenSchema.safeParse(value).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// PkceVerifierSchema
// ---------------------------------------------------------------------------------------------------------------

describe('PkceVerifierSchema: code_verifier do RFC 7636 §4.1, de 43 a 128 unreserved (ADR-004 D7, D3 e D9)', () => {
  test('o verifier do RFC 7636, Apêndice B, sai dos 32 octetos do RFC e passa', () => {
    expect(Buffer.from(RFC7636_OCTETS).toString('base64url')).toBe(RFC7636_VERIFIER);
    expect(PkceVerifierSchema.safeParse(RFC7636_VERIFIER).success).toBe(true);
  });

  test('32 bytes em base64url dão os 43 caracteres que o SW gera (D9) e passam', () => {
    expect(encoded(32)).toHaveLength(43);
    expect(PkceVerifierSchema.safeParse(encoded(32)).success).toBe(true);
  });

  test('borda: 43 e 128 passam; 42 e 129 não', () => {
    expect(PkceVerifierSchema.safeParse('a'.repeat(43)).success).toBe(true);
    expect(PkceVerifierSchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(PkceVerifierSchema.safeParse('a'.repeat(42)).success).toBe(false);
    expect(PkceVerifierSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  test.each([
    ['.', '.'],
    ['_', '_'],
    ['~', '~'],
    ['-', '-'],
  ])('aceita o unreserved %s', (_name, symbol) => {
    expect(PkceVerifierSchema.safeParse(`${'a'.repeat(42)}${symbol}`).success).toBe(true);
    expect(PkceVerifierSchema.safeParse(symbol.repeat(43)).success).toBe(true);
  });

  test('aceita o alfabeto unreserved inteiro (66 símbolos) e o pior caso de 128', () => {
    expect(PkceVerifierSchema.safeParse(UNRESERVED).success).toBe(true);
    expect(PkceVerifierSchema.safeParse(VERIFIER_128).success).toBe(true);
  });

  test.each([
    ['vazio', ''],
    ['= de padding', `${'a'.repeat(43)}=`],
    ['espaço no meio', `${'a'.repeat(21)} ${'a'.repeat(21)}`],
    ['espaço no fim', `${'a'.repeat(43)} `],
    ['\\n no fim', `${'a'.repeat(43)}\n`],
    ['\\n no início', `\n${'a'.repeat(43)}`],
    ['letra acentuada', `${'a'.repeat(42)}é`],
    ['homoglifo cirílico', `${'a'.repeat(42)}а`],
  ])('recusa %s', (_name, verifier) => {
    expect(PkceVerifierSchema.safeParse(verifier).success).toBe(false);
  });

  test.each(emCadaPosicao(/[A-Za-z0-9._~-]/, [['no fim', (c) => `${'a'.repeat(42)}${c}`]]))(
    'recusa o ASCII de fora do unreserved %s (nem sub-delims, nem gen-delims, nem %%)',
    (_name, verifier) => {
      expect(PkceVerifierSchema.safeParse(verifier).success).toBe(false);
    },
  );

  test.each(dobraEmCadaPosicao([['no fim', (c) => `${'a'.repeat(42)}${c}`]]))(
    'recusa o que o case folding do Unicode levaria ao ASCII: %s',
    (_name, verifier) => {
      expect(PkceVerifierSchema.safeParse(verifier).success).toBe(false);
    },
  );

  test.each(NOT_STRINGS)('recusa não-string: %s', (_name, value) => {
    expect(PkceVerifierSchema.safeParse(value).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// AuthCodeSchema
// ---------------------------------------------------------------------------------------------------------------

describe('AuthCodeSchema: forma larga, de 8 a 128 em [A-Za-z0-9-] (ADR-004 D7 e D4, troca, passo 1)', () => {
  test('borda: 8 e 128 passam; 7 e 129 não', () => {
    expect(AuthCodeSchema.safeParse('a'.repeat(8)).success).toBe(true);
    expect(AuthCodeSchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(AuthCodeSchema.safeParse('a'.repeat(7)).success).toBe(false);
    expect(AuthCodeSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  test.each([
    ['UUID', UUID_CODE],
    ['UUID em maiúsculas', UUID_CODE.toUpperCase()],
    ['hexadecimal', '0123456789abcdef'],
    ['alfabeto inteiro [A-Za-z0-9-] (63 símbolos)', CODE_ALPHABET],
    ['pior caso de 128 com o alfabeto inteiro', CODE_128],
  ])('aceita %s', (_name, code) => {
    expect(AuthCodeSchema.safeParse(code).success).toBe(true);
  });

  test.each([
    ['vazio', ''],
    ['=', 'abcdefgh='],
    ['espaço no fim', 'abcdefgh '],
    ['\\n no fim', 'abcdefgh\n'],
    ['\\n no início', '\nabcdefgh'],
    ['& de outro parâmetro da query', 'abcdefgh&st=x'],
    ['letra acentuada', 'abcdefgé'],
    ['homoglifo cirílico', 'abcdefgа'],
    ['UUID entre chaves', `{${UUID_CODE}}`],
  ])('recusa %s', (_name, code) => {
    expect(AuthCodeSchema.safeParse(code).success).toBe(false);
  });

  test.each(emCadaPosicao(/[A-Za-z0-9-]/, [['no meio', (c) => `abcd${c}efgh`]]))(
    'recusa o ASCII de fora de [A-Za-z0-9-] %s',
    (_name, code) => {
      expect(AuthCodeSchema.safeParse(code).success).toBe(false);
    },
  );

  test.each(dobraEmCadaPosicao([['no meio', (c) => `abcd${c}efgh`]]))(
    'recusa o que o case folding do Unicode levaria ao ASCII: %s',
    (_name, code) => {
      expect(AuthCodeSchema.safeParse(code).success).toBe(false);
    },
  );

  test('qual regra recusa: o vazio cai no min e no regex (+, não *); 7 e 129, só no tamanho', () => {
    expect(issueCodes(AuthCodeSchema, '')).toEqual(['too_small', 'invalid_format']);
    expect(issueCodes(AuthCodeSchema, 'a'.repeat(7))).toEqual(['too_small']);
    expect(issueCodes(AuthCodeSchema, 'a'.repeat(129))).toEqual(['too_big']);
  });

  test.each(NOT_STRINGS)('recusa não-string: %s', (_name, value) => {
    expect(AuthCodeSchema.safeParse(value).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SealedRefreshSchema
// ---------------------------------------------------------------------------------------------------------------

describe('SealedRefreshSchema: r1.<kid>.<iv>.<cifrado>.<tag> do AES-256-GCM (ADR-004 D5 e D7)', () => {
  test('o pior caso (kid de 16, cifrado de 1.024) tem 1.084 caracteres e passa', () => {
    expect(WORST_KID).toHaveLength(16);
    expect(WORST_ENVELOPE).toHaveLength(1_084);
    expect(WORST_ENVELOPE).toHaveLength(3 + 16 + 1 + 16 + 1 + 1_024 + 1 + 22);
    expect(SealedRefreshSchema.safeParse(WORST_ENVELOPE).success).toBe(true);
  });

  test('o texto claro do D5 no pior caso ASCII (rt de 512) tem 600 bytes, cabe nos 768 e o envelope passa', () => {
    const plaintext = JSON.stringify({
      rt: 'x'.repeat(512),
      sid: UUID_CODE,
      sst: 9_999_999_999,
      iat: 9_999_999_999,
    });
    const bytes = new TextEncoder().encode(plaintext).length;
    expect(bytes).toBe(600);
    // No GCM, o cifrado tem o tamanho do texto claro.
    expect(SealedRefreshSchema.safeParse(envelope({ ciphertext: encoded(bytes) })).success).toBe(true);
  });

  test('cifrado: 15 bytes (20 caracteres) e 768 bytes (1.024) passam; 769 bytes (1.026) não', () => {
    expect(SealedRefreshSchema.safeParse(envelope({ ciphertext: encoded(15) })).success).toBe(true);
    expect(SealedRefreshSchema.safeParse(envelope({ ciphertext: encoded(768) })).success).toBe(true);
    expect(SealedRefreshSchema.safeParse(envelope({ ciphertext: encoded(769) })).success).toBe(false);
  });

  test.each([
    ['o envelope típico', envelope()],
    ['kid de 1', envelope({ kid: 'k' })],
    ['kid de 1 dígito', envelope({ kid: '7' })],
    ['kid de 16', envelope({ kid: WORST_KID })],
    ['kid a-p', envelope({ kid: 'abcdefghijklmnop' })],
    ['kid q-z e 0-5', envelope({ kid: 'qrstuvwxyz012345' })],
    ['kid u-z e 0-9', envelope({ kid: 'uvwxyz0123456789' })],
    ['iv de 16 caracteres (A-P)', envelope({ iv: b64(16) })],
    ['iv Q-Z e a-f', envelope({ iv: B64URL_ALPHABET.slice(16, 32) })],
    ['iv g-v', envelope({ iv: B64URL_ALPHABET.slice(32, 48) })],
    ['iv w-z, dígitos, - e _', envelope({ iv: B64URL_ALPHABET.slice(48, 64) })],
    ['tag de 22 caracteres (A-V)', envelope({ tag: b64(22) })],
    ['tag W-Z e a-r', envelope({ tag: B64URL_ALPHABET.slice(22, 44) })],
    ['tag q-z, dígitos, - e _', envelope({ tag: B64URL_ALPHABET.slice(42, 64) })],
    ['cifrado de 20 caracteres', envelope({ ciphertext: b64(20) })],
    ['cifrado de 1.024 caracteres', envelope({ ciphertext: b64(1_024) })],
    ['cifrado com - e _', envelope({ ciphertext: b64(128).slice(64) })],
  ])('aceita %s', (_name, value) => {
    expect(SealedRefreshSchema.safeParse(value).success).toBe(true);
  });

  test.each([
    ['vazio', ''],
    ['kid vazio', envelope({ kid: '' })],
    ['kid de 17', envelope({ kid: 'k'.repeat(17) })],
    ['kid maiúsculo', envelope({ kid: 'K1' })],
    ['iv de 15', envelope({ iv: b64(15) })],
    ['iv de 17', envelope({ iv: b64(17) })],
    ['iv de 13 bytes', envelope({ iv: encoded(13) })],
    ['tag de 21', envelope({ tag: b64(21) })],
    ['tag de 23', envelope({ tag: b64(23) })],
    ['tag de 15 bytes', envelope({ tag: encoded(15) })],
    ['cifrado de 19', envelope({ ciphertext: b64(19) })],
    ['cifrado de 1.025', envelope({ ciphertext: b64(1_025) })],
    ['cifrado vazio', envelope({ ciphertext: '' })],
    ['prefixo s1 (o envelope da pretensão)', envelope({ prefix: 's1' })],
    ['prefixo r2', envelope({ prefix: 'r2' })],
    ['prefixo R1', envelope({ prefix: 'R1' })],
    ['sem prefixo', envelope().slice(3)],
    ['parte faltando (sem tag)', [DEFAULT_PARTS.prefix, 'k1', DEFAULT_PARTS.iv, DEFAULT_PARTS.ciphertext].join('.')],
    ['parte faltando (sem kid)', [DEFAULT_PARTS.prefix, DEFAULT_PARTS.iv, DEFAULT_PARTS.ciphertext, DEFAULT_PARTS.tag].join('.')],
    ['parte a mais no fim', `${envelope()}.${b64(22)}`],
    ['parte a mais no meio', envelope({ ciphertext: `${b64(20)}.${b64(20)}` })],
    ['= de padding na tag', envelope({ tag: `${b64(21)}=` })],
    ['= de padding no iv', envelope({ iv: `${b64(15)}=` })],
    ['== de padding no cifrado', envelope({ ciphertext: `${b64(22)}==` })],
    ['espaço no início', ` ${envelope()}`],
    ['\\n no fim', `${envelope()}\n`],
    ['letra acentuada no cifrado', envelope({ ciphertext: `${b64(20)}é` })],
    ['homoglifo cirílico no kid', envelope({ kid: 'kа' })],
    ['refresh cru do Supabase', 'v1r3fr35hcru'],
    ['access token no lugar do envelope', jws(900)],
  ])('recusa %s', (_name, value) => {
    expect(SealedRefreshSchema.safeParse(value).success).toBe(false);
  });

  test.each([
    ['entre r1 e kid', 0],
    ['entre kid e iv', 1],
    ['entre iv e cifrado', 2],
    ['entre cifrado e tag', 3],
  ])('recusa ":" no lugar do ponto %s', (_name, index) => {
    const parts = envelope().split('.');
    const joined = `${parts.slice(0, index + 1).join('.')}:${parts.slice(index + 1).join('.')}`;
    expect(joined.split('.')).toHaveLength(4);
    expect(SealedRefreshSchema.safeParse(joined).success).toBe(false);
  });

  test.each([
    ...emCadaPosicao(/[a-z0-9]/, [['no kid', (c) => envelope({ kid: `k${c}1` })]]),
    ...emCadaPosicao(/[\w-]/, [
      ['no iv', (c) => envelope({ iv: `${b64(15)}${c}` })],
      ['no cifrado', (c) => envelope({ ciphertext: `${b64(20)}${c}` })],
      ['na tag', (c) => envelope({ tag: `${b64(21)}${c}` })],
    ]),
  ])('recusa o ASCII de fora do alfabeto da parte: %s', (_name, value) => {
    expect(SealedRefreshSchema.safeParse(value).success).toBe(false);
  });

  test('teto de 1.100: com 1.100 só o formato recusa; com 1.101 o teto também', () => {
    expect(`${WORST_ENVELOPE}${'a'.repeat(16)}`).toHaveLength(1_100);
    expect(issueCodes(SealedRefreshSchema, `${WORST_ENVELOPE}${'a'.repeat(16)}`)).toEqual(['invalid_format']);
    expect(`${WORST_ENVELOPE}${'a'.repeat(17)}`).toHaveLength(1_101);
    expect(issueCodes(SealedRefreshSchema, `${WORST_ENVELOPE}${'a'.repeat(17)}`)).toEqual(['too_big', 'invalid_format']);
  });

  test.each(NOT_STRINGS)('recusa não-string: %s', (_name, value) => {
    expect(SealedRefreshSchema.safeParse(value).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Pedidos e resposta: comum aos 4
// ---------------------------------------------------------------------------------------------------------------

type ObjectCase = [string, z.ZodType, Record<string, unknown>];

const OBJECT_CASES: ObjectCase[] = [
  ['AuthExchangeRequestSchema', AuthExchangeRequestSchema, EXCHANGE_OK],
  ['AuthRefreshRequestSchema', AuthRefreshRequestSchema, REFRESH_OK],
  ['AuthLogoutRequestSchema', AuthLogoutRequestSchema, LOGOUT_OK],
  ['AuthSessionResponseSchema', AuthSessionResponseSchema, SESSION_OK],
];

const MISSING_FIELD_CASES: Array<[string, z.ZodType, Record<string, unknown>]> = OBJECT_CASES.flatMap(
  ([name, schema, valid]) =>
    Object.keys(valid).map((key): [string, z.ZodType, Record<string, unknown>] => [
      `${name} sem ${key}`,
      schema,
      without(valid, key),
    ]),
);

describe('pedidos e resposta: strictObject, schemaVersion 1, sem coerção (ADR-004 D4 e D7)', () => {
  test.each(OBJECT_CASES)('%s: o válido passa e sai idêntico, sem coerção nem chave nova', (_name, schema, valid) => {
    const result = schema.safeParse(valid);
    expect(result.success).toBe(true);
    expect(result.data).toStrictEqual(valid);
  });

  test.each(OBJECT_CASES)('%s: chave extra é recusada', (_name, schema, valid) => {
    expect(issueCodes(schema, { ...valid, extra: 'x' })).toEqual(['unrecognized_keys']);
    expect(schema.safeParse({ ...valid, extra: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...valid, constructor: 'x' }).success).toBe(false);
  });

  test.each(OBJECT_CASES)('%s: __proto__ vindo do JSON.parse é recusado, sem poluir o protótipo', (_name, schema, valid) => {
    const body = `{"__proto__":{"isAdmin":true},${JSON.stringify(valid).slice(1)}`;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(parsed)).toContain('__proto__');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(issueCodes(schema, parsed)).toEqual(['unrecognized_keys']);
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
  });

  test.each(OBJECT_CASES)('%s: schemaVersion diferente do número 1 é recusado', (_name, schema, valid) => {
    expect(schema.safeParse({ ...valid, schemaVersion: AUTH_SCHEMA_VERSION }).success).toBe(true);
    for (const version of [2, 0, -1, 1.5, '1', '01', true, null, [1], 1n]) {
      expect(schema.safeParse({ ...valid, schemaVersion: version }).success, `schemaVersion ${String(version)}`).toBe(
        false,
      );
    }
  });

  test.each(MISSING_FIELD_CASES)('%s: campo faltando é recusado', (_name, schema, partial) => {
    expect(schema.safeParse(partial).success).toBe(false);
  });

  test.each(OBJECT_CASES)('%s: campo null ou undefined é recusado', (_name, schema, valid) => {
    for (const key of Object.keys(valid)) {
      expect(schema.safeParse({ ...valid, [key]: null }).success, `${key}: null`).toBe(false);
      expect(schema.safeParse({ ...valid, [key]: undefined }).success, `${key}: undefined`).toBe(false);
    }
  });

  test.each(OBJECT_CASES)('%s: o que não é objeto é recusado', (_name, schema, valid) => {
    for (const value of [undefined, null, 1, 'x', true, [], [valid], JSON.stringify(valid)]) {
      expect(schema.safeParse(value).success, JSON.stringify(value) ?? 'undefined').toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Pedidos e resposta: específicos
// ---------------------------------------------------------------------------------------------------------------

describe('AuthExchangeRequestSchema (POST /v1/auth/exchange; ADR-004 D4 e D7)', () => {
  test('os campos usam os schemas de formato: código e verifier nas bordas e no alfabeto', () => {
    const at = (authCode: string, codeVerifier: string): boolean =>
      AuthExchangeRequestSchema.safeParse({ schemaVersion: 1, authCode, codeVerifier }).success;
    expect(at('a'.repeat(8), 'a'.repeat(43))).toBe(true);
    expect(at(CODE_128, VERIFIER_128)).toBe(true);
    expect(at('a'.repeat(7), 'a'.repeat(43))).toBe(false);
    expect(at('a'.repeat(129), 'a'.repeat(43))).toBe(false);
    expect(at('a'.repeat(8), 'a'.repeat(42))).toBe(false);
    expect(at('a'.repeat(8), 'a'.repeat(129))).toBe(false);
    // Tamanho certo, alfabeto errado: só o regex de cada schema recusa.
    expect(at('abcd_efgh', 'a'.repeat(43))).toBe(false);
    expect(at('a'.repeat(8), `${'a'.repeat(42)}+`)).toBe(false);
  });

  test.each([
    ['auth_code (nome do GoTrue)', 'auth_code'],
    ['code_verifier (nome do GoTrue)', 'code_verifier'],
    ['state (privado do SW)', 'state'],
    ['st', 'st'],
    ['redirect_to (nunca passa pela API)', 'redirect_to'],
    ['redirectTo', 'redirectTo'],
    ['provider', 'provider'],
  ])('recusa a chave %s', (_name, key) => {
    expect(AuthExchangeRequestSchema.safeParse({ ...EXCHANGE_OK, [key]: 'x' }).success).toBe(false);
  });

  test('a forma do GoTrue no lugar da do contrato é recusada', () => {
    const gotrue = { schemaVersion: 1, auth_code: UUID_CODE, code_verifier: RFC7636_VERIFIER };
    expect(AuthExchangeRequestSchema.safeParse(gotrue).success).toBe(false);
  });
});

describe('AuthRefreshRequestSchema (POST /v1/auth/refresh; ADR-004 D4, D5 e D7)', () => {
  test('o pior envelope passa; o refresh cru e o access token são recusados', () => {
    expect(AuthRefreshRequestSchema.safeParse(REFRESH_WORST).success).toBe(true);
    expect(AuthRefreshRequestSchema.safeParse({ schemaVersion: 1, refreshToken: 'v1r3fr35hcru' }).success).toBe(false);
    expect(AuthRefreshRequestSchema.safeParse({ schemaVersion: 1, refreshToken: jws(900) }).success).toBe(false);
  });

  test.each([
    ['refresh_token (nome do GoTrue)', 'refresh_token'],
    ['accessToken', 'accessToken'],
    ['sid', 'sid'],
  ])('recusa a chave %s', (_name, key) => {
    expect(AuthRefreshRequestSchema.safeParse({ ...REFRESH_OK, [key]: 'x' }).success).toBe(false);
  });
});

describe('AuthLogoutRequestSchema (POST /v1/auth/logout; ADR-004 D4 e D7)', () => {
  test.each([
    ['scope global (o escopo é fixo no servidor)', 'scope', 'global'],
    ['scope local', 'scope', 'local'],
    ['accessToken no corpo (vai no Bearer)', 'accessToken', 'a.b.c'],
    ['refreshToken no corpo', 'refreshToken', envelope()],
  ])('recusa %s', (_name, key, value) => {
    expect(AuthLogoutRequestSchema.safeParse({ ...LOGOUT_OK, [key]: value }).success).toBe(false);
  });
});

describe('AuthSessionResponseSchema (200 da troca e da renovação; ADR-004 D4 passo 5 e 8, D7; SR-22)', () => {
  test.each([
    ['user', { id: 'u', email: 'x@example.com' }],
    ['provider_token', 'gho_canario'],
    ['provider_refresh_token', 'canario'],
    ['email', 'x@example.com'],
    ['access_token', 'a.b.c'],
    ['refresh_token', 'cru'],
    ['expires_in', 900],
    ['expires_at', 1],
    ['token_type', 'bearer'],
    ['userId', 'u'],
    ['sessionId', 's'],
  ])('recusa a chave %s (nada além das 4)', (key, value) => {
    expect(issueCodes(AuthSessionResponseSchema, { ...SESSION_OK, [key]: value })).toEqual(['unrecognized_keys']);
  });

  test('a projeção crua do GoTrue (snake_case) é recusada', () => {
    const gotrue = {
      access_token: jws(900),
      refresh_token: 'cru',
      expires_in: 900,
      token_type: 'bearer',
      user: { id: 'u' },
    };
    expect(AuthSessionResponseSchema.safeParse(gotrue).success).toBe(false);
  });

  test('borda de expiresIn: 1 e 900 passam; 0 e 901 não', () => {
    expect(AuthSessionResponseSchema.safeParse({ ...SESSION_OK, expiresIn: 1 }).success).toBe(true);
    expect(AuthSessionResponseSchema.safeParse({ ...SESSION_OK, expiresIn: 900 }).success).toBe(true);
    expect(AuthSessionResponseSchema.safeParse({ ...SESSION_OK, expiresIn: 0 }).success).toBe(false);
    expect(AuthSessionResponseSchema.safeParse({ ...SESSION_OK, expiresIn: 901 }).success).toBe(false);
  });

  test.each([
    ['-0', -0],
    ['1,5', 1.5],
    ['899,5', 899.5],
    ['-1', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['3.600 (jwt_expiry fora do HITL-004)', 3_600],
    ['"900" (string, sem coerção)', '900'],
    ['"1" (string)', '1'],
    ['900n (bigint)', 900n],
    ['true', true],
    ['null', null],
  ])('recusa expiresIn %s', (_name, expiresIn) => {
    expect(AuthSessionResponseSchema.safeParse({ ...SESSION_OK, expiresIn }).success).toBe(false);
  });

  test('accessToken e refreshToken usam os schemas de formato', () => {
    expect(AuthSessionResponseSchema.safeParse(SESSION_WORST).success).toBe(true);
    const over = { ...SESSION_WORST, accessToken: jws(limits.ACCESS_TOKEN_MAX_CHARS + 1) };
    expect(AuthSessionResponseSchema.safeParse(over).success).toBe(false);
    expect(AuthSessionResponseSchema.safeParse({ ...SESSION_OK, accessToken: 'a.b.' }).success).toBe(false);
    expect(AuthSessionResponseSchema.safeParse({ ...SESSION_OK, refreshToken: 'cru' }).success).toBe(false);
    expect(AuthSessionResponseSchema.safeParse({ ...SESSION_OK, refreshToken: jws(900) }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Cabe no corpo
// ---------------------------------------------------------------------------------------------------------------

describe('cabe no corpo: o pior pedido válido fica até AUTH_BODY_MAX_BYTES (ADR-004 D4)', () => {
  const WORST_REQUESTS: Array<[string, z.ZodType, Record<string, unknown>, number]> = [
    ['troca (código e verifier de 128)', AuthExchangeRequestSchema, EXCHANGE_WORST, 307],
    ['renovação (envelope de 1.084)', AuthRefreshRequestSchema, REFRESH_WORST, 1_121],
    ['logout', AuthLogoutRequestSchema, LOGOUT_OK, 19],
  ];

  test.each(WORST_REQUESTS)('%s', (_name, schema, body, bytes) => {
    expect(schema.safeParse(body).success).toBe(true);
    expect(utf8Bytes(body)).toBe(bytes);
    expect(utf8Bytes(body)).toBeLessThanOrEqual(AUTH_BODY_MAX_BYTES);
    // Mesmo formatado com recuo de 2, o pior caso cabe.
    expect(new TextEncoder().encode(JSON.stringify(body, null, 2)).length).toBeLessThanOrEqual(AUTH_BODY_MAX_BYTES);
  });

  test('os piores corpos válidos são ASCII: bytes UTF-8 = caracteres, sem escape que infle o corpo', () => {
    for (const body of [EXCHANGE_WORST, REFRESH_WORST, LOGOUT_OK, SESSION_WORST]) {
      const json = JSON.stringify(body);
      expect(utf8Bytes(body)).toBe(json.length);
      expect(json).not.toContain('\\');
    }
  });

  test('a resposta no pior caso (token de 8.192 e envelope de 1.084) tem 9.346 bytes', () => {
    expect(AuthSessionResponseSchema.safeParse(SESSION_WORST).success).toBe(true);
    expect(utf8Bytes(SESSION_WORST)).toBe(9_346);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------------------------------------------

describe('tipos inferidos (ADR-004 D7; SR-22)', () => {
  test('AuthSessionResponse tem exatamente as 4 chaves', () => {
    expectTypeOf<AuthSessionResponse>().toEqualTypeOf<{
      schemaVersion: 1;
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    }>();
    expectTypeOf<keyof AuthSessionResponse>().toEqualTypeOf<
      'schemaVersion' | 'accessToken' | 'refreshToken' | 'expiresIn'
    >();
    expectTypeOf<z.input<typeof AuthSessionResponseSchema>>().toEqualTypeOf<AuthSessionResponse>();
  });

  test('os pedidos têm exatamente as chaves do D7, e a entrada é igual à saída', () => {
    expectTypeOf<AuthExchangeRequest>().toEqualTypeOf<{ schemaVersion: 1; authCode: string; codeVerifier: string }>();
    expectTypeOf<AuthRefreshRequest>().toEqualTypeOf<{ schemaVersion: 1; refreshToken: string }>();
    expectTypeOf<AuthLogoutRequest>().toEqualTypeOf<{ schemaVersion: 1 }>();
    expectTypeOf<z.input<typeof AuthExchangeRequestSchema>>().toEqualTypeOf<AuthExchangeRequest>();
    expectTypeOf<z.input<typeof AuthRefreshRequestSchema>>().toEqualTypeOf<AuthRefreshRequest>();
    expectTypeOf<z.input<typeof AuthLogoutRequestSchema>>().toEqualTypeOf<AuthLogoutRequest>();
  });

  test('constantes literais: versão 1 e caminhos exatos, somente leitura', () => {
    expectTypeOf(AUTH_SCHEMA_VERSION).toEqualTypeOf<1>();
    expectTypeOf(AUTH_ROUTES.exchange).toEqualTypeOf<'/v1/auth/exchange'>();
    expectTypeOf(AUTH_ROUTES.refresh).toEqualTypeOf<'/v1/auth/refresh'>();
    expectTypeOf(AUTH_ROUTES.logout).toEqualTypeOf<'/v1/auth/logout'>();
    expectTypeOf(AUTH_ROUTES).toEqualTypeOf<
      Readonly<{ readonly exchange: '/v1/auth/exchange'; readonly refresh: '/v1/auth/refresh'; readonly logout: '/v1/auth/logout' }>
    >();
  });
});
