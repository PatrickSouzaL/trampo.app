// Cliente da API no portal (ADR-028 D2): a tabela de classificação inteira, a lista fechada de cabeçalhos, o destino
// fixo e os tetos, contra a API simulada em socket real.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { CRITERIA_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { API_CLIENT_POLICY, createApiClient, type ApiClient } from "../../src/server/api-client";
import { apiErrorBody, startFakeApi, type FakeApi } from "../support/fake-api";
import { SALARY_CANARY, fullCriteria } from "../support/criteria-fixtures";

const OWNER = "7c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5";
const TOKEN = "aaa.bbb.ccc";
let api: FakeApi;
let client: ApiClient;

beforeAll(async () => {
  api = await startFakeApi({ owner: (token) => (token === TOKEN ? OWNER : null) });
});
afterAll(() => api.close());
beforeEach(() => {
  api.mode = { kind: "normal" };
  api.requests.length = 0;
  api.rows.clear();
  client = createApiClient({ apiOrigin: api.url.origin, timeoutMs: 400 });
});

/** Um servidor de uma resposta só, para as formas que a API simulada não emite. */
async function oneShot(handler: (response: import("node:http").ServerResponse) => void): Promise<{ origin: string; server: Server }> {
  const server = createServer((_request, response) => handler(response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

describe("política (ADR-028 D2)", () => {
  it("prazo de 5 s e teto de 32 KiB", () => {
    expect(API_CLIENT_POLICY).toEqual({ timeoutMs: 5_000, maxResponseBytes: 32 * 1024 });
  });

  it("recusa origem fora da forma no boot, sem repetir o valor", () => {
    for (const origin of ["http://api.exemplo.invalid", "https://api.exemplo.invalid/", "nada"]) {
      expect(() => createApiClient({ apiOrigin: origin })).toThrow(/^API_ORIGIN precisa ser uma origem exata$/);
    }
    expect(() => createApiClient({ apiOrigin: "https://api.exemplo.invalid" })).not.toThrow();
  });
});

describe("readCriteria (GET /v1/criteria)", () => {
  it("200: os critérios do dono, com a pretensão", async () => {
    api.rows.set(OWNER, fullCriteria());
    const result = await client.readCriteria(TOKEN);
    expect(result).toEqual({ ok: true, criteria: fullCriteria() });
  });

  it("409 CRITERIOS_NAO_CONFIGURADOS: ok com null (nunca salvou)", async () => {
    expect(await client.readCriteria(TOKEN)).toEqual({ ok: true, criteria: null });
  });

  it("401 NAO_AUTENTICADO com o corpo da API: recusado", async () => {
    expect(await client.readCriteria("xxx.yyy.zzz")).toEqual({ ok: false, reason: "recusado" });
  });

  it("cabeçalhos em lista fechada, destino fixo, sem corpo e sem cache", async () => {
    await client.readCriteria(TOKEN);
    const request = api.requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe("/v1/criteria");
    expect(request?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers["accept"]).toBe("application/json");
    for (const name of ["cookie", "origin", "referer", "x-forwarded-for", "x-real-ip", "forwarded", "content-type", "apikey"]) {
      expect(request?.headers[name], name).toBeUndefined();
    }
    expect(request?.body).toBe("");
  });

  it.each([
    ["401 sem o corpo da API", { kind: "responde", status: 401, body: "{}" }],
    ["401 com outro código", { kind: "responde", status: 401, code: "PROIBIDO" }],
    ["409 com outro código", { kind: "responde", status: 409, code: "PROIBIDO" }],
    ["403 da borda (CORS)", { kind: "responde", status: 403, code: "PROIBIDO" }],
    ["429", { kind: "responde", status: 429, code: "LIMITE_DE_TAXA", retryAfter: 30 }],
    ["503", { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" }],
    ["500", { kind: "responde", status: 500, code: "ERRO_INTERNO" }],
    ["400", { kind: "responde", status: 400, code: "PAYLOAD_INVALIDO" }],
    ["204", { kind: "responde", status: 204, body: "", contentType: null }],
    ["200 fora do contrato", { kind: "responde", status: 200, body: JSON.stringify({ schemaVersion: 1 }) }],
    ["200 em texto", { kind: "responde", status: 200, body: "{}", contentType: "text/plain" }],
    ["200 com chave de protótipo", { kind: "responde", status: 200, body: JSON.stringify(fullCriteria()).replace('{"schemaVersion"', '{"__proto__":{},"schemaVersion"') }],
    ["200 que não é JSON", { kind: "responde", status: 200, body: "não é json" }],
    ["redirecionamento", { kind: "redireciona", location: "https://outro.exemplo.invalid/v1/criteria" }],
    ["trava (prazo)", { kind: "trava" }],
    ["corta no meio", { kind: "corta" }],
  ] as const)("%s: nao_recebido", async (_label, mode) => {
    api.rows.set(OWNER, fullCriteria());
    api.mode = mode;
    expect(await client.readCriteria(TOKEN)).toEqual({ ok: false, reason: "nao_recebido" });
    // Nenhuma nova tentativa: a página só lê uma vez.
    expect(api.requests).toHaveLength(1);
  });

  it("200 com UTF-8 inválido de verdade (bytes): nao_recebido", async () => {
    const { origin, server } = await oneShot((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.from([0x7b, 0xff, 0x7d]));
    });
    try {
      expect(await createApiClient({ apiOrigin: origin }).readCriteria(TOKEN)).toEqual({ ok: false, reason: "nao_recebido" });
    } finally {
      await closeServer(server);
    }
  });

  it("resposta acima de 32 KiB: nao_recebido, sem ler o resto", async () => {
    const { origin, server } = await oneShot((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`"${"x".repeat(API_CLIENT_POLICY.maxResponseBytes)}"`);
    });
    try {
      expect(await createApiClient({ apiOrigin: origin }).readCriteria(TOKEN)).toEqual({ ok: false, reason: "nao_recebido" });
    } finally {
      await closeServer(server);
    }
  });

  it("conexão recusada: nao_recebido", async () => {
    const { origin, server } = await oneShot(() => undefined);
    await closeServer(server);
    expect(await createApiClient({ apiOrigin: origin }).readCriteria(TOKEN)).toEqual({ ok: false, reason: "nao_recebido" });
  });

  it("token fora da forma ou sinal já abortado: nao_recebido sem rede", async () => {
    expect(await client.readCriteria("nao-e-jws")).toEqual({ ok: false, reason: "nao_recebido" });
    expect(await client.readCriteria("a".repeat(8_193))).toEqual({ ok: false, reason: "nao_recebido" });
    expect(await client.readCriteria(TOKEN, AbortSignal.abort())).toEqual({ ok: false, reason: "nao_recebido" });
    expect(api.requests).toHaveLength(0);
  });
});

describe("writeCriteria (PUT /v1/criteria)", () => {
  it("204: ok, e a API recebe o JSON do contrato com a pretensão", async () => {
    expect(await client.writeCriteria(TOKEN, fullCriteria())).toEqual({ ok: true });
    expect(api.rows.get(OWNER)).toEqual(fullCriteria());
    const request = api.requests[0];
    expect(request?.method).toBe("PUT");
    expect(request?.url).toBe("/v1/criteria");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers["accept"]).toBe("application/json");
    for (const name of ["cookie", "origin", "referer", "x-forwarded-for", "x-real-ip", "forwarded"]) expect(request?.headers[name], name).toBeUndefined();
    expect(JSON.parse(request?.body ?? "")).toEqual(fullCriteria());
    expect(request?.body).toContain(String(SALARY_CANARY));
  });

  it.each([
    ["401 NAO_AUTENTICADO", { kind: "responde", status: 401, code: "NAO_AUTENTICADO" }, "recusado"],
    ["400 PAYLOAD_INVALIDO", { kind: "responde", status: 400, code: "PAYLOAD_INVALIDO" }, "invalido"],
    ["415 PAYLOAD_INVALIDO", { kind: "responde", status: 415, code: "PAYLOAD_INVALIDO" }, "invalido"],
    ["413 PAYLOAD_GRANDE_DEMAIS", { kind: "responde", status: 413, code: "PAYLOAD_GRANDE_DEMAIS" }, "invalido"],
    ["429 LIMITE_DE_TAXA", { kind: "responde", status: 429, code: "LIMITE_DE_TAXA", retryAfter: 5 }, "nao_recebido"],
    ["redirecionamento", { kind: "redireciona", location: "https://outro.exemplo.invalid/" }, "nao_recebido"],
    ["503 (o guarda pode ter cortado depois de gravar)", { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" }, "pode_ter_gravado"],
    ["500", { kind: "responde", status: 500, code: "ERRO_INTERNO" }, "pode_ter_gravado"],
    ["401 sem o corpo da API", { kind: "responde", status: 401, body: "<html>401</html>", contentType: "text/html" }, "pode_ter_gravado"],
    ["400 com outro código", { kind: "responde", status: 400, code: "PROIBIDO" }, "pode_ter_gravado"],
    ["413 com outro código", { kind: "responde", status: 413, code: "PAYLOAD_INVALIDO" }, "pode_ter_gravado"],
    ["429 sem o corpo da API", { kind: "responde", status: 429, body: "" }, "pode_ter_gravado"],
    ["409", { kind: "responde", status: 409, code: "CRITERIOS_NAO_CONFIGURADOS" }, "pode_ter_gravado"],
    ["200 (2xx que não é 204)", { kind: "responde", status: 200, body: "{}" }, "pode_ter_gravado"],
    ["trava (prazo depois do envio)", { kind: "trava" }, "pode_ter_gravado"],
    ["corta no meio", { kind: "corta" }, "pode_ter_gravado"],
  ] as const)("%s: %s, com um PUT só", async (_label, mode, reason) => {
    api.mode = mode;
    expect(await client.writeCriteria(TOKEN, fullCriteria())).toEqual({ ok: false, reason });
    expect(api.requests).toHaveLength(1);
  });

  it("redirecionamento para um destino que responderia: nao_recebido, e nada chega lá (condição 1)", async () => {
    let reached = 0;
    const { origin, server } = await oneShot((response) => {
      reached += 1;
      response.writeHead(204);
      response.end();
    });
    try {
      api.mode = { kind: "redireciona", location: `${origin}/v1/criteria` };
      expect(await client.writeCriteria(TOKEN, fullCriteria())).toEqual({ ok: false, reason: "nao_recebido" });
      expect(await client.readCriteria(TOKEN)).toEqual({ ok: false, reason: "nao_recebido" });
      expect(reached).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it("lento dentro do prazo: ok", async () => {
    api.mode = { kind: "lento", delayMs: 50 };
    expect(await client.writeCriteria(TOKEN, fullCriteria())).toEqual({ ok: true });
  });

  it("conexão recusada: nao_recebido", async () => {
    const { origin, server } = await oneShot(() => undefined);
    await closeServer(server);
    expect(await createApiClient({ apiOrigin: origin }).writeCriteria(TOKEN, fullCriteria())).toEqual({ ok: false, reason: "nao_recebido" });
  });

  it("corpo acima de 16.384 bytes: invalido, sem rede", async () => {
    const big = { ...fullCriteria(), notes: "é".repeat(CRITERIA_BODY_MAX_BYTES / 2) };
    expect(await client.writeCriteria(TOKEN, big)).toEqual({ ok: false, reason: "invalido" });
    expect(api.requests).toHaveLength(0);
  });

  it("token fora da forma ou sinal já abortado: nao_recebido sem rede", async () => {
    expect(await client.writeCriteria("nao-e-jws", fullCriteria())).toEqual({ ok: false, reason: "nao_recebido" });
    expect(await client.writeCriteria(TOKEN, fullCriteria(), AbortSignal.abort())).toEqual({ ok: false, reason: "nao_recebido" });
    expect(api.requests).toHaveLength(0);
  });

  it("sinal de quem chama: vivo, segue; abortado no meio do envio, pode_ter_gravado (sem nova tentativa)", async () => {
    expect(await client.writeCriteria(TOKEN, fullCriteria(), new AbortController().signal)).toEqual({ ok: true });
    api.mode = { kind: "trava" };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(await client.writeCriteria(TOKEN, fullCriteria(), controller.signal)).toEqual({ ok: false, reason: "pode_ter_gravado" });
    expect(await client.readCriteria(TOKEN, AbortSignal.timeout(50))).toEqual({ ok: false, reason: "nao_recebido" });
  });

  it("o corpo de erro da API nunca sai do cliente", async () => {
    api.mode = { kind: "responde", status: 400, body: apiErrorBody("PAYLOAD_INVALIDO").replace("formato", "CANARIO-ZOD") };
    const result = await client.writeCriteria(TOKEN, fullCriteria());
    expect(JSON.stringify(result)).not.toContain("CANARIO");
  });
});
