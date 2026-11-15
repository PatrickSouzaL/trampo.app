// GET /v1/account/export e POST /v1/account/delete (ADR-029 D3 a D5; SR-16). Registradas só com a opção `account`
// do buildApp.
//
// Ordem na borda, da rejeição mais barata à mais cara: hooks globais (CORS por rota, tipo de mídia, JWT e rate limit
// da classe `conta`, a mais estrita), no POST o bodyLimit de 256 bytes (413 sem parse) e o AccountDeleteRequestSchema
// (400: sem a frase de confirmação, nada chega ao banco), e por último o AccountService. Nenhuma das duas gasta cota
// diária. As duas ficam fora de EXTENSION_ROUTES: a origem da extensão leva 403 na borda.
//
// O dono vem só do principal, e o token é o bearer que o hook de autenticação já verificou. A exclusão responde 204
// (apagou, ou já estava apagada), 403 `PROIBIDO` (o login não é recente: nada foi apagado) ou 503, que NÃO prova que
// nada foi apagado. A exportação sai validada pelo serializerCompiler ou não sai. `Cache-Control: no-store` em toda
// resposta. Nada do `sub`, do token nem dos dados vai para o log (SR-12): a linha `conta_excluida` não tem campo.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import { ACCOUNT_ROUTES, AccountDeleteRequestSchema, AccountExportSchema } from "@trampo/contracts/account";
import { ACCOUNT_DELETE_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AccountDeleteOutcome, AccountExportOutcome, AccountService } from "../../application/account/account-service.js";
import type { AccountSubject } from "../../application/ports/account-store.js";
import { sendApiError } from "../api-error.js";
import { bearerToken, unauthenticated } from "../edge/auth.js";

export interface AccountRouteOptions {
  readonly service: Pick<AccountService, "delete" | "export">;
}

/** O log nunca derruba a resposta (um destino que lança, por exemplo). */
function safely(write: () => void): void {
  try {
    write();
  } catch {
    // Sem log possível: o próprio log falhou.
  }
}

/** Dono só do principal e token só do bearer já verificado. `null` é quebra de invariante: 401. */
function subjectOf(request: FastifyRequest): AccountSubject | null {
  const principal = request.principal;
  const accessToken = bearerToken(request.headers.authorization);
  return principal === null || accessToken === null ? null : { userId: principal.userId, accessToken };
}

export function createExportAccountHandler(service: AccountRouteOptions["service"]) {
  return async function exportAccountHandler(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const subject = subjectOf(request);
    if (subject === null) return unauthenticated(request, reply);
    let outcome: AccountExportOutcome;
    try {
      outcome = await service.export(subject);
    } catch {
      // O serviço nunca rejeita; se rejeitar, falha fechado.
      outcome = { ok: false };
    }
    if (outcome.ok) return reply.code(200).send(outcome.document);
    safely(() => request.log.warn("conta_exportacao_indisponivel"));
    return sendApiError(reply, request.id, "SERVICO_INDISPONIVEL");
  };
}

export function createDeleteAccountHandler(service: AccountRouteOptions["service"]) {
  return async function deleteAccountHandler(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const subject = subjectOf(request);
    if (subject === null) return unauthenticated(request, reply);
    let outcome: AccountDeleteOutcome;
    try {
      outcome = await service.delete(subject);
    } catch {
      outcome = "indisponivel";
    }
    if (outcome === "excluida") {
      // O registro mínimo de que o pedido foi atendido, sem dado pessoal (ADR-029 D3).
      safely(() => request.log.info("conta_excluida"));
      return reply.code(204).send();
    }
    if (outcome === "login_antigo") return sendApiError(reply, request.id, "PROIBIDO");
    safely(() => request.log.warn("conta_exclusao_indisponivel"));
    return sendApiError(reply, request.id, "SERVICO_INDISPONIVEL");
  };
}

/** onSend da rota: vale para o sucesso, para o erro do handler e para o erro dos hooks globais (401, 403, 413, 429). */
async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  void reply.header("cache-control", "no-store");
  return payload;
}

export const accountRoutes: FastifyPluginAsyncZod<AccountRouteOptions> = async (app, options) => {
  const exportHandler = createExportAccountHandler(options.service);
  const deleteHandler = createDeleteAccountHandler(options.service);
  app.get(
    ACCOUNT_ROUTES.export,
    { config: { rateLimit: "conta" }, schema: { response: { 200: AccountExportSchema } }, onSend: noStore },
    async (request, reply) => exportHandler(request, reply),
  );
  app.post(
    ACCOUNT_ROUTES.delete,
    {
      config: { rateLimit: "conta" },
      bodyLimit: ACCOUNT_DELETE_BODY_MAX_BYTES,
      schema: { body: AccountDeleteRequestSchema },
      onSend: noStore,
    },
    async (request, reply) => deleteHandler(request, reply),
  );
};
