// Acesso do test:db à pilha local do Supabase (ADR-018 D7; ADR-019 D8). Tudo passa pelo LocalStack já conferido
// pelo parseLocalStackEnv: o gateway em 127.0.0.1 com a publishable e o Postgres local pelo psql. Nenhuma chave
// secret nem service_role: a exclusão de conta do cascade sai por SQL como `postgres` no banco local.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { LocalStack } from "./local-stack-env.js";

/** Um usuário do Auth local, criado pelo signup (o local não pede confirmação de e-mail). */
export interface StackUser {
  readonly userId: string;
  readonly accessToken: string;
}

export interface RestResponse {
  readonly status: number;
  readonly body: unknown;
}

const SessionSchema = z.object({
  access_token: z.string().regex(/^[\w-]+\.[\w-]+\.[\w-]+$/),
  user: z.object({ id: z.uuid() }),
});

/** Erro do PostgREST: o código do Postgres (42501, 23503, 23514) e a mensagem com o nome da constraint. */
export const PostgrestErrorSchema = z.object({ code: z.string(), message: z.string() });

const REQUEST_TIMEOUT_MS = 10_000;

async function send(stack: LocalStack, path: string, init: RequestInit): Promise<RestResponse> {
  // `redirect: "error"`: nenhuma resposta leva o teste para fora do 127.0.0.1 já conferido.
  const response = await fetch(new URL(path, stack.apiUrl), {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // As escritas do `rest` pedem `return=representation`, e os erros vêm como objeto. Só o upsert com
  // `return=minimal` volta sem corpo, e aí o `body` é `null`.
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : (JSON.parse(text) as unknown) };
}

export async function signUp(stack: LocalStack): Promise<StackUser> {
  const response = await send(stack, "/auth/v1/signup", {
    method: "POST",
    headers: { apikey: stack.publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email: `trampo-db-${randomUUID()}@example.com`, password: randomUUID() }),
  });
  const session = SessionSchema.parse(response.body);
  return { userId: session.user.id, accessToken: session.access_token };
}

/**
 * Uma chamada ao PostgREST local. Sem `user`, sai só com a publishable, ou seja, como `anon`. Com `user`, leva o
 * JWT dele no Authorization, como o cliente de usuário da API (ADR-018 D5). Sempre `return=representation`, para
 * o teste ver quantas linhas a escrita alcançou.
 */
export async function rest(
  stack: LocalStack,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  user: StackUser | null,
  body?: unknown,
): Promise<RestResponse> {
  const headers: Record<string, string> = {
    apikey: stack.publishableKey,
    accept: "application/json",
    prefer: "return=representation",
  };
  if (user !== null) headers["authorization"] = `Bearer ${user.accessToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return send(stack, `/rest/v1/${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * O upsert do adapter (ADR-021 D5) montado à mão: `POST /rest/v1/<path>` com
 * `Prefer: resolution=merge-duplicates,return=minimal`. O `path` traz o `on_conflict` e o `columns=` como o teste
 * quiser escrevê-los (vírgula crua ou `%2C`). Serve para ver o status e o erro que o cliente da API nunca lê.
 * Com `prefer: "return=minimal"`, é um insert puro, sem `ON CONFLICT` nem `RETURNING`.
 */
export async function upsert(
  stack: LocalStack,
  path: string,
  user: StackUser | null,
  body: unknown,
  prefer = "resolution=merge-duplicates,return=minimal",
): Promise<RestResponse> {
  const headers: Record<string, string> = { apikey: stack.publishableKey, "content-type": "application/json", prefer };
  if (user !== null) headers["authorization"] = `Bearer ${user.accessToken}`;
  return send(stack, `/rest/v1/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/**
 * Uma chamada de RPC pedindo um schema pelo `Content-Profile` (F1-DB-02, ADR-026 condição 1): o PostgREST só serve
 * os schemas de `[api] schemas`, então um schema fora da lista é recusado para qualquer papel.
 */
export async function rpcInSchema(
  stack: LocalStack,
  schema: string,
  name: string,
  user: StackUser | null,
  body: unknown,
): Promise<RestResponse> {
  const headers: Record<string, string> = {
    apikey: stack.publishableKey,
    accept: "application/json",
    "content-type": "application/json",
    "content-profile": schema,
  };
  if (user !== null) headers["authorization"] = `Bearer ${user.accessToken}`;
  return send(stack, `/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/**
 * A mesma pilha, com outro papel do banco local na URI (F1-DB-02): o GoTrue local conecta como
 * `supabase_auth_admin` com a senha do banco local, e é assim que o teste chama o hook e envelhece uma sessão. Só
 * troca o usuário; o host continua o 127.0.0.1 já conferido pelo `parseLocalStackEnv`.
 */
export function stackAs(stack: LocalStack, role: string): LocalStack {
  return Object.freeze({ ...stack, dbUrl: stack.dbUrl.replace(/\/\/\w+:/, `//${role}:`) });
}

/**
 * Roda um script no Postgres local pelo psql e devolve o JSON da única linha impressa. O ambiente do processo é
 * limpo (só o PATH): nenhuma PGHOST, PGHOSTADDR ou PGSERVICE do runner redireciona a conexão para outro banco.
 * As variáveis entram com `--set` e são lidas no script como `:'nome'` (literal citado pelo próprio psql).
 */
export function psqlJson(stack: LocalStack, script: string, vars: Readonly<Record<string, string>> = {}): unknown {
  const output = execFileSync(
    "psql",
    [
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--set=ON_ERROR_STOP=1",
      ...Object.entries(vars).map(([name, value]) => `--set=${name}=${value}`),
      `--dbname=${stack.dbUrl}`,
      "--file=-",
    ],
    {
      input: script,
      encoding: "utf8",
      env: { PATH: process.env["PATH"], PGCONNECT_TIMEOUT: "5" },
      timeout: 15_000,
    },
  );
  return JSON.parse(output) as unknown;
}
