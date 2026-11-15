// A borda do portal sem Next.js (ADR-027 D6 e D8; o rascunho dos critérios, ADR-028 D8): o que o `proxy.ts` faz em cada pedido e a tradução das intenções da
// sessão em `Response`. Os arquivos do App Router só chamam daqui.
import { COOKIE_NAMES, cookieClear, hasCookie, readCookie, replaceCookie, serializeCookie } from "./cookies";
import { buildCsp } from "./headers";
import type { Forbidden, PortalAuth, Redirect } from "./session";

/** Estado da sessão que o proxy passa à página. Só escolhe o aviso: a DAL verifica o access de novo. */
export const SESSION_STATE_HEADER = "x-trampo-sessao";

/** Só os `GET` de página renovam: nada de `/auth/*`, `/_next/*` nem arquivo com extensão. */
export function isPageRequest(method: string, pathname: string): boolean {
  if (method !== "GET" || pathname.startsWith("/auth/") || pathname.startsWith("/_next/")) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !/\.[A-Za-z0-9]+$/.test(last);
}

export interface ProxyInput {
  readonly method: string;
  readonly pathname: string;
  readonly headers: Headers;
  readonly nonce: string;
  readonly https: boolean;
  readonly dev: boolean;
  readonly auth: PortalAuth;
}

export interface ProxyOutput {
  /** Cabeçalhos do pedido que segue para a página ou rota. */
  readonly requestHeaders: Headers;
  /** Cabeçalhos da resposta, na ordem. */
  readonly responseHeaders: ReadonlyArray<readonly [string, string]>;
}

export async function handleProxy(input: ProxyInput): Promise<ProxyOutput> {
  const csp = buildCsp({ nonce: input.nonce, https: input.https, dev: input.dev });
  const requestHeaders = new Headers(input.headers);
  // Um valor mandado pelo cliente nunca chega à página.
  requestHeaders.delete(SESSION_STATE_HEADER);
  // O Next lê o nonce da CSP do pedido e o aplica aos scripts dele.
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-nonce", input.nonce);
  const responseHeaders: Array<readonly [string, string]> = [["Content-Security-Policy", csp]];
  if (isPageRequest(input.method, input.pathname)) {
    const cookieHeader = input.headers.get("cookie");
    const resolved = await input.auth.resolveSession(readCookie(cookieHeader, COOKIE_NAMES.sessao));
    requestHeaders.set(SESSION_STATE_HEADER, resolved.state);
    if (resolved.cookie !== undefined) {
      requestHeaders.set("cookie", replaceCookie(cookieHeader, resolved.cookie));
      responseHeaders.push(["Set-Cookie", serializeCookie(resolved.cookie)]);
    }
    // O rascunho dos critérios é de uso único (ADR-028 D8): a página o lê neste pedido, e o navegador o apaga.
    if (hasCookie(cookieHeader, COOKIE_NAMES.rascunho)) responseHeaders.push(["Set-Cookie", serializeCookie(cookieClear(COOKIE_NAMES.rascunho))]);
  }
  return { requestHeaders, responseHeaders };
}

/** A intenção da sessão como resposta: 303 com os cookies, ou 403 com corpo fixo. Nunca em cache. */
export function toResponse(intent: Redirect | Forbidden): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (intent.kind === "forbidden") {
    headers.set("content-type", "text/plain; charset=utf-8");
    return new Response("Proibido.", { status: 403, headers });
  }
  headers.set("location", intent.location);
  for (const cookie of intent.cookies) headers.append("set-cookie", serializeCookie(cookie));
  return new Response(null, { status: 303, headers });
}
