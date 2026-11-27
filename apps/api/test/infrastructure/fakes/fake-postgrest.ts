// PostgREST do Supabase simulado em socket real (127.0.0.1), para o cliente de usuário (ADR-018 D5 e D7): nenhum
// teste toca o Supabase real nem precisa de Docker. Imita a RLS do D3: o token identifica o dono, e a leitura só
// devolve as linhas dele que casam com o filtro `user_id=eq.<uuid>`. O upsert (ADR-021 D5) guarda só as colunas de
// `columns=`, recusa com 403 a linha de outro dono (a RLS do insert e do update) e substitui a linha em conflito
// por `user_id`, respondendo sem corpo 201 na inserção e 200 na atualização, como o real. Modos de falha: lento, travado, status, corpo arbitrário (com
// `content-type` escolhido), corpo gigante, redirecionamento, socket cortado e corpo que nunca termina. Registra cada requisição, com o
// corpo cru recebido (para os canários).
//
// Conta (ADR-029): `GET /rest/v1/analyses` e `/rest/v1/analysis_feedback` com a mesma RLS, o filtro e o `limit`, e
// `POST /rest/v1/rpc/delete_own_account`, que só aceita o corpo `{}` (com argumento, 404 `PGRST202`, como o real),
// devolve a palavra de `deleteResult` e, com `excluida`, apaga as linhas do dono nas três tabelas.
//
// Análises (ADR-031 D1 e §1.1): `POST /rest/v1/analyses` guarda só as colunas de `columns=` e responde como o real
// (medido na pilha local): 201 sem corpo; 403 `42501` com a linha de outro dono (a RLS); 409 `23505` com o id
// repetido (nada é sobrescrito); 429 `PT429` com o teto do dono (`analysesCap`, o gatilho do banco).
//
// Feedback (ADR-031 D4, M3 e M4): `POST /rest/v1/analysis_feedback?on_conflict=analysis_id` como o real: 201 na
// inserção e 200 na atualização; na análise de outro dono que já tem avaliação, 403 `42501` (o ramo do update bate na
// RLS); na de outro dono sem avaliação, ou num id que não existe, 409 `23503` (a FK composta).
//
// Exportação paginada (ADR-031 D5): o `GET` das duas listas respeita o `order` (chaves em ordem decrescente), o filtro
// `or` do cursor de chave composta (`(k.lt."v",and(k.eq."v",i.lt.id))`) e o `max_rows` de 1.000 do PostgREST real.
//
// Opcionalmente serve o JWKS do Auth no mesmo host (o teste de boot usa uma SUPABASE_URL só).
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { JWK } from "jose";

export type PostgrestMode =
  | { readonly kind: "normal" }
  | { readonly kind: "lento"; readonly delayMs: number }
  | { readonly kind: "trava" }
  | { readonly kind: "status"; readonly status: number; readonly body?: string }
  | { readonly kind: "corpo"; readonly body: string | Buffer; readonly contentType?: string | null }
  | { readonly kind: "grande"; readonly bytes: number }
  | { readonly kind: "redireciona"; readonly location: string }
  | { readonly kind: "corta" }
  /** Cabeçalho e um pedaço do corpo, que nunca termina: só quem lê o corpo fica preso. */
  | { readonly kind: "sem_fim"; readonly status: number; readonly chunk: string };

export interface PostgrestRequest {
  readonly method: string;
  readonly url: string;
  readonly apikey: string | undefined;
  readonly authorization: string | undefined;
  readonly accept: string | undefined;
  readonly contentType: string | undefined;
  readonly prefer: string | undefined;
  /** O corpo exatamente como chegou ao socket. */
  readonly body: string;
}

/** A linha como o PostgREST a guarda (as colunas do ADR-018 D2). */
export interface CriteriaRow {
  readonly user_id: string;
  readonly schema_version: number;
  readonly criteria: unknown;
  readonly salary_ciphertext: string;
  readonly updated_at?: string;
}

/** Uma linha de `analyses` ou de `analysis_feedback`: o dono e as colunas como o PostgREST as devolve. */
export type OwnedRow = Readonly<Record<string, unknown>> & { readonly user_id: string };

export interface FakePostgrest {
  readonly url: URL;
  readonly requests: PostgrestRequest[];
  /** Linhas de `user_criteria`. */
  readonly rows: CriteriaRow[];
  /** Linhas de `analyses` e de `analysis_feedback`, na ordem em que o banco as devolveria. */
  readonly analyses: OwnedRow[];
  readonly feedback: OwnedRow[];
  /** O que a função `delete_own_account` devolve (qualquer JSON, para os casos fora do contrato). */
  deleteResult: unknown;
  /** O teto de linhas do dono em `analyses` (o gatilho do banco, ADR-031 D2): acima dele, 429 `PT429`. */
  analysesCap: number;
  /** O `max_rows` do PostgREST (1.000 na pilha do Supabase): nenhuma leitura devolve mais que isto. */
  maxRows: number;
  /** O dono de cada chamada aceita do RPC. */
  readonly deletions: string[];
  /** Token → dono (o `auth.uid()` da RLS). */
  readonly sessions: Map<string, string>;
  mode: PostgrestMode;
  jwks: JWK[] | null;
  close(): Promise<void>;
}

const JWKS_PATH = "/auth/v1/.well-known/jwks.json";

/** Um `timestamptz` como o Postgres o guarda: microssegundos desde a época, ou `null` se o texto não é data. */
function microseconds(value: string): bigint | null {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (match === null) return null;
  const [, base = "", fraction = "", zone = ""] = match;
  return BigInt(Date.parse(`${base}${zone}`)) * 1_000n + BigInt(fraction.padEnd(6, "0"));
}

/** Compara como o Postgres: datas pelo instante (o formato e o fuso não importam); o resto como texto. */
function compareValues(a: string, b: string): number {
  const [x, y] = [microseconds(a), microseconds(b)];
  if (x !== null && y !== null) return x === y ? 0 : x < y ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function send(response: ServerResponse, status: number, body: string | Buffer, contentType: string | null = "application/json; charset=utf-8"): void {
  response.writeHead(status, contentType === null ? {} : { "content-type": contentType });
  response.end(body);
}

export async function startFakePostgrest(publishableKey: string): Promise<FakePostgrest> {
  const requests: PostgrestRequest[] = [];
  const rows: CriteriaRow[] = [];
  const analyses: OwnedRow[] = [];
  const feedback: OwnedRow[] = [];
  const deletions: string[] = [];
  const sessions = new Map<string, string>();
  const fake = { mode: { kind: "normal" } as PostgrestMode, jwks: null as JWK[] | null, deleteResult: "excluida" as unknown, analysesCap: 100, maxRows: 1_000 };
  const lists: Readonly<Record<string, OwnedRow[]>> = { "/rest/v1/analyses": analyses, "/rest/v1/analysis_feedback": feedback };
  const RPC_PATH = "/rest/v1/rpc/delete_own_account";
  /** Tira do array, no lugar, as linhas do dono. */
  const dropOwned = (list: Array<{ readonly user_id: string }>, owner: string): void => {
    for (let index = list.length - 1; index >= 0; index -= 1) if (list[index]?.user_id === owner) list.splice(index, 1);
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake");
      if (url.pathname === JWKS_PATH && fake.jwks !== null) return send(response, 200, JSON.stringify({ keys: fake.jwks }));
      const header = (name: string): string | undefined => {
        const value = request.headers[name];
        return Array.isArray(value) ? value.join(",") : value;
      };
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        apikey: header("apikey"),
        authorization: header("authorization"),
        accept: header("accept"),
        contentType: header("content-type"),
        prefer: header("prefer"),
        body,
      });
      const mode = fake.mode;
      if (mode.kind === "trava") return;
      if (mode.kind === "corta") return request.socket.destroy();
      if (mode.kind === "sem_fim") {
        response.writeHead(mode.status, { "content-type": "application/json" });
        response.write(mode.chunk);
        return;
      }
      if (mode.kind === "lento") await new Promise((resolve) => setTimeout(resolve, mode.delayMs));
      if (mode.kind === "status") return send(response, mode.status, mode.body ?? '{"message":"erro"}');
      if (mode.kind === "corpo") return send(response, 200, mode.body, mode.contentType);
      if (mode.kind === "grande") return send(response, 200, `[${" ".repeat(mode.bytes)}]`);
      if (mode.kind === "redireciona") {
        response.writeHead(307, { location: mode.location });
        return response.end();
      }
      const method = request.method ?? "";
      const list = method === "GET" ? lists[url.pathname] : undefined;
      const rpc = method === "POST" && url.pathname === RPC_PATH;
      const analysisInsert = method === "POST" && url.pathname === "/rest/v1/analyses";
      const feedbackUpsert = method === "POST" && url.pathname === "/rest/v1/analysis_feedback";
      if (list === undefined && !rpc && !analysisInsert && !feedbackUpsert && (!["GET", "POST"].includes(method) || url.pathname !== "/rest/v1/user_criteria")) {
        return send(response, 404, '{"message":"not found"}');
      }
      if (header("apikey") !== publishableKey) return send(response, 401, '{"message":"Invalid API key"}');
      const owner = sessions.get((header("authorization") ?? "").replace(/^Bearer /, ""));
      if (owner === undefined) return send(response, 401, '{"message":"JWT invalid"}');
      if (rpc) {
        // A função não tem parâmetro: qualquer argumento é outra função, que não existe.
        if (body !== "{}") return send(response, 404, '{"code":"PGRST202","message":"Could not find the function"}');
        deletions.push(owner);
        if (fake.deleteResult === "excluida") for (const owned of [rows, analyses, feedback]) dropOwned(owned, owner);
        return send(response, 200, JSON.stringify(fake.deleteResult));
      }
      if (analysisInsert) {
        // Só as chaves de `columns=`, como o PostgREST; depois a RLS, a chave primária e o gatilho do teto.
        const listed = (url.searchParams.get("columns") ?? "").split(",");
        const sent = JSON.parse(body) as Record<string, unknown>;
        const row = Object.fromEntries(listed.filter((column) => column in sent).map((column) => [column, sent[column]])) as OwnedRow;
        if (row.user_id !== owner) return send(response, 403, '{"code":"42501","message":"new row violates row-level security policy"}');
        if (analyses.some((existing) => existing["id"] === row["id"])) return send(response, 409, '{"code":"23505","message":"duplicate key value violates unique constraint"}');
        if (analyses.filter((existing) => existing.user_id === owner).length >= fake.analysesCap) {
          return send(response, 429, '{"code":"PT429","message":"analises_limite_diario"}');
        }
        analyses.push({ ...row, created_at: new Date().toISOString() });
        return send(response, 201, "", null);
      }
      if (feedbackUpsert) {
        const listed = (url.searchParams.get("columns") ?? "").split(",");
        const sent = JSON.parse(body) as Record<string, unknown>;
        const row = Object.fromEntries(listed.filter((column) => column in sent).map((column) => [column, sent[column]])) as OwnedRow;
        const updatedAt = new Date().toISOString();
        const owned = analyses.some((analysis) => analysis["id"] === row["analysis_id"] && analysis.user_id === row.user_id);
        const existing = feedback.findIndex((entry) => entry["analysis_id"] === row["analysis_id"]);
        // A RLS do insert e do update (`auth.uid() = user_id`), inclusive no ramo do update da linha de outro dono.
        if (row.user_id !== owner || (existing !== -1 && feedback[existing]?.user_id !== owner)) {
          return send(response, 403, '{"code":"42501","message":"new row violates row-level security policy"}');
        }
        // A FK composta (analysis_id, user_id): só a análise do mesmo dono.
        if (!owned) return send(response, 409, '{"code":"23503","message":"insert or update violates foreign key constraint"}');
        if (existing === -1) {
          feedback.push({ ...row, updated_at: updatedAt });
          return send(response, 201, "", null);
        }
        feedback[existing] = { ...feedback[existing], ...row, updated_at: updatedAt };
        return send(response, 200, "", null);
      }
      if (list !== undefined) {
        const wanted = url.searchParams.get("user_id");
        const limit = Math.min(Number(url.searchParams.get("limit") ?? String(fake.maxRows)), fake.maxRows);
        const listed = (url.searchParams.get("select") ?? "").split(",");
        // `order=a.desc,b.asc`: cada chave na sua direção, com as datas comparadas como o Postgres (em microssegundos).
        const keys = (url.searchParams.get("order") ?? "")
          .split(",")
          .filter((part) => part.endsWith(".desc") || part.endsWith(".asc"))
          .map((part) => ({ key: part.slice(0, part.lastIndexOf(".")), direction: part.endsWith(".desc") ? -1 : 1 }));
        const ordered = [...list].sort((a, b) => {
          for (const { key, direction } of keys) {
            const order = compareValues(String(a[key]), String(b[key]));
            if (order !== 0) return order * direction;
          }
          return 0;
        });
        // O cursor de chave composta: `(k.lt."v",and(k.eq."v",i.lt.id))`. Qualquer outra forma é 400, como o real.
        const or = url.searchParams.get("or");
        const cursor = or === null ? null : /^\((\w+)\.lt\."([^"]+)",and\(\1\.eq\."\2",(\w+)\.lt\.([0-9a-f-]{36})\)\)$/.exec(or);
        if (or !== null && cursor === null) return send(response, 400, '{"code":"PGRST100","message":"failed to parse logic tree"}');
        const after = (row: OwnedRow): boolean => {
          if (cursor === null) return true;
          const [, key = "", value = "", idKey = "", id = ""] = cursor;
          const order = compareValues(String(row[key]), value);
          return order < 0 || (order === 0 && compareValues(String(row[idKey]), id) < 0);
        };
        const visible = ordered.filter((row) => row.user_id === owner && wanted === `eq.${row.user_id}` && after(row)).slice(0, limit);
        return send(response, 200, JSON.stringify(visible.map((row) => Object.fromEntries(listed.filter((column) => column in row).map((column) => [column, row[column]])))));
      }
      if (method === "POST") {
        // O PostgREST só olha as chaves de `columns=`; as outras do corpo são ignoradas.
        const listed = (url.searchParams.get("columns") ?? "").split(",");
        const sent = JSON.parse(body) as Record<string, unknown>;
        const row = Object.fromEntries(listed.filter((column) => column in sent).map((column) => [column, sent[column]])) as unknown as CriteriaRow;
        // A RLS do insert e do update (`with check (auth.uid() = user_id)`).
        if (row.user_id !== owner) return send(response, 403, '{"code":"42501","message":"new row violates row-level security policy"}');
        const conflict = url.searchParams.get("on_conflict") === "user_id" ? rows.findIndex((existing) => existing.user_id === row.user_id) : -1;
        // Como o PostgREST real (fixado pelo test:db, ADR-021 §5.6): 201 na inserção e 200 na atualização.
        if (conflict === -1) {
          rows.push(row);
          return send(response, 201, "", null);
        }
        rows[conflict] = { ...rows[conflict], ...row };
        return send(response, 200, "", null);
      }
      // A RLS (`auth.uid() = user_id`) e depois o filtro da consulta.
      const filter = url.searchParams.get("user_id");
      const visible = rows.filter((row) => row.user_id === owner && filter === `eq.${row.user_id}`);
      const columns = (url.searchParams.get("select") ?? "").split(",");
      const projected = visible.map((row) =>
        Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column as keyof CriteriaRow]])),
      );
      return send(response, 200, JSON.stringify(projected));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return Object.assign(fake, {
    url: new URL(`http://127.0.0.1:${port}`),
    requests,
    rows,
    analyses,
    feedback,
    deletions,
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
