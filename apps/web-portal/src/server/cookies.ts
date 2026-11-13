// Cookies do portal (ADR-027 D3). O `Set-Cookie` é montado aqui, com os atributos fixos e na ordem, para que nenhum
// padrão de framework os mude: prefixo `__Host-` (exige `Secure`, `Path=/` e nenhum `Domain`), `HttpOnly`, `Secure`
// e `SameSite=Lax`. Os valores são envelopes selados (base64url e pontos), sem nada a escapar.

export const COOKIE_NAMES = Object.freeze({
  sessao: "__Host-trampo-sessao",
  fluxo: "__Host-trampo-fluxo",
} as const);

export type CookieName = (typeof COOKIE_NAMES)[keyof typeof COOKIE_NAMES];

export interface CookieWrite {
  readonly name: CookieName;
  readonly value: string;
  /** Segundos inteiros; 0 apaga. */
  readonly maxAge: number;
}

export function cookieWrite(name: CookieName, value: string, maxAgeSeconds: number): CookieWrite {
  return { name, value, maxAge: Math.max(0, Math.floor(maxAgeSeconds)) };
}

/** Apagar: valor vazio e `Max-Age=0`, com os mesmos atributos (senão o navegador não casa o cookie). */
export function cookieClear(name: CookieName): CookieWrite {
  return { name, value: "", maxAge: 0 };
}

export function serializeCookie(cookie: CookieWrite): string {
  return `${cookie.name}=${cookie.value}; Path=/; Max-Age=${cookie.maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function pairs(header: string): Array<readonly [string, string]> {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const index = part.indexOf("=");
      return index === -1 ? ([part, ""] as const) : ([part.slice(0, index), part.slice(index + 1)] as const);
    });
}

/**
 * O valor do cookie no cabeçalho `Cookie`. Repetido (o mesmo nome duas vezes, como faria um cookie plantado por outro
 * caminho) não vale: `undefined`, como se não houvesse.
 */
export function readCookie(header: string | null, name: CookieName): string | undefined {
  if (header === null) return undefined;
  const found = pairs(header).filter(([key, value]) => key === name && value.length > 0);
  return found.length === 1 ? found[0]?.[1] : undefined;
}

/** O cabeçalho `Cookie` do pedido com este cookie trocado ou tirado (a página vê a sessão renovada pelo proxy). */
export function replaceCookie(header: string | null, cookie: CookieWrite): string {
  const others = pairs(header ?? "").filter(([key]) => key !== cookie.name);
  const next = cookie.maxAge > 0 ? [...others, [cookie.name, cookie.value] as const] : others;
  return next.map(([key, value]) => `${key}=${value}`).join("; ");
}
