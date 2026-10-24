// Cliente REST de USUÁRIO do PostgREST do Supabase (ADR-018 D5). Sem SDK, no modelo do upstash-rest-client
// (ADR-014 D2): a chave *publishable* no `apikey` e o JWT do próprio usuário no `Authorization`, um token por
// chamada e nunca guardado. Assim a RLS vale como segunda barreira (a primeira é o filtro pelo `sub` verificado).
//
// O construtor recusa chave *secret* (`sb_secret_`) e legada (`eyJ`): este cliente nunca fura a RLS. Na leitura,
// falha fechado em qualquer desvio (status ≠ 200, redirecionamento, prazo, `content-type` que não é JSON, corpo
// acima de 32 KiB, UTF-8 ou JSON inválido, `__proto__`/`constructor`) → `{ ok: false }`. Na escrita (ADR-021 D5),
// o corpo enviado tem teto de 32 KiB e só as colunas declaradas, e só os status de sucesso fixados valem; o corpo da
// resposta nunca é lido (o erro de `check` do Postgres ecoa a linha recusada). Nunca rejeita. Nada da chave, do
// token, da URL, do corpo enviado ou da resposta vai para log ou mensagem de erro.
import { parseJsonWithoutPrototypeKeys } from "../../application/llm/llm-output-guard.js";

export const POSTGREST_CLIENT_POLICY = {
  /** Teto de cada chamada. O CriteriaGuard tem 1.000 ms (ADR-018 D6); este é o cinto por baixo dele. */
  timeoutMs: 900,
  maxResponseBytes: 32 * 1024,
  /** O mesmo teto da leitura, para o corpo enviado no `upsert` (ADR-021 D3). */
  maxRequestBytes: 32 * 1024,
  /**
   * Os status de sucesso do `upsert` com `return=minimal`, fixados contra o PostgREST real pelo `test:db` (ADR-021
   * D5 e §5.6): 201 quando a linha é inserida e 200 quando a linha em conflito é atualizada. Nenhum outro vale.
   */
  upsertSuccessStatuses: Object.freeze([201, 200] as const),
  /** O mesmo teto da borda (ADR-013 D3) e do CriteriaGuard. */
  accessTokenMaxChars: 8_192,
} as const;

/** Tabelas que o cliente de usuário pode ler e gravar. Cresce com o F1-API-06. */
export type PostgrestTable = "user_criteria";

/** Colunas que o cliente pode gravar em cada tabela (ADR-021 D4): a lista vai na URL (`columns=`) e no corpo. */
export interface PostgrestWritableColumns {
  readonly user_criteria: "user_id" | "schema_version" | "criteria" | "salary_ciphertext" | "updated_at";
}

export type PostgrestRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
export type PostgrestWrite = { readonly ok: true } | { readonly ok: false };

/** Um `INSERT ... ON CONFLICT DO UPDATE` com as colunas explícitas. */
export interface PostgrestUpsert<T extends PostgrestTable> {
  readonly columns: readonly PostgrestWritableColumns[T][];
  readonly onConflict: PostgrestWritableColumns[T];
  readonly row: Readonly<Record<PostgrestWritableColumns[T], unknown>>;
}

export interface PostgrestUserClient {
  /** `GET /rest/v1/<table>?<query>` com o token do dono. Nunca rejeita. */
  select(
    table: PostgrestTable,
    query: Readonly<Record<string, string>>,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<PostgrestRead>;
  /**
   * `POST /rest/v1/<table>?on_conflict=<coluna>&columns=<lista>` com o token do dono e
   * `Prefer: resolution=merge-duplicates,return=minimal`. O corpo leva só as colunas de `columns`, na ordem delas,
   * mesmo que `row` traga outras chaves. Nunca rejeita.
   */
  upsert<T extends PostgrestTable>(
    table: T,
    upsert: PostgrestUpsert<T>,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<PostgrestWrite>;
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
const FAILURE = { ok: false } as const;
const WRITTEN: PostgrestWrite = { ok: true };
const UPSERT_PREFER = "resolution=merge-duplicates,return=minimal";
const UPSERT_SUCCESS: ReadonlySet<number> = new Set(POSTGREST_CLIENT_POLICY.upsertSuccessStatuses);

/** Token fora da forma nem sai daqui (e nunca vira cabeçalho com quebra de linha). */
function isAccessToken(accessToken: string): boolean {
  return accessToken.length <= POSTGREST_CLIENT_POLICY.accessTokenMaxChars && ACCESS_TOKEN.test(accessToken);
}

/** O corpo com só as colunas declaradas, ou `null` se não serializa ou passa do teto. */
function upsertBody(columns: readonly string[], row: Readonly<Record<string, unknown>>): string | null {
  try {
    const body = JSON.stringify(Object.fromEntries(columns.map((column) => [column, row[column]])));
    return Buffer.byteLength(body, "utf8") <= POSTGREST_CLIENT_POLICY.maxRequestBytes ? body : null;
  } catch {
    // Valor cíclico ou BigInt: nada é enviado.
    return null;
  }
}

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
  const deadline = (signal: AbortSignal | undefined): AbortSignal => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  };

  return {
    async select(table, query, accessToken, signal) {
      if (!isAccessToken(accessToken)) return FAILURE;
      const endpoint = new URL(table, base);
      // URLSearchParams codifica cada valor: um filtro não injeta outro parâmetro.
      endpoint.search = new URLSearchParams(query).toString();
      try {
        const response = await fetch(endpoint, {
          method: "GET",
          headers: { apikey: publishableKey, authorization: `Bearer ${accessToken}`, accept: "application/json" },
          // Seguir um redirecionamento levaria o token do usuário para outro host.
          redirect: "error",
          signal: deadline(signal),
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

    async upsert(table, upsert, accessToken, signal) {
      if (!isAccessToken(accessToken)) return FAILURE;
      const body = upsertBody(upsert.columns, upsert.row);
      if (body === null) return FAILURE;
      const endpoint = new URL(table, base);
      endpoint.search = new URLSearchParams({ on_conflict: upsert.onConflict, columns: upsert.columns.join(",") }).toString();
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            apikey: publishableKey,
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            prefer: UPSERT_PREFER,
          },
          body,
          // Seguir um redirecionamento levaria o token e os critérios do usuário para outro host.
          redirect: "error",
          signal: deadline(signal),
        });
        // O corpo nunca é lido: o `details` de um erro de `check` traz a linha recusada inteira.
        await response.body?.cancel();
        return UPSERT_SUCCESS.has(response.status) ? WRITTEN : FAILURE;
      } catch {
        return FAILURE;
      }
    },
  };
}
