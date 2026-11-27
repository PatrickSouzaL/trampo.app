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
//
// RPC (ADR-029 D3): `POST /rest/v1/rpc/<função>` com o corpo fixo `{}` e o nome numa lista fechada. Nada de quem
// chama vira URL nem argumento: a função decide tudo pelo JWT. Só o 200 com JSON de até 64 bytes vale.
//
// Insert (ADR-031 D1): `POST /rest/v1/<tabela>?columns=<lista>` com `Prefer: return=minimal`, sem `on_conflict`
// (um id repetido é recusado, nunca sobrescrito), as colunas de uma lista fechada e o mesmo teto de 32 KiB. O
// resultado se classifica só pelo status, sem ler o corpo: 201 gravada; 429 o teto do banco; 400, 403 e 409 recusa;
// o resto (5xx, prazo, rede, redirecionamento) indisponível. Nada enviado (token ou corpo fora da forma) é recusa.
//
// Upsert classificado (ADR-031 D4): o mesmo protocolo do `upsert`, com o resultado só pelo status, sem ler o corpo:
// 201 e 200 gravada; 403 (a RLS no ramo do update) e 409 (a FK composta) negada, as duas iguais; o resto
// indisponível. O `upsert` dos critérios não muda (ok verdadeiro ou falso).
import { ACCESS_TOKEN_MAX_CHARS } from "@trampo/contracts/limits";

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
  /** O mesmo teto da borda (ADR-013 D3) e do CriteriaGuard, da fonte única do contrato. */
  accessTokenMaxChars: ACCESS_TOKEN_MAX_CHARS,
  /** A resposta de um RPC é uma palavra entre aspas (ADR-029 D2): nada maior é lido. */
  rpcMaxResponseBytes: 64,
  /**
   * Os status do insert que são recusa do banco (ADR-031 §1.1, medidos na pilha local): 400 (forma), 403 (a RLS) e
   * 409 (o id repetido, `23505`). O 201 é a gravação e o 429 o teto do gatilho (`PT429`); o resto é indisponível.
   */
  insertRefusedStatuses: Object.freeze([400, 403, 409] as const),
  /**
   * Os status do upsert classificado que são "não é sua" (ADR-031 §1.1, M4, medidos na pilha local): 403 `42501` na
   * análise de outro dono que já tem avaliação, 409 `23503` na de outro dono sem avaliação ou no id que não existe.
   */
  upsertDeniedStatuses: Object.freeze([403, 409] as const),
} as const;

/** Tabelas que o cliente de usuário pode ler. Só `user_criteria` é gravável (PostgrestWritableColumns). */
export type PostgrestTable = "user_criteria" | "analyses" | "analysis_feedback";

/** Funções que o cliente de usuário pode chamar por RPC (ADR-029 D3): lista fechada, sem argumento. */
export const POSTGREST_FUNCTIONS = Object.freeze(["delete_own_account"] as const);
export type PostgrestFunction = (typeof POSTGREST_FUNCTIONS)[number];

/** Colunas que o cliente pode gravar em cada tabela (ADR-021 D4): a lista vai na URL (`columns=`) e no corpo. */
export interface PostgrestWritableColumns {
  readonly user_criteria: "user_id" | "schema_version" | "criteria" | "salary_ciphertext" | "updated_at";
  /** O `updated_at` é do banco (ADR-031 D2): não é gravável. */
  readonly analysis_feedback: "analysis_id" | "user_id" | "agreement" | "reason";
}

export type PostgrestRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
export type PostgrestWrite = { readonly ok: true } | { readonly ok: false };

export type PostgrestWritableTable = keyof PostgrestWritableColumns;

/** Colunas que o cliente pode inserir em cada tabela (ADR-031 D1): só a linha mínima da análise. */
export interface PostgrestInsertColumns {
  readonly analyses: "id" | "user_id" | "decision_path" | "verdict" | "score";
}

export type PostgrestInsertTable = keyof PostgrestInsertColumns;

/** Um `INSERT` simples, com as colunas explícitas e sem resolução de conflito. */
export interface PostgrestInsert<T extends PostgrestInsertTable> {
  readonly columns: readonly PostgrestInsertColumns[T][];
  readonly row: Readonly<Record<PostgrestInsertColumns[T], unknown>>;
}

/** O resultado do insert, só pelo status (ADR-031 D1). */
export type PostgrestInsertOutcome = "gravada" | "recusada" | "limite" | "indisponivel";

/** O resultado do upsert classificado, só pelo status (ADR-031 D4). */
export type PostgrestUpsertOutcome = "gravada" | "negada" | "indisponivel";

/** Um `INSERT ... ON CONFLICT DO UPDATE` com as colunas explícitas. */
export interface PostgrestUpsert<T extends PostgrestWritableTable> {
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
  upsert<T extends PostgrestWritableTable>(
    table: T,
    upsert: PostgrestUpsert<T>,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<PostgrestWrite>;
  /**
   * `POST /rest/v1/rpc/<name>` com o token do dono e o corpo `{}`. Devolve o JSON da resposta (até 64 bytes) só no
   * 200. Nunca rejeita, e `{ ok: false }` NÃO prova que a função não rodou.
   */
  /**
   * O mesmo `upsert`, com o resultado classificado só pelo status (ADR-031 D4). Nunca rejeita, e o corpo da resposta
   * nunca é lido.
   */
  upsertClassified<T extends PostgrestWritableTable>(
    table: T,
    upsert: PostgrestUpsert<T>,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<PostgrestUpsertOutcome>;
  rpc(name: PostgrestFunction, accessToken: string, signal?: AbortSignal): Promise<PostgrestRead>;
  /**
   * `POST /rest/v1/<table>?columns=<lista>` com o token do dono e `Prefer: return=minimal`. O corpo leva só as colunas
   * de `columns`, na ordem delas. Nunca rejeita, e o corpo da resposta nunca é lido.
   */
  insert<T extends PostgrestInsertTable>(
    table: T,
    insert: PostgrestInsert<T>,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<PostgrestInsertOutcome>;
}

export interface PostgrestUserClientConfig {
  /** Origem do projeto (a mesma `SUPABASE_URL` do JWT, ADR-013 D6). */
  readonly url: URL;
  readonly publishableKey: string;
  /** O prazo de cada chamada. Padrão: o da política (os critérios); a conta usa um maior (ADR-029 D3). */
  readonly timeoutMs?: number;
  /** O teto da leitura do `select`. Padrão: o da política; a exportação da conta usa um maior (ADR-029 D4). */
  readonly maxResponseBytes?: number;
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
const INSERT_REFUSED: ReadonlySet<number> = new Set(POSTGREST_CLIENT_POLICY.insertRefusedStatuses);
const UPSERT_DENIED: ReadonlySet<number> = new Set(POSTGREST_CLIENT_POLICY.upsertDeniedStatuses);
const FUNCTIONS: ReadonlySet<string> = new Set(POSTGREST_FUNCTIONS);

/** Token fora da forma nem sai daqui (e nunca vira cabeçalho com quebra de linha). */
function isAccessToken(accessToken: string): boolean {
  return accessToken.length <= POSTGREST_CLIENT_POLICY.accessTokenMaxChars && ACCESS_TOKEN.test(accessToken);
}

/** Só o status decide (ADR-031 D1): o corpo da resposta nunca é lido. */
function insertOutcome(status: number): PostgrestInsertOutcome {
  if (status === 201) return "gravada";
  if (status === 429) return "limite";
  return INSERT_REFUSED.has(status) ? "recusada" : "indisponivel";
}

/** Só o status decide (ADR-031 D4): o corpo da resposta nunca é lido. */
function upsertOutcome(status: number): PostgrestUpsertOutcome {
  if (UPSERT_SUCCESS.has(status)) return "gravada";
  return UPSERT_DENIED.has(status) ? "negada" : "indisponivel";
}

/** O corpo com só as colunas declaradas, ou `null` se não serializa ou passa do teto. */
function rowBody(columns: readonly string[], row: Readonly<Record<string, unknown>>): string | null {
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
  const maxResponseBytes = config.maxResponseBytes ?? POSTGREST_CLIENT_POLICY.maxResponseBytes;
  const deadline = (signal: AbortSignal | undefined): AbortSignal => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  };

  /** Só o 200 com JSON dentro do teto vale; qualquer desvio é falha, com o resto do corpo cancelado. */
  const readJson = async (response: Response, maxBytes: number): Promise<PostgrestRead> => {
    if (response.status !== 200 || response.body === null || !isJson(response.headers.get("content-type"))) {
      await response.body?.cancel();
      return FAILURE;
    }
    const text = await readCapped(response.body, maxBytes);
    if (text === null) return FAILURE;
    const json = parseJsonWithoutPrototypeKeys(text);
    return json.ok ? { ok: true, value: json.value } : FAILURE;
  };

  /**
   * O upsert em si: o status da resposta, ou `null` quando nada saiu (token ou corpo fora da forma) ou não veio resposta
   * (prazo, rede, redirecionamento). Nunca rejeita.
   */
  const sendUpsert = async <T extends PostgrestWritableTable>(
    table: T,
    upsert: PostgrestUpsert<T>,
    accessToken: string,
    signal: AbortSignal | undefined,
  ): Promise<number | null> => {
    if (!isAccessToken(accessToken)) return null;
    const body = rowBody(upsert.columns, upsert.row);
    if (body === null) return null;
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
      return response.status;
    } catch {
      return null;
    }
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
        return await readJson(response, maxResponseBytes);
      } catch {
        return FAILURE;
      }
    },

    async rpc(name, accessToken, signal) {
      // Nome fora da lista (só por coerção de tipo): nada sai, e nenhum texto vira caminho.
      if (!FUNCTIONS.has(name) || !isAccessToken(accessToken)) return FAILURE;
      try {
        const response = await fetch(new URL(`rpc/${name}`, base), {
          method: "POST",
          headers: {
            apikey: publishableKey,
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          // Sem argumento: a função decide tudo pelo JWT.
          body: "{}",
          redirect: "error",
          signal: deadline(signal),
        });
        return await readJson(response, POSTGREST_CLIENT_POLICY.rpcMaxResponseBytes);
      } catch {
        return FAILURE;
      }
    },

    async upsert(table, upsert, accessToken, signal) {
      const status = await sendUpsert(table, upsert, accessToken, signal);
      return status !== null && UPSERT_SUCCESS.has(status) ? WRITTEN : FAILURE;
    },

    async upsertClassified(table, upsert, accessToken, signal) {
      const status = await sendUpsert(table, upsert, accessToken, signal);
      return status === null ? "indisponivel" : upsertOutcome(status);
    },

    async insert(table, insert, accessToken, signal) {
      if (!isAccessToken(accessToken)) return "recusada";
      const body = rowBody(insert.columns, insert.row);
      if (body === null) return "recusada";
      const endpoint = new URL(table, base);
      endpoint.search = new URLSearchParams({ columns: insert.columns.join(",") }).toString();
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            apikey: publishableKey,
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            prefer: "return=minimal",
          },
          body,
          // Seguir um redirecionamento levaria o token e a linha do usuário para outro host.
          redirect: "error",
          signal: deadline(signal),
        });
        // O corpo nunca é lido: o erro do Postgres ecoa a linha recusada.
        await response.body?.cancel();
        return insertOutcome(response.status);
      } catch {
        return "indisponivel";
      }
    },
  };
}
