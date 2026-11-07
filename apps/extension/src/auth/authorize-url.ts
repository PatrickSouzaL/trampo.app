// URL do `authorize` do Supabase Auth hospedado (ADR-004 D3 passo 5). Só leva o challenge: o
// verifier nunca sai do Service Worker antes da troca (D9).
import type { AuthProvider } from "../messaging/protocol";

/** Caminho do `getRedirectURL`: o retorno esperado é `https://<id>.chromiumapp.org/auth` (D3 passo 4). */
export const AUTH_REDIRECT_PATH = "auth";

/** Parâmetro da query do `redirect_to` que devolve o `state` (D3 passo 5; P5 aprovado no HITL-035). */
export const STATE_PARAM = "st";

export interface AuthorizeUrlInput {
  /** Origem https exata do projeto Supabase (`TRAMPO_SUPABASE_ORIGIN`, validada no build). */
  readonly supabaseOrigin: string;
  readonly provider: AuthProvider;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
}

/**
 * `${origem}/auth/v1/authorize` com os 4 parâmetros, nesta ordem e codificados um a um. Nenhum
 * `response_type` (o fluxo é só o Authorization Code; nunca *implicit*, D2) e o método fixo em `s256`,
 * a grafia aceita no pré-spike (P4). Origem fora da forma lança, em falha fechada.
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  if (!URL.canParse(input.supabaseOrigin) || new URL(input.supabaseOrigin).origin !== input.supabaseOrigin || !input.supabaseOrigin.startsWith("https://")) {
    throw new Error("TRAMPO_SUPABASE_ORIGIN fora da forma: precisa ser uma origem https exata");
  }
  const redirectTo = `${input.redirectUri}?${STATE_PARAM}=${input.state}`;
  const query = [
    `provider=${encodeURIComponent(input.provider)}`,
    `redirect_to=${encodeURIComponent(redirectTo)}`,
    `code_challenge=${encodeURIComponent(input.challenge)}`,
    "code_challenge_method=s256",
  ].join("&");
  return `${input.supabaseOrigin}/auth/v1/authorize?${query}`;
}
