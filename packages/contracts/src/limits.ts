/**
 * Limites de TRANSPORTE e de FORMA compartilhados entre extensão, portal e API.
 * Nada aqui é regra de avaliação de vaga (pesos, tetos, faixas de veredito vivem
 * exclusivamente no domínio da API — AGENTS.md §1.2).
 */

/**
 * Teto do texto da vaga após o truncamento na borda (AGENTS.md §1.3, Blueprint §4.2).
 * Unidade: CODE POINTS — a mesma de `z.string().max()` no zod >= 4.5 (emoji = 1).
 * O zod é fixado em versão exata no catálogo do pnpm para extensão, portal e API contarem igual.
 */
export const JOB_TEXT_MAX_CHARS = 15_000;

/** Abaixo disso não há vaga para analisar. Hipótese — calibrar no Spike S-2. */
export const JOB_TEXT_MIN_CHARS = 200;

/**
 * Limite do corpo HTTP aplicado pelo servidor ANTES do parse do JSON (Blueprint §4.2).
 * Pior caso legítimo: 15.000 code points x 4 bytes UTF-8 = 60.000 B + envelope < 65.536 B.
 * Pressuposto: o cliente remove caracteres de controle e surrogates órfãos antes de enviar
 * (viram escapes `\uXXXX` de 6 bytes no JSON). Fora disso, 413 é a resposta correta.
 */
export const HTTP_BODY_MAX_BYTES = 65_536;

export const JOB_TITLE_MAX_CHARS = 200;

/** Teto numérico para salários (anti-absurdo; JSON não carrega Infinity, mas carrega 1e308). */
export const SALARY_MAX = 10_000_000;
