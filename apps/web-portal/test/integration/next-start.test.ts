// Integração contra o `next start` de verdade (ADR-027 §4.2): o portal construído (`turbo test` depende do `build`),
// em 127.0.0.1, falando com o GoTrue simulado em socket real. Prova os cabeçalhos em toda resposta (SR-26), o fluxo
// pelas rotas e pelo proxy (SR-25) e que nada sensível sai na saída do processo (SR-12).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COOKIE_NAMES } from "../../src/server/cookies";
import { SECURITY_HEADERS } from "../../src/server/headers";
import { startFakeApi, type FakeApi } from "../support/fake-api";
import { GOTRUE_CANARIES, startFakeGotrue, type FakeGotrue } from "../support/fake-gotrue";

const APP = join(import.meta.dirname, "..", "..");
const NEXT_BIN = join(APP, "node_modules", "next", "dist", "bin", "next");
const PUBLISHABLE = ["sb", "publishable", "p".repeat(24)].join("_");

let fake: FakeGotrue;
let api: FakeApi;
let server: ChildProcess;
let portal = "";
let output = "";
/** Tudo que não pode aparecer na saída do processo nem no HTML. */
const secrets = new Set<string>(Object.values(GOTRUE_CANARIES).filter((value) => value !== GOTRUE_CANARIES.userId));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  if (!existsSync(join(APP, ".next", "BUILD_ID"))) throw new Error("rode o build do portal antes (o turbo test depende dele)");
  const port = await freePort();
  portal = `http://127.0.0.1:${port}`;
  fake = await startFakeGotrue({ publishableKey: PUBLISHABLE, allowedRedirects: [`${portal}/auth/retorno`] });
  // A API simulada (ADR-028 §4.2) aceita os access que o GoTrue simulado emitiu.
  api = await startFakeApi({ owner: (token) => (fake.issued.some((pair) => pair.accessToken === token) ? GOTRUE_CANARIES.userId : null) });
  server = spawn(process.execPath, [NEXT_BIN, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: APP,
    env: {
      PATH: process.env["PATH"],
      SYSTEMROOT: process.env["SYSTEMROOT"],
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      PORTAL_ORIGIN: portal,
      SUPABASE_URL: fake.url.origin,
      SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
      API_ORIGIN: api.url.origin,
      PORTAL_SEAL_KEYS: `a1:${randomBytes(32).toString("base64url")}`,
      PORTAL_SEAL_ACTIVE_KEY: "a1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  server.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(`${portal}/favicon.ico`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`o next start não subiu:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}, 90_000);

afterAll(async () => {
  server?.kill();
  await fake?.close();
  await api?.close();
});

beforeEach(() => {
  fake.mode = { kind: "normal" };
  fake.hookRefuses = false;
  fake.expiresIn = 900;
  fake.claims = {};
});

type Init = { readonly method?: string; readonly headers?: Record<string, string> };
const get = (path: string, init: Init = {}) => fetch(`${portal}${path}`, { redirect: "manual", method: init.method ?? "GET", headers: init.headers ?? {} });
const cookieValue = (response: Response, name: string): string | undefined =>
  response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] as string)
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1);

/** Login completo pelo portal e pelo simulado; devolve o cookie da sessão. */
async function login(): Promise<string> {
  const start = await get("/auth/entrar?provedor=github", { headers: { "sec-fetch-site": "same-origin" } });
  expect(start.status).toBe(303);
  const flow = cookieValue(start, COOKIE_NAMES.fluxo) as string;
  const authorize = await fetch(start.headers.get("location") as string, { redirect: "manual" });
  const back = new URL(authorize.headers.get("location") as string);
  secrets.add(back.searchParams.get("code") as string);
  const done = await get(back.pathname + back.search, { headers: { cookie: `${COOKIE_NAMES.fluxo}=${flow}` } });
  expect(done.status).toBe(303);
  expect(done.headers.get("location")).toBe(`${portal}/conta`);
  return cookieValue(done, COOKIE_NAMES.sessao) as string;
}

function expectSecurityHeaders(response: Response, where: string): void {
  for (const { key, value } of SECURITY_HEADERS) expect(response.headers.get(key), `${where}: ${key}`).toBe(value);
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp, where).toMatch(/^default-src 'self'; script-src 'self' 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic';/);
  expect(csp, where).toContain("frame-ancestors 'none'");
  // Uma CSP só: duas viriam juntas por vírgula.
  expect(csp.split("default-src").length, where).toBe(2);
  expect(response.headers.get("x-powered-by"), where).toBeNull();
}

describe("cabeçalhos em toda resposta (SR-26)", () => {
  it("página, rotas de auth, erro, 404, estático e favicon", async () => {
    const home = await get("/");
    const html = await home.text();
    const asset = /\/_next\/static\/[^"']+\.js/.exec(html)?.[0] as string;
    expect(asset).toBeDefined();
    const cases: Array<readonly [string, Promise<Response>, number]> = [
      ["/", Promise.resolve(home), 200],
      ["/conta sem sessão", get("/conta"), 307],
      ["/auth/entrar", get("/auth/entrar?provedor=github", { headers: { "sec-fetch-site": "same-origin" } }), 303],
      ["/auth/retorno", get("/auth/retorno?code=x&st=y"), 303],
      ["GET /auth/sair", get("/auth/sair"), 405],
      ["POST /auth/sair sem Origin", get("/auth/sair", { method: "POST" }), 403],
      ["404", get("/nao-existe"), 404],
      ["estático", get(asset), 200],
      ["favicon", get("/favicon.ico"), 200],
    ];
    for (const [where, pending, status] of cases) {
      const response = await pending;
      expect(response.status, where).toBe(status);
      expectSecurityHeaders(response, where);
    }
  });

  it("todo script da página e do 404 leva o nonce da CSP da própria resposta", async () => {
    for (const path of ["/", "/nao-existe"]) {
      const response = await get(path);
      const nonce = /'nonce-([^']+)'/.exec(response.headers.get("content-security-policy") ?? "")?.[1];
      const scripts = [...(await response.text()).matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
      expect(scripts.length, path).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag, path).toContain(`nonce="${nonce}"`);
    }
  });

  it("rotas de auth e a conta não vão para cache", async () => {
    expect((await get("/auth/retorno?code=x&st=y")).headers.get("cache-control")).toBe("no-store");
    const conta = await get("/conta", { headers: { cookie: `${COOKIE_NAMES.sessao}=${await login()}` } });
    expect(conta.headers.get("cache-control")).toContain("no-store");
  });
});

describe("fluxo pelas rotas e pelo proxy (SR-25)", () => {
  it("login, conta com a sessão e nenhum token no HTML", async () => {
    const session = await login();
    const conta = await get("/conta", { headers: { cookie: `${COOKIE_NAMES.sessao}=${session}` } });
    expect(conta.status).toBe(200);
    const html = await conta.text();
    expect(html).toContain("Você está conectado.");
    for (const secret of [...secrets, GOTRUE_CANARIES.userId, session]) expect(html).not.toContain(secret);
  });

  it("os Set-Cookie do login têm os atributos exatos", async () => {
    const start = await get("/auth/entrar?provedor=google", { headers: { "sec-fetch-site": "same-origin" } });
    expect(start.headers.getSetCookie()).toEqual([expect.stringMatching(/^__Host-trampo-fluxo=f1\.[^;]+; Path=\/; Max-Age=300; HttpOnly; Secure; SameSite=Lax$/)]);
  });

  it("início de outro site é recusado sem cookie", async () => {
    const start = await get("/auth/entrar?provedor=github", { headers: { "sec-fetch-site": "cross-site" } });
    expect(start.headers.get("location")).toBe(`${portal}/?aviso=entrada_recusada`);
    expect(start.headers.getSetCookie()).toEqual([]);
  });

  it("nenhum parâmetro muda o destino (sem open redirect)", async () => {
    for (const path of ["/auth/retorno?code=x&st=y&redirect_to=https://evil.invalid", "/auth/retorno?next=//evil.invalid", "/auth/entrar?provedor=github&redirect_to=https://evil.invalid"]) {
      const response = await get(path, { headers: { "sec-fetch-site": "same-origin", referer: "https://evil.invalid/" } });
      const location = response.headers.get("location") as string;
      expect(location.startsWith(`${portal}/`) || location.startsWith(`${fake.url.origin}/auth/v1/authorize?`), path).toBe(true);
      expect(location, path).not.toContain("evil.invalid");
    }
  });

  it("renovação pelo proxy e a recusa do hook virando 'entre de novo'", async () => {
    fake.expiresIn = 30;
    const session = await login();
    const renewed = await get("/conta", { headers: { cookie: `${COOKIE_NAMES.sessao}=${session}` } });
    expect(renewed.status).toBe(200);
    const next = cookieValue(renewed, COOKIE_NAMES.sessao) as string;
    expect(next).not.toBe(session);
    fake.hookRefuses = true;
    const refused = await get("/conta", { headers: { cookie: `${COOKIE_NAMES.sessao}=${next}` } });
    expect(refused.status).toBe(307);
    expect(refused.headers.get("location")).toBe("/?aviso=sessao_expirada");
    expect(refused.headers.getSetCookie()).toEqual([`${COOKIE_NAMES.sessao}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`]);
    const home = await (await get("/?aviso=sessao_expirada")).text();
    expect(home).toContain("Sua sessão expirou. Entre de novo.");
  });

  it("o 503 do GoTrue na renovação mantém o cookie (T30)", async () => {
    fake.expiresIn = 30;
    const session = await login();
    fake.mode = { kind: "responde", status: 503, body: "" };
    const response = await get("/", { headers: { cookie: `${COOKIE_NAMES.sessao}=${session}` } });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await response.text()).toContain("O serviço de login está indisponível agora.");
  });

  it("logout: Origin exato encerra a sessão no GoTrue; sem Origin, 403", async () => {
    const session = await login();
    const before = fake.liveSessions.size;
    const refused = await get("/auth/sair", { method: "POST", headers: { cookie: `${COOKIE_NAMES.sessao}=${session}`, "sec-fetch-site": "same-origin" } });
    expect(refused.status).toBe(403);
    expect(fake.liveSessions.size).toBe(before);
    const out = await get("/auth/sair", { method: "POST", headers: { cookie: `${COOKIE_NAMES.sessao}=${session}`, origin: portal, "sec-fetch-site": "same-origin" } });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe(`${portal}/?aviso=saiu`);
    expect(out.headers.getSetCookie()).toEqual([`${COOKIE_NAMES.sessao}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`]);
    expect(fake.liveSessions.size).toBe(before - 1);
  });
});

describe("SR-12", () => {
  it("nada sensível na saída do processo do portal", () => {
    expect(secrets.size).toBeGreaterThan(Object.keys(GOTRUE_CANARIES).length - 1);
    for (const secret of secrets) expect(output).not.toContain(secret);
  });
});
