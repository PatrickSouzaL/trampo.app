// Proxy do Next 16 (ADR-027 D6 e D8): CSP com nonce novo em toda resposta e renovação da sessão nos GET de página.
// Roda no runtime Node.js (padrão do proxy) e em todo pedido, sem `matcher`: a CSP também vale para rota, erro e
// estático. A lógica fica em `server/edge.ts`; aqui só a tradução para o `NextResponse`.
import { NextResponse, type NextRequest } from "next/server";

import { readPortalConfig } from "./server/config";
import { handleProxy } from "./server/edge";
import { createNonce } from "./server/pkce";
import { getPortalAuth } from "./server/runtime";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const result = await handleProxy({
    method: request.method,
    pathname: request.nextUrl.pathname,
    headers: request.headers,
    nonce: createNonce(),
    https: readPortalConfig().https,
    dev: process.env.NODE_ENV === "development",
    auth: getPortalAuth(),
  });
  const response = NextResponse.next({ request: { headers: result.requestHeaders } });
  for (const [name, value] of result.responseHeaders) response.headers.append(name, value);
  return response;
}
