// Leitura da URL de retorno do `launchWebAuthFlow` (ADR-004 D3 passo 7; SR-18), em falha fechada.
// A URL é dado hostil: nada dela é exibido nem registrado, e o texto de `error` é do atacante.
import { AuthCodeSchema } from "@trampo/contracts/auth";

import { STATE_PARAM } from "./authorize-url";

/**
 * - `ok`: o código, pronto para a troca;
 * - `cancelado`: negação ou cancelamento no IdP (`error` ou `error_code`), `{ false, null }` no painel (D12);
 * - `recusado`: retorno adulterado, `{ false, "ERRO_INTERNO" }` no painel, sem troca (D12).
 */
export type AuthRedirectResult = { readonly ok: true; readonly code: string } | { readonly ok: false; readonly motivo: "cancelado" | "recusado" };

const RECUSADO: AuthRedirectResult = { ok: false, motivo: "recusado" };
const CANCELADO: AuthRedirectResult = { ok: false, motivo: "cancelado" };

/** O fragmento só pode trazer o erro do IdP. Qualquer outra chave, como `access_token`, é *downgrade* para *implicit*. */
const FRAGMENT_KEYS: ReadonlySet<string> = new Set(["error", "error_code", "error_description"]);
const ERROR_KEYS = ["error", "error_code"] as const;

function keysOf(params: URLSearchParams): string[] {
  return [...params.keys()];
}

/**
 * Aceita só `<redirectUri>?code=<código>&st=<state>` (em qualquer ordem, cada um uma vez):
 * - o trecho antes de `?` ou `#` é igual ao `redirectUri`, byte a byte (sem barra final, sem `userinfo`,
 *   sem porta, sem caixa diferente). A raiz do host, destino do Site URL na opção A do D15, é recusada;
 * - o fragmento só pode ter `error`, `error_code` e `error_description`;
 * - `error` ou `error_code` na query ou no fragmento é cancelamento, sem ecoar o texto;
 * - o `code` casa com o `AuthCodeSchema`, e o `st` é igual ao `state` do fluxo, sempre.
 */
export function parseAuthRedirect(url: string, redirectUri: string, state: string): AuthRedirectResult {
  const cut = url.search(/[?#]/);
  const base = cut === -1 ? url : url.slice(0, cut);
  if (base !== redirectUri || !URL.canParse(url)) return RECUSADO;

  const parsed = new URL(url);
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  if (keysOf(fragment).some((key) => !FRAGMENT_KEYS.has(key))) return RECUSADO;

  const query = parsed.searchParams;
  if (ERROR_KEYS.some((key) => query.has(key) || fragment.has(key))) return CANCELADO;

  // Duas chaves, um `code` que passa no schema (ausente é `null` e falha) e um `st` igual ao state
  // (ausente é `null` e difere): sobra exatamente `{ code, st }`, cada um uma vez.
  if (keysOf(query).length !== 2) return RECUSADO;
  const code = AuthCodeSchema.safeParse(query.get("code"));
  if (!code.success || query.get(STATE_PARAM) !== state) return RECUSADO;
  return { ok: true, code: code.data };
}
