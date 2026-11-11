// Sessões do GoTrue local para o contrato do BFF (ADR-004 §4.3; F1-API-07 07h). Só a pilha local já conferida pelo
// parseLocalStackEnv, com a publishable: o usuário nasce pelo signup com e-mail e senha (o local não confirma e-mail),
// e uma segunda sessão do mesmo usuário sai do `grant_type=password`. É o único lugar do repositório que entra por
// senha, e o verificador só a aceita com `NODE_ENV=test` (ADR-004 D6).
//
// F1-API-08: o POST cru ao Auth local (o adapter de produção não deixa sair corpo fora da forma) e o fluxo PKCE gravado
// direto em `auth.flow_state`, como `postgres` no banco local, para chegar às recusas de verifier errado e de fluxo
// vencido sem um IdP.
import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import type { LocalStack } from "./local-stack-env.js";
import { psqlJson } from "./local-stack.js";

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

/** A resposta crua do Auth local: o status, o `content-type` e o corpo JSON (todas as respostas de erro do GoTrue são JSON). */
export interface RawAuthResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

/** Um POST cru ao Auth local, com os cabeçalhos e o corpo dados, para ler a recusa como o GoTrue a manda. */
export async function rawAuthPost(
  stack: LocalStack,
  path: string,
  headers: Readonly<Record<string, string>>,
  body: string | null,
): Promise<RawAuthResponse> {
  const response = await fetch(new URL(path, stack.apiUrl), {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, contentType: response.headers.get("content-type"), body: JSON.parse(await response.text()) as unknown };
}

// As colunas obrigatórias de `auth.flow_state` no GoTrue v2.197.0 (migrations de 2023-03 e 2023-04; as de 2026-01 têm
// padrão ou aceitam nulo). O `created_at` recua `age` segundos: acima do `flow_state_expiry_duration` (300 s), vencido.
const INSERT_PKCE_FLOW_SQL = `
with ins as (
  insert into auth.flow_state
    (id, user_id, auth_code, code_challenge_method, code_challenge, provider_type, authentication_method, created_at, updated_at)
  values
    (gen_random_uuid(), :'uid'::uuid, :'code', 's256', :'challenge', 'github', 'oauth', now() - make_interval(secs => :'age'::int), now())
  returning id
)
select json_build_object('inseridos', count(*)) from ins;
`;

/** Um fluxo PKCE do usuário, com o challenge S256 do verifier dado; devolve o `auth_code`. */
export function insertPkceFlow(stack: LocalStack, userId: string, verifier: string, ageSeconds: number): string {
  const code = randomUUID();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  // Uma linha, ou o parse derruba o teste.
  z.object({ inseridos: z.literal(1) }).parse(psqlJson(stack, INSERT_PKCE_FLOW_SQL, { uid: userId, code, challenge, age: String(ageSeconds) }));
  return code;
}

/** O cabeçalho do JWS, decodificado sem verificar (só para ler `alg` e `kid`). */
export function jwsHeader(token: string): unknown {
  return JSON.parse(Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString("utf8")) as unknown;
}
