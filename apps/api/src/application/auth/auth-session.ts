// Peças comuns da troca e da renovação do BFF (ADR-004 D4, troca, passos 6 a 8, e renovação, passos 7 e 8): o
// resultado dos casos de uso, em união discriminada que a rota (07g) mapeia para HTTP pelo D7, e a emissão da sessão
// depois do GoTrue: verificação antes de repassar (D6), política dos 900 s sem *clamp* silencioso e selagem do
// refresh (D5). Código puro: só as portas injetadas, sem HTTP nem framework. Nada daqui lança ou rejeita, e o caso de
// uso não confia nas portas: exceção ou rejeição de uma delas é falha fechada (ADR-014 §3, restrição 2).
import { AUTH_SCHEMA_VERSION, AuthSessionResponseSchema, type AuthSessionResponse } from "@trampo/contracts/auth";

import type { AccessTokenVerification, AccessTokenVerifier } from "../ports/access-token-verifier.js";
import type { AuthTokens } from "../ports/auth-token-gateway.js";
import type { RefreshSealer, RefreshSealResult, SealedSession } from "../ports/refresh-sealer.js";

import type { EgressCall, EgressOutcome, GotrueEgress } from "./gotrue-egress.js";

/** O JWT do Supabase dura 900 s (HITL-004): teto do `expires_in`, do `exp − iat` e do `expiresIn` da resposta. */
export const ACCESS_TOKEN_LIFETIME_MAX_SECONDS = 900;

/** 401 `NAO_AUTENTICADO` (D7). Cada motivo é uma mensagem do catálogo de log do D8 item 7. */
export type AuthRejectionReason =
  | "auth_troca_recusada"
  | "auth_renovacao_recusada"
  | "auth_envelope_invalido"
  | "auth_sessao_idade_maxima"
  | "auth_sessao_inativa";

/** 503 `SERVICO_INDISPONIVEL` (D7). Idem. */
export type AuthUnavailableReason = "auth_chaves_indisponiveis" | "auth_provedor_indisponivel" | "auth_token_fora_da_politica";

export interface AuthRejected {
  readonly kind: "nao_autenticado";
  readonly reason: AuthRejectionReason;
}

export interface AuthUnavailable {
  readonly kind: "indisponivel";
  readonly reason: AuthUnavailableReason;
  /** O da negação do orçamento ou do *bulkhead* (D8 item 5); `null` quando a falha não veio deles. */
  readonly retryAfterSeconds: number | null;
}

/** 400 `PAYLOAD_INVALIDO`: a entrada fora do contrato. A borda (07g) barra antes; aqui é a segunda trava. */
export interface AuthInvalidInput {
  readonly kind: "entrada_invalida";
}

export interface AuthSessionIssued {
  readonly kind: "sessao";
  /** Exatamente as 4 chaves do contrato, reparseadas pelo `AuthSessionResponseSchema`. */
  readonly session: AuthSessionResponse;
}

/** Resultado da troca e da renovação: 200, 401, 503 ou 400. */
export type AuthSessionOutcome = AuthSessionIssued | AuthRejected | AuthUnavailable | AuthInvalidInput;

export const INVALID_INPUT: AuthInvalidInput = { kind: "entrada_invalida" };

export function rejected(reason: AuthRejectionReason): AuthRejected {
  return { kind: "nao_autenticado", reason };
}

export function unavailable(reason: AuthUnavailableReason, retryAfterSeconds: number | null = null): AuthUnavailable {
  return { kind: "indisponivel", reason, retryAfterSeconds };
}

const OUT_OF_POLICY = unavailable("auth_token_fora_da_politica");
const VERIFY_FAILED: AccessTokenVerification = { ok: false, reason: "token_invalido" };

/** Pré-checagem das chaves do JWKS (D6). Qualquer coisa que não seja `true`, inclusive exceção, é "sem chaves". */
export async function keysReady(verifier: AccessTokenVerifier): Promise<boolean> {
  try {
    return (await verifier.keysReady()) === true;
  } catch {
    return false;
  }
}

/**
 * Chama o GoTrue pelo orçamento e pelo *bulkhead* (D8 item 5): é o único caminho dos casos de uso até a porta. A porta
 * promete nunca rejeitar; se rejeitar, a falha não diz se o GoTrue processou, e vira `threw` (sempre um 503).
 */
export async function callGotrue<T>(
  egress: GotrueEgress,
  kind: EgressCall,
  call: () => Promise<T>,
  threw: T,
): Promise<EgressOutcome<T>> {
  try {
    return await egress.run(kind, call);
  } catch {
    return { ok: true, value: threw };
  }
}

async function verifySafely(verifier: AccessTokenVerifier, token: string): Promise<AccessTokenVerification> {
  try {
    return await verifier.verify(token);
  } catch {
    return VERIFY_FAILED;
  }
}

function sealSafely(sealer: RefreshSealer, session: SealedSession, origin: string): RefreshSealResult {
  try {
    return sealer.seal(session, origin);
  } catch {
    return { ok: false };
  }
}

export interface SessionIssueDeps {
  readonly verifier: AccessTokenVerifier;
  readonly sealer: RefreshSealer;
}

export interface SessionIssue {
  /** A resposta do GoTrue, já projetada nos 4 campos pelo adapter. */
  readonly tokens: AuthTokens;
  /** O `Origin` da extensão: entra no AAD do envelope. */
  readonly origin: string;
  /** Relógio de parede, epoch em ms, lido depois da resposta do GoTrue. */
  readonly nowMs: number;
  /**
   * Troca: `null`, a sessão nasce agora (`sst` = agora). Renovação: a sessão do envelope aberto, que o token novo
   * precisa continuar (mesmo `sid`) e cujo início (`sst`) passa adiante sem mudar.
   */
  readonly previous: { readonly sid: string; readonly sst: number } | null;
}

/**
 * Verifica o access novo e sela o refresh (D4, troca, passos 6 a 8; renovação, passos 7 e 8). Qualquer falha da
 * verificação depois do GoTrue é desvio de política, nunca 401 (D6; T30): 503 `auth_token_fora_da_politica`. Só o
 * `sid` divergente da renovação é 401, e o refresh novo é descartado sem selar (sessão órfã, residual do §3).
 */
export async function issueSession(deps: SessionIssueDeps, issue: SessionIssue): Promise<AuthSessionOutcome> {
  const { tokens, previous } = issue;
  const verification = await verifySafely(deps.verifier, tokens.accessToken);
  if (!verification.ok) return OUT_OF_POLICY;
  const sessionId = verification.principal.sessionId;
  if (sessionId === null) return OUT_OF_POLICY;
  if (previous !== null && sessionId !== previous.sid) return rejected("auth_renovacao_recusada");

  const { issuedAt, expiresAt } = verification.lifetime;
  if (tokens.expiresIn > ACCESS_TOKEN_LIFETIME_MAX_SECONDS) return OUT_OF_POLICY;
  if (expiresAt - issuedAt > ACCESS_TOKEN_LIFETIME_MAX_SECONDS) return OUT_OF_POLICY;
  // A idade usa o relógio com milissegundos: o `expiresIn` nunca promete mais vida do que o token tem. O `min()` só
  // desconta a idade; o teto de 900 já foi imposto acima, sem *clamp*.
  const ageSeconds = issue.nowMs / 1_000 - issuedAt;
  const expiresIn = Math.floor(Math.min(tokens.expiresIn, ACCESS_TOKEN_LIFETIME_MAX_SECONDS - ageSeconds));
  if (expiresIn < 1) return OUT_OF_POLICY;

  const nowSeconds = Math.floor(issue.nowMs / 1_000);
  const sealed = sealSafely(
    deps.sealer,
    { rt: tokens.refreshToken, sid: sessionId, sst: previous === null ? nowSeconds : previous.sst, iat: nowSeconds },
    issue.origin,
  );
  if (!sealed.ok) return OUT_OF_POLICY;

  // Campo a campo, nunca por *spread* (M-11), e reparseado: token fora do `AccessTokenSchema`, envelope fora do
  // `SealedRefreshSchema` ou `expiresIn` fora de 1 a 900 também são desvio de política.
  const response = AuthSessionResponseSchema.safeParse({
    schemaVersion: AUTH_SCHEMA_VERSION,
    accessToken: tokens.accessToken,
    refreshToken: sealed.envelope,
    expiresIn,
  });
  return response.success ? { kind: "sessao", session: response.data } : OUT_OF_POLICY;
}
