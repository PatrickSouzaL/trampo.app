// F1-API-01 (SR-07; ADR-007): a borda recusa antes do parse e do handler, com fastify.inject.
// Os casos que o inject não exercita (socket, timeouts) estão em edge-socket.test.ts.
import { Readable } from "node:stream";

import { ApiErrorSchema } from "@trampo/contracts/api";
import { HTTP_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { buildApp, type BuildAppOptions } from "../src/presentation/build-app.js";
import { EDGE_TIMEOUTS } from "../src/presentation/edge/timeouts.js";
import { TEST_AUTHORIZATION, acceptAll } from "./auth-fakes.js";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PORTAL = "https://portal.trampo.example";

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * App com rota de eco e contadores. O parser JSON padrão é envolvido por um contador (mesmo parser,
 * mesmo bodyLimit da instância), para provar que o 413 e o 415 acontecem SEM parse.
 */
function probeApp(options: Partial<BuildAppOptions> = {}) {
  const counts = { parser: 0, handler: 0 };
  const instance = buildApp({ logger: false, accessTokenVerifier: acceptAll, corsAllowedOrigins: [EXTENSION, PORTAL], ...options });
  const defaultJson = instance.getDefaultJsonParser("error", "error");
  instance.removeContentTypeParser("application/json");
  instance.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    counts.parser += 1;
    defaultJson(request, typeof body === "string" ? body : body.toString("utf8"), done);
  });
  instance.post("/probe/eco", { schema: { body: z.strictObject({ texto: z.string() }) } }, async () => {
    counts.handler += 1;
    return { ok: true };
  });
  instance.get("/probe/ip", async (request) => ({ ip: request.ip }));
  app = instance;
  return { app: instance, counts };
}

function expectApiError(body: string, code: string) {
  const parsed = ApiErrorSchema.parse(JSON.parse(body));
  expect(parsed.code).toBe(code);
  return parsed;
}

/** Corpo JSON `{"texto":"…"}` com exatamente `bytes` bytes em UTF-8. */
function jsonOfBytes(bytes: number, filler = "a"): string {
  const envelope = Buffer.byteLength('{"texto":""}');
  const fillerBytes = Buffer.byteLength(filler);
  return `{"texto":"${filler.repeat(Math.floor((bytes - envelope) / fillerBytes))}"}`;
}

// Token aceito pelo verificador falso: os testes de borda não tratam de autenticação (ver auth.test.ts).
const JSON_HEADERS = { "content-type": "application/json", authorization: TEST_AUTHORIZATION };

describe("SR-07: corpo acima de 64 KiB dá 413 sem parse", () => {
  test("no limite exato (65.536 bytes) passa e chega ao handler", async () => {
    const { app, counts } = probeApp();
    const payload = jsonOfBytes(HTTP_BODY_MAX_BYTES);
    expect(Buffer.byteLength(payload)).toBe(HTTP_BODY_MAX_BYTES);
    const res = await app.inject({ method: "POST", url: "/probe/eco", headers: JSON_HEADERS, payload });
    expect(res.statusCode).toBe(200);
    expect(counts).toEqual({ parser: 1, handler: 1 });
  });

  test("um byte acima: 413 PAYLOAD_GRANDE_DEMAIS, sem parser e sem handler", async () => {
    const { app, counts } = probeApp();
    const payload = `${jsonOfBytes(HTTP_BODY_MAX_BYTES)} `;
    const res = await app.inject({ method: "POST", url: "/probe/eco", headers: JSON_HEADERS, payload });
    expect(res.statusCode).toBe(413);
    expectApiError(res.body, "PAYLOAD_GRANDE_DEMAIS");
    expect(counts).toEqual({ parser: 0, handler: 0 });
  });

  test("conta BYTES, não caracteres: 40.000 'é' (80.000 bytes) dá 413", async () => {
    const { app, counts } = probeApp();
    const payload = JSON.stringify({ texto: "é".repeat(40_000) });
    expect(payload.length).toBeLessThan(HTTP_BODY_MAX_BYTES);
    const res = await app.inject({ method: "POST", url: "/probe/eco", headers: JSON_HEADERS, payload });
    expect(res.statusCode).toBe(413);
    expect(counts).toEqual({ parser: 0, handler: 0 });
  });

  test("streaming sem Content-Length: a contagem durante a leitura também dá 413", async () => {
    const { app, counts } = probeApp();
    const chunks = ['{"texto":"', ...Array.from({ length: 10 }, () => "a".repeat(8_192)), '"}'];
    const res = await app.inject({
      method: "POST",
      url: "/probe/eco",
      headers: { ...JSON_HEADERS, "transfer-encoding": "chunked" },
      payload: Readable.from(chunks),
    });
    expect(res.statusCode).toBe(413);
    expectApiError(res.body, "PAYLOAD_GRANDE_DEMAIS");
    expect(counts).toEqual({ parser: 0, handler: 0 });
  });
});

describe("SR-07: tipo de mídia e Content-Encoding dão 415 antes de ler o corpo", () => {
  const VALID = '{"texto":"oi"}';

  test.each([
    ["text/plain", "text/plain"],
    ["formulário", "application/x-www-form-urlencoded"],
    ["multipart", "multipart/form-data; boundary=x"],
    ["sufixo +json", "application/merge-patch+json"],
    ["prefixo parecido", "application/jsonp"],
    ["charset latin1", "application/json; charset=iso-8859-1"],
    ["charset sem valor", "application/json; charset"],
  ])("Content-Type %s: 415 PAYLOAD_INVALIDO", async (_label, contentType) => {
    const { app, counts } = probeApp();
    const res = await app.inject({ method: "POST", url: "/probe/eco", headers: { "content-type": contentType, authorization: TEST_AUTHORIZATION }, payload: VALID });
    expect(res.statusCode).toBe(415);
    expectApiError(res.body, "PAYLOAD_INVALIDO");
    expect(counts).toEqual({ parser: 0, handler: 0 });
  });

  test("POST sem Content-Type, com e sem corpo: 415", async () => {
    const { app, counts } = probeApp();
    const withBody = await app.inject({ method: "POST", url: "/probe/eco", payload: Buffer.from(VALID) });
    const empty = await app.inject({ method: "POST", url: "/probe/eco" });
    expect([withBody.statusCode, empty.statusCode]).toEqual([415, 415]);
    expect(counts).toEqual({ parser: 0, handler: 0 });
  });

  test.each([["gzip"], ["br"], ["deflate"], ["gzip, identity"], ["identity, gzip"]])(
    "Content-Encoding %s: 415 sem descompressão",
    async (encoding) => {
      const { app, counts } = probeApp();
      const res = await app.inject({
        method: "POST",
        url: "/probe/eco",
        headers: { ...JSON_HEADERS, "content-encoding": encoding },
        payload: VALID,
      });
      expect(res.statusCode).toBe(415);
      expectApiError(res.body, "PAYLOAD_INVALIDO");
      expect(counts).toEqual({ parser: 0, handler: 0 });
    },
  );

  test("Content-Encoding gzip também é recusado num GET", async () => {
    const { app } = probeApp();
    const res = await app.inject({ method: "GET", url: "/health", headers: { "content-encoding": "gzip" } });
    expect(res.statusCode).toBe(415);
  });

  test.each([
    ["application/json"],
    ["Application/JSON"],
    ["application/json; charset=utf-8"],
    ['application/json; charset="UTF-8"'],
  ])("Content-Type %s com encoding identity é aceito", async (contentType) => {
    const { app, counts } = probeApp();
    const res = await app.inject({
      method: "POST",
      url: "/probe/eco",
      headers: { "content-type": contentType, "content-encoding": "identity", authorization: TEST_AUTHORIZATION },
      payload: VALID,
    });
    expect(res.statusCode).toBe(200);
    expect(counts).toEqual({ parser: 1, handler: 1 });
  });

  test("GET ou DELETE que carregam corpo não JSON: 415", async () => {
    const { app } = probeApp();
    const get = await app.inject({ method: "GET", url: "/health", headers: { "content-type": "text/plain" }, payload: "x" });
    const del = await app.inject({ method: "DELETE", url: "/health", headers: { "content-type": "text/plain" }, payload: "x" });
    expect([get.statusCode, del.statusCode]).toEqual([415, 415]);
  });

  test("segunda camada: um 415 vindo do Fastify mantém o status 415 no ApiError", async () => {
    const { app } = probeApp();
    app.get("/probe/415", async () => {
      throw Object.assign(new Error("FST_ERR_CTP_INVALID_MEDIA_TYPE"), { statusCode: 415 });
    });
    const res = await app.inject({ method: "GET", url: "/probe/415", headers: { authorization: TEST_AUTHORIZATION } });
    expect(res.statusCode).toBe(415);
    expectApiError(res.body, "PAYLOAD_INVALIDO");
  });

  test("GET sem corpo não exige Content-Type", async () => {
    const { app } = probeApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  test("só o parser JSON está registrado", () => {
    const { app } = probeApp();
    expect(buildApp({ logger: false, accessTokenVerifier: acceptAll }).hasContentTypeParser("text/plain")).toBe(false);
    expect(app.hasContentTypeParser("application/json")).toBe(true);
  });
});

describe("CORS com origens exatas", () => {
  const VALID = '{"texto":"oi"}';

  test.each([[EXTENSION], [PORTAL]])("origem permitida %s: ecoa a origem exata, com Vary e sem credentials", async (origin) => {
    const { app, counts } = probeApp();
    const res = await app.inject({ method: "POST", url: "/probe/eco", headers: { ...JSON_HEADERS, origin }, payload: VALID });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(res.headers["vary"]).toMatch(/Origin/);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(counts.handler).toBe(1);
  });

  test.each([
    ["outra extensão", "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba"],
    ["origem opaca", "null"],
    ["maiúsculas", "chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP"],
    ["barra final", `${PORTAL}/`],
    ["subdomínio", "https://evil.portal.trampo.example"],
    ["http do portal", "http://portal.trampo.example"],
  ])("origem negada (%s): 403 PROIBIDO na borda, sem cabeçalhos de CORS", async (_label, origin) => {
    const { app, counts } = probeApp();
    const res = await app.inject({ method: "POST", url: "/probe/eco", headers: { ...JSON_HEADERS, origin }, payload: VALID });
    expect(res.statusCode).toBe(403);
    expectApiError(res.body, "PROIBIDO");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(counts).toEqual({ parser: 0, handler: 0 });
  });

  test("lista vazia (padrão) nega toda origem de navegador", async () => {
    app = buildApp({ logger: false, accessTokenVerifier: acceptAll });
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: EXTENSION } });
    expect(res.statusCode).toBe(403);
  });

  test("sem Origin (cliente que não é navegador): segue, sem cabeçalhos de CORS", async () => {
    const { app } = probeApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("preflight permitido: 204 com métodos, headers e Max-Age restritos", async () => {
    const { app, counts } = probeApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/probe/eco",
      headers: {
        origin: EXTENSION,
        "access-control-request-method": "POST",
        "access-control-request-headers": "Content-Type, authorization",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(res.headers["access-control-allow-origin"]).toBe(EXTENSION);
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, PUT");
    expect(res.headers["access-control-allow-headers"]).toBe("authorization, content-type");
    expect(res.headers["access-control-max-age"]).toBe("600");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(counts).toEqual({ parser: 0, handler: 0 });
  });

  test.each([
    ["método fora da lista", { "access-control-request-method": "DELETE" }],
    ["método em minúsculas", { "access-control-request-method": "post" }],
    ["header fora da lista", { "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-debug" }],
  ])("preflight negado (%s): 403 sem cabeçalhos de CORS", async (_label, headers) => {
    const { app } = probeApp();
    const res = await app.inject({ method: "OPTIONS", url: "/probe/eco", headers: { origin: EXTENSION, ...headers } });
    expect(res.statusCode).toBe(403);
    expectApiError(res.body, "PROIBIDO");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
  });

  test("preflight de origem negada: 403", async () => {
    const { app } = probeApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/probe/eco",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("respostas de erro da borda carregam o CORS (a extensão lê o ApiError)", async () => {
    const { app } = probeApp();
    const tooBig = await app.inject({
      method: "POST",
      url: "/probe/eco",
      headers: { ...JSON_HEADERS, origin: EXTENSION },
      payload: `${jsonOfBytes(HTTP_BODY_MAX_BYTES)} `,
    });
    const badType = await app.inject({
      method: "POST",
      url: "/probe/eco",
      headers: { "content-type": "text/plain", origin: EXTENSION, authorization: TEST_AUTHORIZATION },
      payload: "x",
    });
    for (const res of [tooBig, badType]) expect(res.headers["access-control-allow-origin"]).toBe(EXTENSION);
    expect([tooBig.statusCode, badType.statusCode]).toEqual([413, 415]);
  });
});

describe("proto poisoning recusado no parse", () => {
  test.each([
    ["__proto__", '{"__proto__":{"admin":true},"n":1}'],
    ["constructor.prototype", '{"constructor":{"prototype":{"admin":true}},"n":1}'],
  ])("%s: 400 PAYLOAD_INVALIDO e o handler não roda", async (_label, payload) => {
    let handled = 0;
    app = buildApp({ logger: false, accessTokenVerifier: acceptAll });
    app.post("/probe/poison", async () => {
      handled += 1;
      return { ok: true };
    });
    const res = await app.inject({ method: "POST", url: "/probe/poison", headers: JSON_HEADERS, payload });
    expect(res.statusCode).toBe(400);
    expectApiError(res.body, "PAYLOAD_INVALIDO");
    expect(handled).toBe(0);
    expect(({} as Record<string, unknown>)["admin"]).toBeUndefined();
  });
});

describe("trustProxy", () => {
  const PROXY = "10.0.0.7";
  const CLIENT = "203.0.113.9";

  test("padrão false: X-Forwarded-For é ignorado", async () => {
    const { app } = probeApp();
    const res = await app.inject({ method: "GET", url: "/probe/ip", remoteAddress: PROXY, headers: { "x-forwarded-for": CLIENT, authorization: TEST_AUTHORIZATION } });
    expect(res.json()).toEqual({ ip: PROXY });
  });

  test("salto de proxy configurado: usa o cliente do X-Forwarded-For", async () => {
    const { app } = probeApp({ trustProxy: ["10.0.0.0/8"] });
    const res = await app.inject({ method: "GET", url: "/probe/ip", remoteAddress: PROXY, headers: { "x-forwarded-for": CLIENT, authorization: TEST_AUTHORIZATION } });
    expect(res.json()).toEqual({ ip: CLIENT });
  });

  test("X-Forwarded-For vindo de quem não é o proxy configurado é ignorado", async () => {
    const { app } = probeApp({ trustProxy: ["10.0.0.0/8"] });
    const res = await app.inject({
      method: "GET",
      url: "/probe/ip",
      remoteAddress: "192.168.1.50",
      headers: { "x-forwarded-for": CLIENT, authorization: TEST_AUTHORIZATION },
    });
    expect(res.json()).toEqual({ ip: "192.168.1.50" });
  });
});

describe("padrões de produção travados", () => {
  test("bodyLimit, poisoning e prazos do servidor (trustProxy: ver o describe acima)", async () => {
    app = buildApp({ logger: false, accessTokenVerifier: acceptAll });
    await app.ready();
    expect(app.initialConfig.bodyLimit).toBe(HTTP_BODY_MAX_BYTES);
    expect(app.initialConfig.onProtoPoisoning).toBe("error");
    expect(app.initialConfig.onConstructorPoisoning).toBe("error");
    expect(app.initialConfig.connectionTimeout).toBe(EDGE_TIMEOUTS.connectionTimeout);
    expect(app.server.timeout).toBe(30_000);
    expect(app.server.requestTimeout).toBe(10_000);
    expect(app.server.headersTimeout).toBe(5_000);
    expect(app.server.keepAliveTimeout).toBe(5_000);
    expect(EDGE_TIMEOUTS.headersTimeout).toBeLessThanOrEqual(EDGE_TIMEOUTS.requestTimeout);
    expect(Object.isFrozen(EDGE_TIMEOUTS)).toBe(true);
  });
});
