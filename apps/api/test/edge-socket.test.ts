// F1-API-01 em socket real (porta efêmera): o que o inject não exercita. Content-Length mentiroso,
// streaming, timeouts, HTTP malformado e headers grandes demais (ADR-007 D3 e D4).
import { connect } from "node:net";

import { ApiErrorSchema } from "@trampo/contracts/api";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { buildApp } from "../src/presentation/build-app.js";
import { TEST_AUTHORIZATION, acceptAll } from "./auth-fakes.js";
import type { EdgeTimeouts } from "../src/presentation/edge/timeouts.js";

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Prazos curtos para o teste caber em segundos; o teste de padrões trava os de produção. */
const FAST: Partial<EdgeTimeouts> = {
  headersTimeout: 200,
  requestTimeout: 300,
  connectionTimeout: 2_000,
  keepAliveTimeout: 300,
  connectionsCheckingInterval: 50,
};

async function listen(timeouts: Partial<EdgeTimeouts> = FAST) {
  const counts = { handler: 0 };
  const instance = buildApp({ logger: false, accessTokenVerifier: acceptAll, timeouts });
  instance.post("/probe/eco", { schema: { body: z.strictObject({ texto: z.string() }) } }, async () => {
    counts.handler += 1;
    return { ok: true };
  });
  await instance.listen({ host: "127.0.0.1", port: 0 });
  app = instance;
  const address = instance.server.address();
  if (address === null || typeof address === "string") throw new Error("sem porta");
  return { port: address.port, counts };
}

interface Exchange {
  readonly response: string;
  readonly elapsedMs: number;
}

/**
 * Abre um socket cru, escreve cada parte com o intervalo pedido e devolve tudo o que o servidor
 * mandou até fechar a conexão. Para de escrever quando a resposta começa: dado não lido no servidor
 * vira RST ao fechar, e no Windows o RST descarta a resposta ainda não lida pelo cliente.
 */
function exchange(port: number, parts: readonly string[], options: { gapMs?: number; guardMs?: number } = {}): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    let closed = false;
    const guard = setTimeout(() => {
      socket.destroy();
      reject(new Error(`o servidor não fechou a conexão em ${String(options.guardMs ?? 4_000)} ms`));
    }, options.guardMs ?? 4_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      closed = true;
      clearTimeout(guard);
      resolve({ response, elapsedMs: performance.now() - started });
    });
    void (async () => {
      for (const part of parts) {
        if (closed || response.length > 0) return;
        socket.write(part);
        if (options.gapMs !== undefined) await new Promise((r) => setTimeout(r, options.gapMs));
      }
    })();
  });
}

function parseHttp(raw: string): { status: number; headers: string; body: string } {
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, split);
  return { status: Number(head.split(" ")[1]), headers: head.toLowerCase(), body: raw.slice(split + 4) };
}

function expectApiError(body: string, code: string) {
  const parsed = ApiErrorSchema.parse(JSON.parse(body));
  expect(parsed.code).toBe(code);
  return parsed;
}

const head = (lines: readonly string[]) => `${["POST /probe/eco HTTP/1.1", "Host: 127.0.0.1", `Authorization: ${TEST_AUTHORIZATION}`, ...lines].join("\r\n")}\r\n\r\n`;

describe("413 antes de ler o corpo (socket real)", () => {
  test("Content-Length acima do limite: 413 só com os headers, sem enviar um byte do corpo", async () => {
    const { port, counts } = await listen();
    const { response } = await exchange(port, [
      head(["Content-Type: application/json", "Content-Length: 70000", "Connection: close"]),
    ]);
    const res = parseHttp(response);
    expect(res.status).toBe(413);
    expectApiError(res.body, "PAYLOAD_GRANDE_DEMAIS");
    expect(counts.handler).toBe(0);
  });

  test("chunked acima do limite: 413 durante o streaming", async () => {
    const { port, counts } = await listen();
    const chunk = (data: string) => `${data.length.toString(16)}\r\n${data}\r\n`;
    // 8 × 8.192 = exatamente o limite; o último chunk (1 byte) estoura. Ele é o último dado enviado:
    // o servidor leu tudo, então fechar não gera RST (ver exchange).
    const parts = [
      head(["Content-Type: application/json", "Transfer-Encoding: chunked", "Connection: close"]),
      ...Array.from({ length: 8 }, () => chunk("a".repeat(8_192))),
      chunk("a"),
    ];
    const { response } = await exchange(port, parts, { gapMs: 10 });
    const res = parseHttp(response);
    expect(res.status).toBe(413);
    expectApiError(res.body, "PAYLOAD_GRANDE_DEMAIS");
    expect(counts.handler).toBe(0);
  });
});

describe("Content-Length mentiroso", () => {
  test("anuncia mais do que manda: 408 no requestTimeout, como ApiError, sem handler", async () => {
    const { port, counts } = await listen();
    const { response, elapsedMs } = await exchange(port, [
      head(["Content-Type: application/json", "Content-Length: 100"]),
      '{"texto":"',
    ]);
    const res = parseHttp(response);
    expect(res.status).toBe(408);
    expect(res.headers).toContain("connection: close");
    const body = expectApiError(res.body, "PAYLOAD_INVALIDO");
    expect(body.requestId).toBeNull();
    expect(counts.handler).toBe(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(250);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  test("anuncia menos do que manda: o resto não vira corpo; 400 e handler não roda", async () => {
    const { port, counts } = await listen();
    const { response } = await exchange(port, [
      head(["Content-Type: application/json", "Content-Length: 5"]),
      '{"texto":"oi"}',
    ]);
    expect(parseHttp(response).status).toBe(400);
    expect(counts.handler).toBe(0);
  });
});

describe("timeouts explícitos", () => {
  test("headers lentos (slowloris): 408 no headersTimeout", async () => {
    const { port } = await listen();
    const { response, elapsedMs } = await exchange(port, ["POST /probe/eco HTTP/1.1\r\n", "Host: 127.0.0.1\r\n"], { gapMs: 20 });
    const res = parseHttp(response);
    expect(res.status).toBe(408);
    expectApiError(res.body, "PAYLOAD_INVALIDO");
    expect(elapsedMs).toBeLessThan(1_500);
  });

  test("socket ocioso sem enviar nada é fechado pelo connectionTimeout", async () => {
    const { port } = await listen({ ...FAST, headersTimeout: 5_000, requestTimeout: 10_000, connectionTimeout: 300 });
    const { elapsedMs } = await exchange(port, []);
    expect(elapsedMs).toBeGreaterThanOrEqual(250);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  test("keep-alive ocioso depois da resposta fecha no keepAliveTimeout", async () => {
    const { port } = await listen();
    const { response, elapsedMs } = await exchange(port, ["GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"]);
    expect(parseHttp(response).status).toBe(200);
    expect(elapsedMs).toBeGreaterThanOrEqual(250);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

describe("erros de socket como ApiError", () => {
  test("HTTP malformado: 400 PAYLOAD_INVALIDO, requestId nulo", async () => {
    const { port } = await listen();
    const { response } = await exchange(port, ["ISTO NAO E HTTP\r\n\r\n"]);
    const res = parseHttp(response);
    expect(res.status).toBe(400);
    expect(expectApiError(res.body, "PAYLOAD_INVALIDO").requestId).toBeNull();
  });

  test("headers grandes demais: 431 PAYLOAD_GRANDE_DEMAIS", async () => {
    const { port } = await listen();
    const { response } = await exchange(port, [`GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Grande: ${"a".repeat(20_000)}\r\n\r\n`]);
    const res = parseHttp(response);
    expect(res.status).toBe(431);
    expectApiError(res.body, "PAYLOAD_GRANDE_DEMAIS");
  });
});
