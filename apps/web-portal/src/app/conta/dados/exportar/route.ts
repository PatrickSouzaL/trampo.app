// POST /conta/dados/exportar (ADR-029 D9): o arquivo com os dados do usuário, como anexo. `Origin` exato e
// `Sec-Fetch-Site` `same-origin`, um `GET` na API e o JSON revalidado pelo contrato. Sem `GET` (405): um link de outro
// site não gasta o limite do usuário. A lógica é da DAL (`server/account.ts`); aqui só a tradução.
import { COOKIE_NAMES, readCookie } from "../../../../server/cookies";
import { toResponse } from "../../../../server/edge";
import { getPortalAccount } from "../../../../server/runtime";

export async function POST(request: Request): Promise<Response> {
  return toResponse(
    await getPortalAccount().exportData({
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
      sessionCookie: readCookie(request.headers.get("cookie"), COOKIE_NAMES.sessao),
    }),
  );
}
