// Cliente REST do Upstash (ADR-014 D2 e D3) contra um Upstash simulado em socket real (127.0.0.1): protocolo,
// token só no header, e falha fechado (`null`, nunca rejeição) em status de erro, prazo, travamento, corpo
// gigante, JSON ou UTF-8 inválido, item com erro, tamanho ou tipo errado e redirecionamento (não segue).
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  UPSTASH_CLIENT_POLICY,
  createUpstashRestClient,
  type RedisCommand,
  type RedisTransactions,
} from "../../src/infrastructure/redis/upstash-rest-client.js";
import { startFakeUpstash, type FakeUpstash } from "./fakes/fake-upstash.js";

const TOKEN = "AXyz_token-de-teste.123";

let upstash: FakeUpstash;
let other: FakeUpstash | undefined;
let client: RedisTransactions;
beforeEach(async () => {
  upstash = await startFakeUpstash(TOKEN);
  client = createUpstashRestClient({ url: upstash.url, token: TOKEN, timeoutMs: 300 });
});
afterEach(async () => {
  await upstash.close();
  await other?.close();
  other = undefined;
});

const COMMANDS: readonly RedisCommand[] = [
  ["INCR", "rl:k:1"],
  ["PEXPIRE", "rl:k:1", 121_000],
  ["GET", "rl:k:0"],
];
const exec = (commands: readonly RedisCommand[] = COMMANDS, signal = new AbortController().signal) => client.exec(commands, signal);

describe("protocolo", () => {
  test("POST /multi-exec com Bearer e corpo [[cmd, ...]]; devolve os resultados na ordem", async () => {
    await expect(exec()).resolves.toEqual([1, 1, null]);
    await expect(exec()).resolves.toEqual([2, 1, null]);
    expect(upstash.requests[0]).toEqual({
      method: "POST",
      url: "/multi-exec",
      authorization: `Bearer ${TOKEN}`,
      commands: [
        ["INCR", "rl:k:1"],
        ["PEXPIRE", "rl:k:1", 121_000],
        ["GET", "rl:k:0"],
      ],
    });
  });

  test("o token nunca vai na URL", async () => {
    await exec();
    expect(upstash.requests[0]?.url).not.toContain(TOKEN);
    expect(upstash.requests[0]?.url).not.toContain("_token");
  });

  test("respostas em texto (GET) e inteiras (INCR) passam como vieram", async () => {
    await exec([["INCR", "c"]]);
    await expect(exec([["GET", "c"], ["SADD", "s", "m"], ["SCARD", "s"]])).resolves.toEqual(["1", 1, 1]);
  });

  test("a URL base com barra final ou não dá no mesmo endpoint", async () => {
    const withSlash = createUpstashRestClient({ url: new URL(`${upstash.url.origin}/`), token: TOKEN });
    await expect(withSlash.exec([["INCR", "x"]], new AbortController().signal)).resolves.toEqual([1]);
    expect(upstash.requests.at(-1)?.url).toBe("/multi-exec");
  });

  test("sem comando ou com mais de 16: null sem requisição", async () => {
    await expect(exec([])).resolves.toBeNull();
    const many = Array.from({ length: UPSTASH_CLIENT_POLICY.maxCommands + 1 }, (_, i): RedisCommand => ["INCR", `k${i}`]);
    await expect(exec(many)).resolves.toBeNull();
    expect(upstash.requests).toHaveLength(0);
    const exactly16 = many.slice(0, UPSTASH_CLIENT_POLICY.maxCommands);
    await expect(exec(exactly16)).resolves.toHaveLength(16);
  });

  test("política fixada no ADR-014 D3", () => {
    expect(UPSTASH_CLIENT_POLICY).toEqual({ timeoutMs: 200, maxCommands: 16, maxResponseBytes: 16_384, maxStringReplyChars: 64 });
  });
});

describe("falha fechado: nunca rejeita, devolve null", () => {
  test("token errado (401)", async () => {
    const wrong = createUpstashRestClient({ url: upstash.url, token: "outro" });
    await expect(wrong.exec(COMMANDS, new AbortController().signal)).resolves.toBeNull();
  });

  test.each([[400], [404], [429], [500], [503]])("status %d", async (status) => {
    upstash.mode = { kind: "status", status };
    await expect(exec()).resolves.toBeNull();
  });

  test.each([[201], [202], [302], [400], [500]])("status %d com um corpo que seria válido", async (status) => {
    upstash.mode = { kind: "status", status, body: '[{"result":1},{"result":1},{"result":null}]' };
    await expect(exec()).resolves.toBeNull();
  });

  test("teto exato de 16 KiB: 16.384 bytes passam, 16.385 não", async () => {
    const valid = '[{"result":1},{"result":1},{"result":null}]';
    upstash.mode = { kind: "corpo", body: valid + " ".repeat(UPSTASH_CLIENT_POLICY.maxResponseBytes - valid.length) };
    await expect(exec()).resolves.toEqual([1, 1, null]);
    upstash.mode = { kind: "corpo", body: valid + " ".repeat(UPSTASH_CLIENT_POLICY.maxResponseBytes - valid.length + 1) };
    await expect(exec()).resolves.toBeNull();
  });

  test("UTF-8 inválido dentro de uma string de um JSON que seria válido", async () => {
    const body = Buffer.concat([Buffer.from('[{"result":"'), Buffer.from([0xff]), Buffer.from('"},{"result":1},{"result":null}]')]);
    upstash.mode = { kind: "corpo", body };
    await expect(exec()).resolves.toBeNull();
  });

  test("204 sem corpo", async () => {
    upstash.mode = { kind: "status", status: 204, body: "" };
    await expect(exec()).resolves.toBeNull();
  });

  test.each([
    ["erro global da transação", '{"error":"ERR syntax"}'],
    ["JSON inválido", "[{"],
    ["corpo vazio", ""],
    ["array do tamanho errado", '[{"result":1},{"result":1}]'],
    ["array a mais", '[{"result":1},{"result":1},{"result":null},{"result":1}]'],
    ["item com campo a mais", '[{"result":1,"x":1},{"result":1},{"result":null}]'],
    ["item sem result", '[{},{"result":1},{"result":null}]'],
    ["item com error e result", '[{"result":1,"error":"x"},{"result":1},{"result":null}]'],
    ["número fracionário", '[{"result":1.5},{"result":1},{"result":null}]'],
    ["booleano", '[{"result":true},{"result":1},{"result":null}]'],
    ["array como resultado", '[{"result":[1]},{"result":1},{"result":null}]'],
    ["texto longo demais", `[{"result":"${"a".repeat(65)}"},{"result":1},{"result":null}]`],
    ["objeto em vez de array", '{"result":[1,1,null]}'],
  ])("%s", async (_name, body) => {
    upstash.mode = { kind: "corpo", body };
    await expect(exec()).resolves.toBeNull();
  });

  test("texto de 64 caracteres ainda passa", async () => {
    upstash.mode = { kind: "corpo", body: `[{"result":"${"a".repeat(64)}"},{"result":1},{"result":null}]` };
    await expect(exec()).resolves.toEqual(["a".repeat(64), 1, null]);
  });

  test("UTF-8 inválido", async () => {
    upstash.mode = { kind: "corpo", body: Buffer.from([0x5b, 0x7b, 0xff, 0xfe, 0x7d, 0x5d]) };
    await expect(exec()).resolves.toBeNull();
  });

  test("erro em um único comando (o Upstash segue executando os outros)", async () => {
    upstash.mode = { kind: "erro_em", index: 1 };
    await expect(exec()).resolves.toBeNull();
    expect(upstash.store.counter("rl:k:1")).toBe(1);
  });

  test("comando desconhecido devolvido como erro pelo servidor", async () => {
    await expect(exec([["FLUSHALL" as "INCR", "x"]])).resolves.toBeNull();
  });

  test("corpo acima de 16 KiB", async () => {
    upstash.mode = { kind: "grande", bytes: 20 * 1024 };
    await expect(exec()).resolves.toBeNull();
  });

  test("lento além do prazo: null dentro do prazo", async () => {
    upstash.mode = { kind: "lento", delayMs: 1_000 };
    const start = performance.now();
    await expect(exec()).resolves.toBeNull();
    expect(performance.now() - start).toBeLessThan(900);
  });

  test("travado (nunca responde): null dentro do prazo", async () => {
    upstash.mode = { kind: "trava" };
    const start = performance.now();
    await expect(exec()).resolves.toBeNull();
    expect(performance.now() - start).toBeLessThan(900);
  });

  test("o signal do chamador aborta a requisição", async () => {
    upstash.mode = { kind: "trava" };
    const controller = new AbortController();
    const slowClient = createUpstashRestClient({ url: upstash.url, token: TOKEN, timeoutMs: 10_000 });
    const pending = slowClient.exec(COMMANDS, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const start = performance.now();
    await expect(pending).resolves.toBeNull();
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  test("redirecionamento não é seguido: o token não vai para outro host", async () => {
    other = await startFakeUpstash(TOKEN);
    upstash.mode = { kind: "redireciona", location: `${other.url.origin}/multi-exec` };
    await expect(exec()).resolves.toBeNull();
    expect(other.requests).toHaveLength(0);
  });

  test("servidor fora do ar (porta fechada)", async () => {
    const url = upstash.url;
    await upstash.close();
    upstash = await startFakeUpstash(TOKEN);
    const closed = createUpstashRestClient({ url, token: TOKEN, timeoutMs: 300 });
    await expect(closed.exec(COMMANDS, new AbortController().signal)).resolves.toBeNull();
  });
});
