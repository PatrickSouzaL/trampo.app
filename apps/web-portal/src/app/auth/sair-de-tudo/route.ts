// POST /auth/sair-de-tudo (ADR-027 §9.2): `Origin` exato e `Sec-Fetch-Site` `same-origin`, escopo `global`. Sem `GET`
// (405). Nada do pedido escolhe o escopo: a rota só passa o `Origin`, o `Sec-Fetch-Site` e o cookie para a DAL.
import { COOKIE_NAMES, readCookie } from "../../../server/cookies";
import { toResponse } from "../../../server/edge";
import { getPortalAuth } from "../../../server/runtime";

export async function POST(request: Request): Promise<Response> {
  return toResponse(
    await getPortalAuth().logoutEverywhere({
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
      sessionCookie: readCookie(request.headers.get("cookie"), COOKIE_NAMES.sessao),
    }),
  );
}
