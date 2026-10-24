// GET e PUT /v1/criteria (ADR-021 D2, D4, D8.1 e D9). Registradas só com a opção `criteria` do buildApp.
//
// Ordem na borda, da rejeição mais barata à mais cara: hooks globais (CORS por rota, tipo de mídia, JWT e rate
// limit da classe da rota: `padrao` no GET, `criterios` no PUT), no PUT o bodyLimit de 16 KiB (413 sem parse) e o
// UserCriteriaSchema (400), e por último o CriteriaGuard. Nenhuma das duas gasta cota diária: nenhuma chama LLM.
//
// O dono vem só do principal, e o token é o bearer que o hook de autenticação já verificou nesta requisição: ele
// segue ao PostgREST para a RLS valer (ADR-018 D6). O PUT nunca devolve corpo (204), e a pretensão em claro só sai
// pelo GET, validado na saída pelo serializerCompiler. `Cache-Control: no-store` vale em toda resposta das duas
// rotas, inclusive nos erros dos hooks globais. Nada do `sub`, do token nem dos critérios vai para o log (SR-12).
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import { type UserCriteria, UserCriteriaSchema } from "@trampo/contracts";
import { CRITERIA_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import type { FastifyReply, FastifyRequest } from "fastify";

import type {
  CriteriaLookup,
  CriteriaRepository,
  CriteriaSave,
  CriteriaSubject,
} from "../../application/ports/criteria-repository.js";
import { sendApiError } from "../api-error.js";
import { bearerToken, unauthenticated } from "../edge/auth.js";

export const CRITERIA_ROUTE = "/v1/criteria";

export interface CriteriaRouteOptions {
  /** O CriteriaGuard (prazo e revalidação), o mesmo que a rota de análise lê (ADR-021 §4). */
  readonly repository: CriteriaRepository;
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
function subjectOf(request: FastifyRequest): CriteriaSubject | null {
  const principal = request.principal;
  const accessToken = bearerToken(request.headers.authorization);
  return principal === null || accessToken === null ? null : { userId: principal.userId, accessToken };
}

/** A porta nunca rejeita (ADR-021 D5). Se rejeitar ou lançar, é banco fora do ar: falha fechado. */
async function load(repository: CriteriaRepository, subject: CriteriaSubject): Promise<CriteriaLookup> {
  try {
    return await repository.load(subject);
  } catch {
    return { found: false, unavailable: true };
  }
}

async function save(repository: CriteriaRepository, subject: CriteriaSubject, criteria: UserCriteria): Promise<CriteriaSave> {
  try {
    return await repository.save(subject, criteria);
  } catch {
    return { saved: false, unavailable: true };
  }
}

export function createGetCriteriaHandler(repository: CriteriaRepository) {
  return async function getCriteriaHandler(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const subject = subjectOf(request);
    if (subject === null) return unauthenticated(request, reply);
    const lookup = await load(repository, subject);
    if (lookup.found) return reply.code(200).send(lookup.criteria);
    if (lookup.unavailable === true) {
      safely(() => request.log.warn("criterios_indisponiveis"));
      return sendApiError(reply, request.id, "SERVICO_INDISPONIVEL");
    }
    return sendApiError(reply, request.id, "CRITERIOS_NAO_CONFIGURADOS");
  };
}

export function createPutCriteriaHandler(repository: CriteriaRepository) {
  return async function putCriteriaHandler(request: FastifyRequest, criteria: UserCriteria, reply: FastifyReply): Promise<FastifyReply> {
    const subject = subjectOf(request);
    if (subject === null) return unauthenticated(request, reply);
    const result = await save(repository, subject, criteria);
    if (result.saved) return reply.code(204).send();
    // Sem eco: a resposta é só o erro do catálogo, e o log só a mensagem, sem campos.
    safely(() => request.log.warn("criterios_gravacao_indisponivel"));
    return sendApiError(reply, request.id, "SERVICO_INDISPONIVEL");
  };
}

/** onSend da rota: vale para o sucesso, para o erro do handler e para o erro dos hooks globais (401, 403, 413, 429). */
async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  void reply.header("cache-control", "no-store");
  return payload;
}

export const criteriaRoutes: FastifyPluginAsyncZod<CriteriaRouteOptions> = async (app, options) => {
  const getHandler = createGetCriteriaHandler(options.repository);
  const putHandler = createPutCriteriaHandler(options.repository);
  app.get(
    CRITERIA_ROUTE,
    { config: { rateLimit: "padrao" }, schema: { response: { 200: UserCriteriaSchema } }, onSend: noStore },
    async (request, reply) => getHandler(request, reply),
  );
  app.put(
    CRITERIA_ROUTE,
    {
      config: { rateLimit: "criterios" },
      bodyLimit: CRITERIA_BODY_MAX_BYTES,
      schema: { body: UserCriteriaSchema },
      onSend: noStore,
    },
    async (request, reply) => putHandler(request, request.body, reply),
  );
};
