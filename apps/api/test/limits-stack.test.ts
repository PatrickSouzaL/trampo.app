// F1-API-03 de ponta a ponta (SR-06, SR-12, SR-17; ADR-014 §3): buildApp com os guardas, os adapters em Redis
// e o cliente REST reais, como no main.ts, contra um Upstash simulado em socket real. Só o JWT é falso (a pilha
// do JWT tem o próprio teste de ponta a ponta). Nenhuma chamada ao Upstash real.
import { ApiErrorSchema } from "@trampo/contracts/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { DailyQuotaGuard, RateLimitGuard } from "../src/application/limits/limit-guards.js";
import { createHmacKeyPseudonymizer } from "../src/infrastructure/crypto/hmac-key-pseudonymizer.js";
import { createRedisDailyQuota } from "../src/infrastructure/limits/redis-daily-quota.js";
import { createRedisRateLimiter } from "../src/infrastructure/limits/redis-rate-limiter.js";
import { createUpstashRestClient, type RedisCommand } from "../src/infrastructure/redis/upstash-rest-client.js";
import { systemClock } from "../src/infrastructure/time/system-clock.js";
import { buildApp } from "../src/presentation/build-app.js";
import { TEST_PRINCIPAL, TEST_TOKEN, fakeVerifier } from "./auth-fakes.js";
import { startFakeUpstash, type FakeUpstash, type UpstashMode } from "./infrastructure/fakes/fake-upstash.js";
import { plainIdentifierLeaks } from "./infrastructure/fakes/redis-store.js";

const UPSTASH_TOKEN = "AXcanario_upstash-token.987";
const PEPPER = "canarioPepper0123456789abcdefghijklmnopqrstu";
const CLIENT_IP = "203.0.113.77";
const NOON = Date.parse("2026-10-21T18:00:00.000Z");
const requestId = (n: number): string => `0b1c2d3e-4f50-4a6b-9c7d-${String(n).padStart(12, "0")}`;

let upstash: FakeUpstash;
let app: ReturnType<typeof buildApp> | undefined;
let lines: string[];
beforeEach(async () => {
  upstash = await startFakeUpstash(UPSTASH_TOKEN);
  lines = [];
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await upstash.close();
});

/** Igual ao main.ts: instâncias criadas uma vez, compartilhadas por todas as requisições. */
function stackApp(token = UPSTASH_TOKEN) {
  const deps = {
    redis: createUpstashRestClient({ url: upstash.url, token }),
    pseudonymizer: createHmacKeyPseudonymizer(PEPPER),
    now: () => NOON,
  };
  const instance = buildApp({
    accessTokenVerifier: fakeVerifier().verifier,
    limits: {
      rateLimit: new RateLimitGuard(createRedisRateLimiter(deps), systemClock),
      dailyQuota: new DailyQuotaGuard(createRedisDailyQuota(deps), systemClock),
    },
    logger: { level: "trace", stream: { write: (l) => void lines.push(l) } },
  });
  instance.post(
    "/probe/analise",
    {
      config: { rateLimit: "analise" },
      schema: { body: z.strictObject({ requestId: z.uuid() }) },
      preHandler: instance.dailyQuotaPreHandler,
    },
    async () => ({ ok: true }),
  );
  instance.get("/probe", async () => ({ ok: true }));
  app = instance;
  return { app: instance, pseudonymizer: deps.pseudonymizer };
}

const analyze = (instance: ReturnType<typeof buildApp>, n: number) =>
  instance.inject({
    method: "POST",
    url: "/probe/analise",
    remoteAddress: CLIENT_IP,
    headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
    payload: JSON.stringify({ requestId: requestId(n) }),
  });

const commandLog = (): RedisCommand[][] => upstash.requests.map((r) => r.commands as RedisCommand[]);

describe("fluxo feliz e limites reais", () => {
  test("5 análises por minuto passam; a 6ª dá 429 LIMITE_DE_TAXA com Retry-After", async () => {
    const { app } = stackApp();
    for (let n = 1; n <= 5; n += 1) expect((await analyze(app, n)).statusCode).toBe(200);
    const res = await analyze(app, 6);
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("60");
    expect(ApiErrorSchema.parse(res.json()).code).toBe("LIMITE_DE_TAXA");
    // 5 transações de rate limit + 5 de cota + a 6ª de rate limit; nenhuma de cota na negada.
    expect(upstash.requests).toHaveLength(11);
  });

  test("cota do dia esgotada: 429 COTA_DIARIA_ESGOTADA até a meia-noite de Brasília (9 h)", async () => {
    const { app, pseudonymizer } = stackApp();
    const key = `quota:${pseudonymizer.pseudonym("sub", TEST_PRINCIPAL.userId)}:2026-10-21`;
    upstash.store.values.set(key, new Set(Array.from({ length: 50 }, (_, i) => requestId(1_000 + i))));
    const res = await analyze(app, 1);
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("32400");
    expect(ApiErrorSchema.parse(res.json()).code).toBe("COTA_DIARIA_ESGOTADA");
    // A repetição de um pedido já contado passa.
    expect((await analyze(app, 1_000)).statusCode).toBe(200);
  });

  test("SR-17: nenhum argumento enviado ao Redis contém o IP ou o sub", async () => {
    const { app } = stackApp();
    for (let n = 1; n <= 7; n += 1) await analyze(app, n);
    await app.inject({ method: "GET", url: "/probe", remoteAddress: "2001:db8:aaaa:bbbb::1", headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    expect(upstash.requests.length).toBeGreaterThan(10);
    expect(plainIdentifierLeaks(commandLog(), [TEST_PRINCIPAL.userId, CLIENT_IP, "2001:db8"])).toEqual([]);
    expect(upstash.requests.every((r) => r.authorization === `Bearer ${UPSTASH_TOKEN}` && r.url === "/multi-exec")).toBe(true);
  });
});

describe("falha fechado na pilha inteira (SR-06, T39): 503, nunca 200", () => {
  test.each<[string, UpstashMode]>([
    ["lento além do prazo", { kind: "lento", delayMs: 2_000 }],
    ["travado", { kind: "trava" }],
    ["500", { kind: "status", status: 500 }],
    ["erro global", { kind: "corpo", body: '{"error":"ERR max daily request limit exceeded"}' }],
    ["erro num comando", { kind: "erro_em", index: 2 }],
    ["lixo", { kind: "corpo", body: "<html>proxy</html>" }],
    ["corpo gigante", { kind: "grande", bytes: 64 * 1024 }],
    ["redirecionamento", { kind: "redireciona", location: "https://outro.example/multi-exec" }],
  ])("Upstash %s", async (_name, mode) => {
    const { app } = stackApp();
    upstash.mode = mode;
    const start = performance.now();
    const res = await analyze(app, 1);
    expect(res.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("SERVICO_INDISPONIVEL");
    // Responde dentro do prazo do guarda (250 ms), com folga para a máquina de CI.
    expect(performance.now() - start).toBeLessThan(1_500);
  });

  test("token do Upstash errado (401)", async () => {
    const { app } = stackApp("token-errado");
    expect((await analyze(app, 1)).statusCode).toBe(503);
  });

  test("Upstash fora do ar (porta fechada)", async () => {
    const { app } = stackApp();
    await upstash.close();
    upstash = await startFakeUpstash(UPSTASH_TOKEN);
    expect((await analyze(app, 1)).statusCode).toBe(503);
  });

  test("a cota falha sozinha (WRONGTYPE no set do dia): 503 depois de o rate limit passar", async () => {
    const { app, pseudonymizer } = stackApp();
    upstash.store.values.set(`quota:${pseudonymizer.pseudonym("sub", TEST_PRINCIPAL.userId)}:2026-10-21`, "texto");
    const res = await analyze(app, 1);
    expect(res.statusCode).toBe(503);
    const warnings = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r["level"] === 40);
    expect(warnings).toEqual([expect.objectContaining({ msg: "cota_indisponivel" })]);
  });
});

describe("SR-12 na pilha inteira", () => {
  test("canário de IP, sub, requestId, token, token do Upstash, pepper, chave e HMAC fora de todas as linhas", async () => {
    const { app, pseudonymizer } = stackApp();
    for (let n = 1; n <= 6; n += 1) await analyze(app, n);
    upstash.mode = { kind: "status", status: 500 };
    await analyze(app, 7);
    const output = lines.join("");
    expect(lines.length).toBeGreaterThan(10);
    const leaks = [
      CLIENT_IP,
      TEST_PRINCIPAL.userId,
      requestId(1),
      TEST_TOKEN,
      UPSTASH_TOKEN,
      PEPPER,
      "rl:",
      "quota:",
      "multi-exec",
      pseudonymizer.pseudonym("sub", TEST_PRINCIPAL.userId),
      pseudonymizer.pseudonym("ip", `v4:${CLIENT_IP}`),
    ];
    for (const leak of leaks) expect(output).not.toContain(leak);
    const messages = new Set(lines.map((l) => (JSON.parse(l) as { msg: string }).msg));
    expect(messages.has("limite_indisponivel")).toBe(true);
    expect(messages.has("mensagem_fora_do_catalogo")).toBe(false);
  });
});
