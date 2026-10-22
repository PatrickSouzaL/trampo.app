// PostgREST do Supabase simulado em socket real (127.0.0.1), para o cliente de usuário (ADR-018 D5 e D7): nenhum
// teste toca o Supabase real nem precisa de Docker. Imita a RLS do D3: o token identifica o dono, e a leitura só
// devolve as linhas dele que casam com o filtro `user_id=eq.<uuid>`. Modos de falha: lento, travado, status,
// corpo arbitrário (com `content-type` escolhido), corpo gigante e redirecionamento. Registra cada requisição.
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
  | { readonly kind: "redireciona"; readonly location: string };

export interface PostgrestRequest {
  readonly method: string;
  readonly url: string;
  readonly apikey: string | undefined;
  readonly authorization: string | undefined;
  readonly accept: string | undefined;
}

/** A linha como o PostgREST a guarda (as colunas do ADR-018 D2). */
export interface CriteriaRow {
  readonly user_id: string;
  readonly schema_version: number;
  readonly criteria: unknown;
  readonly salary_ciphertext: string;
}

export interface FakePostgrest {
  readonly url: URL;
  readonly requests: PostgrestRequest[];
  /** Linhas de `user_criteria`. */
  readonly rows: CriteriaRow[];
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
  const sessions = new Map<string, string>();
  const fake = { mode: { kind: "normal" } as PostgrestMode, jwks: null as JWK[] | null };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake");
      if (url.pathname === JWKS_PATH && fake.jwks !== null) return send(response, 200, JSON.stringify({ keys: fake.jwks }));
      const header = (name: string): string | undefined => {
        const value = request.headers[name];
        return Array.isArray(value) ? value.join(",") : value;
      };
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        apikey: header("apikey"),
        authorization: header("authorization"),
        accept: header("accept"),
      });
      const mode = fake.mode;
      if (mode.kind === "trava") return;
      if (mode.kind === "lento") await new Promise((resolve) => setTimeout(resolve, mode.delayMs));
      if (mode.kind === "status") return send(response, mode.status, mode.body ?? '{"message":"erro"}');
      if (mode.kind === "corpo") return send(response, 200, mode.body, mode.contentType);
      if (mode.kind === "grande") return send(response, 200, `[${" ".repeat(mode.bytes)}]`);
      if (mode.kind === "redireciona") {
        response.writeHead(307, { location: mode.location });
        return response.end();
      }
      if (request.method !== "GET" || url.pathname !== "/rest/v1/user_criteria") return send(response, 404, '{"message":"not found"}');
      if (header("apikey") !== publishableKey) return send(response, 401, '{"message":"Invalid API key"}');
      const owner = sessions.get((header("authorization") ?? "").replace(/^Bearer /, ""));
      if (owner === undefined) return send(response, 401, '{"message":"JWT invalid"}');
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
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
