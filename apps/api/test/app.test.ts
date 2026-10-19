// F1-API-00: o esqueleto responde, valida a SAÍDA e todo erro sai como ApiError sem vazamento.
import { ApiErrorSchema } from "@trampo/contracts/api";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { buildApp } from "../src/presentation/build-app.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** App de teste com rotas extras que forçam cada tipo de falha. */
function appWithProbes() {
  app = buildApp({ logger: false });
  app.get("/probe/explode", async () => {
    throw new Error("segredo interno: postgres://user:senha@db/trampo");
  });
  // Handler devolve chave fora do schema de resposta: o serializer precisa barrar.
  app.get("/probe/vaza", { schema: { response: { 200: z.strictObject({ ok: z.literal(true) }) } } }, async () => {
    return { ok: true, perfilDoUsuario: "pretensão salarial" } as unknown as { ok: true };
  });
  app.post("/probe/body", { schema: { body: z.strictObject({ n: z.int() }) } }, async () => ({ ok: true }));
  return app;
}

function expectApiError(body: string, code: string): z.infer<typeof ApiErrorSchema> {
  const parsed = ApiErrorSchema.parse(JSON.parse(body));
  expect(parsed.code).toBe(code);
  expect(parsed.requestId).toMatch(UUID);
  return parsed;
}

describe("GET /health", () => {
  test("responde 200 { status: 'ok' } em JSON", async () => {
    app = buildApp({ logger: false });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("erros sempre no formato ApiError", () => {
  test("rota inexistente: 404 com código genérico, sem dizer o que existe", async () => {
    const res = await appWithProbes().inject({ method: "GET", url: "/v1/admin/usuarios" });
    expect(res.statusCode).toBe(404);
    expectApiError(res.body, "PROIBIDO");
    expect(res.body).not.toContain("/v1/admin");
  });

  test("exceção interna: 500 ERRO_INTERNO sem stack, mensagem ou detalhe do erro", async () => {
    const res = await appWithProbes().inject({ method: "GET", url: "/probe/explode" });
    expect(res.statusCode).toBe(500);
    expectApiError(res.body, "ERRO_INTERNO");
    for (const leak of ["segredo", "postgres", "senha", "stack", "Error", "at "]) expect(res.body).not.toContain(leak);
  });

  test("serializer valida a SAÍDA: chave fora do schema não vaza e vira ERRO_INTERNO", async () => {
    const res = await appWithProbes().inject({ method: "GET", url: "/probe/vaza" });
    expect(res.statusCode).toBe(500);
    expectApiError(res.body, "ERRO_INTERNO");
    expect(res.body).not.toContain("pretensão");
  });

  test("corpo inválido: 400 PAYLOAD_INVALIDO sem os detalhes do Zod", async () => {
    const res = await appWithProbes().inject({ method: "POST", url: "/probe/body", payload: { n: 1.5, extra: "x" } });
    expect(res.statusCode).toBe(400);
    expectApiError(res.body, "PAYLOAD_INVALIDO");
    for (const leak of ["issues", "expected", "invalid_type", "unrecognized", "extra", "path"]) expect(res.body).not.toContain(leak);
  });

  test("JSON malformado: 400 PAYLOAD_INVALIDO", async () => {
    const res = await appWithProbes().inject({
      method: "POST",
      url: "/probe/body",
      headers: { "content-type": "application/json" },
      payload: '{"n":',
    });
    expect(res.statusCode).toBe(400);
    expectApiError(res.body, "PAYLOAD_INVALIDO");
  });
});

describe("id de correlação", () => {
  test("é um UUID do servidor; o x-request-id do cliente é ignorado", async () => {
    const res = await appWithProbes().inject({
      method: "GET",
      url: "/nao-existe",
      headers: { "x-request-id": "injetado-pelo-cliente" },
    });
    const body = expectApiError(res.body, "PROIBIDO");
    expect(body.requestId).not.toBe("injetado-pelo-cliente");
  });
});
