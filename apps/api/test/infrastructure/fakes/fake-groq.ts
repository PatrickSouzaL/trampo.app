// Groq simulado em socket real (127.0.0.1), para o adapter do ADR-022: nenhum teste toca o Groq nem gasta cota.
// Registra cada requisição (método, caminho, cabeçalhos e corpo) e responde conforme o modo: resposta pronta, status
// com cabeçalhos, lento, travado ou corte do socket no meio do corpo.
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type GroqMode =
  | { readonly kind: "responde"; readonly status?: number; readonly body: string | Buffer; readonly headers?: Record<string, string> }
  | { readonly kind: "trava" }
  | { readonly kind: "lento"; readonly delayMs: number; readonly body: string }
  | { readonly kind: "corta" };

export interface GroqRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface FakeGroq {
  readonly url: URL;
  readonly requests: GroqRequest[];
  mode: GroqMode;
  close(): Promise<void>;
}

export interface CompletionOptions {
  readonly finishReason?: string;
  readonly usage?: unknown;
  /** Campos extras da mensagem (`reasoning`, `tool_calls`…). */
  readonly message?: Record<string, unknown>;
  /** Campos extras do envelope (`x_groq`, `system_fingerprint`…). */
  readonly extra?: Record<string, unknown>;
}

/** O envelope de sucesso do `chat/completions` no formato OpenAI, como o S-1 mediu. */
export function completion(content: string | null, options: CompletionOptions = {}): string {
  return JSON.stringify({
    id: "chatcmpl-simulado",
    object: "chat.completion",
    model: "openai/gpt-oss-20b",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...options.message },
        finish_reason: options.finishReason ?? "stop",
      },
    ],
    ...(options.usage === undefined
      ? { usage: { prompt_tokens: 2_400, completion_tokens: 380, completion_tokens_details: { reasoning_tokens: 120 } } }
      : options.usage === null
        ? {}
        : { usage: options.usage }),
    ...options.extra,
  });
}

function send(response: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body);
}

export async function startFakeGroq(): Promise<FakeGroq> {
  const requests: GroqRequest[] = [];
  const fake = { mode: { kind: "responde", body: completion("{}") } as GroqMode };
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
          response.write('{"choices":[{"message":{"content":"');
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
    set mode(value: GroqMode) {
      fake.mode = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
