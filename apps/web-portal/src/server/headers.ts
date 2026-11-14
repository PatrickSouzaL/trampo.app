// Cabeçalhos de segurança do portal (ADR-027 D8). A CSP leva um nonce novo por pedido e é posta pelo proxy (o Next
// extrai o nonce do cabeçalho do pedido e o aplica aos scripts dele); os demais vão pelo `headers()` do `next.config`,
// uma vez cada.

export interface CspInput {
  readonly nonce: string;
  /** O portal está em https: liga o `upgrade-insecure-requests`. */
  readonly https: boolean;
  /** `next dev`: o React usa `eval` para as pilhas de erro (só em desenvolvimento). */
  readonly dev: boolean;
}

export function buildCsp(input: CspInput): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${input.nonce}' 'strict-dynamic'${input.dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${input.nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(input.https ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

export const SECURITY_HEADERS: ReadonlyArray<{ readonly key: string; readonly value: string }> = Object.freeze([
  // Reserva para navegador sem `frame-ancestors`.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Nenhum Referer sai para outra origem (a URL do retorno leva o código). `same-origin`, e não `no-referrer`: com
  // `no-referrer`, o navegador manda `Origin: null` no POST do formulário "Sair", e o logout cairia no 403 (achado do
  // E2E, ADR-027 §7). O `/auth/retorno` responde sempre 303, então a URL dele nunca é o Referer de nada.
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  // Ignorado em http; sem `preload` até o domínio existir (S-5).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
]);
