// SR-12 (F1-OBS-01; ADR-010 §4): varredura por canário no log REAL do buildApp. Requisições com texto de
// vaga, critérios, token, cookie, query, cabeçalhos e IP passam pelos caminhos de 200, 404, 4xx, 500 e por
// um código malicioso que tenta fugir da política (child logger, serializers de rota, Error como argumento,
// interpolação). Nenhum canário pode aparecer, e cada linha precisa caber na allowlist.
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { buildApp } from "../src/presentation/build-app.js";
import { LOG_ALLOWLIST } from "../src/presentation/logging/log-policy.js";

const CANARY = {
  jobText: "canario-vaga-Desenvolvedora-Senior-Remota-a1",
  criteria: "canario-criterio-pretensao-23000-b2",
  token: "canario.token.eyJhbGciOiJFUzI1NiJ9-c3",
  cookie: "canario-cookie-sb-access-d4",
  query: "canario-query-e5",
  header: "canario-header-f6",
  userAgent: "canario-agente-g7",
  errorMessage: "canario-mensagem-erro-h8",
  forwardedIp: "203.0.113.77",
  clientIp: "198.51.100.23",
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function captureApp() {
  const lines: string[] = [];
  app = buildApp({ logger: { level: "trace", stream: { write: (line) => void lines.push(line) } } });
  const body = z.strictObject({ jobText: z.string(), criteria: z.strictObject({ salaryFloor: z.string() }) });

  app.post("/probe/analise", { schema: { body } }, async () => ({ ok: true }));
  app.get("/probe/explode", async () => {
    throw Object.assign(new Error(`${CANARY.errorMessage} ${CANARY.jobText}`), { input: CANARY.criteria });
  });
  // Código malicioso (ou descuidado): tenta todos os caminhos conhecidos para gravar dado no log.
  app.post("/probe/vazador", { schema: { body } }, async (request) => {
    const leaky = request.log.child(
      { leak: CANARY.jobText, reqId: CANARY.query },
      { serializers: { req: (r: { headers: unknown }) => ({ headers: r.headers }) }, formatters: { log: (o: object) => ({ ...o, extra: CANARY.token }) } },
    );
    leaky.info({ req: request, body: request.body, headers: request.headers }, `texto ${request.body.jobText}`);
    request.log.info(new Error(CANARY.errorMessage));
    request.log.warn({ err: { message: CANARY.errorMessage, stack: CANARY.jobText } });
    request.log.error("%s e %o", CANARY.criteria, request.headers);
    request.log.info({ msg: CANARY.jobText, level: CANARY.token, time: CANARY.cookie }, request.body.criteria.salaryFloor);
    request.log.info(request.raw);
    return { ok: true };
  });
  // Serializers de plugin (logSerializers) que devolveriam os cabeçalhos e a URL com query.
  void app.register(
    async (plugin) => {
      plugin.get("/probe/rota-serializer", async (request) => {
        request.log.info({ req: request }, "incoming request");
        return { ok: true };
      });
    },
    { logSerializers: { req: (r: { headers: unknown; url: string }) => JSON.stringify({ headers: r.headers, url: r.url }) } },
  );
  return { app, lines };
}

const sensitiveHeaders = {
  authorization: `Bearer ${CANARY.token}`,
  cookie: `sb-access-token=${CANARY.cookie}`,
  "x-forwarded-for": CANARY.forwardedIp,
  "user-agent": CANARY.userAgent,
  "x-qualquer": CANARY.header,
};
const payload = { jobText: CANARY.jobText, criteria: { salaryFloor: CANARY.criteria } };

function parseLines(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectOnlyAllowlistedKeys(record: Record<string, unknown>): void {
  expect(LOG_ALLOWLIST.top).toEqual(expect.arrayContaining(Object.keys(record)));
  for (const nested of ["req", "res", "err"] as const) {
    const value = record[nested];
    if (value !== undefined) expect(LOG_ALLOWLIST[nested]).toEqual(expect.arrayContaining(Object.keys(value as object)));
  }
}

describe("SR-12: o log nunca contém vaga, critérios, token, cookie, query, cabeçalho ou IP", () => {
  test("varredura por canário em 200, 404, 400, 415, 500, código malicioso e serializer de rota", async () => {
    const { app, lines } = captureApp();
    const responses = await Promise.all([
      app.inject({ method: "POST", url: `/probe/analise?q=${CANARY.query}`, headers: sensitiveHeaders, payload, remoteAddress: CANARY.clientIp }),
      app.inject({ method: "GET", url: `/nao/existe?token=${CANARY.query}`, headers: sensitiveHeaders, remoteAddress: CANARY.clientIp }),
      app.inject({ method: "POST", url: "/probe/analise", headers: sensitiveHeaders, payload: { jobText: CANARY.jobText }, remoteAddress: CANARY.clientIp }),
      app.inject({ method: "POST", url: "/probe/analise", headers: { ...sensitiveHeaders, "content-type": "text/plain" }, payload: CANARY.jobText, remoteAddress: CANARY.clientIp }),
      app.inject({ method: "GET", url: `/probe/explode?q=${CANARY.query}`, headers: sensitiveHeaders, remoteAddress: CANARY.clientIp }),
      app.inject({ method: "POST", url: `/probe/vazador?q=${CANARY.query}`, headers: sensitiveHeaders, payload, remoteAddress: CANARY.clientIp }),
      app.inject({ method: "GET", url: `/probe/rota-serializer?q=${CANARY.query}`, headers: sensitiveHeaders, remoteAddress: CANARY.clientIp }),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 404, 400, 415, 500, 200, 200]);

    const output = lines.join("");
    // O app de teste escreveu dezenas de linhas: a varredura não passa por falta de log.
    expect(lines.length).toBeGreaterThan(20);
    for (const canary of Object.values(CANARY)) expect(output).not.toContain(canary);
    // Nem o IP padrão do inject, nem partes do token e dos cabeçalhos.
    for (const leak of ["127.0.0.1", "hostname", "pid", "Bearer", "sb-access-token", "authorization", "cookie", "user-agent", "headers", "?q=", "stack"]) {
      expect(output).not.toContain(leak);
    }
    for (const record of parseLines(lines)) expectOnlyAllowlistedKeys(record);
  });

  test("os campos úteis continuam lá: reqId, rota registrada, método, status e tempo de resposta", async () => {
    const { app, lines } = captureApp();
    await app.inject({ method: "POST", url: `/probe/analise?q=${CANARY.query}`, headers: sensitiveHeaders, payload });
    const [received, completed] = parseLines(lines);
    expect(received).toMatchObject({ level: 30, msg: "requisicao_recebida", req: { method: "POST", route: "/probe/analise" } });
    expect(received?.["reqId"]).toMatch(UUID);
    expect((received?.["req"] as { id: string }).id).toBe(received?.["reqId"]);
    expect(completed).toMatchObject({ level: 30, msg: "requisicao_concluida", reqId: received?.["reqId"], res: { statusCode: 200 } });
    expect(Number.isInteger(completed?.["responseTime"])).toBe(true);
    expect(typeof completed?.["time"]).toBe("number");
  });

  test("rota inexistente aparece como rota_desconhecida, nunca com a URL pedida", async () => {
    const { app, lines } = captureApp();
    await app.inject({ method: "GET", url: `/v1/admin/${CANARY.query}` });
    expect(parseLines(lines)[0]).toMatchObject({ msg: "requisicao_recebida", req: { method: "GET", route: "rota_desconhecida" } });
  });

  test("500 grava erro_interno com o tipo do erro e sem a mensagem", async () => {
    const { app, lines } = captureApp();
    await app.inject({ method: "GET", url: "/probe/explode" });
    const internal = parseLines(lines).find((r) => r["msg"] === "erro_interno");
    expect(internal).toMatchObject({ level: 50, err: { type: "Error" } });
    expect(Object.keys(internal?.["err"] as object)).toEqual(["type"]);
  });

  test("subir o servidor grava servidor_ouvindo sem o endereço de bind", async () => {
    const { app, lines } = captureApp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const listening = parseLines(lines).filter((r) => r["msg"] === "servidor_ouvindo");
    expect(listening.length).toBeGreaterThan(0);
    expect(lines.join("")).not.toContain("127.0.0.1");
  });

  test("logger: false desliga o log", async () => {
    app = buildApp({ logger: false });
    // Sem pino: o Fastify usa o logger nulo (abstract-logging), que não tem nível nem destino.
    expect(app.log.level).toBeUndefined();
  });
});
