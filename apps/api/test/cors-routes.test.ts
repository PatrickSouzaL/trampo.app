// F1-API-05 commit 4 (ADR-021 D8.3, emenda ao ADR-007 D6; [APPSEC] critérios 5 e 8): a origem da extensão só
// alcança as rotas de EXTENSION_ROUTES, no preflight e na requisição real, comparando o caminho CRU. O portal não
// muda. As rotas de sonda têm os caminhos reais (as rotas de critérios só entram no commit 5). O `inject` normaliza
// `..`, `/./` e `#` antes do hook, então esses caminhos vão por socket real, com a linha de requisição escrita à mão.
import { connect } from "node:net";

import { ApiErrorSchema } from "@trampo/contracts/api";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { buildApp, type BuildAppOptions } from "../src/presentation/build-app.js";
import { EXTENSION_ROUTES } from "../src/presentation/edge/cors.js";
import { TEST_AUTHORIZATION, fakeVerifier } from "./auth-fakes.js";
import { fakeLimits } from "./limit-fakes.js";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PORTAL = "https://portal.trampo.example";
const PORTAL_DEV = "http://localhost:3000";
const VALID = '{"texto":"oi"}';

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** App com as rotas de sonda e contadores de tudo o que vem depois do CORS: JWT, rate limit, parser e handler. */
function routesApp(options: Partial<BuildAppOptions> = {}) {
  const auth = fakeVerifier();
  const limits = fakeLimits();
  const counts = { parser: 0 };
  const routes: string[] = [];
  const instance = buildApp({
    limits: limits.limits,
    logger: false,
    accessTokenVerifier: auth.verifier,
    corsAllowedOrigins: [EXTENSION, PORTAL, PORTAL_DEV],
    ...options,
  });
  const defaultJson = instance.getDefaultJsonParser("error", "error");
  instance.removeContentTypeParser("application/json");
  instance.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    counts.parser += 1;
    defaultJson(request, typeof body === "string" ? body : body.toString("utf8"), done);
  });
  const body = z.strictObject({ texto: z.string() });
  instance.post("/v1/analyze", { schema: { body } }, async () => {
    routes.push("POST /v1/analyze");
    return { ok: true };
  });
  instance.get("/v1/criteria", async () => {
    routes.push("GET /v1/criteria");
    return { ok: true };
  });
  instance.put("/v1/criteria", { schema: { body } }, async () => {
    routes.push("PUT /v1/criteria");
    return { ok: true };
  });
  app = instance;
  /** Nada depois do CORS rodou: nem o JWT, nem o rate limit, nem o parser, nem o handler. */
  const untouched = () => ({ jwt: auth.calls.length, rate: limits.rate.calls.length, parser: counts.parser, routes });
  return { app: instance, routes, untouched };
}

const NOTHING_RAN = { jwt: 0, rate: 0, parser: 0, routes: [] };

function preflight(instance: ReturnType<typeof buildApp>, origin: string, url: string, method: string) {
  return instance.inject({
    method: "OPTIONS",
    url,
    headers: { origin, "access-control-request-method": method, "access-control-request-headers": "authorization, content-type" },
  });
}

function real(instance: ReturnType<typeof buildApp>, origin: string, url: string, method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS") {
  const withBody = method === "POST" || method === "PUT" || method === "PATCH";
  return instance.inject({
    method,
    url,
    headers: { origin, authorization: TEST_AUTHORIZATION, ...(withBody ? { "content-type": "application/json" } : {}) },
    ...(withBody ? { payload: VALID } : {}),
  });
}

function expectForbidden(res: { statusCode: number; body: string; headers: Record<string, unknown> }) {
  expect(res.statusCode).toBe(403);
  expect(ApiErrorSchema.parse(JSON.parse(res.body)).code).toBe("PROIBIDO");
  expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  expect(res.headers["access-control-allow-methods"]).toBeUndefined();
  expect(String(res.headers["vary"])).toMatch(/\bOrigin\b/);
}

describe("EXTENSION_ROUTES (ADR-021 D8.3)", () => {
  test("lista positiva fixada contra o ADR: só POST /v1/analyze", () => {
    expect(EXTENSION_ROUTES).toEqual([{ method: "POST", path: "/v1/analyze" }]);
  });

  test("congelada: ninguém acrescenta rota em tempo de execução", () => {
    expect(Object.isFrozen(EXTENSION_ROUTES)).toBe(true);
    for (const route of EXTENSION_ROUTES) expect(Object.isFrozen(route)).toBe(true);
  });
});

describe("origem da extensão na rota dela", () => {
  test.each([["/v1/analyze"], ["/v1/analyze?x=1"], ["/v1/analyze?"], ["/v1/analyze?x=?y"]])("preflight de POST %s: 204 com a origem exata", async (url) => {
    const { app, untouched } = routesApp();
    const res = await preflight(app, EXTENSION, url, "POST");
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(EXTENSION);
    expect(untouched()).toEqual(NOTHING_RAN);
  });

  test.each([["/v1/analyze"], ["/v1/analyze?x=1"], ["/v1/analyze?x=?y"]])("POST %s real: chega ao handler, com a origem exata", async (url) => {
    const { app, routes } = routesApp();
    const res = await real(app, EXTENSION, url, "POST");
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(EXTENSION);
    expect(routes).toEqual(["POST /v1/analyze"]);
  });

  test("os erros depois do CORS na rota da extensão ainda trazem a origem (a extensão lê o ApiError)", async () => {
    const { app } = routesApp({ accessTokenVerifier: fakeVerifier({ ok: false, reason: "token_invalido" }).verifier });
    const res = await real(app, EXTENSION, "/v1/analyze", "POST");
    expect(res.statusCode).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBe(EXTENSION);
  });
});

describe("origem da extensão fora da lista: 403 PROIBIDO antes do JWT, do rate limit e do corpo", () => {
  test.each([
    ["GET /v1/criteria", "/v1/criteria", "GET"],
    ["PUT /v1/criteria", "/v1/criteria", "PUT"],
    ["GET /v1/analyze", "/v1/analyze", "GET"],
    ["PUT /v1/analyze", "/v1/analyze", "PUT"],
    ["POST /v1/criteria", "/v1/criteria", "POST"],
    ["GET /health", "/health", "GET"],
  ])("preflight de %s", async (_label, url, method) => {
    const { app, untouched } = routesApp();
    expectForbidden(await preflight(app, EXTENSION, url, method));
    expect(untouched()).toEqual(NOTHING_RAN);
  });

  test.each([
    ["GET /v1/criteria", "/v1/criteria", "GET"],
    ["PUT /v1/criteria", "/v1/criteria", "PUT"],
    ["GET /v1/analyze", "/v1/analyze", "GET"],
    ["PUT /v1/analyze", "/v1/analyze", "PUT"],
    ["DELETE /v1/analyze", "/v1/analyze", "DELETE"],
    ["PATCH /v1/analyze", "/v1/analyze", "PATCH"],
    ["HEAD /v1/analyze", "/v1/analyze", "HEAD"],
    ["OPTIONS /v1/analyze sem Access-Control-Request-Method", "/v1/analyze", "OPTIONS"],
    ["GET /health", "/health", "GET"],
  ] as const)("requisição real %s (sem preflight, como faria quem não é navegador)", async (_label, url, method) => {
    const { app, untouched } = routesApp();
    const res = await real(app, EXTENSION, url, method);
    expect(res.statusCode).toBe(403);
    if (method !== "HEAD") expect(ApiErrorSchema.parse(JSON.parse(res.body)).code).toBe("PROIBIDO");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(untouched()).toEqual(NOTHING_RAN);
  });

  // Caminhos que o inject entrega sem normalizar. `/v1/%61nalyze` é o mais importante: o roteador decodifica e
  // chegaria à rota de análise (provado abaixo com o portal), então só a comparação crua o recusa.
  test.each([
    ["barra final", "/v1/analyze/"],
    ["percent-encoding", "/v1/%61nalyze"],
    ["barra dupla", "//v1/analyze"],
    ["maiúsculas", "/V1/analyze"],
    ["ponto e vírgula", "/v1/analyze;x"],
    ["barra codificada", "/v1%2Fanalyze"],
    ["a rota proibida com a permitida na query", "/v1/criteria?/v1/analyze"],
    ["prefixo da rota", "/v1/analyz"],
    ["rota estendida", "/v1/analyze/extra"],
  ])("caminho disfarçado (%s) no preflight e na requisição real", async (_label, url) => {
    const { app, untouched } = routesApp();
    expectForbidden(await preflight(app, EXTENSION, url, "POST"));
    expectForbidden(await real(app, EXTENSION, url, "POST"));
    expect(untouched()).toEqual(NOTHING_RAN);
  });

  test("o Access-Control-Request-Method é o que decide no preflight, não o método do OPTIONS", async () => {
    const { app } = routesApp();
    expect((await preflight(app, EXTENSION, "/v1/analyze", "POST")).statusCode).toBe(204);
    expectForbidden(await preflight(app, EXTENSION, "/v1/analyze", "GET"));
    expectForbidden(await preflight(app, EXTENSION, "/v1/analyze", "PUT"));
  });

  // O main.ts recusa estas origens (edge-env); aqui elas chegam ao buildApp direto, sem a validação. A segunda
  // contém `https://` fora do início: só a origem que COMEÇA como web fica sem restrição.
  test.each([["moz-extension://4b1d2c3e-0000-4000-8000-000000000000"], ["chrome-extension://https://portal.trampo.example"]])(
    "falha fechado: uma origem que não é de web (%s), mesmo fora do padrão da extensão, fica presa à lista",
    async (other) => {
      const { app, routes } = routesApp({ corsAllowedOrigins: [other] });
      expectForbidden(await preflight(app, other, "/v1/criteria", "GET"));
      expectForbidden(await real(app, other, "/v1/criteria", "GET"));
      const allowed = await real(app, other, "/v1/analyze", "POST");
      expect(allowed.statusCode).toBe(200);
      expect(routes).toEqual(["POST /v1/analyze"]);
    },
  );
});

describe("origem do portal: sem restrição por rota (nada muda)", () => {
  test.each([
    ["POST /v1/analyze", "/v1/analyze", "POST"],
    ["GET /v1/criteria", "/v1/criteria", "GET"],
    ["PUT /v1/criteria", "/v1/criteria", "PUT"],
  ] as const)("%s: preflight 204 e requisição real até o handler, para o portal e o portal em dev", async (label, url, method) => {
    for (const origin of [PORTAL, PORTAL_DEV]) {
      const { app, routes } = routesApp();
      const pre = await preflight(app, origin, url, method);
      expect(pre.statusCode).toBe(204);
      expect(pre.headers["access-control-allow-origin"]).toBe(origin);
      const res = await real(app, origin, url, method);
      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(routes).toEqual([label]);
      await app.close();
    }
  });

  test("o roteador decodifica /v1/%61nalyze e chega à rota de análise: a recusa da extensão é do CORS", async () => {
    const { app, routes } = routesApp();
    const res = await real(app, PORTAL, "/v1/%61nalyze", "POST");
    expect(res.statusCode).toBe(200);
    expect(routes).toEqual(["POST /v1/analyze"]);
  });

  test("origem fora da lista continua 403, inclusive na rota da extensão", async () => {
    const { app, untouched } = routesApp();
    expectForbidden(await preflight(app, "https://evil.example", "/v1/analyze", "POST"));
    expectForbidden(await real(app, "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba", "/v1/analyze", "POST"));
    expect(untouched()).toEqual(NOTHING_RAN);
  });
});

describe("caminho cru em socket real (o inject normalizaria)", () => {
  async function listen() {
    const { app: instance, untouched } = routesApp();
    await instance.listen({ host: "127.0.0.1", port: 0 });
    const address = instance.server.address();
    if (address === null || typeof address === "string") throw new Error("sem porta");
    return { port: address.port, untouched };
  }

  /** Escreve a requisição inteira (sem corpo) e devolve o que o servidor mandou até fechar. */
  function send(port: number, requestLine: string, headers: readonly string[]): Promise<{ status: number; head: string }> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port });
      let response = "";
      const guard = setTimeout(() => {
        socket.destroy();
        reject(new Error("o servidor não fechou a conexão"));
      }, 4_000);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        response += chunk;
      });
      socket.on("error", () => undefined);
      socket.on("close", () => {
        clearTimeout(guard);
        const head = response.slice(0, response.indexOf("\r\n\r\n")).toLowerCase();
        resolve({ status: Number(head.split(" ")[1]), head });
      });
      socket.write(`${[requestLine, "Host: 127.0.0.1", ...headers, "Connection: close"].join("\r\n")}\r\n\r\n`);
    });
  }

  const PREFLIGHT = [`Origin: ${EXTENSION}`, "Access-Control-Request-Method: POST"];
  // POST com corpo vazio: o 403 vem antes de qualquer leitura, e nenhum byte fica sem ler (RST no Windows).
  const REAL = [`Origin: ${EXTENSION}`, `Authorization: ${TEST_AUTHORIZATION}`, "Content-Type: application/json", "Content-Length: 0"];

  test("controle: o caminho exato passa no preflight e chega ao parser na requisição real", async () => {
    const { port } = await listen();
    const pre = await send(port, "OPTIONS /v1/analyze HTTP/1.1", PREFLIGHT);
    expect(pre.status).toBe(204);
    expect(pre.head).toContain(`access-control-allow-origin: ${EXTENSION}`);
    // Corpo JSON vazio: 400 do parser, ou seja, passou do CORS, do JWT e do rate limit.
    const res = await send(port, "POST /v1/analyze HTTP/1.1", REAL);
    expect(res.status).toBe(400);
    expect(res.head).toContain(`access-control-allow-origin: ${EXTENSION}`);
  });

  test.each([
    ["segmento ..", "/v1/criteria/../analyze"],
    ["segmento .. que volta à própria rota", "/v1/analyze/../analyze"],
    ["segmento .", "/v1/./analyze"],
    ["ponto no início", "/./v1/analyze"],
    ["fragmento", "/v1/analyze#x"],
    ["barra dupla", "//v1/analyze"],
    ["percent-encoding", "/v1/%61nalyze"],
    ["forma absoluta", "http://127.0.0.1/v1/analyze"],
  ])("%s (%s): 403 no preflight e na requisição real, sem passar do CORS", async (_label, target) => {
    const { port, untouched } = await listen();
    const pre = await send(port, `OPTIONS ${target} HTTP/1.1`, PREFLIGHT);
    const res = await send(port, `POST ${target} HTTP/1.1`, REAL);
    expect([pre.status, res.status]).toEqual([403, 403]);
    for (const reply of [pre, res]) expect(reply.head).not.toContain("access-control-allow-origin");
    expect(untouched()).toEqual(NOTHING_RAN);
  });
});
