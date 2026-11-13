import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parsePortalConfig, type PortalConfig } from "../../src/server/config";
import { COOKIE_NAMES, type CookieWrite } from "../../src/server/cookies";
import { createGotrueClient } from "../../src/server/gotrue";
import { SEAL_PURPOSES, createSealer } from "../../src/server/seal";
import { PORTAL_SESSION_POLICY, createPortalAuth, type PortalAuth, type Redirect } from "../../src/server/session";
import { createAccessTokenVerifier } from "../../src/server/verifier";
import { GOTRUE_CANARIES, startFakeGotrue, type FakeGotrue } from "../support/fake-gotrue";

const PUBLISHABLE = ["sb", "publishable", "p".repeat(24)].join("_");
const PORTAL = "http://127.0.0.1:3999";
let fake: FakeGotrue;
let config: PortalConfig;
let clock = { ms: Date.now() };
let pending: Array<Promise<unknown>> = [];
let auth: PortalAuth;

const nowS = (): number => Math.floor(clock.ms / 1_000);

beforeAll(async () => {
  fake = await startFakeGotrue({ publishableKey: PUBLISHABLE, allowedRedirects: [`${PORTAL}/auth/retorno`] });
  config = parsePortalConfig({
    PORTAL_ORIGIN: PORTAL,
    SUPABASE_URL: fake.url.origin,
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    PORTAL_SEAL_KEYS: `a1:${randomBytes(32).toString("base64url")}`,
    PORTAL_SEAL_ACTIVE_KEY: "a1",
  });
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.mode = { kind: "normal" };
  fake.hookRefuses = false;
  fake.claims = {};
  fake.expiresIn = 900;
  fake.requests.length = 0;
  clock = { ms: Date.now() };
  pending = [];
  auth = createPortalAuth({
    config,
    gotrue: createGotrueClient({ supabaseUrl: config.supabaseUrl, publishableKey: PUBLISHABLE, timeoutMs: 500 }),
    verifier: createAccessTokenVerifier({ issuer: config.issuer, jwksUrl: config.jwksUrl }),
    now: () => clock.ms,
    defer: (task) => pending.push(task),
  });
});

const sessaoSealer = () => createSealer(config.sealKeys, SEAL_PURPOSES.sessao, PORTAL);
const fluxoSealer = () => createSealer(config.sealKeys, SEAL_PURPOSES.fluxo, PORTAL);
const cookieOf = (result: { readonly cookies: readonly CookieWrite[] }, name: string) => result.cookies.find((cookie) => cookie.name === name);
const tokenCalls = () => fake.requests.filter((request) => request.url.startsWith("/auth/v1/token"));

/** O navegador seguindo o `authorize`: devolve a query do retorno. */
async function followAuthorize(location: string): Promise<URLSearchParams> {
  const response = await fetch(location, { redirect: "manual" });
  return new URL(response.headers.get("location") as string).searchParams;
}

async function login(): Promise<{ readonly session: CookieWrite; readonly result: Redirect }> {
  const start = await auth.startLogin({ provider: "github", secFetchSite: "same-origin" });
  const flow = cookieOf(start, COOKIE_NAMES.fluxo) as CookieWrite;
  const result = await auth.completeLogin({ search: await followAuthorize(start.location), flowCookie: flow.value });
  return { session: cookieOf(result, COOKIE_NAMES.sessao) as CookieWrite, result };
}

/** Cookie de sessão montado à mão (idade, inatividade, sid). */
function sealSession(payload: Record<string, unknown>): string {
  return sessaoSealer().seal(JSON.stringify(payload)) as string;
}

describe("startLogin (ADR-027 D2 passo 1)", () => {
  it.each(["same-origin", "none"])("Sec-Fetch-Site %s: 303 para o authorize com os 4 parâmetros e o cookie do fluxo", async (site) => {
    const result = await auth.startLogin({ provider: "google", secFetchSite: site });
    const url = new URL(result.location);
    expect(url.origin + url.pathname).toBe(`${fake.url.origin}/auth/v1/authorize`);
    expect([...url.searchParams.keys()]).toEqual(["provider", "redirect_to", "code_challenge", "code_challenge_method"]);
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
    const redirectTo = new URL(url.searchParams.get("redirect_to") as string);
    expect(redirectTo.origin + redirectTo.pathname).toBe(`${PORTAL}/auth/retorno`);
    expect([...redirectTo.searchParams.keys()]).toEqual(["st"]);
    const flow = cookieOf(result, COOKIE_NAMES.fluxo) as CookieWrite;
    expect(flow.maxAge).toBe(300);
    const payload = JSON.parse(fluxoSealer().open(flow.value) as string) as Record<string, unknown>;
    expect(payload["st"]).toBe(redirectTo.searchParams.get("st"));
    // O verifier só existe selado no cookie: nunca na URL.
    expect(result.location).not.toContain(payload["v"] as string);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ["cross-site", "github"],
    ["same-site", "github"],
    [null, "github"],
    ["same-origin", "gitlab"],
    ["same-origin", null],
    ["same-origin", "GitHub"],
  ])("Sec-Fetch-Site %s e provedor %s: aviso, sem cookie e sem rede", async (site, provider) => {
    const result = await auth.startLogin({ provider, secFetchSite: site });
    expect(result).toEqual({ kind: "redirect", location: `${PORTAL}/?aviso=entrada_recusada`, cookies: [] });
  });
});

describe("completeLogin (ADR-027 D2 passo 2)", () => {
  it("troca, verifica, sela a sessão e vai para /conta; o cookie do fluxo é apagado", async () => {
    const { session, result } = await login();
    expect(result.location).toBe(`${PORTAL}/conta`);
    expect(cookieOf(result, COOKIE_NAMES.fluxo)).toEqual({ name: COOKIE_NAMES.fluxo, value: "", maxAge: 0 });
    expect(session.maxAge).toBe(PORTAL_SESSION_POLICY.maxAgeSeconds);
    const payload = JSON.parse(sessaoSealer().open(session.value) as string) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["at", "ate", "iat", "rt", "sid", "sst"]);
    expect(payload["sst"]).toBe(nowS());
    expect(JSON.stringify(result)).not.toContain(GOTRUE_CANARIES.email);
  });

  async function started() {
    const start = await auth.startLogin({ provider: "github", secFetchSite: "same-origin" });
    const flow = cookieOf(start, COOKIE_NAMES.fluxo) as CookieWrite;
    const search = await followAuthorize(start.location);
    fake.requests.length = 0;
    return { flow, search };
  }

  const failed = (notice: string) => ({ kind: "redirect", location: `${PORTAL}/?aviso=${notice}`, cookies: [{ name: COOKIE_NAMES.fluxo, value: "", maxAge: 0 }] });

  it.each([
    ["st diferente", (s: URLSearchParams) => s.set("st", "x".repeat(22))],
    ["st diferente só no fim", (s: URLSearchParams) => s.set("st", (s.get("st") as string).slice(0, -1) + ((s.get("st") as string).endsWith("A") ? "B" : "A"))],
    ["sem st", (s: URLSearchParams) => s.delete("st")],
    ["sem code", (s: URLSearchParams) => s.delete("code")],
    ["st repetido", (s: URLSearchParams) => s.append("st", s.get("st") as string)],
    ["code repetido", (s: URLSearchParams) => s.append("code", s.get("code") as string)],
    ["chave extra", (s: URLSearchParams) => s.append("redirect_to", "https://evil.invalid")],
    ["erro do IdP", (s: URLSearchParams) => (s.delete("code"), s.append("error", "access_denied"))],
  ])("query hostil (%s): login_falhou sem chamar o GoTrue", async (_caso, mutate) => {
    const { flow, search } = await started();
    mutate(search);
    expect(await auth.completeLogin({ search, flowCookie: flow.value })).toEqual(failed("login_falhou"));
    expect(fake.requests).toHaveLength(0);
  });

  it("cookie do fluxo ausente, adulterado, de outra finalidade ou vencido: sem rede", async () => {
    const { flow, search } = await started();
    const sessaoComoFluxo = sealSession({ v: "x" });
    for (const value of [undefined, flow.value.slice(0, -2) + "AA", sessaoComoFluxo]) {
      expect(await auth.completeLogin({ search, flowCookie: value })).toEqual(failed("login_falhou"));
    }
    clock.ms += 301_000;
    expect(await auth.completeLogin({ search, flowCookie: flow.value })).toEqual(failed("login_falhou"));
    expect(fake.requests).toHaveLength(0);
  });

  it("payload do fluxo fora da forma não vale", async () => {
    const { search } = await started();
    const forged = fluxoSealer().seal(JSON.stringify({ v: "v".repeat(43), st: search.get("st"), p: "github", iat: nowS(), extra: 1 })) as string;
    expect(await auth.completeLogin({ search, flowCookie: forged })).toEqual(failed("login_falhou"));
    const notJson = fluxoSealer().seal("{") as string;
    expect(await auth.completeLogin({ search, flowCookie: notJson })).toEqual(failed("login_falhou"));
  });

  it("recusa do GoTrue (verifier de outro fluxo): login_falhou, uma chamada só", async () => {
    const a = await started();
    const b = await auth.startLogin({ provider: "github", secFetchSite: "same-origin" });
    const otherFlow = JSON.parse(fluxoSealer().open((cookieOf(b, COOKIE_NAMES.fluxo) as CookieWrite).value) as string) as Record<string, unknown>;
    const mixed = fluxoSealer().seal(JSON.stringify({ ...otherFlow, st: a.search.get("st") })) as string;
    expect(await auth.completeLogin({ search: a.search, flowCookie: mixed })).toEqual(failed("login_falhou"));
    expect(tokenCalls()).toHaveLength(1);
  });

  it.each([
    ["503", { kind: "responde", status: 503, body: "" }],
    ["prazo", { kind: "trava" }],
  ] as const)("GoTrue %s: servico_indisponivel, sem nova tentativa", async (_caso, mode) => {
    const { flow, search } = await started();
    fake.mode = mode;
    expect(await auth.completeLogin({ search, flowCookie: flow.value })).toEqual(failed("servico_indisponivel"));
    expect(tokenCalls()).toHaveLength(1);
  });

  it.each([
    ["amr password", { amr: [{ method: "password", timestamp: 1 }] }, "login_falhou"],
    ["sem session_id", { sessionId: null }, "login_falhou"],
    ["access acima de 2.400 caracteres", { extra: { pad: "p".repeat(2_400) } }, "servico_indisponivel"],
  ] as const)("access recusado na entrada (%s): aviso e logout da sessão órfã", async (_caso, claims, notice) => {
    const { flow, search } = await started();
    fake.claims = claims;
    expect(await auth.completeLogin({ search, flowCookie: flow.value })).toEqual(failed(notice));
    await Promise.all(pending);
    expect(fake.requests.at(-1)?.url).toBe("/auth/v1/logout?scope=local");
  });

  it("JWKS fora: servico_indisponivel e logout da órfã", async () => {
    const { flow, search } = await started();
    const offline = createPortalAuth({
      config,
      gotrue: createGotrueClient({ supabaseUrl: config.supabaseUrl, publishableKey: PUBLISHABLE, timeoutMs: 500 }),
      verifier: { verify: () => Promise.resolve({ ok: false, reason: "indisponivel" }) },
      now: () => clock.ms,
      defer: (task) => pending.push(task),
    });
    expect(await offline.completeLogin({ search, flowCookie: flow.value })).toEqual(failed("servico_indisponivel"));
    await Promise.all(pending);
    expect(fake.requests.at(-1)?.url).toBe("/auth/v1/logout?scope=local");
  });
});

describe("resolveSession: a renovação no proxy (ADR-027 D6)", () => {
  it("sem cookie: ausente, sem mexer em nada", async () => {
    expect(await auth.resolveSession(undefined)).toEqual({ state: "ausente" });
  });

  it("cookie que não abre ou fora da forma: ausente e apagado", async () => {
    const clear = { name: COOKIE_NAMES.sessao, value: "", maxAge: 0 };
    expect(await auth.resolveSession("lixo")).toEqual({ state: "ausente", cookie: clear });
    expect(await auth.resolveSession(sealSession({ at: "x" }))).toEqual({ state: "ausente", cookie: clear });
    expect(await auth.resolveSession(sessaoSealer().seal("[") as string)).toEqual({ state: "ausente", cookie: clear });
  });

  it("access com mais de 60 s pela frente: ativa, sem rede", async () => {
    const { session } = await login();
    fake.requests.length = 0;
    clock.ms += (900 - 61) * 1_000;
    expect(await auth.resolveSession(session.value)).toEqual({ state: "ativa" });
    expect(fake.requests).toHaveLength(0);
  });

  it("perto do fim: renova, sela de novo com o mesmo sst e o Max-Age que falta das 24 h", async () => {
    const { session } = await login();
    const before = JSON.parse(sessaoSealer().open(session.value) as string) as Record<string, number | string>;
    clock.ms += 850_000;
    const result = await auth.resolveSession(session.value);
    expect(result.state).toBe("ativa");
    const after = JSON.parse(sessaoSealer().open(result.cookie?.value as string) as string) as Record<string, number | string>;
    expect(after["sst"]).toBe(before["sst"]);
    expect(after["iat"]).toBe(nowS());
    expect(after["rt"]).not.toBe(before["rt"]);
    expect(after["sid"]).toBe(before["sid"]);
    expect(result.cookie?.maxAge).toBe(PORTAL_SESSION_POLICY.maxAgeSeconds - 850);
  });

  it("idade acima de 24 h ou inatividade acima de 4 h: expirada, apagado, sem rede", async () => {
    const base = { at: "a.b.c", rt: "r", sid: randomUUID(), ate: nowS() + 900 };
    const clear = { name: COOKIE_NAMES.sessao, value: "", maxAge: 0 };
    expect(await auth.resolveSession(sealSession({ ...base, sst: nowS() - 86_401, iat: nowS() }))).toEqual({ state: "expirada", cookie: clear });
    expect(await auth.resolveSession(sealSession({ ...base, sst: nowS() - 86_400, iat: nowS() - 14_401 }))).toEqual({ state: "expirada", cookie: clear });
    expect(fake.requests).toHaveLength(0);
  });

  it("a recusa do hook (403 unknown) vira expirada com o cookie apagado, uma chamada só", async () => {
    const { session } = await login();
    fake.requests.length = 0;
    clock.ms += 850_000;
    fake.hookRefuses = true;
    expect(await auth.resolveSession(session.value)).toEqual({ state: "expirada", cookie: { name: COOKIE_NAMES.sessao, value: "", maxAge: 0 } });
    expect(tokenCalls()).toHaveLength(1);
  });

  it.each([
    ["503", { kind: "responde", status: 503, body: "" }],
    ["429", { kind: "responde", status: 429, body: JSON.stringify({ error_code: "over_request_rate_limit" }) }],
    ["403 em HTML", { kind: "responde", status: 403, body: "<html/>", contentType: "text/html" }],
  ] as const)("GoTrue %s: indisponível e o cookie fica (T30), sem nova tentativa", async (_caso, mode) => {
    const { session } = await login();
    fake.requests.length = 0;
    clock.ms += 850_000;
    fake.mode = mode;
    expect(await auth.resolveSession(session.value)).toEqual({ state: "indisponivel" });
    expect(tokenCalls()).toHaveLength(1);
  });

  it("pode ter rotacionado: uma nova tentativa com o mesmo refresh, que o reuso de 10 s aceita", async () => {
    const { session } = await login();
    fake.requests.length = 0;
    clock.ms += 850_000;
    // A 1ª resposta morre no meio do corpo; a 2ª tentativa sai com o modo normal.
    fake.mode = { kind: "corta", vezes: 1 };
    const result = await auth.resolveSession(session.value);
    expect(result.state).toBe("ativa");
    const bodies = tokenCalls().map((request) => request.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("pode ter rotacionado duas vezes: indisponível com o cookie", async () => {
    const { session } = await login();
    fake.requests.length = 0;
    clock.ms += 850_000;
    fake.mode = { kind: "corta" };
    expect(await auth.resolveSession(session.value)).toEqual({ state: "indisponivel" });
    expect(tokenCalls()).toHaveLength(2);
  });

  it("access novo de outra sessão (sid divergente) ou com amr password: expirada", async () => {
    const { session } = await login();
    clock.ms += 850_000;
    fake.claims = { sessionId: randomUUID() };
    expect((await auth.resolveSession(session.value)).state).toBe("expirada");
    fake.claims = {};
    const second = await login();
    clock.ms += 850_000;
    fake.claims = { amr: [{ method: "password", timestamp: 1 }] };
    expect((await auth.resolveSession(second.session.value)).state).toBe("expirada");
  });

  it("access novo acima do teto do cookie: indisponível, o cookie antigo fica", async () => {
    const { session } = await login();
    clock.ms += 850_000;
    fake.claims = { extra: { pad: "p".repeat(2_400) } };
    expect(await auth.resolveSession(session.value)).toEqual({ state: "indisponivel" });
  });

  it("JWKS fora depois da renovação: sela os tokens novos e diz indisponível", async () => {
    const { session } = await login();
    clock.ms += 850_000;
    const offline = createPortalAuth({
      config,
      gotrue: createGotrueClient({ supabaseUrl: config.supabaseUrl, publishableKey: PUBLISHABLE, timeoutMs: 500 }),
      verifier: { verify: () => Promise.resolve({ ok: false, reason: "indisponivel" }) },
      now: () => clock.ms,
      defer: (task) => pending.push(task),
    });
    const result = await offline.resolveSession(session.value);
    expect(result.state).toBe("indisponivel");
    expect(result.cookie?.maxAge).toBeGreaterThan(0);
  });
});

describe("readSession: a DAL (ADR-027 D5)", () => {
  it("verifica o access e devolve só o userId", async () => {
    const { session } = await login();
    expect(await auth.readSession(session.value)).toEqual({ ok: true, userId: GOTRUE_CANARIES.userId });
  });

  it("sem cookie, vencida, sid divergente ou access inválido: sem sessão", async () => {
    expect(await auth.readSession(undefined)).toEqual({ ok: false });
    const { session } = await login();
    const payload = JSON.parse(sessaoSealer().open(session.value) as string) as Record<string, unknown>;
    expect(await auth.readSession(sealSession({ ...payload, sid: randomUUID() }))).toEqual({ ok: false });
    expect(await auth.readSession(sealSession({ ...payload, sst: nowS() - 90_000 }))).toEqual({ ok: false });
    expect(await auth.readSession(sealSession({ ...payload, at: "a.b.c" }))).toEqual({ ok: false });
  });
});

describe("logout (ADR-027 D7)", () => {
  const allowed = { origin: PORTAL, secFetchSite: "same-origin" };

  it.each([
    ["sem Origin", { origin: null, secFetchSite: "same-origin" }],
    ["outra origem", { origin: "https://evil.invalid", secFetchSite: "same-origin" }],
    ["Origin null", { origin: "null", secFetchSite: "same-origin" }],
    ["origem com barra", { origin: `${PORTAL}/`, secFetchSite: "same-origin" }],
    ["cross-site", { origin: PORTAL, secFetchSite: "cross-site" }],
    ["sem Sec-Fetch-Site", { origin: PORTAL, secFetchSite: null }],
  ])("%s: 403, cookie intacto e sem rede", async (_caso, input) => {
    const { session } = await login();
    fake.requests.length = 0;
    expect(await auth.logout({ ...input, sessionCookie: session.value })).toEqual({ kind: "forbidden" });
    expect(fake.requests).toHaveLength(0);
  });

  it("apaga o cookie e encerra a sessão no GoTrue com escopo local", async () => {
    const { session } = await login();
    const sid = (JSON.parse(sessaoSealer().open(session.value) as string) as Record<string, string>)["sid"] as string;
    expect(await auth.logout({ ...allowed, sessionCookie: session.value })).toEqual({
      kind: "redirect",
      location: `${PORTAL}/?aviso=saiu`,
      cookies: [{ name: COOKIE_NAMES.sessao, value: "", maxAge: 0 }],
    });
    expect(fake.requests.at(-1)?.url).toBe("/auth/v1/logout?scope=local");
    expect(fake.liveSessions.has(sid)).toBe(false);
  });

  it("sem cookie: só apaga", async () => {
    expect(await auth.logout({ ...allowed, sessionCookie: undefined })).toEqual({ kind: "redirect", location: `${PORTAL}/?aviso=saiu`, cookies: [{ name: COOKIE_NAMES.sessao, value: "", maxAge: 0 }] });
    expect(fake.requests).toHaveLength(0);
  });

  it("GoTrue fora: o cookie é apagado assim mesmo, com o aviso saiu_local", async () => {
    const { session } = await login();
    fake.mode = { kind: "responde", status: 503, body: "" };
    expect(await auth.logout({ ...allowed, sessionCookie: session.value })).toEqual({
      kind: "redirect",
      location: `${PORTAL}/?aviso=saiu_local`,
      cookies: [{ name: COOKIE_NAMES.sessao, value: "", maxAge: 0 }],
    });
  });

  it("access perto do fim: renova antes, para o Bearer valer", async () => {
    const { session } = await login();
    clock.ms += 850_000;
    fake.requests.length = 0;
    const result = await auth.logout({ ...allowed, sessionCookie: session.value });
    expect(result.kind === "redirect" && result.location).toBe(`${PORTAL}/?aviso=saiu`);
    expect(fake.requests.map((request) => request.url)).toEqual(["/auth/v1/token?grant_type=refresh_token", "/auth/v1/logout?scope=local"]);
  });

  it("renovação recusada no logout: tenta encerrar assim mesmo, com o access que tem", async () => {
    const { session } = await login();
    clock.ms += 850_000;
    fake.hookRefuses = true;
    fake.requests.length = 0;
    const result = await auth.logout({ ...allowed, sessionCookie: session.value });
    expect(result.kind === "redirect" && result.location).toBe(`${PORTAL}/?aviso=saiu`);
    expect(fake.requests.map((request) => request.url)).toEqual(["/auth/v1/token?grant_type=refresh_token", "/auth/v1/logout?scope=local"]);
  });
});
