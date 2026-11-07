import { z } from 'zod';
import { ACCESS_TOKEN_MAX_CHARS } from './limits.js';

/**
 * Contratos do BFF de autenticação da extensão (ADR-004 D4 e D7). O Service Worker troca o código do
 * PKCE e renova a sessão só pela API; o painel e o extrator nunca veem nada daqui (ADR-004 D10).
 * Nenhum código de erro novo: as rotas respondem com o `ApiErrorCodeSchema` de sempre (ADR-004 D7).
 */
export const AUTH_SCHEMA_VERSION = 1 as const;

/**
 * `bodyLimit` das 3 rotas de auth, aplicado antes do parse (ADR-004 D4). O pior caso de cada pedido
 * (código e verifier de 128, ou o envelope de 1.084 caracteres) cabe com folga.
 */
export const AUTH_BODY_MAX_BYTES = 2_048;

/** Caminhos exatos das rotas do BFF (ADR-004 D4). A API compara pelo padrão registrado, nunca por prefixo (D8 item 1). */
export const AUTH_ROUTES = Object.freeze({
  exchange: '/v1/auth/exchange',
  refresh: '/v1/auth/refresh',
  logout: '/v1/auth/logout',
} as const);

/**
 * Access token do Supabase como JWS compacto: três partes base64url, nenhuma vazia (recusa o JWS sem
 * assinatura; quem confere o `alg` e a assinatura é a API, ADR-013 D4). A extensão o trata como opaco e
 * nunca lê as claims (ADR-004 D9). No zod, o `.max()` não interrompe os checks seguintes: ele não é
 * pré-filtro de custo, e quem corta o tamanho antes é o `bodyLimit` da rota.
 */
export const AccessTokenSchema = z.string().max(ACCESS_TOKEN_MAX_CHARS).regex(/^[\w-]+\.[\w-]+\.[\w-]+$/);

/** `code_verifier` do RFC 7636 §4.1: de 43 a 128 caracteres *unreserved*. O SW gera 43 em base64url (ADR-004 D3). */
export const PkceVerifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);

/**
 * Código de autorização do GoTrue, conferido antes da rede (ADR-004 D4, troca, passo 1). O pré-spike
 * do HITL-035 não anotou o formato (`code_e_uuid`): a forma larga fica, e o aperto para UUID espera essa
 * anotação (HITL-036 item 3 ou spike S-3), junto com os canários `CANARIO-CODE-*` do E2E (ADR-004 §4.4).
 */
export const AuthCodeSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9-]+$/);

/**
 * Envelope AES-256-GCM do refresh do Supabase, que só a API abre (ADR-004 D5):
 * `r1.<kid>.<iv>.<cifrado>.<tag>`, com IV de 96 bits (16 caracteres), tag de 128 bits (22) e no
 * máximo 768 bytes de texto claro (1.024). O pior caso tem 1.084 caracteres. Este schema confere só a
 * forma; a base64url canônica de cada parte e a autenticidade são do `open` da API.
 */
export const SealedRefreshSchema = z
  .string()
  .max(1_100)
  .regex(/^r1\.[a-z0-9]{1,16}\.[\w-]{16}\.[\w-]{20,1024}\.[\w-]{22}$/);

/** POST /v1/auth/exchange (SW -> API). Rota pública: o PKCE é o controle (ADR-004 D8). */
export const AuthExchangeRequestSchema = z.strictObject({
  schemaVersion: z.literal(AUTH_SCHEMA_VERSION),
  authCode: AuthCodeSchema,
  codeVerifier: PkceVerifierSchema,
});
export type AuthExchangeRequest = z.infer<typeof AuthExchangeRequestSchema>;

/** POST /v1/auth/refresh (SW -> API). Rota pública: o AEAD do envelope é o controle (ADR-004 D8). */
export const AuthRefreshRequestSchema = z.strictObject({
  schemaVersion: z.literal(AUTH_SCHEMA_VERSION),
  refreshToken: SealedRefreshSchema,
});
export type AuthRefreshRequest = z.infer<typeof AuthRefreshRequestSchema>;

/** POST /v1/auth/logout (SW -> API), com Bearer. O escopo `global` é fixo no servidor (ADR-004 D4). */
export const AuthLogoutRequestSchema = z.strictObject({
  schemaVersion: z.literal(AUTH_SCHEMA_VERSION),
});
export type AuthLogoutRequest = z.infer<typeof AuthLogoutRequestSchema>;

/**
 * Resposta 200 da troca e da renovação: exatamente 4 chaves. `provider_token`, `user` e e-mail nunca
 * saem da API (ADR-004 D4, passo 5; SR-22). O refresh vai só selado.
 */
export const AuthSessionResponseSchema = z.strictObject({
  schemaVersion: z.literal(AUTH_SCHEMA_VERSION),
  accessToken: AccessTokenSchema,
  refreshToken: SealedRefreshSchema,
  /** Impõe também no contrato o JWT de 900 s do HITL-004. A API já desconta a idade do token. */
  expiresIn: z.int().min(1).max(900),
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;
