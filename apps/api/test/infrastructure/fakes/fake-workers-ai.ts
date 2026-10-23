// Workers AI simulada em socket real (127.0.0.1), para o adapter do ADR-020: nenhum teste toca a Cloudflare nem gasta
// neurons. Registra cada requisição (método, caminho, cabeçalhos e corpo) e responde conforme o modo: resposta
// pronta, status com cabeçalhos, bytes crus, lento, travado ou corte do socket no meio do corpo.
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type WorkersAiMode =
  | { readonly kind: "responde"; readonly status?: number; readonly body: string | Buffer; readonly headers?: Record<string, string> }
  | { readonly kind: "trava" }
  | { readonly kind: "lento"; readonly delayMs: number; readonly body: string }
  | { readonly kind: "corta" };

export interface WorkersAiRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface FakeWorkersAi {
  readonly url: URL;
  readonly requests: WorkersAiRequest[];
  mode: WorkersAiMode;
  close(): Promise<void>;
}

/** O envelope de sucesso da API (`/api/resources/ai/methods/run/`). */
export function envelope(response: unknown, usage?: unknown): string {
  return JSON.stringify({ result: usage === undefined ? { response } : { response, usage }, success: true, errors: [], messages: [] });
}

function send(response: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body);
}

export async function startFakeWorkersAi(): Promise<FakeWorkersAi> {
  const requests: WorkersAiRequest[] = [];
  const fake = { mode: { kind: "responde", body: envelope("{}") } as WorkersAiMode };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const mode = fake.mode;
      switch (mode.kind) {
        case "responde":
          send(response, mode.status ?? 200, mode.body, mode.headers);
          return;
        case "trava":
          return;
        case "lento":
          setTimeout(() => send(response, 200, mode.body), mode.delayMs);
          return;
        case "corta":
          response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
          response.write('{"result":{"response":"');
          setTimeout(() => response.socket?.destroy(), 20);
          return;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}`),
    requests,
    get mode() {
      return fake.mode;
    },
    set mode(value: WorkersAiMode) {
      fake.mode = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
