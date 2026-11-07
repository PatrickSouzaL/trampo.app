// Sessões do GoTrue local para o contrato do BFF (ADR-004 §4.3; F1-API-07 07h). Só a pilha local já conferida pelo
// parseLocalStackEnv, com a publishable: o usuário nasce pelo signup com e-mail e senha (o local não confirma e-mail),
// e uma segunda sessão do mesmo usuário sai do `grant_type=password`. É o único lugar do repositório que entra por
// senha, e o verificador só a aceita com `NODE_ENV=test` (ADR-004 D6).
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { LocalStack } from "./local-stack-env.js";

export interface PasswordSession {
  readonly email: string;
  readonly password: string;
  readonly userId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

const SessionSchema = z.object({
  access_token: z.string().regex(/^[\w-]+\.[\w-]+\.[\w-]+$/),
  refresh_token: z.string().min(1),
  expires_in: z.int().positive(),
  user: z.object({ id: z.uuid() }),
});

const REQUEST_TIMEOUT_MS = 10_000;

async function authPost(stack: LocalStack, path: string, body: unknown): Promise<unknown> {
  // `redirect: "error"`: nenhuma resposta leva o teste para fora do 127.0.0.1 já conferido.
  const response = await fetch(new URL(path, stack.apiUrl), {
    method: "POST",
    headers: { apikey: stack.publishableKey, "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return JSON.parse(await response.text()) as unknown;
}

function sessionFrom(body: unknown, email: string, password: string): PasswordSession {
  const session = SessionSchema.parse(body);
  return {
    email,
    password,
    userId: session.user.id,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresIn: session.expires_in,
  };
}

/** Usuário novo, com a primeira sessão. */
export async function signUpWithPassword(stack: LocalStack): Promise<PasswordSession> {
  const email = `trampo-auth-${randomUUID()}@example.com`;
  const password = randomUUID();
  return sessionFrom(await authPost(stack, "/auth/v1/signup", { email, password }), email, password);
}

/** Outra sessão do mesmo usuário (outro `session_id`), para o logout global (P11). */
export async function signInWithPassword(stack: LocalStack, user: PasswordSession): Promise<PasswordSession> {
  const body = await authPost(stack, "/auth/v1/token?grant_type=password", { email: user.email, password: user.password });
  return sessionFrom(body, user.email, user.password);
}

/** O JWKS como o verificador da API o busca: sem `apikey`, na origem do projeto. */
export async function fetchJwks(stack: LocalStack): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL("/auth/v1/.well-known/jwks.json", stack.apiUrl), {
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: JSON.parse(await response.text()) as unknown };
}

/** O cabeçalho do JWS, decodificado sem verificar (só para ler `alg` e `kid`). */
export function jwsHeader(token: string): unknown {
  return JSON.parse(Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString("utf8")) as unknown;
}
