// DAL de exportar e excluir a conta (ADR-029 D9, condições 13 a 15) e as duas chamadas novas do cliente da API, contra
// o GoTrue e a API simulados, em socket real, com a sessão de verdade do portal. Prova a tabela de CSRF, a frase de
// confirmação, o login recente sem rede, o mapa de erros inteiro (só o 204 apaga o cookie; o "não confirmada" nunca
// promete), um pedido por clique e que os dados exportados só saem revalidados pelo contrato.
import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { AccountExportSchema } from "@trampo/contracts/account";
import { ACCOUNT_RECENT_LOGIN_SECONDS } from "@trampo/contracts/limits";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ACCOUNT_POLICY, createAccountDal, type AccountDal, type Download } from "../../src/server/account";
import { createApiClient, type ApiClient } from "../../src/server/api-client";
import { parsePortalConfig, type PortalConfig } from "../../src/server/config";
import { COOKIE_NAMES, type CookieWrite } from "../../src/server/cookies";
import { createGotrueClient } from "../../src/server/gotrue";
import { SEAL_PURPOSES, createSealer } from "../../src/server/seal";
import { createPortalAuth, type PortalAuth, type Redirect } from "../../src/server/session";
import { createAccessTokenVerifier } from "../../src/server/verifier";
import { SALARY_CANARY, SALARY_CANARY_TEXT, fullCriteria } from "../support/criteria-fixtures";
import { apiErrorBody, startFakeApi, type FakeApi, type FakeApiMode } from "../support/fake-api";
import { GOTRUE_CANARIES, startFakeGotrue, type FakeGotrue } from "../support/fake-gotrue";

const PUBLISHABLE = ["sb", "publishable", "d".repeat(24)].join("_");
const PORTAL = "http://127.0.0.1:3996";
const DADOS = `${PORTAL}/conta/dados`;
const URLENCODED = "application/x-www-form-urlencoded";
const PHRASE = "excluir minha conta";
const ID = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const analysis = { id: ID, createdAt: "2026-11-15T11:00:00.000Z", decisionPath: "extracao_llm", verdict: "neutro", score: 50 } as const;
const feedback = { analysisId: ID, agreement: "concordo", reason: null, updatedAt: "2026-11-15T11:30:00.000Z" } as const;
const CLEARED = [
  { name: COOKIE_NAMES.sessao, value: "", maxAge: 0 },
  { name: COOKIE_NAMES.rascunho, value: "", maxAge: 0 },
];
let fake: FakeGotrue;
let api: FakeApi;
let config: PortalConfig;
let clock = { ms: Date.now() };
let auth: PortalAuth;
let client: ApiClient;
let dal: AccountDal;

beforeAll(async () => {
  fake = await startFakeGotrue({ publishableKey: PUBLISHABLE, allowedRedirects: [`${PORTAL}/auth/retorno`] });
  api = await startFakeApi({ owner: (token) => (fake.issued.some((pair) => pair.accessToken === token) ? GOTRUE_CANARIES.userId : null) });
  config = parsePortalConfig({
    PORTAL_ORIGIN: PORTAL,
    SUPABASE_URL: fake.url.origin,
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    API_ORIGIN: api.url.origin,
    PORTAL_SEAL_KEYS: `d1:${randomBytes(32).toString("base64url")}`,
    PORTAL_SEAL_ACTIVE_KEY: "d1",
  });
});
afterAll(async () => {
  await fake.close();
  await api.close();
});
beforeEach(() => {
  fake.mode = { kind: "normal" };
  fake.hookRefuses = false;
  fake.claims = {};
  fake.expiresIn = 900;
  api.mode = { kind: "normal" };
  api.deleteResult = "excluida";
  api.rows.clear();
  api.analyses.length = 0;
  api.feedback.length = 0;
  api.deletions.length = 0;
  api.requests.length = 0;
  fake.requests.length = 0;
  clock = { ms: Date.now() };
  auth = createPortalAuth({
    config,
    gotrue: createGotrueClient({ supabaseUrl: config.supabaseUrl, publishableKey: PUBLISHABLE, timeoutMs: 500 }),
    verifier: createAccessTokenVerifier({ issuer: config.issuer, jwksUrl: config.jwksUrl }),
    now: () => clock.ms,
    defer: () => undefined,
  });
  client = createApiClient({ apiOrigin: config.apiOrigin, timeoutMs: 400 });
  dal = createAccountDal({ config, auth, api: client, now: () => clock.ms });
});

const sessaoSealer = () => createSealer(config.sealKeys, SEAL_PURPOSES.sessao, PORTAL);
const accessOf = (cookie: string): string => (JSON.parse(sessaoSealer().open(cookie) as string) as { at: string }).at;
const tokenCalls = () => fake.requests.filter((request) => request.url.startsWith("/auth/v1/token"));
const posts = () => api.requests.filter((request) => request.method === "POST");

async function login(): Promise<string> {
  const start = await auth.startLogin({ provider: "github", secFetchSite: "same-origin" });
  const flow = start.cookies[0] as CookieWrite;
  const authorize = await fetch(start.location, { redirect: "manual" });
  const search = new URL(authorize.headers.get("location") as string).searchParams;
  const done = await auth.completeLogin({ search, flowCookie: flow.value });
  fake.requests.length = 0;
  api.requests.length = 0;
  return (done.cookies.find((cookie) => cookie.name === COOKIE_NAMES.sessao) as CookieWrite).value;
}

const stream = (text: string): ReadableStream<Uint8Array> => new Response(text).body as ReadableStream<Uint8Array>;
const form = (pairs: ReadonlyArray<readonly [string, string]>): ReadableStream<Uint8Array> => stream(new URLSearchParams(pairs.map(([key, value]) => [key, value])).toString());
const allowed = { origin: PORTAL as string | null, secFetchSite: "same-origin" as string | null };
const remove = (sessionCookie: string | undefined, typed: string = PHRASE, over: Partial<typeof allowed & { contentType: string | null }> = {}) =>
  dal.deleteAccount({ ...allowed, contentType: URLENCODED, ...over, body: form([["confirmacao", typed]]), sessionCookie });
const asRedirect = (result: Awaited<ReturnType<AccountDal["deleteAccount"]>> | Download): Redirect => {
  if (result.kind !== "redirect") throw new Error(`esperava um redirecionamento, veio ${result.kind}`);
  return result;
};

const CSRF: ReadonlyArray<readonly [string, typeof allowed]> = [
  ["sem Origin", { origin: null, secFetchSite: "same-origin" }],
  ["outra origem", { origin: "https://evil.invalid", secFetchSite: "same-origin" }],
  ["Origin null", { origin: "null", secFetchSite: "same-origin" }],
  ["origem com barra", { origin: `${PORTAL}/`, secFetchSite: "same-origin" }],
  ["cross-site", { origin: PORTAL, secFetchSite: "cross-site" }],
  ["same-site", { origin: PORTAL, secFetchSite: "same-site" }],
  ["none (URL digitada)", { origin: PORTAL, secFetchSite: "none" }],
  ["sem Sec-Fetch-Site", { origin: PORTAL, secFetchSite: null }],
];

/** Um servidor de uma resposta só, para as formas que a API simulada não emite. */
async function oneShot(handler: (response: ServerResponse) => void): Promise<{ origin: string; server: Server }> {
  const server = createServer((_request, response) => handler(response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/** A origem de uma porta que acabou de fechar: a conexão é recusada. */
async function closedOrigin(): Promise<string> {
  const { origin, server } = await oneShot(() => undefined);
  await closeServer(server);
  return origin;
}

describe("cliente: exportAccount (GET /v1/account/export)", () => {
  it("200: o documento do contrato, com cabeçalhos em lista fechada, destino fixo e sem corpo", async () => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    api.analyses.push(analysis);
    api.feedback.push(feedback);
    const result = await client.exportAccount(accessOf(session));
    expect(result.ok && result.document).toMatchObject({ schemaVersion: 1, criteria: fullCriteria(), analyses: [analysis], feedback: [feedback], analysesTruncated: false, feedbackTruncated: false });
    expect(result.ok && AccountExportSchema.safeParse(result.document).success).toBe(true);
    const [request] = api.requests;
    expect(api.requests).toHaveLength(1);
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe("/v1/account/export");
    expect(request?.body).toBe("");
    expect(request?.headers["authorization"]).toBe(`Bearer ${accessOf(session)}`);
    for (const name of ["cookie", "origin", "referer", "x-forwarded-for", "content-type", "apikey"]) expect(request?.headers[name], name).toBeUndefined();
  });

  it.each<[string, FakeApiMode, "recusado" | "nao_recebido"]>([
    ["401 NAO_AUTENTICADO", { kind: "responde", status: 401, code: "NAO_AUTENTICADO" }, "recusado"],
    ["401 sem o corpo da API", { kind: "responde", status: 401, body: "<html/>", contentType: "text/html" }, "nao_recebido"],
    ["401 com outro código", { kind: "responde", status: 401, code: "PROIBIDO" }, "nao_recebido"],
    ["403 PROIBIDO", { kind: "responde", status: 403, code: "PROIBIDO" }, "nao_recebido"],
    ["429", { kind: "responde", status: 429, code: "LIMITE_DE_TAXA", retryAfter: 9 }, "nao_recebido"],
    ["503", { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" }, "nao_recebido"],
    ["200 fora do contrato", { kind: "responde", status: 200, body: JSON.stringify({ schemaVersion: 1 }) }, "nao_recebido"],
    ["200 com chave a mais (o e-mail)", { kind: "responde", status: 200, body: JSON.stringify({ schemaVersion: 1, exportedAt: "2026-11-15T12:00:00.000Z", criteria: null, analyses: [], analysesTruncated: false, feedback: [], feedbackTruncated: false, email: "x@exemplo.invalid" }) }, "nao_recebido"],
    ["200 que não é JSON", { kind: "responde", status: 200, body: "<html/>", contentType: "text/html" }, "nao_recebido"],
    ["201 com o documento", { kind: "responde", status: 201, body: JSON.stringify({ schemaVersion: 1, exportedAt: "2026-11-15T12:00:00.000Z", criteria: null, analyses: [], analysesTruncated: false, feedback: [], feedbackTruncated: false }) }, "nao_recebido"],
    ["prazo", { kind: "trava" }, "nao_recebido"],
    ["resposta cortada", { kind: "corta" }, "nao_recebido"],
    ["redirecionamento", { kind: "redireciona", location: "http://127.0.0.1:1/" }, "nao_recebido"],
  ])("%s: %s", async (_caso, mode, reason) => {
    const session = await login();
    api.mode = mode;
    expect(await client.exportAccount(accessOf(session))).toEqual({ ok: false, reason });
    expect(api.requests).toHaveLength(1);
  });

  it("o teto da exportação: acima de 32 KiB passa, acima de 256 KiB não", async () => {
    const session = await login();
    const document = { schemaVersion: 1, exportedAt: "2026-11-15T12:00:00.000Z", criteria: null, analyses: [], analysesTruncated: false, feedback: [], feedbackTruncated: false };
    const padded = (bytes: number): string => JSON.stringify(document) + " ".repeat(bytes);
    api.mode = { kind: "responde", status: 200, body: padded(100_000) };
    expect((await client.exportAccount(accessOf(session))).ok).toBe(true);
    api.mode = { kind: "responde", status: 200, body: padded(256 * 1024) };
    expect(await client.exportAccount(accessOf(session))).toEqual({ ok: false, reason: "nao_recebido" });
  });

  it("token fora da forma, sinal abortado e conexão recusada: nao_recebido", async () => {
    expect(await client.exportAccount("a.b")).toEqual({ ok: false, reason: "nao_recebido" });
    expect(await client.exportAccount("a.b.c", AbortSignal.abort())).toEqual({ ok: false, reason: "nao_recebido" });
    expect(api.requests).toHaveLength(0);
    expect(await createApiClient({ apiOrigin: await closedOrigin(), timeoutMs: 400 }).exportAccount("a.b.c")).toEqual({ ok: false, reason: "nao_recebido" });
  });

  it("socket que cai no meio do corpo do 200: nao_recebido", async () => {
    const { origin, server } = await oneShot((response) => {
      response.writeHead(200, { "content-type": "application/json", "content-length": "500" });
      response.write('{"schemaVersion":1');
      setTimeout(() => response.socket?.destroy(), 20);
    });
    expect(await createApiClient({ apiOrigin: origin, timeoutMs: 400 }).exportAccount("a.b.c")).toEqual({ ok: false, reason: "nao_recebido" });
    await closeServer(server);
  });
});

describe("cliente: deleteAccount (POST /v1/account/delete)", () => {
  it("204: ok, com o corpo fixo do contrato e os cabeçalhos em lista fechada", async () => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    expect(await client.deleteAccount(accessOf(session))).toEqual({ ok: true });
    expect(api.requests).toHaveLength(1);
    const [request] = api.requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/v1/account/delete");
    expect(JSON.parse(request?.body ?? "")).toEqual({ schemaVersion: 1, confirmation: PHRASE });
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["authorization"]).toBe(`Bearer ${accessOf(session)}`);
    for (const name of ["cookie", "origin", "referer", "x-forwarded-for", "apikey"]) expect(request?.headers[name], name).toBeUndefined();
    expect(api.deletions).toEqual([GOTRUE_CANARIES.userId]);
    expect(api.rows.size).toBe(0);
  });

  it("403 PROIBIDO da função (login antigo): login_antigo, e nada some", async () => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    api.deleteResult = "login_antigo";
    expect(await client.deleteAccount(accessOf(session))).toEqual({ ok: false, reason: "login_antigo" });
    expect(api.rows.size).toBe(1);
  });

  it.each<[string, FakeApiMode, string]>([
    ["401 NAO_AUTENTICADO", { kind: "responde", status: 401, code: "NAO_AUTENTICADO" }, "recusado"],
    ["401 sem o corpo da API", { kind: "responde", status: 401, body: "<html/>", contentType: "text/html" }, "pode_ter_excluido"],
    ["403 sem o corpo da API", { kind: "responde", status: 403, body: "<html/>", contentType: "text/html" }, "pode_ter_excluido"],
    ["403 com outro código", { kind: "responde", status: 403, code: "NAO_AUTENTICADO" }, "pode_ter_excluido"],
    ["400 PAYLOAD_INVALIDO", { kind: "responde", status: 400, code: "PAYLOAD_INVALIDO" }, "nao_recebido"],
    ["415 PAYLOAD_INVALIDO", { kind: "responde", status: 415, code: "PAYLOAD_INVALIDO" }, "nao_recebido"],
    ["413 PAYLOAD_GRANDE_DEMAIS", { kind: "responde", status: 413, code: "PAYLOAD_GRANDE_DEMAIS" }, "nao_recebido"],
    ["400 sem o corpo da API", { kind: "responde", status: 400, body: "" }, "pode_ter_excluido"],
    ["429 LIMITE_DE_TAXA", { kind: "responde", status: 429, code: "LIMITE_DE_TAXA", retryAfter: 9 }, "nao_recebido"],
    ["429 sem o corpo da API", { kind: "responde", status: 429, body: "" }, "pode_ter_excluido"],
    ["500", { kind: "responde", status: 500, code: "ERRO_INTERNO" }, "pode_ter_excluido"],
    ["503", { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" }, "pode_ter_excluido"],
    ["200 no lugar do 204", { kind: "responde", status: 200, body: "{}" }, "pode_ter_excluido"],
    ["202", { kind: "responde", status: 202, body: "" }, "pode_ter_excluido"],
    ["404", { kind: "responde", status: 404, code: "PROIBIDO" }, "pode_ter_excluido"],
    ["prazo", { kind: "trava" }, "pode_ter_excluido"],
    ["resposta cortada", { kind: "corta" }, "pode_ter_excluido"],
    ["redirecionamento", { kind: "redireciona", location: "http://127.0.0.1:1/" }, "nao_recebido"],
  ])("%s: %s, uma chamada só", async (_caso, mode, reason) => {
    const session = await login();
    api.mode = mode;
    expect(await client.deleteAccount(accessOf(session))).toEqual({ ok: false, reason });
    expect(api.requests).toHaveLength(1);
  });

  it("token fora da forma, sinal abortado e conexão recusada: nao_recebido, sem rede", async () => {
    expect(await client.deleteAccount("a.b.c\r\nx: y")).toEqual({ ok: false, reason: "nao_recebido" });
    expect(await client.deleteAccount("a.b.c", AbortSignal.abort())).toEqual({ ok: false, reason: "nao_recebido" });
    expect(api.requests).toHaveLength(0);
    expect(await createApiClient({ apiOrigin: await closedOrigin(), timeoutMs: 400 }).deleteAccount("a.b.c")).toEqual({ ok: false, reason: "nao_recebido" });
  });

  it("redirecionamento para um destino que responderia: nada chega lá", async () => {
    const session = await login();
    let hits = 0;
    const { origin, server } = await oneShot((response) => {
      hits += 1;
      response.writeHead(204);
      response.end();
    });
    api.mode = { kind: "redireciona", location: `${origin}/v1/account/delete` };
    expect(await client.deleteAccount(accessOf(session))).toEqual({ ok: false, reason: "nao_recebido" });
    expect(hits).toBe(0);
    await closeServer(server);
  });

  it("o corpo de erro da API nunca sai do cliente", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 503, body: apiErrorBody("SERVICO_INDISPONIVEL") };
    const result = await client.deleteAccount(accessOf(session));
    expect(Object.keys(result).sort()).toEqual(["ok", "reason"]);
  });
});

describe("page e confirmPage (ADR-029 D9)", () => {
  it("sem sessão, ou com sessão que não verifica: sem_sessao, sem rede na API", async () => {
    for (const view of [await dal.page({ sessionCookie: undefined, aviso: undefined }), await dal.confirmPage({ sessionCookie: "s1.d1.AAAA.BBBB.CCCC", aviso: undefined })]) expect(view).toEqual({ kind: "sem_sessao" });
    expect(api.requests).toHaveLength(0);
  });

  it("com sessão: o aviso só do catálogo da conta; a página não chama a API nem renova", async () => {
    const session = await login();
    clock.ms += 850_000;
    expect(await dal.page({ sessionCookie: session, aviso: "exportacao_indisponivel" })).toEqual({ kind: "pagina", notice: "exportacao_indisponivel" });
    for (const aviso of ["saiu", "criterios_salvos", "conta_excluida", "<script>", "toString", ["exclusao_indisponivel"], undefined]) {
      expect(await dal.page({ sessionCookie: session, aviso })).toEqual({ kind: "pagina", notice: null });
    }
    expect(api.requests).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  it("confirmação: o formulário só com a sessão de até 600 s, na borda exata", async () => {
    const session = await login();
    expect(await dal.confirmPage({ sessionCookie: session, aviso: "exclusao_frase_errada" })).toEqual({ kind: "confirmar", recent: true, notice: "exclusao_frase_errada" });
    clock.ms += ACCOUNT_RECENT_LOGIN_SECONDS * 1_000;
    expect(await dal.confirmPage({ sessionCookie: session, aviso: undefined })).toEqual({ kind: "confirmar", recent: true, notice: null });
    clock.ms += 1_000;
    expect(await dal.confirmPage({ sessionCookie: session, aviso: undefined })).toEqual({ kind: "confirmar", recent: false, notice: null });
    expect(api.requests).toHaveLength(0);
  });

  it("sessão com o início no futuro (relógio adulterado) não é recente", async () => {
    const session = await login();
    clock.ms -= 5_000;
    expect(await dal.confirmPage({ sessionCookie: session, aviso: undefined })).toMatchObject({ recent: false });
  });
});

describe("exportData (POST /conta/dados/exportar)", () => {
  it.each(CSRF)("%s: 403, sem cookie e sem rede", async (_caso, input) => {
    const session = await login();
    expect(await dal.exportData({ ...input, sessionCookie: session })).toEqual({ kind: "forbidden" });
    expect(api.requests).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  it("o arquivo: JSON do contrato com a pretensão, nome fixo, uma leitura na API e nenhum cookie novo", async () => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    api.analyses.push(analysis);
    const result = await dal.exportData({ ...allowed, sessionCookie: session });
    expect(result.kind).toBe("download");
    const download = result as Download;
    expect(download.filename).toBe("trampo-meus-dados.json");
    expect(ACCOUNT_POLICY.exportFilename).toBe("trampo-meus-dados.json");
    expect(download.cookies).toEqual([]);
    expect(download.body.endsWith("}\n")).toBe(true);
    const document = AccountExportSchema.parse(JSON.parse(download.body));
    expect(document.criteria?.salary?.minimum).toBe(SALARY_CANARY);
    expect(document.analyses).toEqual([analysis]);
    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /v1/account/export"]);
  });

  it("access perto do fim: renova antes, e o arquivo sai com o cookie novo", async () => {
    const session = await login();
    clock.ms += 850_000;
    const result = (await dal.exportData({ ...allowed, sessionCookie: session })) as Download;
    expect(result.kind).toBe("download");
    expect(result.cookies.map((cookie) => cookie.name)).toEqual([COOKIE_NAMES.sessao]);
    expect(tokenCalls()).toHaveLength(1);
    expect(api.requests[0]?.headers["authorization"]).toBe(`Bearer ${accessOf(result.cookies[0]?.value as string)}`);
  });

  it("sem sessão: a página inicial, sem rede na API", async () => {
    expect(await dal.exportData({ ...allowed, sessionCookie: undefined })).toEqual({ kind: "redirect", location: `${PORTAL}/`, cookies: [] });
    const session = await login();
    clock.ms += 5 * 3_600_000;
    expect(await dal.exportData({ ...allowed, sessionCookie: session })).toEqual({ kind: "redirect", location: `${PORTAL}/?aviso=sessao_expirada`, cookies: [{ name: COOKIE_NAMES.sessao, value: "", maxAge: 0 }] });
    expect(api.requests).toHaveLength(0);
  });

  it("GoTrue fora na renovação: indisponível, a sessão fica e a API não é chamada", async () => {
    const session = await login();
    clock.ms += 850_000;
    fake.mode = { kind: "responde", status: 503, body: "" };
    expect(await dal.exportData({ ...allowed, sessionCookie: session })).toEqual({ kind: "redirect", location: `${DADOS}?aviso=exportacao_indisponivel`, cookies: [] });
    expect(api.requests).toHaveLength(0);
  });

  it.each<[string, FakeApiMode]>([
    ["503", { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" }],
    ["429", { kind: "responde", status: 429, code: "LIMITE_DE_TAXA" }],
    ["documento fora do contrato", { kind: "responde", status: 200, body: JSON.stringify({ schemaVersion: 1, criteria: { salary: SALARY_CANARY } }) }],
    ["prazo", { kind: "trava" }],
  ])("a API falha (%s): aviso de indisponível, sem arquivo, sem dado no destino e uma leitura só", async (_caso, mode) => {
    const session = await login();
    api.mode = mode;
    const result = asRedirect(await dal.exportData({ ...allowed, sessionCookie: session }));
    expect(result).toEqual({ kind: "redirect", location: `${DADOS}?aviso=exportacao_indisponivel`, cookies: [] });
    expect(result.location).not.toContain(SALARY_CANARY_TEXT);
    expect(api.requests).toHaveLength(1);
  });

  it("401 da API: renovação forçada; o GoTrue aceita, a sessão fica com o cookie novo e a leitura não se repete", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 401, code: "NAO_AUTENTICADO" };
    const result = asRedirect(await dal.exportData({ ...allowed, sessionCookie: session }));
    expect(result.location).toBe(`${DADOS}?aviso=exportacao_indisponivel`);
    expect(result.cookies.map((cookie) => cookie.name)).toEqual([COOKIE_NAMES.sessao]);
    expect(result.cookies[0]?.maxAge).toBeGreaterThan(0);
    expect(tokenCalls()).toHaveLength(1);
    expect(api.requests).toHaveLength(1);
  });

  it("401 da API e o GoTrue recusa a renovação: a página inicial com a sessão apagada", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 401, code: "NAO_AUTENTICADO" };
    fake.hookRefuses = true;
    expect(await dal.exportData({ ...allowed, sessionCookie: session })).toEqual({
      kind: "redirect",
      location: `${PORTAL}/?aviso=sessao_expirada`,
      cookies: [{ name: COOKIE_NAMES.sessao, value: "", maxAge: 0 }],
    });
  });

  it("401 da API e o GoTrue fora: indisponível, com o cookie de antes (T30)", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 401, code: "NAO_AUTENTICADO" };
    fake.mode = { kind: "responde", status: 503, body: "" };
    expect(await dal.exportData({ ...allowed, sessionCookie: session })).toEqual({ kind: "redirect", location: `${DADOS}?aviso=exportacao_indisponivel`, cookies: [] });
  });
});

describe("deleteAccount (POST /conta/dados/excluir/confirmar)", () => {
  it.each(CSRF)("%s: 403, sem cookie, sem rede e a conta intacta", async (_caso, input) => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    expect(await remove(session, PHRASE, input)).toEqual({ kind: "forbidden" });
    expect(api.requests).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
    expect(api.rows.size).toBe(1);
  });

  it("a frase certa com login recente: um POST, a conta some, os dois cookies são apagados e o destino é a página inicial", async () => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    expect(await remove(session)).toEqual({ kind: "redirect", location: `${PORTAL}/?aviso=conta_excluida`, cookies: CLEARED });
    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /v1/account/delete"]);
    expect(api.requests[0]?.headers["authorization"]).toBe(`Bearer ${accessOf(session)}`);
    expect(api.deletions).toEqual([GOTRUE_CANARIES.userId]);
    expect(api.rows.size).toBe(0);
    expect(tokenCalls()).toHaveLength(0);
  });

  it.each([["  Excluir Minha Conta  "], ["EXCLUIR MINHA CONTA"], ["excluir minha conta\n"]])("a frase com caixa e pontas diferentes (%j) vale", async (typed) => {
    const session = await login();
    expect(asRedirect(await remove(session, typed)).location).toBe(`${PORTAL}/?aviso=conta_excluida`);
  });

  it.each([[""], ["excluir"], ["excluir minha conta!"], ["excluir  minha conta"], ["excluir minha conta agora"], ["sim"], ["excluir-minha-conta"]])(
    "a frase errada (%j): aviso na página de confirmação, sem cookie e sem rede",
    async (typed) => {
      const session = await login();
      expect(await remove(session, typed)).toEqual({ kind: "redirect", location: `${DADOS}/excluir?aviso=exclusao_frase_errada`, cookies: [] });
      expect(api.requests).toHaveLength(0);
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("a frase é conferida antes da sessão: errada com o access no fim não renova nem grava cookie", async () => {
    fake.expiresIn = 30;
    const session = await login();
    expect(await remove(session, "errada")).toEqual({ kind: "redirect", location: `${DADOS}/excluir?aviso=exclusao_frase_errada`, cookies: [] });
    expect(tokenCalls()).toHaveLength(0);
    expect(api.requests).toHaveLength(0);
  });

  it("a sessão renovada não fica recente: com mais de 600 s desde o login, a renovação de agora não libera a exclusão", async () => {
    const session = await login();
    clock.ms += 700_000;
    const renewed = await auth.apiAccess(session, "forcada");
    const cookie = renewed.cookie?.value as string;
    fake.requests.length = 0;
    expect(await dal.confirmPage({ sessionCookie: cookie, aviso: undefined })).toMatchObject({ recent: false });
    expect(await remove(cookie)).toEqual({ kind: "redirect", location: `${DADOS}?aviso=exclusao_pede_login`, cookies: [] });
    expect(api.requests).toHaveLength(0);
  });

  it.each<[string, ReadonlyArray<readonly [string, string]>]>([
    ["sem campo", []],
    ["campo com outro nome", [["confirmation", PHRASE]]],
    ["a frase duas vezes", [["confirmacao", PHRASE], ["confirmacao", PHRASE]]],
    ["um campo a mais", [["confirmacao", PHRASE], ["scope", "tudo"]]],
    ["um campo a mais antes", [["user_id", "x"], ["confirmacao", PHRASE]]],
  ])("corpo fora da forma (%s): frase errada, sem rede", async (_caso, pairs) => {
    const session = await login();
    const result = await dal.deleteAccount({ ...allowed, contentType: URLENCODED, body: form(pairs), sessionCookie: session });
    expect(asRedirect(result).location).toBe(`${DADOS}/excluir?aviso=exclusao_frase_errada`);
    expect(api.requests).toHaveLength(0);
  });

  it.each<[string, string | null]>([["JSON", "application/json"], ["multipart", "multipart/form-data; boundary=x"], ["texto", "text/plain"], ["sem tipo", null]])(
    "Content-Type %s: frase errada, sem rede",
    async (_caso, contentType) => {
      const session = await login();
      expect(asRedirect(await remove(session, PHRASE, { contentType })).location).toBe(`${DADOS}/excluir?aviso=exclusao_frase_errada`);
      expect(api.requests).toHaveLength(0);
    },
  );

  it("sem corpo, e corpo acima de 1 KiB (no teto exato ele é lido): frase errada, sem rede", async () => {
    const session = await login();
    const none = await dal.deleteAccount({ ...allowed, contentType: URLENCODED, body: null, sessionCookie: session });
    expect(asRedirect(none).location).toBe(`${DADOS}/excluir?aviso=exclusao_frase_errada`);
    const prefix = "confirmacao=excluir+minha+conta";
    const padded = (bytes: number): ReadableStream<Uint8Array> => stream(prefix + "+".repeat(bytes - prefix.length));
    const over = await dal.deleteAccount({ ...allowed, contentType: URLENCODED, body: padded(ACCOUNT_POLICY.confirmationBodyMaxBytes + 1), sessionCookie: session });
    expect(asRedirect(over).location).toBe(`${DADOS}/excluir?aviso=exclusao_frase_errada`);
    expect(api.requests).toHaveLength(0);
    // No teto exato, os espaços das pontas saem no trim e a frase vale.
    const exact = await dal.deleteAccount({ ...allowed, contentType: URLENCODED, body: padded(ACCOUNT_POLICY.confirmationBodyMaxBytes), sessionCookie: session });
    expect(asRedirect(exact).location).toBe(`${PORTAL}/?aviso=conta_excluida`);
    expect(ACCOUNT_POLICY).toEqual({ confirmationBodyMaxBytes: 1_024, confirmationField: "confirmacao", exportFilename: "trampo-meus-dados.json" });
  });

  it("sem sessão, ou com a sessão vencida: a página inicial, sem rede na API", async () => {
    expect(await remove(undefined)).toEqual({ kind: "redirect", location: `${PORTAL}/`, cookies: [] });
    const session = await login();
    clock.ms += 5 * 3_600_000;
    expect(await remove(session)).toEqual({ kind: "redirect", location: `${PORTAL}/?aviso=sessao_expirada`, cookies: [{ name: COOKIE_NAMES.sessao, value: "", maxAge: 0 }] });
    expect(api.requests).toHaveLength(0);
  });

  it("login recente, espelhado sem rede: 600 s ainda chama a API; 601 s pede o login de novo, com a sessão mantida", async () => {
    const old = await login();
    clock.ms += (ACCOUNT_RECENT_LOGIN_SECONDS + 1) * 1_000;
    expect(await remove(old)).toEqual({ kind: "redirect", location: `${DADOS}?aviso=exclusao_pede_login`, cookies: [] });
    expect(api.requests).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
    expect((await auth.readSession(old)).ok).toBe(true);
    clock.ms -= 1_000;
    expect(asRedirect(await remove(old)).location).toBe(`${PORTAL}/?aviso=conta_excluida`);
    expect(posts()).toHaveLength(1);
  });

  it("o banco diz login antigo (403 PROIBIDO da API): pede o login de novo, a sessão fica e nada some", async () => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    api.deleteResult = "login_antigo";
    expect(await remove(session)).toEqual({ kind: "redirect", location: `${DADOS}?aviso=exclusao_pede_login`, cookies: [] });
    expect(api.rows.size).toBe(1);
    expect(posts()).toHaveLength(1);
  });

  it.each<[string, FakeApiMode, string]>([
    ["429", { kind: "responde", status: 429, code: "LIMITE_DE_TAXA", retryAfter: 9 }, "exclusao_indisponivel"],
    ["redirecionamento", { kind: "redireciona", location: "http://127.0.0.1:1/" }, "exclusao_indisponivel"],
    ["503", { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" }, "exclusao_nao_confirmada"],
    ["500", { kind: "responde", status: 500, code: "ERRO_INTERNO" }, "exclusao_nao_confirmada"],
    ["prazo", { kind: "trava" }, "exclusao_nao_confirmada"],
    ["resposta cortada (a API já apagou)", { kind: "corta" }, "exclusao_nao_confirmada"],
    ["status fora da tabela", { kind: "responde", status: 418, body: "" }, "exclusao_nao_confirmada"],
  ])("%s: %s, a sessão fica (nenhum cookie apagado) e há um POST só", async (_caso, mode, notice) => {
    const session = await login();
    api.mode = mode;
    expect(await remove(session)).toEqual({ kind: "redirect", location: `${DADOS}?aviso=${notice}`, cookies: [] });
    expect(posts()).toHaveLength(1);
  });

  it("conexão recusada: indisponível (nada foi excluído), a sessão fica", async () => {
    const session = await login();
    const offline = createAccountDal({ config, auth, api: createApiClient({ apiOrigin: await closedOrigin(), timeoutMs: 400 }), now: () => clock.ms });
    const result = await offline.deleteAccount({ ...allowed, contentType: URLENCODED, body: form([["confirmacao", PHRASE]]), sessionCookie: session });
    expect(result).toEqual({ kind: "redirect", location: `${DADOS}?aviso=exclusao_indisponivel`, cookies: [] });
  });

  it("access perto do fim: renova antes, e o POST leva o access novo", async () => {
    const session = await login();
    clock.ms += 590_000;
    fake.expiresIn = 900;
    // O access de 900 s ainda tem 310 s: sem renovar. Com o access curto, renova.
    expect(tokenCalls()).toHaveLength(0);
    fake.expiresIn = 30;
    const short = await login();
    clock.ms += 5_000;
    expect(asRedirect(await remove(short)).location).toBe(`${PORTAL}/?aviso=conta_excluida`);
    expect(tokenCalls()).toHaveLength(1);
    expect(posts()[0]?.headers["authorization"]).toBe(`Bearer ${fake.issued.at(-1)?.accessToken}`);
    expect(session).not.toBe(short);
  });

  it("GoTrue fora na renovação antes da exclusão: indisponível, sem chamar a API", async () => {
    fake.expiresIn = 30;
    const session = await login();
    fake.mode = { kind: "responde", status: 503, body: "" };
    expect(await remove(session)).toEqual({ kind: "redirect", location: `${DADOS}?aviso=exclusao_indisponivel`, cookies: [] });
    expect(api.requests).toHaveLength(0);
  });

  it("401 da API: renovação forçada; o GoTrue aceita, a sessão fica com o cookie novo, e o POST não se repete", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 401, code: "NAO_AUTENTICADO" };
    const result = asRedirect(await remove(session));
    expect(result.location).toBe(`${DADOS}?aviso=exclusao_indisponivel`);
    expect(result.cookies.map((cookie) => [cookie.name, cookie.maxAge > 0])).toEqual([[COOKIE_NAMES.sessao, true]]);
    expect(tokenCalls()).toHaveLength(1);
    expect(posts()).toHaveLength(1);
  });

  it("401 da API e o GoTrue recusa a renovação: a página inicial com a sessão apagada (nunca 'conta excluída')", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 401, code: "NAO_AUTENTICADO" };
    fake.hookRefuses = true;
    expect(await remove(session)).toEqual({ kind: "redirect", location: `${PORTAL}/?aviso=sessao_expirada`, cookies: [{ name: COOKIE_NAMES.sessao, value: "", maxAge: 0 }] });
    expect(posts()).toHaveLength(1);
  });

  it("401 da API e o GoTrue fora: indisponível, com o cookie de antes", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 401, code: "NAO_AUTENTICADO" };
    fake.mode = { kind: "responde", status: 503, body: "" };
    expect(await remove(session)).toEqual({ kind: "redirect", location: `${DADOS}?aviso=exclusao_indisponivel`, cookies: [] });
  });

  it("nenhum destino sai do pedido: todos começam na origem do portal, com aviso do catálogo", async () => {
    const session = await login();
    const seen: string[] = [];
    for (const typed of [PHRASE, "errada"]) seen.push(asRedirect(await remove(session, typed)).location);
    for (const location of seen) expect(location.startsWith(`${PORTAL}/`)).toBe(true);
    expect(seen).toEqual([`${PORTAL}/?aviso=conta_excluida`, `${DADOS}/excluir?aviso=exclusao_frase_errada`]);
  });
});
