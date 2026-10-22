// F1-API-03 (SR-06; ADR-014 D5 e D9): o preHandler da cota diária que a rota de análise (F1-API-04) vai usar.
// Roda depois da validação do corpo, lê só o requestId e falha fechado (503) com a porta fora do contrato.
import { randomUUID } from "node:crypto";

import { ApiErrorSchema } from "@trampo/contracts/api";
import Fastify from "fastify";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { buildApp } from "../src/presentation/build-app.js";
import { createDailyQuotaPreHandler } from "../src/presentation/edge/daily-quota.js";
import { TEST_AUTHORIZATION, TEST_PRINCIPAL, fakeVerifier } from "./auth-fakes.js";
import { fakeLimits, type FakeBehavior } from "./limit-fakes.js";

const REQUEST_ID = "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3";

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function quotaApp(quota?: FakeBehavior, lines?: string[]) {
  const fakes = fakeLimits(quota === undefined ? {} : { quota });
  const counts = { handler: 0 };
  const instance = buildApp({
    accessTokenVerifier: fakeVerifier().verifier,
    limits: fakes.limits,
    logger: lines === undefined ? false : { level: "trace", stream: { write: (l) => void lines.push(l) } },
  });
  instance.post(
    "/probe/analise",
    {
      config: { rateLimit: "analise" },
      schema: { body: z.strictObject({ requestId: z.uuid(), texto: z.string() }) },
      preHandler: instance.dailyQuotaPreHandler,
    },
    async () => {
      counts.handler += 1;
      return { ok: true };
    },
  );
  // Rota mal montada (sem schema): o preHandler não confia que o corpo tenha requestId.
  instance.post("/probe/sem-schema", { preHandler: instance.dailyQuotaPreHandler }, async () => ({ ok: true }));
  app = instance;
  return { app: instance, counts, calls: fakes.quota.calls, rateCalls: fakes.rate.calls };
}

const post = (instance: ReturnType<typeof buildApp>, body: unknown, url = "/probe/analise") =>
  instance.inject({
    method: "POST",
    url,
    headers: { authorization: TEST_AUTHORIZATION, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });

describe("cota no preHandler", () => {
  test("permitida: a rota responde e a cota recebe o sub verificado e o requestId do corpo", async () => {
    const { app, calls, counts, rateCalls } = quotaApp();
    const res = await post(app, { requestId: REQUEST_ID, texto: "vaga" });
    expect(res.statusCode).toBe(200);
    expect(counts.handler).toBe(1);
    expect(calls).toEqual([{ userId: TEST_PRINCIPAL.userId, requestId: REQUEST_ID }]);
    expect(rateCalls.map((c) => c.rateClass)).toEqual(["analise"]);
  });

  test("repetição também passa", async () => {
    const { app } = quotaApp({ kind: "valor", value: { ok: true, repeated: true } });
    expect((await post(app, { requestId: REQUEST_ID, texto: "vaga" })).statusCode).toBe(200);
  });

  test("corpo inválido: 400 da validação, antes da cota (nada é cobrado)", async () => {
    const { app, calls } = quotaApp();
    const res = await post(app, { requestId: "nao-e-uuid", texto: "vaga" });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("rota sem schema e corpo sem requestId: 400 PAYLOAD_INVALIDO, sem tocar na cota", async () => {
    const { app, calls } = quotaApp();
    for (const body of [{ texto: "x" }, { requestId: 42 }, ["x"], null]) {
      const res = await post(app, body, "/probe/sem-schema");
      expect(res.statusCode).toBe(400);
      expect(ApiErrorSchema.parse(res.json()).code).toBe("PAYLOAD_INVALIDO");
    }
    expect(calls).toHaveLength(0);
  });

  test("esgotada: 429 COTA_DIARIA_ESGOTADA com Retry-After no header e no corpo", async () => {
    const { app, counts } = quotaApp({ kind: "valor", value: { ok: false, reason: "esgotada", retryAfterSeconds: 32_400 } });
    const res = await post(app, { requestId: REQUEST_ID, texto: "vaga" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("32400");
    expect(ApiErrorSchema.parse(res.json())).toMatchObject({ code: "COTA_DIARIA_ESGOTADA", retryAfterSeconds: 32_400 });
    expect(counts.handler).toBe(0);
  });

  test.each<[string, FakeBehavior]>([
    ["indisponível", { kind: "valor", value: { ok: false, reason: "indisponivel" } }],
    ["lixo", { kind: "valor", value: { ok: true } }],
    ["porta que lança", { kind: "lanca" }],
    ["porta que rejeita", { kind: "rejeita" }],
    ["porta travada", { kind: "trava" }],
  ])("%s: 503 SERVICO_INDISPONIVEL, nunca 200", async (_name, quota) => {
    const { app, counts } = quotaApp(quota);
    const res = await post(app, { requestId: REQUEST_ID, texto: "vaga" });
    expect(res.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("SERVICO_INDISPONIVEL");
    expect(counts.handler).toBe(0);
  });

  test("indisponível gera só `cota_indisponivel`, sem sub nem requestId (SR-12)", async () => {
    const lines: string[] = [];
    const { app } = quotaApp({ kind: "rejeita" }, lines);
    await post(app, { requestId: REQUEST_ID, texto: "vaga" });
    const output = lines.join("");
    for (const leak of [REQUEST_ID, TEST_PRINCIPAL.userId]) expect(output).not.toContain(leak);
    const warnings = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r["level"] === 40);
    expect(warnings).toEqual([expect.objectContaining({ msg: "cota_indisponivel" })]);
  });

  test("invariante: sem principal, 401 e a cota não é tocada", async () => {
    const fakes = fakeLimits();
    const bare = Fastify({ logger: false, genReqId: () => randomUUID() });
    bare.decorateRequest("principal", null);
    bare.post("/probe", { preHandler: createDailyQuotaPreHandler(fakes.limits.dailyQuota) }, async () => ({ ok: true }));
    const res = await bare.inject({ method: "POST", url: "/probe", payload: { requestId: REQUEST_ID } });
    expect(res.statusCode).toBe(401);
    expect(fakes.quota.calls).toHaveLength(0);
    await bare.close();
  });
});
