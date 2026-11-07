// Porta do retorno do IdP (ADR-004 D3): abre o `authorize` e devolve a URL de retorno. O adapter de
// produção é o web-auth-flow-source.ts (05a-4), o único arquivo com `browser.identity`; o do E2E e as
// contingências do D14 são outros adapters da mesma porta. O auth-service nunca interpreta a mensagem de
// erro do navegador: qualquer falha vira `{ ok: false }`.

export interface AuthCodeRequest {
  readonly authorizeUrl: string;
  readonly redirectUri: string;
}

export type AuthCodeResult = { readonly ok: true; readonly url: string } | { readonly ok: false };

export interface AuthCodeSource {
  /** `browser.identity.getRedirectURL("auth")` no adapter de produção: `https://<id>.chromiumapp.org/auth` (D3 passo 4). */
  redirectUri(): string;
  /** Nunca rejeita: janela fechada, falha do navegador ou retorno sem URL dão `{ ok: false }`. */
  obtainRedirect(request: AuthCodeRequest): Promise<AuthCodeResult>;
}

const FALHOU: AuthCodeResult = { ok: false };

/**
 * O contrato "nunca rejeita" imposto do lado de quem chama: um adapter que lança, rejeita ou devolve outra
 * forma não trava o fluxo. Só `{ ok: true, url: <string> }` passa; o resto é `{ ok: false }`, sem ecoar nada.
 */
export async function obtainRedirectSafely(source: AuthCodeSource, request: AuthCodeRequest): Promise<AuthCodeResult> {
  try {
    const result: unknown = await source.obtainRedirect(request);
    if (typeof result !== "object" || result === null) return FALHOU;
    const { ok, url } = result as { readonly ok?: unknown; readonly url?: unknown };
    return ok === true && typeof url === "string" ? { ok: true, url } : FALHOU;
  } catch {
    return FALHOU;
  }
}
