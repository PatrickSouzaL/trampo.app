// Troca, renovação e revogação de sessão no Supabase Auth (GoTrue), vistas pela aplicação (ADR-004 D4, "Peças
// novas"). O adapter HTTP fica em infrastructure/supabase. Nenhum método rejeita: toda falha vira um dos três
// motivos, e nada da resposta do GoTrue além dos 4 campos projetados chega aqui (nem o `error_code`, nem `user`,
// nem `provider_token`).

/** Os 4 campos projetados da resposta do GoTrue (D4, troca, passo 5). A política (`expiresIn` ≤ 900) é do caso de uso. */
export interface AuthTokens {
  readonly accessToken: string;
  /** O refresh do Supabase, cru: só a API o vê, e ele sai daqui direto para o RefreshSealer. */
  readonly refreshToken: string;
  /** Segundos, inteiro positivo, como o GoTrue mandou. */
  readonly expiresIn: number;
  readonly tokenType: "bearer";
}

/**
 * Por que a chamada falhou (D4 e D7):
 * - `recusado`: o GoTrue respondeu que não (400, 401, 403 ou 422; o 404 só com o corpo JSON do GoTrue e um
 *   `error_code` string). Vira 401, um único motivo;
 * - `nao_recebido`: o GoTrue não processou (conexão recusada, redirecionamento, 429, 5xx, 404 sem o corpo do
 *   GoTrue, entrada fora da forma). Vira 503, sem nova tentativa;
 * - `pode_ter_rotacionado`: o pedido pode ter sido processado e a resposta se perdeu (prazo, socket cortado,
 *   corpo inválido ou acima do teto). Na renovação, justifica **uma** nova tentativa com o mesmo refresh (07f).
 */
export type AuthTokenFailureReason = "recusado" | "nao_recebido" | "pode_ter_rotacionado";

export interface AuthTokenFailure {
  readonly ok: false;
  readonly reason: AuthTokenFailureReason;
}

export type AuthTokenResult = { readonly ok: true; readonly tokens: AuthTokens } | AuthTokenFailure;

/** Logout: `ok` quando a sessão não está mais viva no GoTrue (2xx, ou 401 de sessão já revogada; D4 passo 3). */
export type AuthLogoutResult = { readonly ok: true } | AuthTokenFailure;

export interface AuthTokenGateway {
  /** `grant_type=pkce` com `{ auth_code, code_verifier }`. Nunca rejeita. */
  exchangePkce(authCode: string, codeVerifier: string, signal?: AbortSignal): Promise<AuthTokenResult>;
  /** `grant_type=refresh_token` com `{ refresh_token }`. Uma chamada só: a nova tentativa é do caso de uso. Nunca rejeita. */
  refresh(refreshToken: string, signal?: AbortSignal): Promise<AuthTokenResult>;
  /** `logout?scope=global` com o Bearer do usuário; o escopo é fixo, o cliente não escolhe. Nunca rejeita. */
  logout(accessToken: string, signal?: AbortSignal): Promise<AuthLogoutResult>;
}
