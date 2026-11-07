// Adapter da porta AccessTokenVerifier (ADR-013): jose com o JWKS remoto do Supabase Auth, ES256 fixo, e
// falha fechado. Único módulo da API que importa jose. Nenhuma claim além de `sub` e `session_id` sai daqui,
// e nada é logado (SR-12).
import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type FetchImplementation,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

import type { AccessTokenVerification, AccessTokenVerifier } from "../../application/ports/access-token-verifier.js";

import type { AmrMethod } from "./allowed-amr-env.js";

/** ADR-013 D4 e D5. Valores em código, sem variável de ambiente (um botão a menos para errar). */
export const JWT_POLICY = {
  algorithm: "ES256",
  type: "JWT",
  audience: "authenticated",
  role: "authenticated",
  clockToleranceSeconds: 10,
  /** O mesmo prazo do JWT no Supabase (HITL-004). Token mais velho é recusado mesmo com `exp` maior. */
  maxTokenAgeSeconds: 900,
} as const;

export interface JwksTimings {
  readonly timeoutMs: number;
  readonly cacheMaxAgeMs: number;
  /** Intervalo mínimo entre buscas: um `kid` desconhecido não vira inundação no Supabase. */
  readonly cooldownMs: number;
  /** Teto da resposta do JWKS, conferido durante a leitura. */
  readonly maxBytes: number;
}

export const JWKS_TIMINGS: JwksTimings = {
  timeoutMs: 3_000,
  cacheMaxAgeMs: 600_000,
  cooldownMs: 30_000,
  maxBytes: 64 * 1024,
};

export interface JoseAccessTokenVerifierConfig {
  /** `${SUPABASE_URL}/auth/v1`. */
  readonly issuer: string;
  /** `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, validada no main.ts (ADR-013 D6). */
  readonly jwksUrl: URL;
  /**
   * Métodos de autenticação aceitos no `amr` (ADR-004 D6), vindos do `readAllowedAmr`. Obrigatório: o adapter não
   * tem padrão próprio.
   */
  readonly allowedAmr: readonly [AmrMethod, ...AmrMethod[]];
  /** Só para os testes encurtarem os prazos. Produção usa JWKS_TIMINGS. */
  readonly jwks?: Partial<JwksTimings>;
}

/**
 * Claims conferidas depois da assinatura. `aud` precisa ser a string (o jose aceita um array que a contenha),
 * e `is_anonymous` ausente também é recusado (ADR-013 D4).
 *
 * `amr` (emenda do ADR-004 D6): o formato do GoTrue, lista de `{ method, timestamp }`, não vazia e com TODO método
 * na lista permitida. Uma sessão que misture `oauth` com outro método é recusada, e a forma do RFC 8176 (lista de
 * strings) também, até o P9 confirmar o token real.
 */
function claimsSchema(allowedAmr: readonly [AmrMethod, ...AmrMethod[]]) {
  return z.object({
    sub: z.uuid(),
    aud: z.literal(JWT_POLICY.audience),
    role: z.literal(JWT_POLICY.role),
    is_anonymous: z.literal(false),
    session_id: z.uuid().optional(),
    amr: z.array(z.object({ method: z.enum(allowedAmr) })).min(1),
  });
}

/** Falha do lado das chaves (rede, timeout, status, JSON, JWKS vazio ou sem ES256): vira 503, não 401. */
class KeysUnavailableError extends Error {}
/** Header sem `kid`: recusado antes de consultar o JWKS. */
class MissingKeyIdError extends Error {}

const INVALID: AccessTokenVerification = { ok: false, reason: "token_invalido" };
const UNAVAILABLE: AccessTokenVerification = { ok: false, reason: "chaves_indisponiveis" };

/** Há ao menos uma chave capaz de verificar ES256? Sem ela o projeto ainda assina com o segredo HS256. */
export function hasSigningKey(jwks: JSONWebKeySet | undefined): boolean {
  return (
    jwks?.keys.some(
      (key) =>
        key.kty === "EC" &&
        key.crv === "P-256" &&
        (key.alg === undefined || key.alg === JWT_POLICY.algorithm) &&
        (key.use === undefined || key.use === "sig"),
    ) ?? false
  );
}

/** fetch que lê o corpo com teto de bytes. O `signal` do jose (timeout) também interrompe a leitura. */
function cappedFetch(maxBytes: number): FetchImplementation {
  return async (url, options) => {
    const response = await fetch(url, options);
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body !== null) {
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        // Sair do for-await cancela o stream: o resto da resposta não é lido.
        if (total > maxBytes) throw new KeysUnavailableError();
        chunks.push(chunk);
      }
    }
    return new Response(total === 0 ? null : Buffer.concat(chunks), {
      status: response.status,
      headers: response.headers,
    });
  };
}

export function createJoseAccessTokenVerifier(config: JoseAccessTokenVerifierConfig): AccessTokenVerifier {
  const timings: JwksTimings = { ...JWKS_TIMINGS, ...config.jwks };
  const ClaimsSchema = claimsSchema(config.allowedAmr);
  const remote = createRemoteJWKSet(config.jwksUrl, {
    timeoutDuration: timings.timeoutMs,
    cacheMaxAge: timings.cacheMaxAgeMs,
    cooldownDuration: timings.cooldownMs,
    [customFetch]: cappedFetch(timings.maxBytes),
  });

  // O jose só chama a chave DEPOIS de conferir o algoritmo: `none` e HS256 nunca chegam aqui.
  const getKey: JWTVerifyGetKey = async (header, token) => {
    if (typeof header.kid !== "string" || header.kid.length === 0) throw new MissingKeyIdError();
    try {
      return await remote(header, token);
    } catch (error) {
      // Chave ES256 existe, mas nenhuma casa com o `kid` (depois da nova busca do jose): o token é que está errado.
      if (error instanceof errors.JWKSNoMatchingKey && hasSigningKey(remote.jwks())) throw error;
      throw new KeysUnavailableError();
    }
  };

  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, getKey, {
          algorithms: [JWT_POLICY.algorithm],
          typ: JWT_POLICY.type,
          // `iss` ausente já falha pelo `issuer`, `iat` pelo `maxTokenAge`, e `aud`, `sub` e `role` pelo
          // ClaimsSchema (que também exige `aud` como string). Só o `exp` o jose não exige sozinho.
          issuer: config.issuer,
          requiredClaims: ["exp"],
          clockTolerance: JWT_POLICY.clockToleranceSeconds,
          maxTokenAge: JWT_POLICY.maxTokenAgeSeconds,
        });
        const claims = ClaimsSchema.safeParse(payload);
        if (!claims.success) return INVALID;
        return { ok: true, principal: { userId: claims.data.sub, sessionId: claims.data.session_id ?? null } };
      } catch (error) {
        return error instanceof KeysUnavailableError ? UNAVAILABLE : INVALID;
      }
    },
    // P15 (ADR-004 D6): o próprio RemoteJWKSet responde sem token. Mesmo cache e mesmas regras do verify: com o
    // cache vencido, busca de novo, e o JWKS fora do ar dá false mesmo com a chave antiga na memória (ADR-013 D5).
    async keysReady() {
      try {
        if (!remote.fresh) await remote.reload();
        return hasSigningKey(remote.jwks());
      } catch {
        return false;
      }
    },
  };
}
