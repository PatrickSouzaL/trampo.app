// Cliente do GoTrue (Supabase Auth) do servidor do portal (ADR-027 D1). Molde do `gotrue-token-client` da API
// (ADR-004 D4 e D7, com as emendas do HITL-035 e da F1-API-08), reescrito aqui porque o portal não importa a API
// (ADR-001 §10.3). Sem SDK: o `@supabase/ssr` guarda os tokens em cookie legível pelo JS (ADR-027 §1.1, S1).
//
// URL fixa derivada de `SUPABASE_URL` (nada do pedido vira URL), `redirect: "error"`, prazo de 5 s, resposta com no
// máximo 32 KiB, UTF-8 estrito, JSON sem chave de protótipo e sem retry (a nova tentativa da renovação é da sessão).
// Lista fechada de cabeçalhos: `apikey`, `content-type` e `accept` no `/token`; `apikey`, `authorization` e `accept`
// no logout, que tem escopo `local` fixo (ADR-027 D7).
//
// Classificação: 400, 401, 403, 404 e 422 só são `recusado` com o corpo JSON do GoTrue e um `error_code` string, que é
// conferido e descartado. Sem esse corpo, `nao_recebido` (um desvio de configuração não vira "entre de novo", T30). No
// logout, só o 2xx e o 403 `session_not_found` são sessão encerrada. Conexão recusada, redirecionamento, 429, 5xx e os
// demais status são `nao_recebido`; prazo, aborto, socket cortado, 2xx que não é 200 e 200 fora da forma são
// `pode_ter_rotacionado`. Nunca rejeita, e nada da chave, dos tokens, do código, do verifier ou da resposta sai daqui.
import { z } from "zod";

export type GotrueFailureReason = "recusado" | "nao_recebido" | "pode_ter_rotacionado";
export interface GotrueFailure {
  readonly ok: false;
  readonly reason: GotrueFailureReason;
}
export interface GotrueTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}
export type GotrueTokenResult = { readonly ok: true; readonly tokens: GotrueTokens } | GotrueFailure;
export type GotrueLogoutResult = { readonly ok: true } | GotrueFailure;

export interface GotrueClient {
  exchangePkce(authCode: string, codeVerifier: string, signal?: AbortSignal): Promise<GotrueTokenResult>;
  refresh(refreshToken: string, signal?: AbortSignal): Promise<GotrueTokenResult>;
  logout(accessToken: string, signal?: AbortSignal): Promise<GotrueLogoutResult>;
}

export const GOTRUE_POLICY = Object.freeze({
  timeoutMs: 5_000,
  maxResponseBytes: 32 * 1024,
  /** O teto do JWS no contrato do projeto (ADR-013 D3). O teto menor do cookie é da sessão (ADR-027 D3). */
  accessTokenMaxChars: 8_192,
  refreshTokenMaxChars: 512,
});

export interface GotrueClientConfig {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  /** Só para os testes encurtarem o prazo. */
  readonly timeoutMs?: number;
}

const PUBLISHABLE_KEY = /^sb_publishable_[\w-]{1,256}$/;
const AccessTokenSchema = z.string().max(GOTRUE_POLICY.accessTokenMaxChars).regex(/^[\w-]+\.[\w-]+\.[\w-]+$/);
const RefreshTokenSchema = z.string().min(1).max(GOTRUE_POLICY.refreshTokenMaxChars);
/** RFC 7636 §4.1. */
const VerifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
/** A forma larga do código do GoTrue (a mesma do `AuthCodeSchema` do contrato). */
const AuthCodeSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9-]+$/);

/** O 200 do GoTrue; as chaves extras (`user`, `provider_token`…) são descartadas pela projeção. */
const TokenResponseSchema = z.object({
  access_token: AccessTokenSchema,
  refresh_token: RefreshTokenSchema,
  expires_in: z.int().positive(),
  token_type: z.literal("bearer"),
});
const GotrueErrorSchema = z.object({ error_code: z.string() });
const SESSION_GONE = "session_not_found";

const RECUSADO: GotrueFailure = Object.freeze({ ok: false, reason: "recusado" });
const NAO_RECEBIDO: GotrueFailure = Object.freeze({ ok: false, reason: "nao_recebido" });
const PODE_TER_ROTACIONADO: GotrueFailure = Object.freeze({ ok: false, reason: "pode_ter_rotacionado" });
const LOGGED_OUT = Object.freeze({ ok: true } as const);

const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);
const NOT_CONNECTED_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);
/** Mensagem do undici para o 3xx com `redirect: "error"`. */
const REDIRECT_REFUSED = "unexpected redirect";
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * O fetch rejeitou: só é `nao_recebido` quando a conexão nem abriu ou quando a resposta foi um redirecionamento.
 * Qualquer outra coisa (prazo, aborto, socket fechado) pode ter acontecido depois do envio.
 */
function failureForFetchError(error: unknown): GotrueFailure {
  // O fetch do Node sempre rejeita com um Error; o `cause` dele só existe nas falhas de rede.
  const cause: unknown = (error as Error).cause;
  if (!(cause instanceof Error)) return PODE_TER_ROTACIONADO;
  const code = (cause as NodeJS.ErrnoException).code;
  if (code !== undefined && NOT_CONNECTED_CODES.has(code)) return NAO_RECEBIDO;
  return cause.message === REDIRECT_REFUSED ? NAO_RECEBIDO : PODE_TER_ROTACIONADO;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // O corpo já morreu; não há o que soltar.
  }
}

/** Lê no máximo `limit` bytes; `null` se passar (e o resto do stream é cancelado sem ler). */
async function readCapped(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    total += next.value.byteLength;
    if (total > limit) {
      // Se o cancelamento falhar, quem chama já trata a exceção como resposta perdida.
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

/** JSON da resposta com teto, UTF-8 estrito e sem chaves de protótipo; `undefined` em qualquer desvio. */
async function readJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (response.body === null || type !== "application/json") {
    await discard(response);
    return undefined;
  }
  const bytes = await readCapped(response.body, GOTRUE_POLICY.maxResponseBytes);
  if (bytes === null) return undefined;
  try {
    let hostile = false;
    const value: unknown = JSON.parse(STRICT_UTF8.decode(bytes), (key, inner: unknown) => {
      if (PROTOTYPE_KEYS.has(key)) hostile = true;
      return inner;
    });
    return hostile ? undefined : value;
  } catch {
    return undefined;
  }
}

/** O `error_code` do corpo do GoTrue, ou `undefined` sem esse corpo. Nunca sai daqui. */
async function gotrueErrorCode(response: Response): Promise<string | undefined> {
  try {
    const parsed = GotrueErrorSchema.safeParse(await readJson(response));
    return parsed.success ? parsed.data.error_code : undefined;
  } catch {
    return undefined;
  }
}

async function failureForStatus(response: Response): Promise<GotrueFailure> {
  if (REFUSAL_STATUSES.has(response.status)) return (await gotrueErrorCode(response)) === undefined ? NAO_RECEBIDO : RECUSADO;
  await discard(response);
  return NAO_RECEBIDO;
}

async function tokensFrom(response: Response): Promise<GotrueTokenResult> {
  if (response.status !== 200) {
    if (response.status >= 200 && response.status <= 299) {
      await discard(response);
      return PODE_TER_ROTACIONADO;
    }
    return failureForStatus(response);
  }
  try {
    const parsed = TokenResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) return PODE_TER_ROTACIONADO;
    return { ok: true, tokens: { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token, expiresIn: parsed.data.expires_in } };
  } catch {
    // Socket cortado ou prazo no meio do corpo.
    return PODE_TER_ROTACIONADO;
  }
}

export function createGotrueClient(config: GotrueClientConfig): GotrueClient {
  if (!PUBLISHABLE_KEY.test(config.publishableKey)) {
    throw new Error("SUPABASE_PUBLISHABLE_KEY precisa ser uma chave publishable (sb_publishable_...)");
  }
  const { publishableKey } = config;
  const timeoutMs = config.timeoutMs ?? GOTRUE_POLICY.timeoutMs;
  const pkceEndpoint = new URL("/auth/v1/token?grant_type=pkce", config.supabaseUrl);
  const refreshEndpoint = new URL("/auth/v1/token?grant_type=refresh_token", config.supabaseUrl);
  const logoutEndpoint = new URL("/auth/v1/logout?scope=local", config.supabaseUrl);
  const tokenHeaders = { apikey: publishableKey, "content-type": "application/json", accept: "application/json" } as const;

  const post = async (endpoint: URL, headers: Readonly<Record<string, string>>, body: string | null, signal: AbortSignal | undefined): Promise<Response | GotrueFailure> => {
    if (signal?.aborted === true) return NAO_RECEBIDO;
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        // Seguir um redirecionamento levaria o código, o verifier, o refresh ou o Bearer para outro host.
        redirect: "error",
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      return failureForFetchError(error);
    }
  };

  const tokenCall = async (endpoint: URL, body: string, signal: AbortSignal | undefined): Promise<GotrueTokenResult> => {
    const response = await post(endpoint, tokenHeaders, body, signal);
    return response instanceof Response ? tokensFrom(response) : response;
  };

  return {
    async exchangePkce(authCode, codeVerifier, signal) {
      if (!AuthCodeSchema.safeParse(authCode).success || !VerifierSchema.safeParse(codeVerifier).success) return NAO_RECEBIDO;
      // Um nome só (P7 do pré-spike): `code` seria recusado, e uma 2ª chamada não existe.
      return tokenCall(pkceEndpoint, JSON.stringify({ auth_code: authCode, code_verifier: codeVerifier }), signal);
    },

    async refresh(refreshToken, signal) {
      if (!RefreshTokenSchema.safeParse(refreshToken).success) return NAO_RECEBIDO;
      return tokenCall(refreshEndpoint, JSON.stringify({ refresh_token: refreshToken }), signal);
    },

    async logout(accessToken, signal) {
      if (!AccessTokenSchema.safeParse(accessToken).success) return NAO_RECEBIDO;
      const headers = { apikey: publishableKey, authorization: `Bearer ${accessToken}`, accept: "application/json" } as const;
      const response = await post(logoutEndpoint, headers, null, signal);
      if (!(response instanceof Response)) return response;
      if (response.status >= 200 && response.status <= 299) {
        await discard(response);
        return LOGGED_OUT;
      }
      if (response.status === 403) {
        const errorCode = await gotrueErrorCode(response);
        if (errorCode === undefined) return NAO_RECEBIDO;
        return errorCode === SESSION_GONE ? LOGGED_OUT : RECUSADO;
      }
      return failureForStatus(response);
    },
  };
}
