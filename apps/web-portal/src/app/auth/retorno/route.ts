// GET /auth/retorno?code=…&st=… (ADR-027 D2 passo 2): o retorno do GoTrue depois do IdP. Destino fixo.
import { COOKIE_NAMES, readCookie } from "../../../server/cookies";
import { toResponse } from "../../../server/edge";
import { getPortalAuth } from "../../../server/runtime";

export async function GET(request: Request): Promise<Response> {
  const search = new URL(request.url).searchParams;
  const flowCookie = readCookie(request.headers.get("cookie"), COOKIE_NAMES.fluxo);
  return toResponse(await getPortalAuth().completeLogin({ search, flowCookie }));
}
