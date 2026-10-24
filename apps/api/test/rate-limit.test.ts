// F1-API-03 (SR-06; ADR-014 D4, D8 e D9): o hook de rate limit no onRequest, depois do JWT e antes do corpo.
// Portas falsas para a ordem dos hooks, as classes, o endereço e a falha fechada (porta que lança, rejeita,
// trava ou devolve lixo → 503, nunca 200). A pilha real (Redis simulado) está em limits-stack.test.ts.
import { randomUUID } from "node:crypto";

import { ApiErrorSchema } from "@trampo/contracts/api";
import Fastify from "fastify";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import type { RateLimitClass } from "../src/application/ports/rate-limiter.js";
import { buildApp } from "../src/presentation/build-app.js";
import { createRateLimitHook } from "../src/presentation/edge/rate-limit.js";
import { TEST_AUTHORIZATION, TEST_PRINCIPAL, fakeVerifier } from "./auth-fakes.js";
import { fakeLimits, type FakeBehavior } from "./limit-fakes.js";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function limitApp(rate?: FakeBehavior, options: { verifier?: Parameters<typeof fakeVerifier>[0]; lines?: string[] } = {}) {
  const fakes = fakeLimits(rate === undefined ? {} : { rate });
  const counts = { parser: 0, handler: 0 };
  const instance = buildApp({
    accessTokenVerifier: fakeVerifier(options.verifier).verifier,
    limits: fakes.limits,
    corsAllowedOrigins: [EXTENSION],
    logger: options.lines === undefined ? false : { level: "trace", stream: { write: (l) => void options.lines?.push(l) } },
  });
  const defaultJson = instance.getDefaultJsonParser("error", "error");
  instance.removeContentTypeParser("application/json");
  instance.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    counts.parser += 1;
    defaultJson(request, typeof body === "string" ? body : body.toString("utf8"), done);
  });
  instance.get("/probe", async () => {
    counts.handler += 1;
    return { ok: true };
  });
  instance.post(
    "/probe/analise",
    { config: { rateLimit: "analise" }, schema: { body: z.strictObject({ texto: z.string() }) } },
    async () => {
      counts.handler += 1;
      return { ok: true };
    },
  );
  instance.put(
    "/probe/criterios",
    { config: { rateLimit: "criterios" }, schema: { body: z.strictObject({ texto: z.string() }) } },
    async () => {
      counts.handler += 1;
      return { ok: true };
    },
  );
  instance.get("/probe/classe-estranha", { config: { rateLimit: "inexistente" as RateLimitClass } }, async () => ({ ok: true }));
  app = instance;
  return { app: instance, counts, calls: fakes.rate.calls };
}

const authed = { authorization: TEST_AUTHORIZATION };

describe("quando o rate limit roda", () => {
  test("rota pública (/health) não conta", async () => {
    const { app, calls } = limitApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(0);
  });

  test("sem token: 401 do JWT, sem gastar comando do Redis", async () => {
    const { app, calls } = limitApp();
    const res = await app.inject({ method: "GET", url: "/probe" });
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test("token inválido (401) e JWKS fora (503): o limitador não é chamado", async () => {
    for (const verifier of [{ ok: false, reason: "token_invalido" }, { ok: false, reason: "chaves_indisponiveis" }] as const) {
      const { app: instance, calls } = limitApp(undefined, { verifier });
      const res = await instance.inject({ method: "GET", url: "/probe", headers: authed });
      expect([401, 503]).toContain(res.statusCode);
      expect(calls).toHaveLength(0);
      await instance.close();
      app = undefined;
    }
  });

  test("origem fora da lista (403) e tipo de mídia errado (415) também vêm antes", async () => {
    const { app, calls } = limitApp();
    const cors = await app.inject({ method: "GET", url: "/probe", headers: { ...authed, origin: "https://evil.example" } });
    expect(cors.statusCode).toBe(403);
    const media = await app.inject({
      method: "POST",
      url: "/probe/analise",
      headers: { ...authed, "content-type": "text/plain" },
      payload: "x",
    });
    expect(media.statusCode).toBe(415);
    expect(calls).toHaveLength(0);
  });

  test("token válido: conta com o sub verificado e o balde do IP, e a rota responde", async () => {
    const { app, calls, counts } = limitApp();
    const res = await app.inject({ method: "GET", url: "/probe", headers: authed, remoteAddress: "203.0.113.7" });
    expect(res.statusCode).toBe(200);
    expect(counts.handler).toBe(1);
    expect(calls).toEqual([{ rateClass: "padrao", subject: { userId: TEST_PRINCIPAL.userId, clientAddress: "v4:203.0.113.7" } }]);
  });

  test("IPv6 conta pelo /64 e IPv4 mapeado vira IPv4", async () => {
    const { app, calls } = limitApp();
    await app.inject({ method: "GET", url: "/probe", headers: authed, remoteAddress: "2001:db8:1:2:aaaa:bbbb:cccc:dddd" });
    await app.inject({ method: "GET", url: "/probe", headers: authed, remoteAddress: "::ffff:198.51.100.9" });
    expect(calls.map((c) => c.subject.clientAddress)).toEqual(["v6:2001:db8:1:2::/64", "v4:198.51.100.9"]);
  });

  test("a rota declara a classe; classe desconhecida vale a mais estrita", async () => {
    const { app, calls } = limitApp();
    await app.inject({ method: "POST", url: "/probe/analise", headers: { ...authed, "content-type": "application/json" }, payload: '{"texto":"a"}' });
    await app.inject({ method: "PUT", url: "/probe/criterios", headers: { ...authed, "content-type": "application/json" }, payload: '{"texto":"a"}' });
    await app.inject({ method: "GET", url: "/probe/classe-estranha", headers: authed });
    expect(calls.map((c) => c.rateClass)).toEqual(["analise", "criterios", "analise"]);
  });

  test("criterios: 429 antes de ler o corpo, como as outras classes", async () => {
    const { app, calls, counts } = limitApp({ kind: "valor", value: { ok: false, reason: "limite_excedido", retryAfterSeconds: 9 } });
    const res = await app.inject({
      method: "PUT",
      url: "/probe/criterios",
      headers: { ...authed, "content-type": "application/json" },
      payload: '{"texto":"a"}',
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("9");
    expect(calls.map((c) => c.rateClass)).toEqual(["criterios"]);
    expect(counts).toEqual({ parser: 0, handler: 0 });
  });

  test("rota inexistente com token conta como padrao (a sondagem também gasta limite) e dá 404", async () => {
    const { app, calls } = limitApp();
    const res = await app.inject({ method: "GET", url: "/nao-existe", headers: authed });
    expect(res.statusCode).toBe(404);
    expect(calls.map((c) => c.rateClass)).toEqual(["padrao"]);
  });
});

describe("respostas", () => {
  test("limite excedido: 429 LIMITE_DE_TAXA com Retry-After no header e no corpo, sem ler o corpo", async () => {
    const { app, counts } = limitApp({ kind: "valor", value: { ok: false, reason: "limite_excedido", retryAfterSeconds: 17 } });
    const res = await app.inject({
      method: "POST",
      url: "/probe/analise",
      headers: { ...authed, "content-type": "application/json" },
      payload: JSON.stringify({ texto: "x".repeat(60_000) }),
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("17");
    const body = ApiErrorSchema.parse(res.json());
    expect(body).toMatchObject({ code: "LIMITE_DE_TAXA", retryAfterSeconds: 17 });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(counts).toEqual({ parser: 0, handler: 0 });
  });

  test.each<[string, FakeBehavior]>([
    ["indisponível", { kind: "valor", value: { ok: false, reason: "indisponivel" } }],
    ["lixo", { kind: "valor", value: { ok: true, liberar: "sim" } }],
    ["nulo", { kind: "valor", value: null }],
    ["Retry-After fora da faixa", { kind: "valor", value: { ok: false, reason: "limite_excedido", retryAfterSeconds: 0 } }],
    ["porta que lança", { kind: "lanca" }],
    ["porta que rejeita", { kind: "rejeita" }],
    ["porta travada", { kind: "trava" }],
  ])("%s: 503 SERVICO_INDISPONIVEL, nunca 200, e sem Retry-After", async (_name, rate) => {
    const { app, counts } = limitApp(rate);
    const res = await app.inject({ method: "GET", url: "/probe", headers: authed });
    expect(res.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(res.json())).toMatchObject({ code: "SERVICO_INDISPONIVEL", retryAfterSeconds: null });
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(counts.handler).toBe(0);
  });

  test("indisponível gera só a linha `limite_indisponivel`, sem IP nem sub (SR-12)", async () => {
    const lines: string[] = [];
    const { app } = limitApp({ kind: "rejeita" }, { lines });
    await app.inject({ method: "GET", url: "/probe", headers: authed, remoteAddress: "203.0.113.77" });
    const output = lines.join("");
    for (const leak of ["203.0.113.77", TEST_PRINCIPAL.userId, "Bearer"]) expect(output).not.toContain(leak);
    const warnings = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r["level"] === 40);
    expect(warnings).toEqual([expect.objectContaining({ msg: "limite_indisponivel" })]);
    expect(Object.keys(warnings[0] ?? {}).sort()).toEqual(["level", "msg", "reqId", "time"]);
  });
});

describe("invariante: rota protegida sem principal nunca passa", () => {
  test("sem o hook do JWT na frente, o rate limit responde 401 em vez de liberar", async () => {
    const fakes = fakeLimits();
    // Ids em UUID, como no buildApp: o ApiError só aceita requestId UUID.
    const bare = Fastify({ logger: false, genReqId: () => randomUUID() });
    bare.decorateRequest("principal", null);
    bare.addHook("onRequest", createRateLimitHook(fakes.limits.rateLimit));
    bare.get("/probe", async () => ({ ok: true }));
    bare.get("/health", async () => ({ ok: true }));
    const res = await bare.inject({ method: "GET", url: "/probe" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(fakes.rate.calls).toHaveLength(0);
    expect((await bare.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await bare.close();
  });
});
