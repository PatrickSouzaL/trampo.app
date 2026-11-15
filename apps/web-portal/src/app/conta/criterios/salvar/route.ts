// POST /conta/criterios/salvar (ADR-028 D6): a gravação dos critérios por formulário, sem JS. `Origin` exato e
// `Sec-Fetch-Site` `same-origin`, corpo urlencoded, validação antes da rede e um `PUT` na API. Destino fixo (303), sem
// `GET` (405). A lógica é da DAL (`server/criteria.ts`); aqui só a tradução.
import { COOKIE_NAMES, readCookie } from "../../../../server/cookies";
import { toResponse } from "../../../../server/edge";
import { getPortalCriteria } from "../../../../server/runtime";

export async function POST(request: Request): Promise<Response> {
  return toResponse(
    await getPortalCriteria().save({
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
      contentType: request.headers.get("content-type"),
      body: request.body,
      sessionCookie: readCookie(request.headers.get("cookie"), COOKIE_NAMES.sessao),
    }),
  );
}
