// F1-EXT-05c, 05c-1 (ADR-004 §4.4): os falsos do E2E com IdP falso, sem navegador. O que o E2E prova depende deles: o
// `authorize` aceita exatamente o que o Service Worker monta e nada mais, a troca confere o PKCE de ponta a ponta com
// código de uso único e 5 min, o BFF falso só fala com a origem exata da extensão, e os coletores acham o canário nas
// três formas. Todo valor com cara de segredo nasce aqui em tempo de execução (cuidado 14 do next-step).
import { randomBytes } from "node:crypto";
import { type IncomingHttpHeaders, type Server, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

import { ApiErrorSchema } from "@trampo/contracts/api";
import { AUTH_BODY_MAX_BYTES, AccessTokenSchema, AuthCodeSchema, AuthSessionResponseSchema, SealedRefreshSchema } from "@trampo/contracts/auth";
import { afterEach, describe, expect, test } from "vitest";

import { buildAuthorizeUrl } from "../src/auth/authorize-url";
import { createPkcePair, createState } from "../src/auth/pkce";
import { parseAuthRedirect } from "../src/auth/redirect";
import {
  LONG_TOKEN,
  base64url,
  canaryForms,
  findCanaries,
  newAccessCanary,
  newCodeCanary,
  newEnvelopeCanary,
  newErrorCanary,
} from "./e2e/support/canaries";
import { AUTHORIZE_SCRIPTS, FAKE_AUTH_POLICY, FakeScriptSchema, createFakeAuth, s256 } from "./e2e/support/fake-auth";
import { CONTROL_HEADER, type FakeEnvironment, type Handler, createFakeEnvironment, extensionOriginRequests, fakeControl } from "./e2e/support/fake-servers";
import { P20_MODES, browserBrand, p20ModeFor } from "./e2e/support/p20";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const OUTRO_ID = "ponmlkjihgfedcbaponmlkjihgfedcba";
const SUPABASE = "https://localhost:47444";
const ORIGIN = `chrome-extension://${ID}`;
const REDIRECT = `https://${ID}.chromiumapp.org/auth`;

/** O que o Service Worker manda: a URL do `buildAuthorizeUrl`, com o par PKCE e o `state` de verdade. */
async function swAuthorize(provider: "github" | "google" = "github") {
  const { verifier, challenge } = await createPkcePair();
  const state = createState();
  const url = new URL(buildAuthorizeUrl({ supabaseOrigin: SUPABASE, provider, redirectUri: REDIRECT, state, challenge }));
  return { verifier, challenge, state, query: url.searchParams };
}

const exchangeBody = (authCode: string, codeVerifier: string) => ({ schemaVersion: 1, authCode, codeVerifier });
const codeOf = (location: string | undefined) => String(new URL(String(location)).searchParams.get("code"));

describe("canários (ADR-004 §4.4): nascem em tempo de execução, na forma dos contratos", () => {
  test("access token: JWS compacto no AccessTokenSchema, com sub e session_id canários e os 3 segmentos à parte", () => {
    const a = newAccessCanary();
    expect(AccessTokenSchema.safeParse(a.token).success).toBe(true);
    expect(a.segments.join(".")).toBe(a.token);
    const payload = JSON.parse(Buffer.from(a.segments[1], "base64url").toString("utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({ sub: expect.stringMatching(/^CANARIO-SUB-[0-9a-f-]{36}$/), session_id: expect.stringMatching(/^CANARIO-SID-[0-9a-f-]{36}$/) });
    expect(newAccessCanary().token).not.toBe(a.token);
  });

  test("envelope: r1.<kid>.<iv>.CANARIO_RT_<hex>.<tag> no SealedRefreshSchema, com o cifrado à parte", () => {
    const e = newEnvelopeCanary();
    expect(SealedRefreshSchema.safeParse(e.envelope).success).toBe(true);
    expect(e.envelope).toMatch(/^r1\.e2e\.[\w-]{16}\.CANARIO_RT_[0-9a-f]{32}\.[\w-]{22}$/);
    expect(e.envelope.split(".")[3]).toBe(e.cipher);
    expect(newEnvelopeCanary().envelope).not.toBe(e.envelope);
  });

  test("código no AuthCodeSchema e texto de erro do IdP, únicos a cada chamada", () => {
    expect(AuthCodeSchema.safeParse(newCodeCanary()).success).toBe(true);
    expect(newCodeCanary()).toMatch(/^CANARIO-CODE-[0-9a-f-]{36}$/);
    expect(newErrorCanary()).toMatch(/^CANARIO-ERR-[0-9a-f-]{36}$/);
    expect(newCodeCanary()).not.toBe(newCodeCanary());
  });

  test("base64url sem preenchimento", () => {
    expect(base64url(new Uint8Array([251, 255, 191]))).toBe("-_-_");
    expect(base64url(new Uint8Array([1]))).toBe("AQ");
  });

  test("as três formas: crua, encodeURIComponent e string JSON escapada, sem repetição", () => {
    expect(canaryForms('a "b"/c+d')).toEqual(['a "b"/c+d', "a%20%22b%22%2Fc%2Bd", 'a \\"b\\"/c+d']);
    expect(canaryForms("CANARIO-CODE-x")).toEqual(["CANARIO-CODE-x"]);
  });

  test("o coletor acha cada forma, devolve o canário cru e recusa canário vazio", () => {
    const canary = 'x "y"/z';
    expect(findCanaries(`antes ${canary} depois`, [canary, "outro"])).toEqual([canary]);
    expect(findCanaries(`{"v":"x \\"y\\"/z"}`, [canary])).toEqual([canary]);
    expect(findCanaries("?q=x%20%22y%22%2Fz", [canary])).toEqual([canary]);
    expect(findCanaries("nada aqui", [canary])).toEqual([]);
    expect(() => findCanaries("texto", ["ok", ""])).toThrow(/canário vazio/);
  });

  test("reforço: trecho base64url de 100 caracteres ou mais", () => {
    expect(LONG_TOKEN.test("a".repeat(100))).toBe(true);
    expect(LONG_TOKEN.test("a".repeat(99))).toBe(false);
    expect(LONG_TOKEN.test(newAccessCanary().token)).toBe(true);
  });
});

describe("fake-auth: authorize do Supabase falso", () => {
  const make = () => createFakeAuth({ extensionId: ID, now: () => 1_000 });

  test.each(["github", "google"] as const)("aceita a URL que o SW monta (%s): 302 para o chromiumapp com o código e o eco do st", async (provider) => {
    const auth = make();
    const { state, query } = await swAuthorize(provider);
    const reply = auth.authorize(query);
    expect(reply.status).toBe(302);
    const location = new URL(String(reply.location));
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect([...location.searchParams.keys()]).toEqual(["code", "st"]);
    expect(location.searchParams.get("st")).toBe(state);
    expect(AuthCodeSchema.safeParse(location.searchParams.get("code")).success).toBe(true);
    expect(auth.snapshot().counters.authorize).toEqual({ ok: 1, recusado: 0 });
    expect(auth.snapshot().canaries).toEqual([location.searchParams.get("code")]);
  });

  test.each([
    ["parâmetro a mais (response_type)", (q: URLSearchParams) => q.append("response_type", "token"), "parametros"],
    ["parâmetro faltando", (q: URLSearchParams) => q.delete("code_challenge_method"), "parametros"],
    ["parâmetro repetido", (q: URLSearchParams) => q.append("provider", "github"), "parametros"],
    [
      "parâmetro repetido no lugar de outro (4 chaves)",
      (q: URLSearchParams) => {
        q.delete("code_challenge_method");
        q.append("provider", "github");
      },
      "parametros",
    ],
    ["provedor fora da lista", (q: URLSearchParams) => q.set("provider", "facebook"), "provedor"],
    ["método plain", (q: URLSearchParams) => q.set("code_challenge_method", "plain"), "metodo"],
    ["método S256 em maiúsculas", (q: URLSearchParams) => q.set("code_challenge_method", "S256"), "metodo"],
    ["challenge com 42 caracteres", (q: URLSearchParams) => q.set("code_challenge", String(q.get("code_challenge")).slice(1)), "challenge"],
    ["challenge com 44 caracteres", (q: URLSearchParams) => q.set("code_challenge", `${String(q.get("code_challenge"))}a`), "challenge"],
    ["challenge com caractere fora do base64url", (q: URLSearchParams) => q.set("code_challenge", `${String(q.get("code_challenge")).slice(1)}+`), "challenge"],
    ["redirect_to de outra extensão", (q: URLSearchParams) => q.set("redirect_to", String(q.get("redirect_to")).replace(ID, OUTRO_ID)), "redirect_to"],
    ["redirect_to com outro caminho", (q: URLSearchParams) => q.set("redirect_to", String(q.get("redirect_to")).replace("/auth?", "/outro?")), "redirect_to"],
    ["redirect_to sem o st", (q: URLSearchParams) => q.set("redirect_to", REDIRECT), "redirect_to"],
    ["st com 21 caracteres", (q: URLSearchParams) => q.set("redirect_to", String(q.get("redirect_to")).slice(0, -1)), "redirect_to"],
    ["st com sufixo", (q: URLSearchParams) => q.set("redirect_to", `${String(q.get("redirect_to"))}&x=1`), "redirect_to"],
  ])("recusa %s com 400, sem código", async (_caso, change, motivo) => {
    const auth = make();
    const { query } = await swAuthorize();
    change(query);
    expect(auth.authorize(query)).toEqual({ status: 400, body: "authorize recusado pelo Supabase falso" });
    expect(auth.snapshot()).toMatchObject({ counters: { authorize: { ok: 0, recusado: 1 } }, refusals: [`authorize:${motivo}`], canaries: [] });
  });
});

describe("fake-auth: troca no BFF falso (PKCE de ponta a ponta)", () => {
  async function authorized(now = { t: 1_000 }) {
    const auth = createFakeAuth({ extensionId: ID, now: () => now.t });
    const flow = await swAuthorize();
    const code = codeOf(auth.authorize(flow.query).location);
    return { auth, flow, code, now };
  }

  test("verifier certo: 200 com as 4 chaves do contrato, verifier registrado e canários emitidos", async () => {
    const { auth, flow, code } = await authorized();
    const reply = auth.exchange(exchangeBody(code, flow.verifier));
    expect(reply.status).toBe(200);
    const session = AuthSessionResponseSchema.parse(reply.body);
    expect(session.expiresIn).toBe(FAKE_AUTH_POLICY.expiresIn);
    const snap = auth.snapshot();
    expect(snap.counters.exchange).toEqual({ ok: 1, recusado: 0 });
    expect(snap.verifiers).toEqual([flow.verifier]);
    expect(snap.accessTokens).toEqual([session.accessToken]);
    expect(snap.canaries).toEqual([code, flow.verifier, session.accessToken, ...session.accessToken.split("."), session.refreshToken, session.refreshToken.split(".")[3]]);
    expect(s256(flow.verifier)).toBe(flow.challenge);
  });

  test("uso único: a 2ª troca do mesmo código dá 401, mesmo com o verifier certo", async () => {
    const { auth, flow, code } = await authorized();
    expect(auth.exchange(exchangeBody(code, flow.verifier)).status).toBe(200);
    expect(auth.exchange(exchangeBody(code, flow.verifier))).toEqual({ status: 401, body: expect.objectContaining({ code: "NAO_AUTENTICADO" }) });
    expect(auth.snapshot().refusals).toEqual(["exchange:codigo_desconhecido"]);
  });

  test("verifier errado: 401, e o código morre (o verifier certo depois também falha)", async () => {
    const { auth, flow, code } = await authorized();
    const outro = (await createPkcePair()).verifier;
    expect(auth.exchange(exchangeBody(code, outro)).status).toBe(401);
    expect(auth.exchange(exchangeBody(code, flow.verifier)).status).toBe(401);
    expect(auth.snapshot()).toMatchObject({ refusals: ["exchange:verifier_divergente", "exchange:codigo_desconhecido"], verifiers: [outro, flow.verifier] });
  });

  test("a política é a do GoTrue: código de 5 min (P8) e JWT de 900 s (HITL-004)", () => {
    expect(FAKE_AUTH_POLICY).toEqual({ codeTtlMs: 300_000, expiresIn: 900 });
  });

  test("validade de 5 min: vale no limite exato e vence 1 ms depois", async () => {
    const a = await authorized();
    a.now.t += FAKE_AUTH_POLICY.codeTtlMs;
    expect(a.auth.exchange(exchangeBody(a.code, a.flow.verifier)).status).toBe(200);
    const b = await authorized();
    b.now.t += FAKE_AUTH_POLICY.codeTtlMs + 1;
    expect(b.auth.exchange(exchangeBody(b.code, b.flow.verifier)).status).toBe(401);
    expect(b.auth.snapshot().refusals).toEqual(["exchange:codigo_vencido"]);
  });

  test("código que o authorize nunca emitiu: 401", async () => {
    const { auth, flow } = await authorized();
    expect(auth.exchange(exchangeBody(newCodeCanary(), flow.verifier)).status).toBe(401);
    expect(auth.snapshot().refusals).toEqual(["exchange:codigo_desconhecido"]);
  });

  test.each([
    ["chave a mais", (code: string, verifier: string) => ({ ...exchangeBody(code, verifier), redirectTo: "x" })],
    ["schemaVersion 2", (code: string, verifier: string) => ({ ...exchangeBody(code, verifier), schemaVersion: 2 })],
    ["verifier curto", (code: string) => exchangeBody(code, "a".repeat(42))],
    ["não é objeto", () => "corpo"],
  ])("corpo fora do contrato (%s): 400 PAYLOAD_INVALIDO, sem registrar verifier", async (_caso, body) => {
    const { auth, flow, code } = await authorized();
    const reply = auth.exchange(body(code, flow.verifier));
    expect(reply.status).toBe(400);
    expect(ApiErrorSchema.parse(reply.body).code).toBe("PAYLOAD_INVALIDO");
    expect(auth.snapshot()).toMatchObject({ refusals: ["exchange:corpo"], verifiers: [] });
    // O código continua vivo: o corpo inválido nem chegou a ele.
    expect(auth.exchange(exchangeBody(code, flow.verifier)).status).toBe(200);
  });
});

describe("fake-auth: renovação e logout", () => {
  async function session() {
    const auth = createFakeAuth({ extensionId: ID, now: () => 0 });
    const flow = await swAuthorize();
    const body = AuthSessionResponseSchema.parse(auth.exchange(exchangeBody(codeOf(auth.authorize(flow.query).location), flow.verifier)).body);
    return { auth, body };
  }
  const refresh = (refreshToken: string) => ({ schemaVersion: 1, refreshToken });

  test("renovação gira o par: o envelope antigo deixa de valer", async () => {
    const { auth, body } = await session();
    const renewed = auth.refresh(refresh(body.refreshToken));
    expect(renewed.status).toBe(200);
    const next = AuthSessionResponseSchema.parse(renewed.body);
    expect(next.accessToken).not.toBe(body.accessToken);
    expect(auth.refresh(refresh(body.refreshToken)).status).toBe(401);
    expect(auth.refresh(refresh(next.refreshToken)).status).toBe(200);
    expect(auth.snapshot()).toMatchObject({ counters: { refresh: { ok: 2, recusado: 1 } }, refusals: ["refresh:envelope_desconhecido"] });
  });

  test("renovação com corpo fora do contrato: 400", async () => {
    const { auth } = await session();
    expect(auth.refresh({ schemaVersion: 1, refreshToken: "r1.x" }).status).toBe(400);
    expect(auth.snapshot().refusals).toEqual(["refresh:corpo"]);
  });

  test("logout com o Bearer do access vivo: 204, e a sessão morre (renovação e 2º logout dão 401)", async () => {
    const { auth, body } = await session();
    expect(auth.logout({ schemaVersion: 1 }, `Bearer ${body.accessToken}`)).toEqual({ status: 204 });
    expect(auth.logout({ schemaVersion: 1 }, `Bearer ${body.accessToken}`).status).toBe(401);
    expect(auth.refresh(refresh(body.refreshToken)).status).toBe(401);
    expect(auth.snapshot().counters.logout).toEqual({ ok: 1, recusado: 1 });
  });

  test.each([
    ["sem Authorization", () => undefined],
    ["Basic", () => "Basic abc"],
    // O SW sempre manda "Bearer "; o falso não aceita outra grafia, nem com o token vivo.
    ["bearer em minúsculas com o token vivo", (token: string) => `bearer ${token}`],
    ["outro esquema de 6 letras com o token vivo", (token: string) => `Bearxr ${token}`],
    ["outro token", () => `Bearer ${newAccessCanary().token}`],
  ])("logout %s: 401", async (_caso, authorization) => {
    const { auth, body } = await session();
    expect(auth.logout({ schemaVersion: 1 }, authorization(body.accessToken)).status).toBe(401);
    expect(auth.snapshot().refusals).toEqual(["logout:bearer"]);
  });

  test("logout com corpo fora do contrato: 400, e a sessão continua", async () => {
    const { auth, body } = await session();
    expect(auth.logout({ schemaVersion: 1, escopo: "local" }, `Bearer ${body.accessToken}`).status).toBe(400);
    expect(auth.logout({ schemaVersion: 1 }, `Bearer ${body.accessToken}`).status).toBe(204);
  });

  test("o snapshot é cópia: mexer nele não muda o estado", async () => {
    const { auth } = await session();
    const snap = auth.snapshot();
    (snap.counters.exchange as { ok: number }).ok = 99;
    expect(auth.snapshot().counters.exchange.ok).toBe(1);
  });
});

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function serve(handler: Handler): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function call(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("fake-servers: BFF falso", () => {
  let env: FakeEnvironment;
  async function bff() {
    env = createFakeEnvironment({ extensionId: ID, now: () => 0, controlToken: "segredo-de-teste" });
    return serve(env.bff);
  }
  const post = (port: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(port, { method: "POST", path, headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test.each([
    ["sem Origin", {}],
    ["Origin de outra extensão", { origin: `chrome-extension://${OUTRO_ID}` }],
    ["Origin web", { origin: "https://localhost:47443" }],
    ["Origin com barra final", { origin: `${ORIGIN}/` }],
  ])("%s: 403 sem CORS (a borda da API exige a origem exata)", async (_caso, headers) => {
    const port = await bff();
    const reply = await call(port, { method: "POST", path: "/v1/auth/exchange", headers, body: "{}" });
    expect(reply.status).toBe(403);
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    expect(env.state().auth.counters.exchange).toEqual({ ok: 0, recusado: 0 });
  });

  test("preflight de cada rota: 204 com a origem exata, só POST e só authorization e content-type", async () => {
    const port = await bff();
    for (const path of ["/v1/auth/exchange", "/v1/auth/refresh", "/v1/auth/logout"]) {
      const reply = await call(port, { method: "OPTIONS", path, headers: { origin: ORIGIN } });
      expect(reply.status, path).toBe(204);
      expect(reply.headers).toMatchObject({
        "access-control-allow-origin": ORIGIN,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "authorization, content-type",
        "cache-control": "no-store",
        vary: "Origin",
      });
    }
  });

  test("GET /v1/health responde ok para a extensão (alvo do teste de CSP do SW)", async () => {
    const port = await bff();
    const reply = await call(port, { path: "/v1/health", headers: { origin: ORIGIN } });
    expect(reply).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(reply.headers["access-control-allow-origin"]).toBe(ORIGIN);
  });

  test.each([
    ["caminho fora", "POST", "/v1/auth/exchange/", 404],
    ["prefixo", "POST", "/v1/auth", 404],
    ["health por POST", "POST", "/v1/health", 404],
    ["GET numa rota", "GET", "/v1/auth/refresh", 405],
  ])("%s: %s %s dá %i com CORS", async (_caso, method, path, status) => {
    const port = await bff();
    const reply = await call(port, { method, path, headers: { origin: ORIGIN } });
    expect(reply.status).toBe(status);
    expect(reply.headers["access-control-allow-origin"]).toBe(ORIGIN);
  });

  test("corpo acima de 2.048 bytes: 413; JSON quebrado: 400; nada chega ao estado", async () => {
    const port = await bff();
    expect((await call(port, { method: "POST", path: "/v1/auth/refresh", headers: { origin: ORIGIN }, body: "x".repeat(AUTH_BODY_MAX_BYTES + 1) })).status).toBe(413);
    expect((await call(port, { method: "POST", path: "/v1/auth/refresh", headers: { origin: ORIGIN }, body: "{" })).status).toBe(400);
    // No teto exato o corpo passa e cai no contrato (400 do schema, com recusa registrada).
    expect((await call(port, { method: "POST", path: "/v1/auth/refresh", headers: { origin: ORIGIN }, body: `"${"x".repeat(AUTH_BODY_MAX_BYTES - 2)}"` })).status).toBe(400);
    expect(env.state().auth.refusals).toEqual(["refresh:corpo"]);
  });

  test("pedido abortado no meio do corpo: o servidor segue de pé e registra o pedido", async () => {
    const port = await bff();
    await new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/v1/auth/refresh", headers: { origin: ORIGIN, "content-length": "100" } });
      req.on("error", () => resolve());
      req.write("{");
      setTimeout(() => req.destroy(), 50);
    });
    await expect.poll(() => env.state().requests.length).toBe(1);
    expect((await call(port, { path: "/v1/health", headers: { origin: ORIGIN } })).status).toBe(200);
  });

  test("troca, renovação e logout pelo HTTP: o estado é o mesmo do authorize, e o registro guarda presença, nunca valor", async () => {
    const port = await bff();
    const flow = await swAuthorize();
    const code = codeOf(createLocation(env, flow.query));
    const exchanged = await post(port, "/v1/auth/exchange", exchangeBody(code, flow.verifier));
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers).toMatchObject({ "access-control-allow-origin": ORIGIN, "content-type": "application/json", "cache-control": "no-store" });
    const session = AuthSessionResponseSchema.parse(JSON.parse(exchanged.body));
    const renewed = await post(port, "/v1/auth/refresh", { schemaVersion: 1, refreshToken: session.refreshToken }, { cookie: "sb=1" });
    const next = AuthSessionResponseSchema.parse(JSON.parse(renewed.body));
    const out = await post(port, "/v1/auth/logout", { schemaVersion: 1 }, { authorization: `Bearer ${next.accessToken}` });
    expect(out).toMatchObject({ status: 204, body: "" });
    const state = env.state();
    expect(state.auth.counters).toMatchObject({ exchange: { ok: 1 }, refresh: { ok: 1 }, logout: { ok: 1 } });
    expect(state.requests.filter((r) => r.server === "bff")).toEqual([
      { server: "bff", method: "POST", path: "/v1/auth/exchange", origin: ORIGIN, authorization: false, cookie: false },
      { server: "bff", method: "POST", path: "/v1/auth/refresh", origin: ORIGIN, authorization: false, cookie: true },
      { server: "bff", method: "POST", path: "/v1/auth/logout", origin: ORIGIN, authorization: true, cookie: false },
    ]);
    expect(JSON.stringify(state.requests)).not.toContain(next.accessToken);
  });
});

/** O `authorize` pelo handler do Supabase falso, sem socket de verdade: só para pegar o código no mesmo estado. */
function createLocation(env: FakeEnvironment, query: URLSearchParams): string {
  let location = "";
  const res = {
    writeHead: (_status: number, headers: Record<string, string>) => {
      location = headers["location"] ?? "";
      return { end: () => undefined };
    },
  };
  env.supabase({ method: "GET", url: `/auth/v1/authorize?${query.toString()}`, headers: {}, resume: () => undefined } as never, res as never);
  return location;
}

describe("fake-servers: Supabase falso e chromiumapp", () => {
  test("authorize válido: 302 com Location; inválido: 400; outro caminho ou método: 404; tudo registrado sem a query", async () => {
    const env = createFakeEnvironment({ extensionId: ID, now: () => 0, controlToken: "t" });
    const port = await serve(env.supabase);
    const flow = await swAuthorize();
    const ok = await call(port, { path: `/auth/v1/authorize?${flow.query.toString()}`, headers: { "sec-fetch-mode": "navigate" } });
    expect(ok.status).toBe(302);
    expect(String(ok.headers.location)).toMatch(new RegExp(`^${REDIRECT.replaceAll(".", "\\.")}\\?code=CANARIO-CODE-[0-9a-f-]{36}&st=${flow.state}$`));
    flow.query.set("code_challenge_method", "plain");
    expect((await call(port, { path: `/auth/v1/authorize?${flow.query.toString()}` })).status).toBe(400);
    expect((await call(port, { path: "/auth/v1/token?grant_type=pkce", method: "POST", headers: { origin: ORIGIN, authorization: "Bearer x" } })).status).toBe(404);
    expect((await call(port, { path: "/auth/v1/authorize", method: "POST" })).status).toBe(404);
    expect((await call(port, { path: "/rest/v1/criteria", headers: { origin: "https://localhost:47443" } })).status).toBe(404);
    const state = env.state();
    expect(state.requests.map((r) => r.path)).toEqual(["/auth/v1/authorize", "/auth/v1/authorize", "/auth/v1/token", "/auth/v1/authorize", "/rest/v1/criteria"]);
    expect(JSON.stringify(state.requests)).not.toContain(flow.state);
    // O SR-02 do E2E: só o pedido com Origin de extensão conta, em qualquer caminho.
    expect(extensionOriginRequests(state, "supabase")).toEqual([
      { server: "supabase", method: "POST", path: "/auth/v1/token", origin: ORIGIN, authorization: true, cookie: false },
    ]);
    expect(extensionOriginRequests(state, "bff")).toEqual([]);
  });

  test("chromiumapp local: conta e responde 404", async () => {
    const env = createFakeEnvironment({ extensionId: ID, now: () => 0, controlToken: "t" });
    const port = await serve(env.chromiumapp);
    expect((await call(port, { path: "/auth?code=x" })).status).toBe(404);
    expect(env.state().requests).toEqual([{ server: "chromiumapp", method: "GET", path: "/auth", origin: null, authorization: false, cookie: false }]);
  });

  test("o createAuth injetado é chamado de novo no reset, com o ID e o relógio", () => {
    const seen: Array<[string, number]> = [];
    const env = createFakeEnvironment({
      extensionId: ID,
      now: () => 7,
      controlToken: "t",
      createAuth: (extensionId, now) => {
        seen.push([extensionId, now()]);
        return createFakeAuth({ extensionId, now });
      },
    });
    env.reset();
    expect(seen).toEqual([
      [ID, 7],
      [ID, 7],
    ]);
  });
});

describe("fake-servers: canal de controle", () => {
  test("estado e zerar só com o segredo; o cliente lança em resposta que não é 2xx", async () => {
    const token = randomBytes(16).toString("hex");
    const env = createFakeEnvironment({ extensionId: ID, now: () => 0, controlToken: token });
    const port = await serve(env.control);
    const url = `http://127.0.0.1:${port}`;
    const supabasePort = await serve(env.supabase);
    await call(supabasePort, { path: "/qualquer" });

    expect((await call(port, { path: "/estado" })).status).toBe(403);
    expect((await call(port, { path: "/estado", headers: { [CONTROL_HEADER]: `${token}x` } })).status).toBe(403);
    expect((await call(port, { path: "/outro", headers: { [CONTROL_HEADER]: token } })).status).toBe(404);
    expect((await call(port, { path: "/zerar", headers: { [CONTROL_HEADER]: token } })).status).toBe(404);

    const control = fakeControl(url, token);
    expect((await control.state()).requests).toHaveLength(1);
    await control.reset();
    expect(await control.state()).toEqual({ auth: createFakeAuth({ extensionId: ID, now: () => 0 }).snapshot(), requests: [], segurados: 0 });
    await expect(fakeControl(url, "errado").state()).rejects.toThrow(/respondeu 403 em \/estado/);
  });

  test("roteiro pelo canal: forma fechada, só com o segredo e só por POST; o cliente arma e solta", async () => {
    const token = randomBytes(16).toString("hex");
    const env = createFakeEnvironment({ extensionId: ID, now: () => 0, controlToken: token });
    const port = await serve(env.control);
    const control = fakeControl(`http://127.0.0.1:${port}`, token);
    const roteiro = (body: string, headers: Record<string, string> = { [CONTROL_HEADER]: token }) =>
      call(port, { method: "POST", path: "/roteiro", headers, body });

    expect((await roteiro('{"authorize":"cancelar"}', {})).status).toBe(403);
    expect((await call(port, { path: "/roteiro", headers: { [CONTROL_HEADER]: token } })).status).toBe(404);
    expect((await call(port, { method: "POST", path: "/outro", headers: { [CONTROL_HEADER]: token } })).status).toBe(404);
    // O último passa do teto de 256 bytes só pelos espaços: no teto exato, o mesmo roteiro é aceito (abaixo).
    for (const body of ["", "{", "{}", '{"authorize":"aceitar"}', '{"logout503":2,"extra":1}', '{"authorize":"cancelar"}'.padEnd(257)]) {
      expect((await roteiro(body)).status, body).toBe(400);
    }
    // Nenhuma das recusas armou o roteiro.
    expect(codeOf(createLocation(env, (await swAuthorize()).query))).toMatch(/^CANARIO-CODE-/);
    expect(env.state().auth.roteiro).toEqual([]);

    expect((await roteiro('{"authorize":"cancelar"}'.padEnd(256))).status).toBe(204);
    await control.script({ logout503: 2 });
    const cancel = new URL(createLocation(env, (await swAuthorize()).query));
    expect(cancel.searchParams.get("error")).toBe("access_denied");
    expect(env.state().auth.roteiro).toEqual(["authorize:cancelar"]);

    const segurado = createFakeEnvironment({ extensionId: ID, now: () => 0, controlToken: token });
    const segPort = await serve(segurado.control);
    const segControl = fakeControl(`http://127.0.0.1:${segPort}`, token);
    await segControl.script({ authorize: "segurar" });
    const supabasePort = await serve(segurado.supabase);
    const pending = call(supabasePort, { path: `/auth/v1/authorize?${(await swAuthorize()).query.toString()}` });
    await expect.poll(async () => (await segControl.state()).segurados).toBe(1);
    expect(await segControl.release()).toBe(1);
    expect((await pending).status).toBe(302);
    expect(await segControl.release()).toBe(0);
  });
});

describe("fake-auth: roteiro do 05c-2 (ADR-004 §4.4, cenários 7, 8, 13 e 14): mais hostil, nunca mais permissivo", () => {
  const make = () => createFakeAuth({ extensionId: ID, now: () => 0 });
  /** Um authorize do SW com o roteiro armado: a URL de retorno, o que o parser do SW diz dela e o fluxo. */
  async function scripted(script: (typeof AUTHORIZE_SCRIPTS)[number]) {
    const auth = make();
    auth.script({ authorize: script });
    const flow = await swAuthorize();
    const reply = auth.authorize(flow.query);
    const location = String(reply.location);
    return { auth, flow, reply, location, parsed: parseAuthRedirect(location, REDIRECT, flow.state) };
  }
  const codeFrom = (location: string) => String(new URL(location).searchParams.get("code"));

  test("o schema do roteiro: as 5 formas do authorize e de 1 a 5 logouts com 503; nada fora disso", () => {
    expect(AUTHORIZE_SCRIPTS).toEqual(["segurar", "cancelar", "outro_caminho", "fragmento", "outro_challenge"]);
    for (const ok of [{ authorize: "segurar" }, { logout503: 1 }, { logout503: 5 }, { authorize: "fragmento", logout503: 2 }]) {
      expect(FakeScriptSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    }
    for (const bad of [{}, { logout503: 0 }, { logout503: 6 }, { logout503: 1.5 }, { authorize: "aceitar" }, { authorize: "segurar", troca: "ok" }, null]) {
      expect(FakeScriptSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  test("segurar: o 302 normal, marcado para o servidor segurar; o código vale na troca", async () => {
    const { auth, flow, reply, location, parsed } = await scripted("segurar");
    expect(reply).toEqual({ status: 302, location, hold: true });
    expect(parsed).toEqual({ ok: true, code: codeFrom(location) });
    expect(auth.exchange(exchangeBody(codeFrom(location), flow.verifier)).status).toBe(200);
    expect(auth.snapshot().roteiro).toEqual(["authorize:segurar"]);
  });

  test("cancelar: o erro do IdP na query, com o st e o CANARIO-ERR; nenhum código nasce, e o SW lê cancelamento", async () => {
    const auth = createFakeAuth({ extensionId: ID, now: () => 0, newError: () => "CANARIO-ERR-fixo" });
    auth.script({ authorize: "cancelar" });
    const flow = await swAuthorize();
    const reply = auth.authorize(flow.query);
    expect(reply).toEqual({
      status: 302,
      location: `${REDIRECT}?st=${flow.state}&error=access_denied&error_code=access_denied&error_description=CANARIO-ERR-fixo`,
    });
    expect(parseAuthRedirect(String(reply.location), REDIRECT, flow.state)).toEqual({ ok: false, motivo: "cancelado" });
    expect(auth.snapshot()).toMatchObject({ counters: { authorize: { ok: 1, recusado: 0 } }, canaries: ["CANARIO-ERR-fixo"], roteiro: ["authorize:cancelar"] });
  });

  test("outro_caminho: o código certo em /outro; o SW recusa pelo caminho, e o código valeria na troca", async () => {
    const { auth, flow, location, parsed } = await scripted("outro_caminho");
    expect(location).toBe(`https://${ID}.chromiumapp.org/outro?code=${codeFrom(location)}&st=${flow.state}`);
    expect(parsed).toEqual({ ok: false, motivo: "recusado" });
    expect(auth.exchange(exchangeBody(codeFrom(location), flow.verifier)).status).toBe(200);
  });

  test("fragmento: o código certo e um #access_token= canário; o SW recusa pelo fragmento, e o token entra nos canários", async () => {
    const { auth, flow, location, parsed } = await scripted("fragmento");
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}${url.search}`).toBe(`${REDIRECT}?code=${codeFrom(location)}&st=${flow.state}`);
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect([...fragment.keys()]).toEqual(["access_token", "token_type"]);
    const token = String(fragment.get("access_token"));
    expect(AccessTokenSchema.safeParse(token).success).toBe(true);
    expect(parsed).toEqual({ ok: false, motivo: "recusado" });
    expect(auth.snapshot().canaries).toEqual([codeFrom(location), token, ...token.split(".")]);
    expect(auth.exchange(exchangeBody(codeFrom(location), flow.verifier)).status).toBe(200);
  });

  test("outro_challenge: o retorno passa no SW, mas a troca recusa com verifier_divergente", async () => {
    const { auth, flow, location, parsed } = await scripted("outro_challenge");
    expect(parsed).toEqual({ ok: true, code: codeFrom(location) });
    expect(auth.exchange(exchangeBody(codeFrom(location), flow.verifier)).status).toBe(401);
    expect(auth.snapshot()).toMatchObject({ refusals: ["exchange:verifier_divergente"], roteiro: ["authorize:outro_challenge"] });
  });

  test("o roteiro vale para um authorize só, e nunca pula as barreiras: o pedido inválido é recusado e não o consome", async () => {
    const auth = make();
    auth.script({ authorize: "fragmento" });
    auth.script({ authorize: "cancelar" });
    auth.script({ logout503: 1 });
    const bad = await swAuthorize();
    bad.query.set("code_challenge_method", "plain");
    expect(auth.authorize(bad.query).status).toBe(400);
    const first = auth.authorize((await swAuthorize()).query);
    expect(new URL(String(first.location)).searchParams.get("error")).toBe("access_denied");
    const second = await swAuthorize();
    const normal = auth.authorize(second.query);
    expect(normal).toEqual({ status: 302, location: `${REDIRECT}?code=${codeFrom(String(normal.location))}&st=${second.state}` });
    expect(auth.snapshot()).toMatchObject({ refusals: ["authorize:metodo"], roteiro: ["authorize:cancelar"] });
  });

  test("logout com 503: só depois do corpo e do Bearer conferidos, sem derrubar a sessão, e só as vezes armadas", async () => {
    const auth = make();
    const flow = await swAuthorize();
    const body = AuthSessionResponseSchema.parse(auth.exchange(exchangeBody(codeOf(auth.authorize(flow.query).location), flow.verifier)).body);
    auth.script({ logout503: 2 });
    // Corpo fora do contrato e Bearer errado continuam recusados como sempre, e não gastam o roteiro.
    expect(auth.logout({ schemaVersion: 1, escopo: "local" }, `Bearer ${body.accessToken}`).status).toBe(400);
    expect(auth.logout({ schemaVersion: 1 }, `Bearer ${newAccessCanary().token}`).status).toBe(401);
    for (let i = 0; i < 2; i += 1) {
      const reply = auth.logout({ schemaVersion: 1 }, `Bearer ${body.accessToken}`);
      expect(reply.status).toBe(503);
      expect(ApiErrorSchema.parse(reply.body).code).toBe("SERVICO_INDISPONIVEL");
    }
    expect(auth.logout({ schemaVersion: 1 }, `Bearer ${body.accessToken}`)).toEqual({ status: 204 });
    expect(auth.snapshot()).toMatchObject({
      counters: { logout: { ok: 1, recusado: 4 } },
      refusals: ["logout:corpo", "logout:bearer", "logout:roteiro_503", "logout:roteiro_503"],
      roteiro: ["logout:503", "logout:503"],
    });
  });
});

describe("fake-servers: o 302 segurado", () => {
  test("o authorize com segurar não responde até o soltar; o zerar encerra o que estiver preso com 410 e limpa o roteiro", async () => {
    const env = createFakeEnvironment({ extensionId: ID, now: () => 0, controlToken: "t" });
    const port = await serve(env.supabase);
    const authorize = async () => call(port, { path: `/auth/v1/authorize?${(await swAuthorize()).query.toString()}` });

    env.script({ authorize: "segurar" });
    const held = authorize();
    await expect.poll(() => env.state().segurados).toBe(1);
    expect(env.release()).toBe(1);
    const released = await held;
    expect(released.status).toBe(302);
    expect(String(released.headers.location)).toMatch(new RegExp(`^${REDIRECT.replaceAll(".", "\\.")}\\?code=CANARIO-CODE-`));
    expect(env.state().segurados).toBe(0);

    env.script({ authorize: "segurar" });
    const dropped = authorize();
    await expect.poll(() => env.state().segurados).toBe(1);
    env.reset();
    expect((await dropped).status).toBe(410);
    expect(env.state()).toMatchObject({ segurados: 0, requests: [] });
    expect(env.release()).toBe(0);
    // Sem roteiro depois do zerar: o próximo authorize responde na hora.
    expect((await authorize()).status).toBe(302);
  });
});

describe("P20: modo fixo por navegador (ADR-004 §4.4)", () => {
  test.each([
    ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "edge"],
    ["/usr/bin/microsoft-edge", "edge"],
    ["/usr/bin/microsoft-edge-beta", "edge"],
    ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "edge"],
    ["C:/Program Files/Google/Chrome/Application/chrome.exe", "chrome"],
    ["/usr/bin/google-chrome-stable", "chrome"],
    ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "chrome"],
    ["/usr/bin/chromium", undefined],
    ["/opt/brave/brave", undefined],
    ["C:/x/msedge.exe.bak", undefined],
  ])("%s é %s", (path, brand) => {
    expect(browserBrand(path)).toBe(brand);
  });

  test("Edge e Chrome no modo 1 (sondados no 05c-1); navegador sem modo fixado lança, nunca escolhe em runtime", () => {
    expect(P20_MODES).toEqual({ edge: 1, chrome: 1 });
    expect(Object.isFrozen(P20_MODES)).toBe(true);
    expect(p20ModeFor("msedge.exe")).toBe(1);
    expect(p20ModeFor("chrome.exe")).toBe(1);
    expect(() => p20ModeFor("/usr/bin/chromium")).toThrow(/sem modo do P20 fixado/);
  });
});
