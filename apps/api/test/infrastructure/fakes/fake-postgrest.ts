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
  /** O dono de cada chamada aceita do RPC. */
  readonly deletions: string[];
  /** Token → dono (o `auth.uid()` da RLS). */
  readonly sessions: Map<string, string>;
  mode: PostgrestMode;
  jwks: JWK[] | null;
  close(): Promise<void>;
}

const JWKS_PATH = "/auth/v1/.well-known/jwks.json";

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
  const fake = { mode: { kind: "normal" } as PostgrestMode, jwks: null as JWK[] | null, deleteResult: "excluida" as unknown };
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
      if (list === undefined && !rpc && (!["GET", "POST"].includes(method) || url.pathname !== "/rest/v1/user_criteria")) {
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
      if (list !== undefined) {
        const wanted = url.searchParams.get("user_id");
        const limit = Number(url.searchParams.get("limit") ?? "1000");
        const listed = (url.searchParams.get("select") ?? "").split(",");
        const visible = list.filter((row) => row.user_id === owner && wanted === `eq.${row.user_id}`).slice(0, limit);
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
