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

/**
 * Teto dos critérios do usuário em bytes UTF-8 do `JSON.stringify` do valor já parseado (ADR-021 D3).
 * O pior caso latino tem ~7,2 KB; o pior caso com caracteres de 4 bytes passaria de 16 KiB e seria
 * recusado pelo `check (pg_column_size(criteria) <= 16384)` do banco (ADR-018 D2). Com 12 KiB, o
 * contrato recusa antes o que o banco recusaria, e o `jsonb` cabe com folga (prova no `test:db`).
 */
export const USER_CRITERIA_MAX_JSON_BYTES = 12_288;

/**
 * `bodyLimit` da rota `PUT /v1/criteria` (ADR-021 D3): os 12 KiB do contrato mais espaços e quebras
 * de linha de um JSON formatado. Um cliente que escape todo caractere não ASCII em `\uXXXX` pode
 * receber 413 com um perfil válido; o portal usa `JSON.stringify`, que não escapa.
 */
export const CRITERIA_BODY_MAX_BYTES = 16_384;

/**
 * Teto do access token do Supabase (JWS compacto, só ASCII), conferido antes de qualquer parse ou
 * verificação (ADR-013 D3). Fonte única do valor (ADR-004 D7). Hoje só o `AccessTokenSchema` importa
 * daqui; a borda da API, o `CriteriaGuard` e o cliente do PostgREST trocam os seus literais por este
 * import na F1-API-07 (ADR-004 §6.1).
 */
export const ACCESS_TOKEN_MAX_CHARS = 8_192;

/**
 * Teto de linhas de cada lista da exportação da conta (ADR-029 D4): as 500 mais novas, com a marca de corte no
 * próprio arquivo. A paginação entra com a F1-API-06, que passa a gravar as análises.
 */
export const ACCOUNT_EXPORT_MAX_ROWS = 500;

/** `bodyLimit` do `POST /v1/account/delete` (ADR-029 D3): o corpo é a versão e a frase de confirmação. */
export const ACCOUNT_DELETE_BODY_MAX_BYTES = 256;

/**
 * Idade máxima da sessão para excluir a conta (ADR-029 D6). Quem decide é a função do banco, pela data da sessão
 * do token; o `test:db` prende a constante dela a este valor, e o portal só o espelha para avisar antes.
 */
export const ACCOUNT_RECENT_LOGIN_SECONDS = 600;

/**
 * Retenção das análises gravadas (ADR-031 D3): a função agendada do banco apaga as mais velhas que isto, e o feedback
 * vai junto. O `test:db` prende a constante da migration a este valor.
 */
export const ANALYSES_RETENTION_DAYS = 90;

/**
 * Teto de análises gravadas por usuário em 24 horas corridas (ADR-031 D2), aplicado por um gatilho do banco: o dono
 * também grava direto no PostgREST com o próprio JWT. O dobro da cota diária, para o uso legítimo nunca chegar nele;
 * o `test:db` prende a constante da migration a este valor.
 */
export const ANALYSES_DAILY_ROW_CAP = 100;

/** `bodyLimit` do `POST /v1/analyses/:analysisId/feedback` (ADR-031 D4): o corpo é o acordo e o motivo. */
export const ANALYSIS_FEEDBACK_BODY_MAX_BYTES = 256;
