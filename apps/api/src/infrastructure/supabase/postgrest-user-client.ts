// Cliente REST de USUÁRIO do PostgREST do Supabase (ADR-018 D5). Sem SDK, no modelo do upstash-rest-client
// (ADR-014 D2): a chave *publishable* no `apikey` e o JWT do próprio usuário no `Authorization`, um token por
// chamada e nunca guardado. Assim a RLS vale como segunda barreira (a primeira é o filtro pelo `sub` verificado).
//
// O construtor recusa chave *secret* (`sb_secret_`) e legada (`eyJ`): este cliente nunca fura a RLS. Falha
// fechado em qualquer desvio (status ≠ 200, redirecionamento, prazo, `content-type` que não é JSON, corpo acima
// de 32 KiB, UTF-8 ou JSON inválido, `__proto__`/`constructor`) → `{ ok: false }`. Nunca rejeita. Nada da chave,
// do token, da URL ou da resposta vai para log ou mensagem de erro.
import { parseJsonWithoutPrototypeKeys } from "../../application/llm/llm-output-guard.js";

export const POSTGREST_CLIENT_POLICY = {
  /** Teto de cada chamada. O CriteriaGuard tem 1.000 ms (ADR-018 D6); este é o cinto por baixo dele. */
  timeoutMs: 900,
  maxResponseBytes: 32 * 1024,
  /** O mesmo teto da borda (ADR-013 D3) e do CriteriaGuard. */
  accessTokenMaxChars: 8_192,
} as const;

/** Tabelas que o cliente de usuário pode ler. Cresce com o F1-API-05 e o F1-API-06. */
export type PostgrestTable = "user_criteria";

export type PostgrestRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

export interface PostgrestUserClient {
  /** `GET /rest/v1/<table>?<query>` com o token do dono. Nunca rejeita. */
  select(
    table: PostgrestTable,
    query: Readonly<Record<string, string>>,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<PostgrestRead>;
}

export interface PostgrestUserClientConfig {
  /** Origem do projeto (a mesma `SUPABASE_URL` do JWT, ADR-013 D6). */
  readonly url: URL;
  readonly publishableKey: string;
  /** Só para os testes encurtarem o prazo. */
  readonly timeoutMs?: number;
}

/** Mensagem fixa: nunca repete a chave recebida. */
export class PostgrestClientConfigError extends Error {
  constructor() {
    super("SUPABASE_PUBLISHABLE_KEY precisa ser uma chave publishable (sb_publishable_...); secret e legada são recusadas");
    this.name = "PostgrestClientConfigError";
  }
}

// Lista positiva: só a publishable passa, então a secret (`sb_secret_`) e a legada (`eyJ`, JWT de anon ou de
// service_role) caem no mesmo caminho de recusa.
const PUBLISHABLE_KEY = /^sb_publishable_[\w-]{1,256}$/;
const ACCESS_TOKEN = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const FAILURE: PostgrestRead = { ok: false };

/** Lê o corpo contando bytes; `null` acima do teto. Sair do for-await cancela o resto do stream. */
async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) return null;
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

/** `application/json`, com ou sem parâmetros (o PostgREST manda `; charset=utf-8`). */
function isJson(contentType: string | null): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

export function createPostgrestUserClient(config: PostgrestUserClientConfig): PostgrestUserClient {
  if (!PUBLISHABLE_KEY.test(config.publishableKey)) throw new PostgrestClientConfigError();
  const base = new URL("/rest/v1/", config.url);
  const { publishableKey } = config;
  const timeoutMs = config.timeoutMs ?? POSTGREST_CLIENT_POLICY.timeoutMs;

  return {
    async select(table, query, accessToken, signal) {
      // Token fora da forma nem sai daqui (e nunca vira cabeçalho com quebra de linha).
      if (accessToken.length > POSTGREST_CLIENT_POLICY.accessTokenMaxChars || !ACCESS_TOKEN.test(accessToken)) {
        return FAILURE;
      }
      const endpoint = new URL(table, base);
      // URLSearchParams codifica cada valor: um filtro não injeta outro parâmetro.
      endpoint.search = new URLSearchParams(query).toString();
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "GET",
          headers: { apikey: publishableKey, authorization: `Bearer ${accessToken}`, accept: "application/json" },
          // Seguir um redirecionamento levaria o token do usuário para outro host.
          redirect: "error",
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        });
        if (response.status !== 200 || response.body === null || !isJson(response.headers.get("content-type"))) {
          await response.body?.cancel();
          return FAILURE;
        }
        const text = await readCapped(response.body, POSTGREST_CLIENT_POLICY.maxResponseBytes);
        if (text === null) return FAILURE;
        const json = parseJsonWithoutPrototypeKeys(text);
        return json.ok ? { ok: true, value: json.value } : FAILURE;
      } catch {
        return FAILURE;
      }
    },
  };
}
