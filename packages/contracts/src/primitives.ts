import { z } from 'zod';

/**
 * Code points invisíveis ou de controle usados em ocultação de prompt injection
 * ("ASCII smuggling" com Tag characters, zero-width, bidi/Trojan Source, variation
 * selectors). Nenhum texto que sai da API pode contê-los.
 * Regra: regexes compartilhadas NUNCA usam as flags `g`/`y` (lastIndex com estado).
 */
export const INVISIBLE_OR_CONTROL =
  /[\u0000-\u001F\u007F-\u009F­؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ￹-￻\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

/** Mesmo conjunto, mas tolerando quebra de linha (\n) — para textos multilinha do usuário. */
export const INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE =
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F­؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ￹-￻\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

const HTML_ANGLE_BRACKETS = /[<>]/;

/**
 * Padrões "parecidos com link". Política (Blueprint §8, Ameaça 1): nenhum campo de
 * saída aceita URL. Lista deliberadamente sem TLDs que colidem com nomes de
 * tecnologia (.js, .io, .net, .ai, .dev, .app): "Node.js", "Socket.io", "ASP.NET"
 * passam; a defesa final é a UI nunca linkificar texto (renderização textual React).
 * Todos os padrões são lineares (sem quantificadores aninhados) — anti-ReDoS.
 */
export const URL_LIKE_PATTERNS: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]{0,30}:\/\//i, // esquema://
  /\b(?:javascript|data|vbscript|file|blob|mailto|tel):/i, // esquemas sem //
  /\bwww\d{0,3}\./i, // www.
  /\b[a-z0-9-]{1,63}\.[a-z]{2,24}\//i, // dominio.tld/caminho
  /\b[a-z0-9-]{1,63}\.(?:com|org|br|info|biz|xyz|top|click|link|online|site|live|shop|me|ly|gl|gd|to|cc|ru|cn|tk|ml|ga|cf|gq|zip|mov)\b/i, // domínio nu com TLD de risco
  /\]\(/, // link markdown [texto](alvo)
  /[a-z0-9._%+-]@[a-z0-9-]{1,63}\.[a-z]/i, // e-mail (PII + canal de contato)
];

export function containsUrlLike(value: string): boolean {
  return URL_LIKE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Texto curto seguro para qualquer string que a API emite ou persiste:
 * sem caracteres invisíveis/controle, sem `<`/`>`, sem nada parecido com link.
 * `multiline` libera apenas `\n` (ex.: observações do usuário).
 */
export function safeText(max: number, options: { multiline?: boolean } = {}) {
  const invisible = options.multiline === true ? INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE : INVISIBLE_OR_CONTROL;
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !invisible.test(s), { error: 'caractere_invisivel_ou_controle' })
    .refine((s) => !HTML_ANGLE_BRACKETS.test(s), { error: 'marcacao_html_proibida' })
    .refine((s) => !containsUrlLike(s), { error: 'url_proibida' });
}

/** Nome canônico de tecnologia: "TypeScript", "C#", "C++", "Node.js", ".NET", "CI/CD", "Power BI". */
export const TECH_TAG_PATTERN = /^[\p{L}\p{N}.][\p{L}\p{N} +#.\/_-]{0,39}$/u;

export const TechTagSchema = z
  .string()
  .trim()
  .regex(TECH_TAG_PATTERN)
  .refine((s) => !containsUrlLike(s), { error: 'url_proibida' });

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Versões de motor/extrator/prompt: "engine-1.0.0", "jf-p3-s1". */
export const VersionTagSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,31}$/);

/** Array sem duplicatas (comparação exata). */
export function uniqueArray<T extends z.ZodType>(item: T, max: number, min = 0) {
  return z
    .array(item)
    .min(min)
    .max(max)
    .refine((arr) => new Set(arr).size === arr.length, { error: 'itens_duplicados' });
}

/** Lista de TechTags sem duplicatas, comparando sem diferenciar maiúsculas. */
export function techTagList(max: number) {
  return z
    .array(TechTagSchema)
    .max(max)
    .refine((arr) => new Set(arr.map((t) => t.toLowerCase())).size === arr.length, {
      error: 'itens_duplicados',
    });
}

/**
 * Corta em `max` CODE POINTS, a mesma unidade de `.min()/.max()` de string no zod >= 4.5
 * (emoji conta 1). Antes, troca surrogates órfãos por U+FFFD (`toWellFormed`): evita que
 * metades soltas se recombinem em Tag characters depois de uma remoção (ASCII smuggling).
 */
export function truncateCodePoints(value: string, max: number): string {
  const wellFormed = value.toWellFormed();
  let count = 0;
  let end = 0;
  for (const codePoint of wellFormed) {
    if (count === max) return wellFormed.slice(0, end);
    count += 1;
    end += codePoint.length;
  }
  return wellFormed;
}
