// POST /conta/dados/excluir/confirmar (ADR-029 D9): a exclusão da conta por formulário, sem JS. `Origin` exato e
// `Sec-Fetch-Site` `same-origin`, corpo urlencoded só com a frase de confirmação, o login recente e um `POST` na API.
// Destino fixo (303), sem `GET` (405). A lógica é da DAL (`server/account.ts`); aqui só a tradução.
import { COOKIE_NAMES, readCookie } from "../../../../../server/cookies";
import { toResponse } from "../../../../../server/edge";
import { getPortalAccount } from "../../../../../server/runtime";

export async function POST(request: Request): Promise<Response> {
  return toResponse(
    await getPortalAccount().deleteAccount({
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
      contentType: request.headers.get("content-type"),
      body: request.body,
      sessionCookie: readCookie(request.headers.get("cookie"), COOKIE_NAMES.sessao),
    }),
  );
}
