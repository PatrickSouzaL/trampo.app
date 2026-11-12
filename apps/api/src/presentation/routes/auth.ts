// POST /v1/auth/exchange, /v1/auth/refresh e /v1/auth/logout: o BFF sem estado da extensão (ADR-004 D4, D7 e D8;
// F1-API-07 07g). Registradas só com a opção `auth` do buildApp.
//
// Ordem na borda (D4): hooks globais (CORS, com `Origin` obrigatório nas duas públicas e origem de web 403 nas três;
// tipo de mídia; JWT e rate limit no Redis, que passam sem efeito nas públicas, porque elas nunca leem
// `Authorization`) → limitador local pré-JWT no `onRequest` da rota (só nas públicas) → `bodyLimit` de 2.048 (413 sem
// parse) → Zod estrito (400) → caso de uso (07f). O logout é protegido, na classe `padrao` do rate limit.
//
// A rota só traduz o resultado dos casos de uso pelo mapa do D7, sem regra nova. O motivo vai só para a linha de log
// amostrada (D8 item 7), sem campo além do contador. `Cache-Control: no-store` vale em toda resposta das três rotas,
// inclusive nos erros dos hooks globais. Código, verifier, tokens, envelope e IP nunca vão a log (SR-12).
//
// Métricas (D8 item 7; 07i): cada requisição que chega ao handler ou é barrada pelo limitador local conta uma vez em
// `auth_troca_total`, `auth_renovacao_total` ou `auth_logout_total`, com o `resultado` do mesmo mapa do D7. O que a
// borda recusa antes (CORS, tipo de mídia, tamanho, Zod, JWT e o rate limit do Redis no logout) não conta aqui.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import {
  AUTH_BODY_MAX_BYTES,
  AUTH_ROUTES,
  AuthExchangeRequestSchema,
  AuthLogoutRequestSchema,
  AuthRefreshRequestSchema,
  AuthSessionResponseSchema,
} from "@trampo/contracts/auth";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AuthSessionOutcome, AuthUnavailable } from "../../application/auth/auth-session.js";
import type { EndSessionOutcome } from "../../application/auth/end-session.js";
import type { AuthOperation, AuthResult, Telemetry } from "../../application/ports/telemetry.js";
import { authEvent, authSessionResult, endSessionResult } from "../../application/telemetry/auth-telemetry.js";
import { sendApiError } from "../api-error.js";
import { bearerToken, unauthenticated } from "../edge/auth.js";
import { createPreAuthLimitHook, type PreAuthLimiter } from "../edge/pre-auth-limit.js";
import type { AuthLogMessage, AuthLogSampler } from "../logging/auth-log-sampler.js";

/** A troca e a renovação (`ExchangeSession` e `RefreshSession`, 07f). */
export interface AuthSessionUseCase {
  execute(input: { readonly request: unknown; readonly origin: string }): Promise<AuthSessionOutcome>;
}

/** O logout (`EndSession`, 07f). */
export interface EndSessionUseCase {
  execute(input: { readonly accessToken: string }): Promise<EndSessionOutcome>;
}

export interface AuthRouteOptions {
  readonly exchange: AuthSessionUseCase;
  readonly refresh: AuthSessionUseCase;
  readonly logout: EndSessionUseCase;
  /** Um só por processo, compartilhado pelas duas rotas públicas (07e). */
  readonly preAuthLimiter: PreAuthLimiter;
  readonly logSampler: AuthLogSampler;
  /** A mesma do processo (ADR-010 D6): recebe um evento `auth` por operação, só com a operação e o resultado. */
  readonly telemetry: Telemetry;
}

type SessionFlow = Exclude<AuthOperation, "logout">;

/** O caso de uso rejeitou (quebrou a promessa de nunca rejeitar): falha fechada, 503, nunca 500 nem 200. */
const USE_CASE_THREW: AuthUnavailable = { kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: null };

/** O log nunca derruba a resposta (um destino que lança, por exemplo). */
function safely(write: () => void): void {
  try {
    write();
  } catch {
    // Sem log possível: o próprio log falhou.
  }
}

/** Um evento por operação, só com os dois enums. A porta promete não lançar; se lançar, a resposta não muda. */
function recordAuth(telemetry: Telemetry, operation: AuthOperation, result: AuthResult): void {
  safely(() => telemetry.record(authEvent(operation, result)));
}

/** Linha amostrada do catálogo: 1 por motivo a cada 60 s, com o contador das suprimidas e nenhum outro campo. */
function logSampled(sampler: AuthLogSampler, request: FastifyRequest, message: AuthLogMessage): void {
  safely(() => {
    const decision = sampler.sample(message);
    if (decision.emit) request.log.warn({ suprimidas: decision.suppressed }, message);
  });
}

/** 503 com o `retryAfterSeconds` do orçamento ou do *bulkhead*; o `null` fica sem `Retry-After`, como os 503 da borda. */
function sendUnavailable(request: FastifyRequest, reply: FastifyReply, retryAfterSeconds: number | null): FastifyReply {
  return sendApiError(reply, request.id, "SERVICO_INDISPONIVEL", retryAfterSeconds === null ? {} : { retryAfterSeconds });
}

/** O mapa do D7 sobre o resultado da troca e da renovação (M-14: um mutante por linha). */
function sendSessionOutcome(
  request: FastifyRequest,
  reply: FastifyReply,
  sampler: AuthLogSampler,
  flow: SessionFlow,
  outcome: AuthSessionOutcome,
): FastifyReply {
  switch (outcome.kind) {
    case "sessao":
      return reply.code(200).send(outcome.session);
    case "nao_autenticado":
      // Rota sem Bearer: o 401 sai sem o desafio `WWW-Authenticate` das rotas protegidas.
      logSampled(sampler, request, outcome.reason);
      return sendApiError(reply, request.id, "NAO_AUTENTICADO");
    case "indisponivel":
      logSampled(sampler, request, outcome.reason);
      // Na renovação, o desvio de política só nasce depois de o GoTrue rotacionar: a sessão se perdeu (D6).
      if (flow === "renovacao" && outcome.reason === "auth_token_fora_da_politica") {
        logSampled(sampler, request, "auth_renovacao_perdida");
      }
      return sendUnavailable(request, reply, outcome.retryAfterSeconds);
    case "entrada_invalida":
      return sendApiError(reply, request.id, "PAYLOAD_INVALIDO");
  }
}

async function runSession(useCase: AuthSessionUseCase, request: unknown, origin: string): Promise<AuthSessionOutcome> {
  try {
    return await useCase.execute({ request, origin });
  } catch {
    return USE_CASE_THREW;
  }
}

async function runLogout(useCase: EndSessionUseCase, accessToken: string): Promise<EndSessionOutcome> {
  try {
    return await useCase.execute({ accessToken });
  } catch {
    return USE_CASE_THREW;
  }
}

/**
 * Handler da troca e da renovação. O `Origin` já foi exigido e conferido pelo CORS (D8 item 2) e entra no AAD do
 * envelope; ausente aqui é quebra de invariante: 403, sem chamar o caso de uso.
 */
export function createSessionHandler(useCase: AuthSessionUseCase, sampler: AuthLogSampler, telemetry: Telemetry, flow: SessionFlow) {
  return async function sessionHandler(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const origin = request.headers.origin;
    if (origin === undefined) {
      recordAuth(telemetry, flow, "recusado");
      return sendApiError(reply, request.id, "PROIBIDO");
    }
    const outcome = await runSession(useCase, request.body, origin);
    recordAuth(telemetry, flow, authSessionResult(outcome));
    return sendSessionOutcome(request, reply, sampler, flow, outcome);
  };
}

/** Handler do logout: o Bearer já verificado vai ao GoTrue; sem principal ou sem token, quebra de invariante: 401. */
export function createLogoutHandler(useCase: EndSessionUseCase, sampler: AuthLogSampler, telemetry: Telemetry) {
  return async function logoutHandler(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const accessToken = bearerToken(request.headers.authorization);
    if (request.principal === null || accessToken === null) {
      recordAuth(telemetry, "logout", "recusado");
      return unauthenticated(request, reply);
    }
    const outcome = await runLogout(useCase, accessToken);
    recordAuth(telemetry, "logout", endSessionResult(outcome));
    if (outcome.kind === "encerrada") return reply.code(204).send();
    logSampled(sampler, request, outcome.reason);
    return sendUnavailable(request, reply, outcome.retryAfterSeconds);
  };
}

/** onSend da rota: vale para o sucesso, para o erro do handler e para o erro dos hooks globais (401, 403, 413, 429). */
async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  void reply.header("cache-control", "no-store");
  return payload;
}

export const authRoutes: FastifyPluginAsyncZod<AuthRouteOptions> = async (app, options) => {
  const sampler = options.logSampler;
  const { telemetry } = options;
  /** O 429 do limitador local: a linha amostrada e o `limitado` da métrica da própria rota. */
  const onLimited = (flow: SessionFlow) => (request: FastifyRequest): void => {
    logSampled(sampler, request, "auth_limite_local");
    recordAuth(telemetry, flow, "limitado");
  };
  const exchangeHandler = createSessionHandler(options.exchange, sampler, telemetry, "troca");
  const refreshHandler = createSessionHandler(options.refresh, sampler, telemetry, "renovacao");
  const logoutHandler = createLogoutHandler(options.logout, sampler, telemetry);

  app.post(
    AUTH_ROUTES.exchange,
    {
      onRequest: createPreAuthLimitHook(options.preAuthLimiter, "auth_troca", onLimited("troca")),
      bodyLimit: AUTH_BODY_MAX_BYTES,
      schema: { body: AuthExchangeRequestSchema, response: { 200: AuthSessionResponseSchema } },
      onSend: noStore,
    },
    async (request, reply) => exchangeHandler(request, reply),
  );
  app.post(
    AUTH_ROUTES.refresh,
    {
      onRequest: createPreAuthLimitHook(options.preAuthLimiter, "auth_renovacao", onLimited("renovacao")),
      bodyLimit: AUTH_BODY_MAX_BYTES,
      schema: { body: AuthRefreshRequestSchema, response: { 200: AuthSessionResponseSchema } },
      onSend: noStore,
    },
    async (request, reply) => refreshHandler(request, reply),
  );
  app.post(
    AUTH_ROUTES.logout,
    {
      // Protegida: o JWT e o rate limit no Redis já passaram nos hooks globais (ADR-014 D4, classe `padrao`).
      config: { rateLimit: "padrao" },
      bodyLimit: AUTH_BODY_MAX_BYTES,
      schema: { body: AuthLogoutRequestSchema },
      onSend: noStore,
    },
    async (request, reply) => logoutHandler(request, reply),
  );
};
