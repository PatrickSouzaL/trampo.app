import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GOTRUE_POLICY, createGotrueClient, type GotrueClient } from "../../src/server/gotrue";
import { GOTRUE_CANARIES, startFakeGotrue, type FakeGotrue } from "../support/fake-gotrue";

const PUBLISHABLE = ["sb", "publishable", "p".repeat(24)].join("_");
const VERIFIER = "v".repeat(43);

let fake: FakeGotrue;
let client: GotrueClient;

beforeAll(async () => {
  fake = await startFakeGotrue({ publishableKey: PUBLISHABLE, allowedRedirects: ["http://127.0.0.1:1/auth/retorno"] });
  client = createGotrueClient({ supabaseUrl: fake.url.origin, publishableKey: PUBLISHABLE, timeoutMs: 400 });
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.mode = { kind: "normal" };
  fake.hookRefuses = false;
  fake.requests.length = 0;
});

/** Um código PKCE válido no simulado, pelo `authorize` que o navegador faria. */
async function pendingCode(verifier = VERIFIER): Promise<string> {
  const { createHash } = await import("node:crypto");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL("/auth/v1/authorize", fake.url);
  authorize.search = new URLSearchParams({ provider: "github", redirect_to: "http://127.0.0.1:1/auth/retorno?st=x", code_challenge: challenge, code_challenge_method: "s256" }).toString();
  const response = await fetch(authorize, { redirect: "manual" });
  return new URL(response.headers.get("location") as string).searchParams.get("code") as string;
}

describe("createGotrueClient (ADR-027 D1)", () => {
  it("recusa a chave secret e a legada", () => {
    expect(() => createGotrueClient({ supabaseUrl: fake.url.origin, publishableKey: ["sb", "secret", "x".repeat(20)].join("_") })).toThrow(/publishable/);
    expect(() => createGotrueClient({ supabaseUrl: fake.url.origin, publishableKey: "eyJ" + "x".repeat(20) })).toThrow(/publishable/);
  });

  it("usa o prazo padrão quando o teste não o encurta", () => {
    expect(GOTRUE_POLICY.timeoutMs).toBe(5_000);
    expect(createGotrueClient({ supabaseUrl: fake.url.origin, publishableKey: PUBLISHABLE })).toBeDefined();
  });
});

describe("exchangePkce", () => {
  it("troca { auth_code, code_verifier } e projeta só os 4 campos", async () => {
    const code = await pendingCode();
    fake.requests.length = 0;
    const result = await client.exchangePkce(code, VERIFIER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.tokens).sort()).toEqual(["accessToken", "expiresIn", "refreshToken"]);
    expect(result.tokens.expiresIn).toBe(900);
    expect(JSON.stringify(result)).not.toContain(GOTRUE_CANARIES.providerToken);
    const [request] = fake.requests;
    expect(request?.url).toBe("/auth/v1/token?grant_type=pkce");
    expect(JSON.parse(request?.body as string)).toEqual({ auth_code: code, code_verifier: VERIFIER });
  });

  it("manda só a lista fechada de cabeçalhos (sem X-Forwarded-For nem Authorization)", async () => {
    await client.exchangePkce(await pendingCode(), VERIFIER);
    const headers = fake.requests.at(-1)?.headers ?? {};
    expect(headers["apikey"]).toBe(PUBLISHABLE);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["accept"]).toBe("application/json");
    expect(headers["authorization"]).toBeUndefined();
    expect(Object.keys(headers).filter((name) => !["host", "connection", "content-length", "accept-encoding", "accept-language", "sec-fetch-mode", "user-agent"].includes(name)).sort()).toEqual(["accept", "apikey", "content-type"]);
  });

  it("código de uso único: o reuso é recusado", async () => {
    const code = await pendingCode();
    expect((await client.exchangePkce(code, VERIFIER)).ok).toBe(true);
    expect(await client.exchangePkce(code, VERIFIER)).toEqual({ ok: false, reason: "recusado" });
  });

  it("verifier errado é recusado", async () => {
    expect(await client.exchangePkce(await pendingCode(), "w".repeat(43))).toEqual({ ok: false, reason: "recusado" });
  });

  it.each([
    ["código curto", "abc", VERIFIER],
    ["código com caractere fora", "abc_defgh", VERIFIER],
    ["verifier curto", "abcdefgh", "v".repeat(42)],
    ["verifier com caractere fora", "abcdefgh", "v".repeat(42) + "+"],
  ])("entrada fora da forma nem sai daqui: %s", async (_caso, code, verifier) => {
    expect(await client.exchangePkce(code, verifier)).toEqual({ ok: false, reason: "nao_recebido" });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("classificação das respostas", () => {
  const cases: ReadonlyArray<readonly [string, () => void, string]> = [
    ["400 com o corpo do GoTrue", () => (fake.mode = { kind: "responde", status: 400, body: JSON.stringify({ code: 400, error_code: "x", msg: "m" }) }), "recusado"],
    ["401 com o corpo do GoTrue", () => (fake.mode = { kind: "responde", status: 401, body: JSON.stringify({ error_code: "x" }) }), "recusado"],
    ["403 unknown (recusa do hook)", () => (fake.mode = { kind: "responde", status: 403, body: JSON.stringify({ code: 403, error_code: "unknown", msg: "m" }) }), "recusado"],
    ["404 com o corpo do GoTrue", () => (fake.mode = { kind: "responde", status: 404, body: JSON.stringify({ error_code: "flow_state_not_found" }) }), "recusado"],
    ["422 com o corpo do GoTrue", () => (fake.mode = { kind: "responde", status: 422, body: JSON.stringify({ error_code: "x" }) }), "recusado"],
    ["403 em HTML (WAF)", () => (fake.mode = { kind: "responde", status: 403, body: "<html>bloqueado</html>", contentType: "text/html" }), "nao_recebido"],
    ["401 do gateway sem error_code", () => (fake.mode = { kind: "responde", status: 401, body: JSON.stringify({ message: "Invalid API key" }) }), "nao_recebido"],
    ["403 com error_code numérico", () => (fake.mode = { kind: "responde", status: 403, body: JSON.stringify({ error_code: 1 }) }), "nao_recebido"],
    ["403 com JSON inválido", () => (fake.mode = { kind: "responde", status: 403, body: "{" }), "nao_recebido"],
    ["403 com chave de protótipo", () => (fake.mode = { kind: "responde", status: 403, body: '{"__proto__":{"x":1},"error_code":"x"}' }), "nao_recebido"],
    ["403 sem content-type", () => (fake.mode = { kind: "responde", status: 403, body: JSON.stringify({ error_code: "x" }), contentType: null }), "nao_recebido"],
    ["403 com UTF-8 inválido", () => (fake.mode = { kind: "responde", status: 403, body: Buffer.from([0x7b, 0xc3, 0x28, 0x7d]) }), "nao_recebido"],
    ["403 acima do teto", () => (fake.mode = { kind: "responde", status: 403, body: JSON.stringify({ error_code: "x", pad: "p".repeat(GOTRUE_POLICY.maxResponseBytes) }) }), "nao_recebido"],
    ["429", () => (fake.mode = { kind: "responde", status: 429, body: JSON.stringify({ error_code: "over_request_rate_limit" }) }), "nao_recebido"],
    ["500", () => (fake.mode = { kind: "responde", status: 500, body: JSON.stringify({ error_code: "unexpected_failure" }) }), "nao_recebido"],
    ["503", () => (fake.mode = { kind: "responde", status: 503, body: "" }), "nao_recebido"],
    ["302", () => (fake.mode = { kind: "redireciona", location: "http://127.0.0.1:1/" }), "nao_recebido"],
    ["201", () => (fake.mode = { kind: "responde", status: 201, body: "{}" }), "pode_ter_rotacionado"],
    ["200 fora da forma", () => (fake.mode = { kind: "responde", status: 200, body: JSON.stringify({ access_token: "a.b.c" }) }), "pode_ter_rotacionado"],
    ["200 com token_type errado", () => (fake.mode = { kind: "responde", status: 200, body: JSON.stringify({ access_token: "a.b.c", refresh_token: "r", expires_in: 900, token_type: "mac" }) }), "pode_ter_rotacionado"],
    ["200 acima do teto", () => (fake.mode = { kind: "responde", status: 200, body: JSON.stringify({ pad: "p".repeat(GOTRUE_POLICY.maxResponseBytes) }) }), "pode_ter_rotacionado"],
    ["prazo estourado", () => (fake.mode = { kind: "trava" }), "pode_ter_rotacionado"],
    ["socket cortado no corpo", () => (fake.mode = { kind: "corta" }), "pode_ter_rotacionado"],
  ];

  it.each(cases)("renovação: %s", async (_caso, arrange, reason) => {
    const { refreshToken } = await fake.addSession();
    arrange();
    expect(await client.refresh(refreshToken)).toEqual({ ok: false, reason });
  });

  it("a recusa do hook pelo simulado é recusa e não consome o refresh", async () => {
    const { refreshToken } = await fake.addSession();
    fake.hookRefuses = true;
    expect(await client.refresh(refreshToken)).toEqual({ ok: false, reason: "recusado" });
    fake.hookRefuses = false;
    expect((await client.refresh(refreshToken)).ok).toBe(true);
  });

  it("renova com { refresh_token } e rotaciona", async () => {
    const { refreshToken } = await fake.addSession();
    const result = await client.refresh(refreshToken);
    expect(result.ok && result.tokens.refreshToken !== refreshToken).toBe(true);
    expect(JSON.parse(fake.requests.at(-1)?.body as string)).toEqual({ refresh_token: refreshToken });
  });

  it("refresh fora da forma nem sai daqui", async () => {
    expect(await client.refresh("")).toEqual({ ok: false, reason: "nao_recebido" });
    expect(await client.refresh("r".repeat(GOTRUE_POLICY.refreshTokenMaxChars + 1))).toEqual({ ok: false, reason: "nao_recebido" });
    expect(fake.requests).toHaveLength(0);
  });

  it("signal já abortado: o pedido nem sai", async () => {
    expect(await client.refresh("r", AbortSignal.abort())).toEqual({ ok: false, reason: "nao_recebido" });
    expect(fake.requests).toHaveLength(0);
  });

  it("abortar no meio é pode_ter_rotacionado", async () => {
    const { refreshToken } = await fake.addSession();
    fake.mode = { kind: "trava" };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(await client.refresh(refreshToken, controller.signal)).toEqual({ ok: false, reason: "pode_ter_rotacionado" });
  });

  it("o corpo do 403 que morre no meio da leitura não é recusa", async () => {
    const { refreshToken } = await fake.addSession();
    fake.hookRefuses = true;
    fake.mode = { kind: "corta" };
    expect(await client.refresh(refreshToken)).toEqual({ ok: false, reason: "nao_recebido" });
  });

  it("socket fechado antes dos cabeçalhos: o pedido pode ter chegado", async () => {
    const rude = createServer((request) => request.socket.destroy());
    await new Promise<void>((resolve) => rude.listen(0, "127.0.0.1", resolve));
    const { port } = rude.address() as AddressInfo;
    const target = createGotrueClient({ supabaseUrl: `http://127.0.0.1:${port}`, publishableKey: PUBLISHABLE, timeoutMs: 2_000 });
    expect(await target.refresh("r")).toEqual({ ok: false, reason: "pode_ter_rotacionado" });
    await new Promise<void>((resolve) => rude.close(() => resolve()));
  });

  it("conexão recusada é nao_recebido", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const offline = createGotrueClient({ supabaseUrl: `http://127.0.0.1:${port}`, publishableKey: PUBLISHABLE, timeoutMs: 400 });
    expect(await offline.refresh("r")).toEqual({ ok: false, reason: "nao_recebido" });
  });
});

describe("logout (escopo local, ADR-027 D7)", () => {
  it("POST /logout?scope=local com Bearer: encerrada", async () => {
    const session = await fake.addSession();
    expect(await client.logout(session.accessToken)).toEqual({ ok: true });
    const request = fake.requests.at(-1);
    expect(request?.url).toBe("/auth/v1/logout?scope=local");
    expect(request?.headers["authorization"]).toBe(`Bearer ${session.accessToken}`);
    expect(request?.headers["content-type"]).toBeUndefined();
    expect(fake.liveSessions.has(session.sessionId)).toBe(false);
  });

  it("o 403 session_not_found (logout repetido) também é encerrada", async () => {
    const session = await fake.addSession();
    await client.logout(session.accessToken);
    expect(await client.logout(session.accessToken)).toEqual({ ok: true });
  });

  it.each([
    ["403 bad_jwt", { kind: "responde", status: 403, body: JSON.stringify({ error_code: "bad_jwt" }) }, "recusado"],
    ["403 sem o corpo", { kind: "responde", status: 403, body: "<html/>", contentType: "text/html" }, "nao_recebido"],
    ["401 com o corpo", { kind: "responde", status: 401, body: JSON.stringify({ error_code: "no_authorization" }) }, "recusado"],
    ["401 do gateway", { kind: "responde", status: 401, body: JSON.stringify({ message: "Invalid API key" }) }, "nao_recebido"],
    ["503", { kind: "responde", status: 503, body: "" }, "nao_recebido"],
    ["204", { kind: "responde", status: 204, body: "" }, "ok"],
    ["prazo", { kind: "trava" }, "pode_ter_rotacionado"],
    ["302", { kind: "redireciona", location: "http://127.0.0.1:1/" }, "nao_recebido"],
  ] as const)("%s", async (_caso, mode, reason) => {
    const session = await fake.addSession();
    fake.mode = mode;
    expect(await client.logout(session.accessToken)).toEqual(reason === "ok" ? { ok: true } : { ok: false, reason });
  });

  it("access fora da forma nem sai daqui (e nunca vira cabeçalho com quebra de linha)", async () => {
    expect(await client.logout("a.b.c\r\nx: y")).toEqual({ ok: false, reason: "nao_recebido" });
    expect(await client.logout("a.b")).toEqual({ ok: false, reason: "nao_recebido" });
    expect(fake.requests).toHaveLength(0);
  });
});
