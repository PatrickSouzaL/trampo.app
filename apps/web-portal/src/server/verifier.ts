// Verificação do access do Supabase no portal (ADR-027 D5), no molde do verificador da API (ADR-013 D4 e D5) e sem
// importá-lo. ES256 fixo, `kid` obrigatório, JWKS do próprio projeto com prazo, cache, cooldown e teto, e falha
// fechada. O portal aceita só login social: todo método do `amr` precisa ser `oauth` (ADR-004 D6), e o
// `session_id` é obrigatório (a sessão do cookie é conferida contra ele). Só `userId`, `sessionId` e `expiresAt`
// saem daqui; nada vai a log (SR-12).
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type FetchImplementation, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

export type AccessVerification =
  | { readonly ok: true; readonly userId: string; readonly sessionId: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: "invalido" | "indisponivel" };

export interface AccessTokenVerifier {
  verify(token: string): Promise<AccessVerification>;
}

export const JWT_POLICY = Object.freeze({
  algorithm: "ES256",
  type: "JWT",
  audience: "authenticated",
  role: "authenticated",
  clockToleranceSeconds: 10,
  maxTokenAgeSeconds: 900,
});

export interface JwksTimings {
  readonly timeoutMs: number;
  readonly cacheMaxAgeMs: number;
  readonly cooldownMs: number;
  readonly maxBytes: number;
}

export const JWKS_TIMINGS: JwksTimings = Object.freeze({ timeoutMs: 3_000, cacheMaxAgeMs: 600_000, cooldownMs: 30_000, maxBytes: 64 * 1024 });

export interface AccessTokenVerifierConfig {
  readonly issuer: string;
  readonly jwksUrl: URL;
  /** Só para os testes encurtarem os prazos. */
  readonly jwks?: Partial<JwksTimings>;
}

/** Depois da assinatura: `aud` string (o jose aceitaria a lista), `is_anonymous` presente e falso, `amr` só `oauth`. */
const ClaimsSchema = z.object({
  sub: z.uuid(),
  aud: z.literal(JWT_POLICY.audience),
  role: z.literal(JWT_POLICY.role),
  is_anonymous: z.literal(false),
  session_id: z.uuid(),
  amr: z.array(z.object({ method: z.literal("oauth") })).min(1),
  exp: z.number(),
});

class KeysUnavailableError extends Error {}
class MissingKeyIdError extends Error {}

const INVALID: AccessVerification = Object.freeze({ ok: false, reason: "invalido" });
const UNAVAILABLE: AccessVerification = Object.freeze({ ok: false, reason: "indisponivel" });

/** Há ao menos uma chave capaz de verificar ES256? */
function hasSigningKey(jwks: JSONWebKeySet): boolean {
  return jwks.keys.some(
    (key) => key.kty === "EC" && key.crv === "P-256" && (key.alg === undefined || key.alg === JWT_POLICY.algorithm) && (key.use === undefined || key.use === "sig"),
  );
}

/** fetch que lê o corpo com teto de bytes. */
function cappedFetch(maxBytes: number): FetchImplementation {
  return async (url, options) => {
    const response = await fetch(url, options);
    const chunks: Uint8Array[] = [];
    let total = 0;
    // O 204 não tem corpo: o JSON vazio falha no jose, e a falha vira "chaves indisponíveis".
    const reader = (response.body ?? new Blob([]).stream()).getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      total += next.value.byteLength;
      if (total > maxBytes) {
        // Se o cancelamento falhar, quem chama já trata a exceção como resposta perdida.
      await reader.cancel();
        throw new KeysUnavailableError();
      }
      chunks.push(next.value);
    }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
  };
}

export function createAccessTokenVerifier(config: AccessTokenVerifierConfig): AccessTokenVerifier {
  const timings: JwksTimings = { ...JWKS_TIMINGS, ...config.jwks };
  const remote = createRemoteJWKSet(config.jwksUrl, {
    timeoutDuration: timings.timeoutMs,
    cacheMaxAge: timings.cacheMaxAgeMs,
    cooldownDuration: timings.cooldownMs,
    [customFetch]: cappedFetch(timings.maxBytes),
  });

  // O jose só chama a chave depois de conferir o algoritmo: `none` e HS256 nunca chegam aqui.
  const getKey: JWTVerifyGetKey = async (header, token) => {
    if (typeof header.kid !== "string" || header.kid.length === 0) throw new MissingKeyIdError();
    try {
      return await remote(header, token);
    } catch (error) {
      // Chave ES256 existe, mas nenhuma casa com o `kid`: o token é que está errado.
      // O `JWKSNoMatchingKey` só sai com o JWKS já carregado.
      if (error instanceof errors.JWKSNoMatchingKey && hasSigningKey(remote.jwks() as JSONWebKeySet)) throw error;
      throw new KeysUnavailableError();
    }
  };

  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, getKey, {
          algorithms: [JWT_POLICY.algorithm],
          typ: JWT_POLICY.type,
          issuer: config.issuer,
          requiredClaims: ["exp"],
          clockTolerance: JWT_POLICY.clockToleranceSeconds,
          maxTokenAge: JWT_POLICY.maxTokenAgeSeconds,
        });
        const claims = ClaimsSchema.safeParse(payload);
        if (!claims.success) return INVALID;
        return { ok: true, userId: claims.data.sub, sessionId: claims.data.session_id, expiresAt: claims.data.exp };
      } catch (error) {
        return error instanceof KeysUnavailableError ? UNAVAILABLE : INVALID;
      }
    },
  };
}
