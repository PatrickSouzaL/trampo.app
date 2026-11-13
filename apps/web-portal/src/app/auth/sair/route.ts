// POST /auth/sair (ADR-027 D7): `Origin` exato e `Sec-Fetch-Site` `same-origin`, escopo `local`. Sem `GET` (405).
import { COOKIE_NAMES, readCookie } from "../../../server/cookies";
import { toResponse } from "../../../server/edge";
import { getPortalAuth } from "../../../server/runtime";

export async function POST(request: Request): Promise<Response> {
  return toResponse(
    await getPortalAuth().logout({
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
      sessionCookie: readCookie(request.headers.get("cookie"), COOKIE_NAMES.sessao),
    }),
  );
}
