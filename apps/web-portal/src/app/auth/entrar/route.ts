// GET /auth/entrar?provedor=<google|github> (ADR-027 D2 passo 1). Link comum: a CSP `form-action` valeria também
// para os redirecionamentos até o IdP.
import { toResponse } from "../../../server/edge";
import { getPortalAuth } from "../../../server/runtime";

export async function GET(request: Request): Promise<Response> {
  const provider = new URL(request.url).searchParams.get("provedor");
  return toResponse(await getPortalAuth().startLogin({ provider, secFetchSite: request.headers.get("sec-fetch-site") }));
}
