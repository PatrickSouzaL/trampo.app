// Cliente do GoTrue do BFF (ADR-004 D4 e D7, ADR-018 D5) contra o GoTrue simulado em socket real (127.0.0.1,
// test/support/fake-gotrue.ts). Prova:
// - protocolo: URL fixa de SUPABASE_URL, corpo `{ auth_code, code_verifier }` (nunca `code`), `{ refresh_token }`
//   e `logout?scope=global` com o Bearer do usuário;
// - lista fechada de cabeçalhos de saída: nada de `X-Forwarded-For`, `X-Real-IP`, `Forwarded` nem cabeçalho do
//   cliente (condição 2 do `[APPSEC]` no §6.3);
// - projeção de 4 campos: `user`, `provider_token` e e-mail canários nunca chegam ao resultado;
// - a classificação do D7 com as emendas do HITL-035 e da F1-API-08 (achados A-01 e A-02): 400, 401, 403, 404 e 422
//   só são `recusado` com o corpo JSON do GoTrue e `error_code` string, que nunca sai do adapter; sem esse corpo (o
//   `Invalid API key` do gateway, HTML de WAF ou de proxy), `nao_recebido`. No logout, só o 2xx e o 403
//   `session_not_found` são sessão encerrada: o 401 nunca é. "Pode ter rotacionado" quando o GoTrue processou e a
//   resposta se perdeu (M-13);
// - falha fechado sem rejeitar, sem retry e sem seguir redirecionamento.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { REFRESH_SEALER_POLICY } from "../../src/infrastructure/crypto/aead-refresh-sealer.js";
import {
  GOTRUE_CLIENT_POLICY,
  GotrueClientConfigError,
  createGotrueTokenClient,
} from "../../src/infrastructure/supabase/gotrue-token-client.js";
import type { AuthTokenGateway } from "../../src/application/ports/auth-token-gateway.js";
import { GOTRUE_CANARIES, startFakeGotrue, type FakeGotrue, type GotrueRequest } from "../support/fake-gotrue.js";
import { HAPPY_PATH_TIMEOUT_MS } from "../support/socket-deadlines.js";

const PUBLISHABLE = "sb_publishable_AbC123-teste_xyz";
const CODE = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const OTHER_VERIFIER = "x".repeat(43);

/** Cabeçalhos que o próprio fetch do Node põe; nenhum vem do adapter nem do cliente da API. */
const TRANSPORT_HEADERS = new Set(["host", "connection", "content-length", "user-agent", "accept-language", "sec-fetch-mode", "accept-encoding"]);
/** Cabeçalhos de origem de cliente que nunca podem chegar ao GoTrue (T43, *Egress Budget Drain*). */
const CLIENT_ORIGIN_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-client-ip", "cf-connecting-ip", "true-client-ip", "origin", "cookie"];

const RECUSADO = { ok: false, reason: "recusado" };
const NAO_RECEBIDO = { ok: false, reason: "nao_recebido" };
const PODE_TER_ROTACIONADO = { ok: false, reason: "pode_ter_rotacionado" };

/** Os status que o GoTrue usa para dizer "não" (D7). Todos só valem como recusa com o corpo dele. */
const REFUSAL_STATUSES = [400, 401, 403, 404, 422] as const;
/** O que o gateway do Supabase responde à *publishable* revogada ou errada: JSON, mas sem o `error_code` do GoTrue. */
const INVALID_API_KEY = JSON.stringify({ message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." });
/** Página de bloqueio de um WAF ou proxy na frente do Supabase. */
const WAF_PAGE = "<html><body><h1>403 Forbidden</h1>Request blocked.</body></html>";

/** Respostas sem o corpo JSON do GoTrue: nenhuma vira recusa, em nenhum dos 5 status (A-02). */
const WITHOUT_GOTRUE_BODY = [
  ["Invalid API key do gateway", INVALID_API_KEY, "application/json"],
  ["HTML de WAF ou proxy", WAF_PAGE, "text/html"],
  ["vazio", "", "application/json"],
  ["vazio sem content-type", "", null],
  ["JSON sem error_code", JSON.stringify({ message: "not found" }), "application/json"],
  ["error_code numérico", JSON.stringify({ error_code: 404 }), "application/json"],
  ["error_code nulo", JSON.stringify({ error_code: null }), "application/json"],
  ["array", JSON.stringify([{ error_code: "flow_state_not_found" }]), "application/json"],
  ["string JSON", JSON.stringify("flow_state_not_found"), "application/json"],
  ["corpo do GoTrue com content-type de texto", JSON.stringify({ error_code: "flow_state_not_found" }), "text/plain"],
  ["JSON inválido", '{"error_code":', "application/json"],
  ["__proto__", '{"error_code":"x","__proto__":{"admin":true}}', "application/json"],
] as const;

let gotrue: FakeGotrue;
let other: FakeGotrue | undefined;
let client: AuthTokenGateway;
/** Prazo curto, só nos testes de prazo em socket real; os demais usam o folgado (QA-02). */
let short: AuthTokenGateway;
beforeEach(async () => {
  gotrue = await startFakeGotrue(PUBLISHABLE);
  gotrue.addFlow(CODE, VERIFIER);
  client = createGotrueTokenClient({ url: gotrue.url, publishableKey: PUBLISHABLE, timeoutMs: HAPPY_PATH_TIMEOUT_MS });
  short = createGotrueTokenClient({ url: gotrue.url, publishableKey: PUBLISHABLE, timeoutMs: 300 });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await gotrue.close();
  await other?.close();
  other = undefined;
});

const exchange = (code = CODE, verifier = VERIFIER, signal?: AbortSignal) => client.exchangePkce(code, verifier, signal);

/** Os nomes dos cabeçalhos que o adapter escolheu (tira os de transporte do fetch). */
const chosenHeaders = (request: GotrueRequest | undefined): string[] =>
  Object.keys(request?.headers ?? {})
    .filter((name) => !TRANSPORT_HEADERS.has(name))
    .sort();

/** Um 200 do GoTrue com o corpo dado, para os casos de corpo inválido. */
const ok200 = (body: Record<string, unknown>): string =>
  JSON.stringify({ access_token: "aaa.bbb.ccc", token_type: "bearer", expires_in: 900, refresh_token: "r3fr3sh", ...body });

describe("construtor: só a chave publishable", () => {
  test.each([
    ["secret", "sb_secret_AbC123-teste_xyz"],
    ["legada (JWT de anon ou service_role)", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.assinatura"],
    ["vazia", ""],
    ["prefixo sem corpo", "sb_publishable_"],
    ["com quebra de linha", "sb_publishable_abc\r\nx-forwarded-for: 1.2.3.4"],
    ["prefixo em maiúsculas", "SB_PUBLISHABLE_abc"],
    ["publishable precedida de outra coisa", "xsb_publishable_abc"],
    ["longa demais", `sb_publishable_${"a".repeat(257)}`],
  ])("recusa %s, com mensagem fixa que não repete a chave", (_name, key) => {
    let error: unknown;
    try {
      createGotrueTokenClient({ url: gotrue.url, publishableKey: key });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GotrueClientConfigError);
    const message = (error as Error).message;
    expect(message).toContain("SUPABASE_PUBLISHABLE_KEY");
    if (key.length > "sb_publishable_".length) expect(message).not.toContain(key);
    expect((error as Error).name).toBe("GotrueClientConfigError");
  });

  test("aceita a publishable no teto de 256 caracteres depois do prefixo", () => {
    expect(() => createGotrueTokenClient({ url: gotrue.url, publishableKey: `sb_publishable_${"a".repeat(256)}` })).not.toThrow();
  });

  test("política fixada no ADR-004 D4: 5 s, 32 KiB, teto do token do contrato e lista fechada de cabeçalhos", () => {
    expect(GOTRUE_CLIENT_POLICY).toEqual({
      timeoutMs: 5_000,
      maxResponseBytes: 32_768,
      accessTokenMaxChars: 8_192,
      refreshTokenMaxChars: 512,
      outboundHeaders: { token: ["apikey", "content-type", "accept"], logout: ["apikey", "authorization", "accept"] },
    });
  });

  test("o teto do refresh é o mesmo do RefreshSealer: um refresh que o GoTrue mande acima dele não seria selado", () => {
    expect(GOTRUE_CLIENT_POLICY.refreshTokenMaxChars).toBe(REFRESH_SEALER_POLICY.refreshTokenMaxChars);
  });
});

describe("troca (grant_type=pkce): protocolo", () => {
  test("POST /auth/v1/token?grant_type=pkce com exatamente { auth_code, code_verifier }", async () => {
    const result = await exchange();
    expect(result.ok).toBe(true);
    expect(gotrue.requests).toHaveLength(1);
    const [sent] = gotrue.requests;
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toBe("/auth/v1/token?grant_type=pkce");
    // A ordem e o nome exatos: `code` seria recusado pelo GoTrue (pré-spike, P7) e não há nova tentativa.
    expect(sent?.body).toBe(JSON.stringify({ auth_code: CODE, code_verifier: VERIFIER }));
  });

  test("projeção de 4 campos, construída campo a campo: nada de user, provider_token, e-mail ou expires_at", async () => {
    const result = await exchange();
    if (!result.ok) throw new Error("esperava sucesso");
    expect(Object.keys(result).sort()).toEqual(["ok", "tokens"]);
    expect(Object.keys(result.tokens).sort()).toEqual(["accessToken", "expiresIn", "refreshToken", "tokenType"]);
    expect(result.tokens.expiresIn).toBe(900);
    expect(result.tokens.tokenType).toBe("bearer");
    expect(gotrue.liveAccessTokens.has(result.tokens.accessToken)).toBe(true);
    expect(gotrue.activeRefreshTokens.has(result.tokens.refreshToken)).toBe(true);
    const serialized = JSON.stringify(result);
    for (const canary of [GOTRUE_CANARIES.email, GOTRUE_CANARIES.providerToken, GOTRUE_CANARIES.providerRefreshToken, GOTRUE_CANARIES.userId]) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).not.toContain("expires_at");
  });

  test("a projeção ignora chaves extras na raiz, inclusive as de nome parecido", async () => {
    gotrue.mode = { kind: "responde", status: 200, body: ok200({ accessToken: "x.y.z", tokens: "sujo", admin: true, expiresIn: 1 }) };
    await expect(exchange()).resolves.toEqual({
      ok: true,
      tokens: { accessToken: "aaa.bbb.ccc", refreshToken: "r3fr3sh", expiresIn: 900, tokenType: "bearer" },
    });
  });

  test("expires_in acima de 900 passa como veio: a política (503 auth_token_fora_da_politica) é do caso de uso, sem clamp", async () => {
    gotrue.expiresIn = 3_600;
    const result = await exchange();
    expect(result.ok && result.tokens.expiresIn).toBe(3_600);
  });

  test("lista fechada de cabeçalhos: só apikey publishable, content-type e accept JSON; sem Authorization", async () => {
    await exchange();
    const [sent] = gotrue.requests;
    expect(chosenHeaders(sent)).toEqual(["accept", "apikey", "content-type"]);
    expect(sent?.headers).toMatchObject({ apikey: PUBLISHABLE, "content-type": "application/json", accept: "application/json" });
    expect(sent?.headers.authorization).toBeUndefined();
  });

  test("nenhum cabeçalho de origem do cliente chega ao GoTrue, nem por transporte", async () => {
    await exchange();
    const names = Object.keys(gotrue.requests[0]?.headers ?? {});
    for (const header of CLIENT_ORIGIN_HEADERS) expect(names).not.toContain(header);
    for (const name of names) expect([...TRANSPORT_HEADERS, ...GOTRUE_CLIENT_POLICY.outboundHeaders.token]).toContain(name);
  });

  test("nenhum sb_secret_, código ou verifier na URL", async () => {
    await exchange();
    const url = gotrue.requests[0]?.url ?? "";
    expect(JSON.stringify(gotrue.requests)).not.toContain("sb_secret_");
    expect(url).not.toContain(CODE);
    expect(url).not.toContain(VERIFIER);
    expect(url).not.toContain(PUBLISHABLE);
  });

  test("URL fixa: a base com caminho ou barra final dá no mesmo endpoint", async () => {
    const withPath = createGotrueTokenClient({ url: new URL(`${gotrue.url.origin}/outro/caminho/`), publishableKey: PUBLISHABLE, timeoutMs: HAPPY_PATH_TIMEOUT_MS });
    await expect(withPath.exchangePkce(CODE, VERIFIER)).resolves.toMatchObject({ ok: true });
    expect(gotrue.requests.at(-1)?.url).toBe("/auth/v1/token?grant_type=pkce");
  });

  test("o simulado derruba um adapter que mande `code` no lugar de `auth_code` (400)", async () => {
    const response = await fetch(new URL("/auth/v1/token?grant_type=pkce", gotrue.url), {
      method: "POST",
      headers: { apikey: PUBLISHABLE, "content-type": "application/json" },
      body: JSON.stringify({ code: CODE, code_verifier: VERIFIER }),
    });
    expect(response.status).toBe(400);
    await response.body?.cancel();
    expect(gotrue.requests).toHaveLength(1);
  });
});

describe("troca: recusas do GoTrue viram `recusado`, sem nova tentativa", () => {
  test("reuso do código: 404 flow_state_not_found com o corpo do GoTrue", async () => {
    await expect(exchange()).resolves.toMatchObject({ ok: true });
    await expect(exchange()).resolves.toEqual(RECUSADO);
    expect(gotrue.requests).toHaveLength(2);
  });

  test.each([[400], [401], [403], [404], [422]] as const)("verifier errado com %d e corpo JSON do GoTrue", async (status) => {
    gotrue.rejectStatus = status;
    await expect(exchange(CODE, OTHER_VERIFIER)).resolves.toEqual(RECUSADO);
    expect(gotrue.requests).toHaveLength(1);
  });

  test.each([[400], [401], [403], [404], [422]] as const)("código vencido com %d e corpo JSON do GoTrue", async (status) => {
    gotrue.rejectStatus = status;
    gotrue.addFlow("codigo-vencido-123", VERIFIER, { expired: true });
    await expect(exchange("codigo-vencido-123")).resolves.toEqual(RECUSADO);
  });

  test("código desconhecido: 404 do GoTrue", async () => {
    await expect(exchange("codigo-que-nao-existe")).resolves.toEqual(RECUSADO);
  });

  test.each(REFUSAL_STATUSES)("%d com o corpo mínimo do GoTrue (só o error_code string): recusado", async (status) => {
    gotrue.mode = { kind: "responde", status, body: JSON.stringify({ error_code: "qualquer" }) };
    await expect(exchange()).resolves.toEqual(RECUSADO);
    expect(gotrue.requests).toHaveLength(1);
  });

  test.each(REFUSAL_STATUSES)("%d: o error_code do GoTrue nunca sai do adapter nem vai a log", async (status) => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "debug")];
    gotrue.mode = { kind: "responde", status, body: JSON.stringify({ code: status, error_code: GOTRUE_CANARIES.errorCode, msg: GOTRUE_CANARIES.email }) };
    const result = await exchange();
    expect(result).toEqual(RECUSADO);
    expect(Object.keys(result).sort()).toEqual(["ok", "reason"]);
    expect(JSON.stringify(result)).not.toContain(GOTRUE_CANARIES.errorCode);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe("troca: sem o corpo JSON do GoTrue, nenhum status de recusa é `recusado` (emendas do HITL-035 e da F1-API-08; A-02)", () => {
  // O motivo da emenda do 404 vale igual para o resto: um desvio de configuração (a publishable recusada no gateway,
  // um WAF na frente) não pode virar laço de relogin (T30). O GoTrue sem o cabeçalho de versão sempre manda o corpo.
  describe.each(REFUSAL_STATUSES)("%d", (status) => {
    test.each(WITHOUT_GOTRUE_BODY)("%s: nao_recebido, 1 chamada", async (_name, body, contentType) => {
      gotrue.mode = { kind: "responde", status, body, contentType };
      await expect(exchange()).resolves.toEqual(NAO_RECEBIDO);
      expect(gotrue.requests).toHaveLength(1);
    });

    test("UTF-8 inválido no corpo", async () => {
      const body = Buffer.concat([Buffer.from('{"error_code":"'), Buffer.from([0xff]), Buffer.from('"}')]);
      gotrue.mode = { kind: "responde", status, body };
      await expect(exchange()).resolves.toEqual(NAO_RECEBIDO);
    });

    test("corpo acima de 32 KiB", async () => {
      const body = JSON.stringify({ error_code: "flow_state_not_found", pad: "a".repeat(GOTRUE_CLIENT_POLICY.maxResponseBytes) });
      gotrue.mode = { kind: "responde", status, body };
      await expect(exchange()).resolves.toEqual(NAO_RECEBIDO);
    });
  });

  test("a publishable errada leva o 401 Invalid API key do gateway: nao_recebido, e o fluxo segue vivo para a troca certa", async () => {
    const wrongKey = createGotrueTokenClient({ url: gotrue.url, publishableKey: "sb_publishable_ChaveRevogada-0000", timeoutMs: HAPPY_PATH_TIMEOUT_MS });
    await expect(wrongKey.exchangePkce(CODE, VERIFIER)).resolves.toEqual(NAO_RECEBIDO);
    expect(gotrue.requests).toHaveLength(1);
    await expect(exchange()).resolves.toMatchObject({ ok: true });
  });

  test("rota errada (o simulado responde 404 em HTML fora de /auth/v1/token)", async () => {
    const response = await fetch(new URL("/nada", gotrue.url), { method: "POST" });
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });
});

describe("troca: o GoTrue não recebeu (`nao_recebido`), exatamente 1 chamada", () => {
  test.each([[429], [500], [502], [503], [504], [405], [409], [410], [418], [304]])("status %d", async (status) => {
    gotrue.mode = { kind: "responde", status, body: JSON.stringify({ error_code: "x" }) };
    await expect(exchange()).resolves.toEqual(NAO_RECEBIDO);
    expect(gotrue.requests).toHaveLength(1);
  });

  test("redirecionamento não é seguido: o código e o verifier não vão para outro host", async () => {
    other = await startFakeGotrue(PUBLISHABLE);
    other.addFlow(CODE, VERIFIER);
    gotrue.mode = { kind: "redireciona", location: `${other.url.origin}/auth/v1/token?grant_type=pkce` };
    await expect(exchange()).resolves.toEqual(NAO_RECEBIDO);
    expect(other.requests).toHaveLength(0);
    expect(gotrue.requests).toHaveLength(1);
  });

  test("servidor fora do ar (conexão recusada)", async () => {
    const url = gotrue.url;
    await gotrue.close();
    gotrue = await startFakeGotrue(PUBLISHABLE);
    const closed = createGotrueTokenClient({ url, publishableKey: PUBLISHABLE, timeoutMs: HAPPY_PATH_TIMEOUT_MS });
    await expect(closed.exchangePkce(CODE, VERIFIER)).resolves.toEqual(NAO_RECEBIDO);
  });

  test("signal do chamador já abortado: nada sai", async () => {
    await expect(exchange(CODE, VERIFIER, AbortSignal.abort())).resolves.toEqual(NAO_RECEBIDO);
    expect(gotrue.requests).toHaveLength(0);
  });

  test.each([
    ["código curto", "abc", VERIFIER],
    ["código com espaço", "abc def ghi", VERIFIER],
    ["código com quebra de linha", "abcdefgh\r\nx", VERIFIER],
    ["código longo demais", "a".repeat(129), VERIFIER],
    ["verifier curto", CODE, "a".repeat(42)],
    ["verifier longo demais", CODE, "a".repeat(129)],
    ["verifier com caractere fora do RFC 7636", CODE, `${"a".repeat(42)}+`],
  ])("entrada fora da forma (%s): nada sai", async (_name, code, verifier) => {
    await expect(exchange(code, verifier)).resolves.toEqual(NAO_RECEBIDO);
    expect(gotrue.requests).toHaveLength(0);
  });
});

describe("troca: o GoTrue pode ter processado (`pode_ter_rotacionado`; M-13)", () => {
  test("responde depois do prazo: o fluxo já foi consumido, e a falha vem dentro do prazo", async () => {
    gotrue.mode = { kind: "lento", delayMs: 1_000 };
    const start = performance.now();
    await expect(short.exchangePkce(CODE, VERIFIER)).resolves.toEqual(PODE_TER_ROTACIONADO);
    expect(performance.now() - start).toBeLessThan(900);
    expect(gotrue.requests).toHaveLength(1);
  });

  test("travado: falha dentro do prazo, sem nova tentativa", async () => {
    gotrue.mode = { kind: "trava" };
    const start = performance.now();
    await expect(short.exchangePkce(CODE, VERIFIER)).resolves.toEqual(PODE_TER_ROTACIONADO);
    expect(performance.now() - start).toBeLessThan(900);
    expect(gotrue.requests).toHaveLength(1);
  });

  test("socket cortado no meio do corpo do 200", async () => {
    gotrue.mode = { kind: "corta" };
    await expect(exchange()).resolves.toEqual(PODE_TER_ROTACIONADO);
    expect(gotrue.requests).toHaveLength(1);
  });

  test("o signal do chamador aborta depois do envio", async () => {
    gotrue.mode = { kind: "trava" };
    const slow = createGotrueTokenClient({ url: gotrue.url, publishableKey: PUBLISHABLE, timeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = slow.exchangePkce(CODE, VERIFIER, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const start = performance.now();
    await expect(pending).resolves.toEqual(PODE_TER_ROTACIONADO);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  test("com o signal do chamador que nunca aborta, o prazo próprio ainda vale", async () => {
    gotrue.mode = { kind: "trava" };
    const start = performance.now();
    await expect(short.exchangePkce(CODE, VERIFIER, new AbortController().signal)).resolves.toEqual(PODE_TER_ROTACIONADO);
    expect(performance.now() - start).toBeLessThan(900);
  });

  test("teto exato de 32 KiB: 32.768 bytes passam, 32.769 não", async () => {
    const valid = ok200({});
    gotrue.mode = { kind: "responde", status: 200, body: valid + " ".repeat(GOTRUE_CLIENT_POLICY.maxResponseBytes - valid.length) };
    await expect(exchange()).resolves.toMatchObject({ ok: true });
    gotrue.mode = { kind: "responde", status: 200, body: valid + " ".repeat(GOTRUE_CLIENT_POLICY.maxResponseBytes - valid.length + 1) };
    await expect(exchange()).resolves.toEqual(PODE_TER_ROTACIONADO);
  });

  test("corpo muito acima do teto (o stream é cortado)", async () => {
    gotrue.mode = { kind: "grande", bytes: 1024 * 1024 };
    await expect(exchange()).resolves.toEqual(PODE_TER_ROTACIONADO);
  });

  test("UTF-8 inválido no 200", async () => {
    const body = Buffer.concat([Buffer.from('{"access_token":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    gotrue.mode = { kind: "responde", status: 200, body };
    await expect(exchange()).resolves.toEqual(PODE_TER_ROTACIONADO);
  });

  test.each([[201], [202], [204], [206]])("2xx que não é 200 (%d)", async (status) => {
    gotrue.mode = { kind: "responde", status, body: status === 204 ? "" : ok200({}) };
    await expect(exchange()).resolves.toEqual(PODE_TER_ROTACIONADO);
  });

  test.each([
    ["JSON inválido", "{"],
    ["corpo vazio", ""],
    ["array", "[]"],
    ["__proto__", ok200({}).replace("{", '{"__proto__":{"admin":true},')],
    ["constructor", ok200({ constructor: { prototype: { admin: true } } })],
    ["sem access_token", ok200({ access_token: undefined })],
    ["sem refresh_token", ok200({ refresh_token: undefined })],
    ["sem expires_in", ok200({ expires_in: undefined })],
    ["sem token_type", ok200({ token_type: undefined })],
    ["access_token que não é JWS", ok200({ access_token: "opaco" })],
    ["access_token JWS sem assinatura", ok200({ access_token: "aaa.bbb." })],
    ["access_token acima de 8.192", ok200({ access_token: `${"a".repeat(8_189)}.b.c` })],
    ["refresh_token vazio", ok200({ refresh_token: "" })],
    ["refresh_token acima de 512", ok200({ refresh_token: "r".repeat(513) })],
    ["refresh_token numérico", ok200({ refresh_token: 123 })],
    ["expires_in zero", ok200({ expires_in: 0 })],
    ["expires_in negativo", ok200({ expires_in: -1 })],
    ["expires_in fracionário", ok200({ expires_in: 899.5 })],
    ["expires_in em string", ok200({ expires_in: "900" })],
    ["token_type Bearer", ok200({ token_type: "Bearer" })],
    ["token_type mac", ok200({ token_type: "mac" })],
  ])("200 com corpo fora da forma: %s", async (_name, body) => {
    gotrue.mode = { kind: "responde", status: 200, body };
    await expect(exchange()).resolves.toEqual(PODE_TER_ROTACIONADO);
  });

  test.each([
    ["sem content-type", null],
    ["texto", "text/plain"],
    ["json com sufixo", "application/jsonx"],
  ])("200 com content-type %s e um corpo que seria válido", async (_name, contentType) => {
    gotrue.mode = { kind: "responde", status: 200, body: ok200({}), contentType };
    await expect(exchange()).resolves.toEqual(PODE_TER_ROTACIONADO);
  });

  test("content-type com caixa e parâmetros diferentes ainda é JSON", async () => {
    gotrue.mode = { kind: "responde", status: 200, body: ok200({}), contentType: "Application/JSON; charset=utf-8" };
    await expect(exchange()).resolves.toMatchObject({ ok: true });
  });

  test("access_token no teto exato de 8.192 passa", async () => {
    const token = `${"a".repeat(8_188)}.b.c`;
    expect(token).toHaveLength(8_192);
    gotrue.mode = { kind: "responde", status: 200, body: ok200({ access_token: token, refresh_token: "r".repeat(512) }) };
    await expect(exchange()).resolves.toMatchObject({ ok: true, tokens: { accessToken: token } });
  });
});

describe("renovação (grant_type=refresh_token)", () => {
  test("POST com exatamente { refresh_token }, os mesmos cabeçalhos da troca, e o GoTrue rotaciona", async () => {
    const session = gotrue.addSession();
    const result = await client.refresh(session.refreshToken);
    if (!result.ok) throw new Error("esperava sucesso");
    const [sent] = gotrue.requests;
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toBe("/auth/v1/token?grant_type=refresh_token");
    expect(sent?.body).toBe(JSON.stringify({ refresh_token: session.refreshToken }));
    expect(chosenHeaders(sent)).toEqual(["accept", "apikey", "content-type"]);
    expect(sent?.headers.authorization).toBeUndefined();
    for (const header of CLIENT_ORIGIN_HEADERS) expect(sent?.headers[header]).toBeUndefined();
    expect(Object.keys(result.tokens).sort()).toEqual(["accessToken", "expiresIn", "refreshToken", "tokenType"]);
    expect(result.tokens.refreshToken).not.toBe(session.refreshToken);
    expect(gotrue.activeRefreshTokens.has(session.refreshToken)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(GOTRUE_CANARIES.providerToken);
  });

  test("refresh já usado: recusado, sem nova tentativa", async () => {
    const session = gotrue.addSession();
    await client.refresh(session.refreshToken);
    await expect(client.refresh(session.refreshToken)).resolves.toEqual(RECUSADO);
    expect(gotrue.requests).toHaveLength(2);
  });

  test("o GoTrue rotaciona e responde depois do prazo: `pode_ter_rotacionado`, 1 chamada (a nova tentativa é do caso de uso)", async () => {
    const session = gotrue.addSession();
    gotrue.mode = { kind: "lento", delayMs: 1_000 };
    await expect(short.refresh(session.refreshToken)).resolves.toEqual(PODE_TER_ROTACIONADO);
    expect(gotrue.requests).toHaveLength(1);
    expect(gotrue.activeRefreshTokens.has(session.refreshToken)).toBe(false);
  });

  test("o GoTrue rotaciona e a resposta é cortada: `pode_ter_rotacionado`", async () => {
    const session = gotrue.addSession();
    gotrue.mode = { kind: "corta" };
    await expect(client.refresh(session.refreshToken)).resolves.toEqual(PODE_TER_ROTACIONADO);
    expect(gotrue.activeRefreshTokens.has(session.refreshToken)).toBe(false);
  });

  test.each([[429], [500], [503]])("%d: nao_recebido", async (status) => {
    gotrue.mode = { kind: "responde", status, body: "{}" };
    await expect(client.refresh("r3fr3sh")).resolves.toEqual(NAO_RECEBIDO);
  });

  test("404 sem o corpo do GoTrue: nao_recebido (503 sem apagar a sessão no caso de uso)", async () => {
    gotrue.mode = { kind: "responde", status: 404, body: "<html></html>", contentType: "text/html" };
    await expect(client.refresh("r3fr3sh")).resolves.toEqual(NAO_RECEBIDO);
  });

  test.each(REFUSAL_STATUSES)("%d com o corpo do GoTrue: recusado", async (status) => {
    gotrue.mode = { kind: "responde", status, body: JSON.stringify({ code: status, error_code: "refresh_token_not_found", msg: "x" }) };
    await expect(client.refresh("r3fr3sh")).resolves.toEqual(RECUSADO);
  });

  describe.each(REFUSAL_STATUSES)("%d sem o corpo do GoTrue (A-02)", (status) => {
    test.each([
      ["Invalid API key do gateway", INVALID_API_KEY, "application/json"],
      ["HTML de WAF ou proxy", WAF_PAGE, "text/html"],
      ["vazio", "", null],
    ] as const)("%s: nao_recebido (503 sem apagar a sessão no caso de uso)", async (_name, body, contentType) => {
      gotrue.mode = { kind: "responde", status, body, contentType };
      await expect(client.refresh("r3fr3sh")).resolves.toEqual(NAO_RECEBIDO);
      expect(gotrue.requests).toHaveLength(1);
    });
  });

  test("a publishable errada leva o 401 Invalid API key do gateway: nao_recebido, e o refresh segue valendo no GoTrue", async () => {
    const session = gotrue.addSession();
    const wrongKey = createGotrueTokenClient({ url: gotrue.url, publishableKey: "sb_publishable_ChaveRevogada-0000", timeoutMs: HAPPY_PATH_TIMEOUT_MS });
    await expect(wrongKey.refresh(session.refreshToken)).resolves.toEqual(NAO_RECEBIDO);
    expect(gotrue.activeRefreshTokens.has(session.refreshToken)).toBe(true);
  });

  test.each([
    ["vazio", ""],
    ["acima de 512", "r".repeat(513)],
  ])("refresh fora da forma (%s): nada sai", async (_name, refreshToken) => {
    await expect(client.refresh(refreshToken)).resolves.toEqual(NAO_RECEBIDO);
    expect(gotrue.requests).toHaveLength(0);
  });

  test("refresh no teto de 512 sai, dentro do corpo JSON", async () => {
    gotrue.rejectStatus = 401;
    await expect(client.refresh("r".repeat(512))).resolves.toEqual(RECUSADO);
    expect(gotrue.requests).toHaveLength(1);
  });
});

describe("logout (scope=global)", () => {
  test("POST /auth/v1/logout?scope=global com apikey, o Bearer do usuário e accept; sem corpo e sem content-type", async () => {
    const session = gotrue.addSession();
    await expect(client.logout(session.accessToken)).resolves.toEqual({ ok: true });
    const [sent] = gotrue.requests;
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toBe("/auth/v1/logout?scope=global");
    expect(sent?.body).toBe("");
    expect(chosenHeaders(sent)).toEqual(["accept", "apikey", "authorization"]);
    expect(sent?.headers).toMatchObject({ apikey: PUBLISHABLE, authorization: `Bearer ${session.accessToken}`, accept: "application/json" });
    for (const header of CLIENT_ORIGIN_HEADERS) expect(sent?.headers[header]).toBeUndefined();
    for (const name of Object.keys(sent?.headers ?? {})) {
      expect([...TRANSPORT_HEADERS, ...GOTRUE_CLIENT_POLICY.outboundHeaders.logout]).toContain(name);
    }
    expect(gotrue.liveAccessTokens.has(session.accessToken)).toBe(false);
    expect(gotrue.activeRefreshTokens.has(session.refreshToken)).toBe(false);
  });

  test("sessão já apagada (403 session_not_found, como o GoTrue real responde; 07h): ok, idempotente", async () => {
    const session = gotrue.addSession();
    await client.logout(session.accessToken);
    await expect(client.logout(session.accessToken)).resolves.toEqual({ ok: true });
    expect(gotrue.requests).toHaveLength(2);
  });

  test.each([[200], [204], [205]])("%d: ok", async (status) => {
    gotrue.mode = { kind: "responde", status, body: "" };
    await expect(client.logout("aaa.bbb.ccc")).resolves.toEqual({ ok: true });
  });

  test("403 com o corpo JSON do GoTrue e error_code session_not_found: ok, e o corpo não sai do adapter", async () => {
    gotrue.mode = { kind: "responde", status: 403, body: JSON.stringify({ code: 403, error_code: "session_not_found", msg: "x" }) };
    await expect(client.logout("aaa.bbb.ccc")).resolves.toEqual({ ok: true });
    gotrue.mode = { kind: "responde", status: 403, body: JSON.stringify({ error_code: "session_not_found" }), contentType: "application/json; charset=utf-8" };
    await expect(client.logout("aaa.bbb.ccc")).resolves.toEqual({ ok: true });
  });

  // A-01: o 401 nunca é sessão encerrada. O do GoTrue (`no_authorization`) diz que o Bearer não chegou; o do gateway
  // (`Invalid API key`) diz que o GoTrue nem viu o pedido. Nos dois, a sessão pode seguir viva, e o 204 seria mentira.
  test.each([
    ["sem corpo (o 204 de antes da F1-API-08)", "", null, NAO_RECEBIDO],
    ["Invalid API key do gateway", INVALID_API_KEY, "application/json", NAO_RECEBIDO],
    ["HTML de proxy", WAF_PAGE, "text/html", NAO_RECEBIDO],
    ["no_authorization do GoTrue (o Bearer não chegou)", JSON.stringify({ code: 401, error_code: "no_authorization", msg: "x" }), "application/json", RECUSADO],
    ["session_not_found num 401 (só o 403 vale)", JSON.stringify({ error_code: "session_not_found" }), "application/json", RECUSADO],
  ] as const)("401 %s: nunca ok", async (_name, body, contentType, expected) => {
    gotrue.mode = { kind: "responde", status: 401, body, contentType };
    await expect(client.logout("aaa.bbb.ccc")).resolves.toEqual(expected);
  });

  test("a publishable errada leva o 401 Invalid API key do gateway: nao_recebido, e a sessão segue viva no GoTrue (A-01)", async () => {
    const session = gotrue.addSession();
    const wrongKey = createGotrueTokenClient({ url: gotrue.url, publishableKey: "sb_publishable_ChaveRevogada-0000", timeoutMs: HAPPY_PATH_TIMEOUT_MS });
    await expect(wrongKey.logout(session.accessToken)).resolves.toEqual(NAO_RECEBIDO);
    expect(gotrue.liveAccessTokens.has(session.accessToken)).toBe(true);
    expect(gotrue.activeRefreshTokens.has(session.refreshToken)).toBe(true);
  });

  test.each([
    ["bad_jwt (assinatura recusada pelo GoTrue)", JSON.stringify({ error_code: "bad_jwt" }), "application/json"],
    ["user_not_found", JSON.stringify({ code: 403, error_code: "user_not_found", msg: "x" }), "application/json"],
    ["session_not_found em outra caixa", JSON.stringify({ error_code: "SESSION_NOT_FOUND" }), "application/json"],
    ["session_not_found com espaço", JSON.stringify({ error_code: "session_not_found " }), "application/json"],
  ] as const)("403 com o corpo do GoTrue e outro error_code (%s): recusado", async (_name, body, contentType) => {
    gotrue.mode = { kind: "responde", status: 403, body, contentType };
    await expect(client.logout("aaa.bbb.ccc")).resolves.toEqual(RECUSADO);
  });

  test.each([
    ["sem corpo", "", "application/json"],
    ["corpo vazio de JSON", "{}", "application/json"],
    ["HTML de WAF", WAF_PAGE, "text/html"],
    ["session_not_found fora de JSON", JSON.stringify({ error_code: "session_not_found" }), "text/html"],
    ["session_not_found sem content-type", JSON.stringify({ error_code: "session_not_found" }), null],
    ["JSON quebrado", '{"error_code":"session_not_found"', "application/json"],
    ["session_not_found com __proto__", '{"error_code":"session_not_found","__proto__":{"x":1}}', "application/json"],
  ] as const)("403 sem o corpo do GoTrue (%s): nao_recebido", async (_name, body, contentType) => {
    gotrue.mode = { kind: "responde", status: 403, body, contentType };
    await expect(client.logout("aaa.bbb.ccc")).resolves.toEqual(NAO_RECEBIDO);
  });

  test("403 com session_not_found acima do teto de 32 KiB: nao_recebido", async () => {
    const body = JSON.stringify({ error_code: "session_not_found", pad: "x".repeat(GOTRUE_CLIENT_POLICY.maxResponseBytes) });
    gotrue.mode = { kind: "responde", status: 403, body };
    await expect(client.logout("aaa.bbb.ccc")).resolves.toEqual(NAO_RECEBIDO);
  });

  test.each([[400], [404], [422]])("%d com o corpo do GoTrue: recusado (mesmo com session_not_found); sem ele: nao_recebido", async (status) => {
    gotrue.mode = { kind: "responde", status, body: JSON.stringify({ error_code: "session_not_found" }) };
    await expect(client.logout("aaa.bbb.ccc")).resolves.toEqual(RECUSADO);
    gotrue.mode = { kind: "responde", status, body: "", contentType: null };
    await expect(client.logout("aaa.bbb.ccc")).resolves.toEqual(NAO_RECEBIDO);
  });

  test.each([[429], [500], [503]])("%d: nao_recebido", async (status) => {
    gotrue.mode = { kind: "responde", status, body: "" };
    await expect(client.logout("aaa.bbb.ccc")).resolves.toEqual(NAO_RECEBIDO);
  });

  test("prazo: pode_ter_rotacionado (a sessão pode ter caído)", async () => {
    gotrue.mode = { kind: "trava" };
    await expect(short.logout("aaa.bbb.ccc")).resolves.toEqual(PODE_TER_ROTACIONADO);
  });

  test.each([
    ["sem três partes", "opaco"],
    ["com quebra de linha (injeção de cabeçalho)", "aaa.bbb.ccc\r\nx-forwarded-for: 1.2.3.4"],
    ["acima de 8.192", `${"a".repeat(8_190)}.b.c`],
  ])("token fora da forma (%s): nada sai", async (_name, token) => {
    await expect(client.logout(token)).resolves.toEqual(NAO_RECEBIDO);
    expect(gotrue.requests).toHaveLength(0);
  });
});

describe("classificação dos erros do fetch (fetch substituído)", () => {
  const rejectWith = (error: unknown): void => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(error));
  };
  const causedBy = (code: string): TypeError => {
    const cause = Object.assign(new Error(`connect ${code}`), { code });
    return new TypeError("fetch failed", { cause });
  };

  test.each([["ECONNREFUSED"], ["ENOTFOUND"], ["EAI_AGAIN"], ["ENETUNREACH"], ["EHOSTUNREACH"]])(
    "%s antes da conexão: nao_recebido",
    async (code) => {
      rejectWith(causedBy(code));
      await expect(exchange()).resolves.toEqual(NAO_RECEBIDO);
    },
  );

  test("redirecionamento recusado pelo fetch: nao_recebido", async () => {
    rejectWith(new TypeError("fetch failed", { cause: new Error("unexpected redirect") }));
    await expect(exchange()).resolves.toEqual(NAO_RECEBIDO);
  });

  test.each([
    ["socket fechado depois do envio", causedBy("UND_ERR_SOCKET")],
    ["ECONNRESET", causedBy("ECONNRESET")],
    ["TypeError sem causa", new TypeError("fetch failed")],
    ["causa que não é Error", new TypeError("fetch failed", { cause: "ECONNREFUSED" })],
    ["valor que não é Error", "ECONNREFUSED"],
    ["prazo", new DOMException("timeout", "TimeoutError")],
  ])("%s: pode_ter_rotacionado", async (_name, error) => {
    rejectWith(error);
    await expect(exchange()).resolves.toEqual(PODE_TER_ROTACIONADO);
  });

  test("200 sem corpo: pode_ter_rotacionado", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200, headers: { "content-type": "application/json" } })));
    await expect(exchange()).resolves.toEqual(PODE_TER_ROTACIONADO);
  });

  test.each(REFUSAL_STATUSES)("%d sem corpo: nao_recebido", async (status) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status, headers: { "content-type": "application/json" } })));
    await expect(exchange()).resolves.toEqual(NAO_RECEBIDO);
    await expect(client.logout("aaa.bbb.ccc")).resolves.toEqual(NAO_RECEBIDO);
  });

  test.each([
    ["500 da troca", 500, "troca", NAO_RECEBIDO],
    ["404 da troca (o corpo do GoTrue não chega a ser lido)", 404, "troca", NAO_RECEBIDO],
    ["401 da troca (o corpo do GoTrue não chega a ser lido)", 401, "troca", NAO_RECEBIDO],
    ["200 da troca", 200, "troca", PODE_TER_ROTACIONADO],
    ["202 da troca", 202, "troca", PODE_TER_ROTACIONADO],
    ["200 do logout", 200, "logout", { ok: true }],
    ["503 do logout", 503, "logout", NAO_RECEBIDO],
    ["401 do logout", 401, "logout", NAO_RECEBIDO],
    ["403 do logout (o session_not_found nunca chega)", 403, "logout", NAO_RECEBIDO],
  ] as const)("%s com o stream do corpo já em erro: classifica sem rejeitar", async (_name, status, call, expected) => {
    const broken = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(new Error("socket")) });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(broken, { status, headers: { "content-type": "application/json" } })));
    const result = call === "troca" ? exchange() : client.logout("aaa.bbb.ccc");
    await expect(result).resolves.toEqual(expected);
  });

  test("o adapter nunca segue redirecionamento nem repassa cabeçalho além da lista", async () => {
    const spy = vi.fn<typeof fetch>().mockResolvedValue(new Response(ok200({}), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", spy);
    await exchange();
    await client.refresh("r3fr3sh");
    await client.logout("aaa.bbb.ccc");
    expect(spy).toHaveBeenCalledTimes(3);
    for (const [, init] of spy.mock.calls) {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(Object.keys(spy.mock.calls[0]?.[1]?.headers ?? {})).toEqual(GOTRUE_CLIENT_POLICY.outboundHeaders.token);
    expect(Object.keys(spy.mock.calls[1]?.[1]?.headers ?? {})).toEqual(GOTRUE_CLIENT_POLICY.outboundHeaders.token);
    expect(Object.keys(spy.mock.calls[2]?.[1]?.headers ?? {})).toEqual(GOTRUE_CLIENT_POLICY.outboundHeaders.logout);
  });
});
