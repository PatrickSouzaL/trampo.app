// Upstash simulado em socket real (127.0.0.1), com o protocolo REST de `/multi-exec` e modos de falha
// (ADR-014 §3, itens 1 e 5): lento, travado, status de erro, corpo arbitrário, erro num comando, corpo gigante e
// redirecionamento. Registra método, caminho, Authorization e comandos de cada requisição.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { RedisStore } from "./redis-store.js";

export type UpstashMode =
  | { readonly kind: "normal" }
  | { readonly kind: "lento"; readonly delayMs: number }
  | { readonly kind: "trava" }
  | { readonly kind: "status"; readonly status: number; readonly body?: string }
  | { readonly kind: "corpo"; readonly body: string | Buffer }
  | { readonly kind: "erro_em"; readonly index: number }
  | { readonly kind: "grande"; readonly bytes: number }
  | { readonly kind: "redireciona"; readonly location: string };

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly commands: unknown;
}

export interface FakeUpstash {
  readonly url: URL;
  readonly store: RedisStore;
  readonly requests: RecordedRequest[];
  mode: UpstashMode;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: string | Buffer): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

export async function startFakeUpstash(token: string, store = new RedisStore()): Promise<FakeUpstash> {
  const requests: RecordedRequest[] = [];
  const fake = { mode: { kind: "normal" } as UpstashMode };

  const server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      let commands: unknown = null;
      try {
        commands = JSON.parse(raw);
      } catch {
        commands = raw;
      }
      requests.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization, commands });
      const mode = fake.mode;
      if (mode.kind === "trava") return;
      if (mode.kind === "lento") await new Promise((resolve) => setTimeout(resolve, mode.delayMs));
      if (mode.kind === "status") return send(response, mode.status, mode.body ?? '{"error":"ERR"}');
      if (mode.kind === "corpo") return send(response, 200, mode.body);
      if (mode.kind === "grande") return send(response, 200, `[${'{"result":1},'.repeat(Math.ceil(mode.bytes / 13))}{"result":1}]`);
      if (mode.kind === "redireciona") {
        response.writeHead(307, { location: mode.location });
        return response.end();
      }
      if (request.method !== "POST" || request.url !== "/multi-exec") return send(response, 404, '{"error":"not found"}');
      if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, '{"error":"WRONGPASS invalid password"}');
      if (!Array.isArray(commands)) return send(response, 400, '{"error":"ERR syntax"}');
      const items = store.transaction(commands as unknown[][]);
      if (mode.kind === "erro_em") items[mode.index] = { error: "ERR simulado" };
      return send(response, 200, JSON.stringify(items));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return Object.assign(fake, {
    url: new URL(`http://127.0.0.1:${port}`),
    store,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
