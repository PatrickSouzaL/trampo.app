// F1-API-06 fatia 4 (ADR-031 D4; condição 11 do [APPSEC]): a origem da extensão alcança a rota de feedback pelo
// padrão roteado E pelo caminho cru, que tem de casar com ^/v1/analyses/[0-9a-f-]{36}/feedback$. No preflight não há
// rota casada, então vale só o caminho cru com o método POST. `..`, `%2F`, a barra dupla, as maiúsculas e o sufixo
// dão 403 antes do JWT, do rate limit e do corpo (socket real: o `inject` normalizaria). As rotas da conta e dos
// critérios continuam fora do alcance da extensão. O portal (origem de web) não muda.
import { connect } from "node:net";

import { ApiErrorSchema } from "@trampo/contracts/api";
import { afterEach, describe, expect, test } from "vitest";

import type { FeedbackSaveOutcome } from "../src/application/index.js";
import { buildApp } from "../src/presentation/build-app.js";
import { TEST_AUTHORIZATION, fakeVerifier } from "./auth-fakes.js";
import { fakeLimits } from "./limit-fakes.js";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PORTAL = "https://portal.trampo.example";
const ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const PATH = `/v1/analyses/${ID}/feedback`;
const BODY = '{"agreement":"concordo","reason":null}';

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function corsApp() {
  const auth = fakeVerifier();
  const limits = fakeLimits();
  const saved: string[] = [];
  const instance = buildApp({
    accessTokenVerifier: auth.verifier,
    limits: limits.limits,
    logger: false,
    corsAllowedOrigins: [EXTENSION, PORTAL],
    feedback: {
      service: {
        async save(_subject, analysisId): Promise<FeedbackSaveOutcome> {
          saved.push(analysisId);
          return "gravada";
        },
      },
    },
    account: {
      service: {
        export: async () => ({ kind: "indisponivel" }),
        delete: async () => ({ kind: "indisponivel" }),
      } as never,
    },
  });
  app = instance;
  const untouched = () => ({ jwt: auth.calls.length, rate: limits.rate.calls.length, saved: saved.length });
  return { app: instance, untouched, saved };
}

const NOTHING_RAN = { jwt: 0, rate: 0, saved: 0 };

function expectForbidden(res: { statusCode: number; body: string; headers: Record<string, unknown> }) {
  expect(res.statusCode).toBe(403);
  expect(ApiErrorSchema.parse(JSON.parse(res.body)).code).toBe("PROIBIDO");
  expect(res.headers["access-control-allow-origin"]).toBeUndefined();
}

describe("a extensão na rota de feedback", () => {
  test("preflight de POST no caminho exato: 204 com a origem exata, sem nada depois do CORS", async () => {
    const { app, untouched } = corsApp();
    const res = await app.inject({ method: "OPTIONS", url: PATH, headers: { origin: EXTENSION, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(EXTENSION);
    expect(untouched()).toEqual(NOTHING_RAN);
  });

  test("POST real: chega ao serviço, com a origem exata na resposta", async () => {
    const { app, saved } = corsApp();
    const res = await app.inject({ method: "POST", url: `${PATH}?x=1`, headers: { origin: EXTENSION, authorization: TEST_AUTHORIZATION, "content-type": "application/json" }, payload: BODY });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(EXTENSION);
    expect(saved).toEqual([ID]);
  });

  test.each(["GET", "PUT"])("preflight de %s no caminho do feedback: 403", async (method) => {
    const { app, untouched } = corsApp();
    expectForbidden(await app.inject({ method: "OPTIONS", url: PATH, headers: { origin: EXTENSION, "access-control-request-method": method } }));
    expect(untouched()).toEqual(NOTHING_RAN);
  });

  test.each([
    ["exportar a conta", "GET", "/v1/account/export"],
    ["excluir a conta", "POST", "/v1/account/delete"],
    ["ler os critérios", "GET", "/v1/criteria"],
    ["gravar os critérios", "PUT", "/v1/criteria"],
  ] as const)("a conta e os critérios continuam fora do alcance da extensão (%s): 403", async (_name, method, url) => {
    const { app, untouched } = corsApp();
    expectForbidden(await app.inject({ method, url, headers: { origin: EXTENSION, authorization: TEST_AUTHORIZATION } }));
    expectForbidden(await app.inject({ method: "OPTIONS", url, headers: { origin: EXTENSION, "access-control-request-method": method } }));
    expect(untouched()).toEqual(NOTHING_RAN);
  });

  test("sem a rota registrada, a extensão leva o 403 do CORS (o padrão roteado também é exigido), nunca o 404", async () => {
    const auth = fakeVerifier();
    const instance = buildApp({ accessTokenVerifier: auth.verifier, limits: fakeLimits().limits, logger: false, corsAllowedOrigins: [EXTENSION] });
    app = instance;
    const res = await instance.inject({ method: "POST", url: PATH, headers: { origin: EXTENSION, authorization: TEST_AUTHORIZATION, "content-type": "application/json" }, payload: BODY });
    expectForbidden(res);
    expect(auth.calls).toHaveLength(0);
  });

  test("o portal (origem de web) alcança a rota sem restrição", async () => {
    const { app, saved } = corsApp();
    const res = await app.inject({ method: "POST", url: PATH, headers: { origin: PORTAL, authorization: TEST_AUTHORIZATION, "content-type": "application/json" }, payload: BODY });
    expect(res.statusCode).toBe(204);
    expect(saved).toEqual([ID]);
  });
});

describe("caminho cru em socket real (o inject normalizaria)", () => {
  async function listen() {
    const { app: instance, untouched } = corsApp();
    await instance.listen({ host: "127.0.0.1", port: 0 });
    const address = instance.server.address();
    if (address === null || typeof address === "string") throw new Error("sem porta");
    return { port: address.port, untouched };
  }

  function send(port: number, requestLine: string, headers: readonly string[], body = ""): Promise<{ status: number; head: string }> {
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
      socket.write(`${[requestLine, "Host: 127.0.0.1", ...headers, `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close"].join("\r\n")}\r\n\r\n${body}`);
    });
  }

  const PREFLIGHT = [`Origin: ${EXTENSION}`, "Access-Control-Request-Method: POST"];
  const REAL = [`Origin: ${EXTENSION}`, `Authorization: ${TEST_AUTHORIZATION}`, "Content-Type: application/json"];

  test("controle: o caminho exato passa no preflight e chega ao serviço na requisição real", async () => {
    const { port, untouched } = await listen();
    expect((await send(port, `OPTIONS ${PATH} HTTP/1.1`, PREFLIGHT)).status).toBe(204);
    const res = await send(port, `POST ${PATH} HTTP/1.1`, REAL, BODY);
    expect(res.status).toBe(204);
    expect(res.head).toContain(`access-control-allow-origin: ${EXTENSION}`);
    expect(untouched().saved).toBe(1);
  });

  test.each([
    ["segmento ..", `/v1/analyses/x/../${ID}/feedback`],
    ["segmento .. no fim", `/v1/analyses/${ID}/feedback/../feedback`],
    ["%2F no lugar da barra", `/v1/analyses/${ID}%2Ffeedback`],
    ["%2F antes do id", `/v1/analyses%2F${ID}/feedback`],
    ["barra dupla", `/v1/analyses//${ID}/feedback`],
    ["barra dupla no início", `//v1/analyses/${ID}/feedback`],
    ["id em maiúsculas", `/v1/analyses/${ID.toUpperCase()}/feedback`],
    ["caminho em maiúsculas", `/V1/analyses/${ID}/feedback`],
    ["barra no fim", `${PATH}/`],
    ["sufixo", `${PATH}x`],
    ["id de 37 caracteres", `/v1/analyses/${ID}0/feedback`],
    ["percent-encoding de uma letra", `/v1/analyses/${ID}/%66eedback`],
    ["fragmento", `${PATH}#x`],
  ])("%s: 403 no preflight e na requisição real, sem nada depois do CORS", async (_label, target) => {
    const { port, untouched } = await listen();
    expect((await send(port, `OPTIONS ${target} HTTP/1.1`, PREFLIGHT)).status).toBe(403);
    expect((await send(port, `POST ${target} HTTP/1.1`, REAL)).status).toBe(403);
    expect(untouched()).toEqual(NOTHING_RAN);
  });
});
