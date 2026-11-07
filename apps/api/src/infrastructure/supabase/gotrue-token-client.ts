// Cliente do GoTrue (Supabase Auth) do BFF da extensão (ADR-004 D4, "Peças novas"; ADR-018 D5). Sem SDK, no
// modelo do postgrest-user-client: a chave *publishable* no `apikey`, URL fixa derivada de `SUPABASE_URL` (nada do
// cliente vira URL, T19), `redirect: "error"`, prazo de 5 s, resposta com no máximo 32 KiB e **sem retry** (a nova
// tentativa da renovação é do caso de uso, D4 passo 6).
//
// Lista fechada de cabeçalhos de saída (condição 2 do `[APPSEC]` no §6.3): `apikey`, `content-type` e `accept` e,
// só no logout, `authorization` com o Bearer do próprio usuário. A interface não recebe cabeçalho nenhum, então
// `X-Forwarded-For`, `X-Real-IP`, `Forwarded` e qualquer cabeçalho do cliente não têm como chegar ao GoTrue: um
// IP forjado faria o limite por IP do Supabase contar contra outro balde (T43, *Egress Budget Drain*).
//
// Classificação (D7, com a emenda do HITL-035): 400, 401, 403 e 422 são `recusado`; o 404 só é `recusado` com o
// corpo JSON do GoTrue e um `error_code` string, que é conferido e descartado (nunca sai daqui nem vai a log); no
// logout, o 403 com `error_code` exato `session_not_found` é sessão já encerrada (contrato do 07h);
// conexão recusada, redirecionamento, 429, 5xx e os demais status são `nao_recebido`; prazo, socket cortado depois
// do envio e 200 fora da forma são `pode_ter_rotacionado`. Do 200, só os 4 campos do D4 passo 5 são projetados,
// um a um. Nunca rejeita, e nada da chave, dos tokens, do código, do verifier ou da resposta vai para mensagem.
import { AccessTokenSchema, AuthCodeSchema, PkceVerifierSchema } from "@trampo/contracts/auth";
import { ACCESS_TOKEN_MAX_CHARS } from "@trampo/contracts/limits";
import { z } from "zod";

import { parseJsonWithoutPrototypeKeys } from "../../application/llm/llm-output-guard.js";
import type {
  AuthLogoutResult,
  AuthTokenFailure,
  AuthTokenGateway,
  AuthTokenResult,
  AuthTokens,
} from "../../application/ports/auth-token-gateway.js";
import { decodeUtf8, readCapped } from "../llm/llm-http.js";

export const GOTRUE_CLIENT_POLICY = {
  /** Prazo de cada chamada (D4 passo 4). Cobre a resposta inteira, corpo incluído. */
  timeoutMs: 5_000,
  maxResponseBytes: 32 * 1024,
  /** O teto do contrato (ADR-013 D3), da fonte única. */
  accessTokenMaxChars: ACCESS_TOKEN_MAX_CHARS,
  /** O mesmo teto do RefreshSealer (`string(1..512)` do D5): um refresh maior não seria selado. */
  refreshTokenMaxChars: 512,
  /** Os únicos cabeçalhos que o adapter põe, na ordem. Fora estes, só os de transporte do próprio fetch. */
  outboundHeaders: {
    token: Object.freeze(["apikey", "content-type", "accept"] as const),
    logout: Object.freeze(["apikey", "authorization", "accept"] as const),
  },
} as const;

export interface GotrueTokenClientConfig {
  /** Origem do projeto (a mesma `SUPABASE_URL` do JWT, ADR-013 D6). */
  readonly url: URL;
  readonly publishableKey: string;
  /** Só para os testes encurtarem o prazo. */
  readonly timeoutMs?: number;
}

/** Mensagem fixa: nunca repete a chave recebida. */
export class GotrueClientConfigError extends Error {
  constructor() {
    super("SUPABASE_PUBLISHABLE_KEY precisa ser uma chave publishable (sb_publishable_...); secret e legada são recusadas");
    this.name = "GotrueClientConfigError";
  }
}

// Lista positiva, como no postgrest-user-client: a secret (`sb_secret_`) e a legada (`eyJ`) caem na recusa.
const PUBLISHABLE_KEY = /^sb_publishable_[\w-]{1,256}$/;
const RefreshTokenSchema = z.string().min(1).max(GOTRUE_CLIENT_POLICY.refreshTokenMaxChars);

/** O 200 do GoTrue. `z.object` aceita as chaves extras (`user`, `provider_token`…), que a projeção descarta. */
const TokenResponseSchema = z.object({
  access_token: AccessTokenSchema,
  refresh_token: RefreshTokenSchema,
  expires_in: z.int().positive(),
  token_type: z.literal("bearer"),
});
/** O corpo de erro do GoTrue que transforma um 404 em recusa. O valor do `error_code` nunca é guardado. */
const GotrueErrorSchema = z.object({ error_code: z.string() });
/**
 * O 403 do logout com JWT válido de sessão que já não existe (`requireAuthentication` do GoTrue; conferido no
 * contrato do 07h, que trocou a hipótese do 401). Só este código, exato: o `bad_jwt` e o resto do 403 seguem recusa.
 */
const SessionGoneSchema = z.object({ error_code: z.literal("session_not_found") });

const RECUSADO: AuthTokenFailure = Object.freeze({ ok: false, reason: "recusado" });
const NAO_RECEBIDO: AuthTokenFailure = Object.freeze({ ok: false, reason: "nao_recebido" });
const PODE_TER_ROTACIONADO: AuthTokenFailure = Object.freeze({ ok: false, reason: "pode_ter_rotacionado" });
const LOGGED_OUT: AuthLogoutResult = Object.freeze({ ok: true });

/** Status de recusa que valem sem corpo. O 404 é à parte (precisa do corpo do GoTrue). */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 422]);
/** Falhas do fetch que provam que o pedido não saiu: nada chegou a ser conectado. */
const NOT_CONNECTED_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);
/** Mensagem do undici para o 3xx com `redirect: "error"`; o teste em socket real a prende. */
const REDIRECT_REFUSED = "unexpected redirect";

/** `application/json`, com ou sem parâmetros. */
function isJson(contentType: string | null): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * O fetch rejeitou: só é `nao_recebido` quando a conexão nem abriu ou quando a resposta foi um redirecionamento.
 * Qualquer outra coisa (prazo, aborto, socket fechado) pode ter acontecido depois do envio.
 */
function failureForFetchError(error: unknown): AuthTokenFailure {
  const cause = error instanceof Error ? error.cause : undefined;
  if (!(cause instanceof Error)) return PODE_TER_ROTACIONADO;
  const code = (cause as NodeJS.ErrnoException).code;
  if (code !== undefined && NOT_CONNECTED_CODES.has(code)) return NAO_RECEBIDO;
  return cause.message === REDIRECT_REFUSED ? NAO_RECEBIDO : PODE_TER_ROTACIONADO;
}

/** Descarta o corpo sem ler. O `cancel` de um stream que já falhou rejeita, e isso não muda a classificação. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // O corpo já morreu; não há o que soltar.
  }
}

/** JSON da resposta com teto, UTF-8 estrito e sem chaves de protótipo; `undefined` em qualquer desvio. */
async function readJson(response: Response): Promise<unknown> {
  if (response.body === null || !isJson(response.headers.get("content-type"))) {
    await discard(response);
    return undefined;
  }
  const bytes = await readCapped(response.body, GOTRUE_CLIENT_POLICY.maxResponseBytes);
  const text = bytes === null ? null : decodeUtf8(bytes);
  if (text === null) return undefined;
  const json = parseJsonWithoutPrototypeKeys(text);
  return json.ok ? json.value : undefined;
}

/** O 404 só é recusa com o corpo do GoTrue; sem ele (HTML, vazio, rota ou proxy errado), o GoTrue não recebeu. */
async function classify404(response: Response): Promise<AuthTokenFailure> {
  try {
    return GotrueErrorSchema.safeParse(await readJson(response)).success ? RECUSADO : NAO_RECEBIDO;
  } catch {
    return NAO_RECEBIDO;
  }
}

/** Logout com 403: a sessão já não existe (`session_not_found`, D7 idempotente) ou recusa. */
async function logoutFor403(response: Response): Promise<AuthLogoutResult> {
  try {
    return SessionGoneSchema.safeParse(await readJson(response)).success ? LOGGED_OUT : RECUSADO;
  } catch {
    return RECUSADO;
  }
}

/** Status que não é sucesso. O corpo só é lido no 404 (e no 403 do logout, à parte). */
async function failureForStatus(response: Response): Promise<AuthTokenFailure> {
  if (response.status === 404) return classify404(response);
  await discard(response);
  return REFUSAL_STATUSES.has(response.status) ? RECUSADO : NAO_RECEBIDO;
}

/** O 200 de token, projetado campo a campo (D4 passo 5). Qualquer desvio: o GoTrue processou e a resposta se perdeu. */
async function tokensFrom(response: Response): Promise<AuthTokenResult> {
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
    const tokens: AuthTokens = {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresIn: parsed.data.expires_in,
      tokenType: "bearer",
    };
    return { ok: true, tokens };
  } catch {
    // Socket cortado ou prazo no meio do corpo.
    return PODE_TER_ROTACIONADO;
  }
}

export function createGotrueTokenClient(config: GotrueTokenClientConfig): AuthTokenGateway {
  if (!PUBLISHABLE_KEY.test(config.publishableKey)) throw new GotrueClientConfigError();
  const { publishableKey } = config;
  const timeoutMs = config.timeoutMs ?? GOTRUE_CLIENT_POLICY.timeoutMs;
  // URL fixa, montada uma vez: o caminho absoluto descarta qualquer caminho da base.
  const pkceEndpoint = new URL("/auth/v1/token?grant_type=pkce", config.url);
  const refreshEndpoint = new URL("/auth/v1/token?grant_type=refresh_token", config.url);
  const logoutEndpoint = new URL("/auth/v1/logout?scope=global", config.url);

  /** Uma chamada, sem retry. Com o signal já abortado, o pedido nem sai (`nao_recebido`); falha do fetch já vem classificada. */
  const post = async (
    endpoint: URL,
    headers: Readonly<Record<string, string>>,
    body: string | null,
    signal: AbortSignal | undefined,
  ): Promise<Response | AuthTokenFailure> => {
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

  const tokenHeaders = { apikey: publishableKey, "content-type": "application/json", accept: "application/json" } as const;

  const tokenCall = async (endpoint: URL, body: string, signal: AbortSignal | undefined): Promise<AuthTokenResult> => {
    const response = await post(endpoint, tokenHeaders, body, signal);
    return response instanceof Response ? tokensFrom(response) : response;
  };

  return {
    async exchangePkce(authCode, codeVerifier, signal) {
      if (!AuthCodeSchema.safeParse(authCode).success || !PkceVerifierSchema.safeParse(codeVerifier).success) return NAO_RECEBIDO;
      // Um nome só (pré-spike, P7): `code` seria recusado, e uma 2ª chamada com ele não existe.
      return tokenCall(pkceEndpoint, JSON.stringify({ auth_code: authCode, code_verifier: codeVerifier }), signal);
    },

    async refresh(refreshToken, signal) {
      if (!RefreshTokenSchema.safeParse(refreshToken).success) return NAO_RECEBIDO;
      return tokenCall(refreshEndpoint, JSON.stringify({ refresh_token: refreshToken }), signal);
    },

    async logout(accessToken, signal) {
      // Token fora da forma nem sai daqui (e nunca vira cabeçalho com quebra de linha).
      if (!AccessTokenSchema.safeParse(accessToken).success) return NAO_RECEBIDO;
      const headers = { apikey: publishableKey, authorization: `Bearer ${accessToken}`, accept: "application/json" } as const;
      const response = await post(logoutEndpoint, headers, null, signal);
      if (!(response instanceof Response)) return response;
      // 2xx, ou 401 de sessão já revogada: a sessão não está mais viva (D4 passo 3). O corpo não é lido.
      if ((response.status >= 200 && response.status <= 299) || response.status === 401) {
        await discard(response);
        return LOGGED_OUT;
      }
      // O GoTrue real responde 403 `session_not_found` ao logout repetido (contrato do 07h): também encerrada.
      if (response.status === 403) return logoutFor403(response);
      return failureForStatus(response);
    },
  };
}
