// Guarda do test:db (ADR-019 D8; F1-OPS-01 parte 2). O teste de RLS do SR-15 só fala com a pilha local do
// Supabase que o `supabase start` sobe no próprio runner, com as chaves de demonstração que o `supabase status`
// imprime. Recusa, antes de qualquer conexão, URL que não seja 127.0.0.1, chave que não seja publishable e
// qualquer variável de credencial do projeto real. Lista positiva por regex ancorada, sem parser de URL: o libpq
// lê a URI do banco por conta própria (multi-host, `?host=`), então só passa a forma exata que a CLI imprime.
// As mensagens são fixas e nunca repetem o valor recebido.

export type LocalStackEnvReason = "api_url" | "db_url" | "publishable_key" | "credencial_remota";

export class LocalStackEnvError extends Error {
  readonly reason: LocalStackEnvReason;
  constructor(reason: LocalStackEnvReason) {
    super(`test:db recusado (${reason}): só a pilha local do Supabase em 127.0.0.1, com as chaves do supabase status`);
    this.name = "LocalStackEnvError";
    this.reason = reason;
  }
}

export interface LocalStack {
  /** Gateway local (Kong), como `http://127.0.0.1:54321`. */
  readonly apiUrl: URL;
  /** URI do Postgres local, como `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. */
  readonly dbUrl: string;
  readonly publishableKey: string;
}

/** Variáveis que só existem para falar com o projeto real (`supabase link`, `db push`, painel). */
export const REMOTE_CREDENTIAL_VARIABLES = Object.freeze([
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_PROJECT_ID",
  "SUPABASE_PROJECT_REF",
]);

const API_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const DB_URL = /^postgres(?:ql)?:\/\/\w+:\w+@127\.0\.0\.1:\d{1,5}\/\w+$/;
// A mesma lista positiva do cliente de usuário (postgrest-user-client): a secret e a legada nunca entram aqui.
const PUBLISHABLE_KEY = /^sb_publishable_[\w-]{1,256}$/;

export function parseLocalStackEnv(env: Readonly<Record<string, string | undefined>>): LocalStack {
  if (REMOTE_CREDENTIAL_VARIABLES.some((name) => env[name] !== undefined)) {
    throw new LocalStackEnvError("credencial_remota");
  }
  const apiUrl = env["API_URL"] ?? "";
  if (!API_URL.test(apiUrl)) throw new LocalStackEnvError("api_url");
  const dbUrl = env["DB_URL"] ?? "";
  if (!DB_URL.test(dbUrl)) throw new LocalStackEnvError("db_url");
  const publishableKey = env["PUBLISHABLE_KEY"] ?? "";
  if (!PUBLISHABLE_KEY.test(publishableKey)) throw new LocalStackEnvError("publishable_key");
  return Object.freeze({ apiUrl: new URL(apiUrl), dbUrl, publishableKey });
}
