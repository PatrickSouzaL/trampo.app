// Integração contra o `next start` de verdade (ADR-027 §4.2): o portal construído (`turbo test` depende do `build`),
// em 127.0.0.1, falando com o GoTrue simulado em socket real. Prova os cabeçalhos em toda resposta (SR-26), o fluxo
// pelas rotas e pelo proxy (SR-25) e que nada sensível sai na saída do processo (SR-12).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";

import { AccountExportSchema } from "@trampo/contracts/account";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COOKIE_NAMES } from "../../src/server/cookies";
import { criteriaToForm, formPairs, type FormValues } from "../../src/server/criteria-form";
import { SECURITY_HEADERS } from "../../src/server/headers";
import { SALARY_CANARY, SALARY_CANARY_TEXT, fullCriteria } from "../support/criteria-fixtures";
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
  api.mode = { kind: "normal" };
  api.deleteResult = "excluida";
  api.rows.clear();
  api.analyses.length = 0;
  api.feedback.length = 0;
  api.deletions.length = 0;
  api.requests.length = 0;
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

describe("critérios (ADR-028, SR-27)", () => {
  const FORM = "application/x-www-form-urlencoded";
  const SAVE = "/conta/criterios/salvar";
  const formBody = (values: FormValues): string => new URLSearchParams(formPairs(values)).toString();
  const save = (session: string, values: FormValues, headers: Record<string, string> = {}, path = SAVE) =>
    fetch(`${portal}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: `${COOKIE_NAMES.sessao}=${session}`, origin: portal, "sec-fetch-site": "same-origin", "content-type": FORM, ...headers },
      body: formBody(values),
    });
  const puts = () => api.requests.filter((request) => request.method === "PUT");

  it("a página e a rota: cabeçalhos uma vez cada, no-store e nonce em todo script", async () => {
    const session = await login();
    const page = await get("/conta/criterios", { headers: { cookie: `${COOKIE_NAMES.sessao}=${session}` } });
    expect(page.status).toBe(200);
    expectSecurityHeaders(page, "/conta/criterios");
    expect(page.headers.get("cache-control")).toContain("no-store");
    const nonce = /'nonce-([^']+)'/.exec(page.headers.get("content-security-policy") ?? "")?.[1];
    const html = await page.text();
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    // O formulário é POST para a rota fixa (sem JS próprio): a pretensão nunca vai a URL.
    const forms = [...html.matchAll(/<form\b[^>]*>/g)].map((match) => match[0]);
    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain('method="post"');
    expect(forms[0]).toContain('action="/conta/criterios/salvar"');
    const cases: Array<readonly [string, Promise<Response>, number]> = [
      ["POST sem Origin", get(SAVE, { method: "POST", headers: { cookie: `${COOKIE_NAMES.sessao}=${session}` } }), 403],
      ["GET da rota", get(SAVE), 405],
      ["/conta/criterios sem sessão", get("/conta/criterios"), 307],
    ];
    for (const [where, pending, status] of cases) {
      const response = await pending;
      expect(response.status, where).toBe(status);
      expectSecurityHeaders(response, where);
    }
    expect((await get("/conta/criterios")).headers.get("location")).toBe("/");
  });

  it("a /conta leva à página de critérios", async () => {
    const html = await (await get("/conta", { headers: { cookie: `${COOKIE_NAMES.sessao}=${await login()}` } })).text();
    expect(html).toMatch(/<a[^>]*href="\/conta\/criterios"[^>]*>Seus critérios<\/a>/);
  });

  it("quem nunca salvou vê os padrões; salvar e reabrir traz o valor salvo, só na página do dono", async () => {
    const session = await login();
    expect(await (await get("/conta/criterios", { headers: { cookie: `${COOKIE_NAMES.sessao}=${session}` } })).text()).toContain('data-origem="padroes"');
    const saved = await save(session, criteriaToForm(fullCriteria()));
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`${portal}/conta/criterios?aviso=criterios_salvos`);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    expect(api.rows.get(GOTRUE_CANARIES.userId)).toEqual(fullCriteria());
    const html = await (await get("/conta/criterios?aviso=criterios_salvos", { headers: { cookie: `${COOKIE_NAMES.sessao}=${session}` } })).text();
    expect(html).toContain("Critérios salvos.");
    expect(html).toContain('data-origem="salvos"');
    expect(html).toContain(`value="${String(fullCriteria().salary?.minimum)}"`);
  });

  it("a API recebe só a lista fechada de cabeçalhos, mesmo com o navegador mandando cookie, Referer e X-Forwarded-For", async () => {
    const session = await login();
    const browser = { cookie: `outro=1; ${COOKIE_NAMES.sessao}=${session}`, referer: `${portal}/conta/criterios`, "x-forwarded-for": "203.0.113.9", "user-agent": "CANARIO-UA" };
    expect((await save(session, criteriaToForm(fullCriteria()), browser)).status).toBe(303);
    await get("/conta/criterios", { headers: browser });
    expect(api.requests.map((request) => request.method)).toEqual(["PUT", "GET"]);
    for (const request of api.requests) {
      for (const name of ["cookie", "origin", "referer", "x-forwarded-for", "x-real-ip", "forwarded", "apikey"]) expect(request.headers[name], `${request.method} ${name}`).toBeUndefined();
      expect(request.headers["user-agent"]).not.toContain("CANARIO");
      expect(request.headers["authorization"]).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    }
  });

  it.each([
    ["sem Origin", { origin: "" }],
    ["outra origem", { origin: "https://evil.invalid" }],
    ["Origin null", { origin: "null" }],
    ["cross-site", { "sec-fetch-site": "cross-site" }],
    ["sem Sec-Fetch-Site", { "sec-fetch-site": "" }],
  ])("CSRF (%s): 403, nenhum cookie e nenhuma chamada à API", async (_caso, over) => {
    const session = await login();
    const headers = Object.fromEntries(Object.entries({ cookie: `${COOKIE_NAMES.sessao}=${session}`, origin: portal, "sec-fetch-site": "same-origin", "content-type": FORM, ...over }).filter(([, value]) => value !== ""));
    const response = await fetch(`${portal}${SAVE}`, { method: "POST", redirect: "manual", headers, body: formBody(criteriaToForm(fullCriteria())) });
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(api.requests).toHaveLength(0);
  });

  it("o 503 do PUT volta com o rascunho selado; a página o mostra uma vez e o apaga", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" };
    const values = { ...criteriaToForm(fullCriteria()), notes: ["RASCUNHO-DE-TESTE"] };
    const failed = await save(session, values);
    expect(failed.headers.get("location")).toBe(`${portal}/conta/criterios?aviso=criterios_nao_confirmados`);
    const draft = failed.headers.getSetCookie().find((line) => line.startsWith(`${COOKIE_NAMES.rascunho}=`)) as string;
    expect(draft).toMatch(/^__Host-trampo-rascunho=r1\.[^;]+; Path=\/; Max-Age=120; HttpOnly; Secure; SameSite=Lax$/);
    expect(draft).not.toContain(SALARY_CANARY_TEXT);
    expect(puts()).toHaveLength(1);
    const page = await get("/conta/criterios?aviso=criterios_nao_confirmados", { headers: { cookie: `${COOKIE_NAMES.sessao}=${session}; ${draft.split(";")[0] as string}` } });
    const html = await page.text();
    expect(html).toContain('data-origem="rascunho"');
    expect(html).toContain("RASCUNHO-DE-TESTE");
    expect(page.headers.getSetCookie()).toEqual([`${COOKIE_NAMES.rascunho}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`]);
  });

  it("erro de validação: os campos marcados com o texto do catálogo, sem o texto do Zod nem a rede", async () => {
    const session = await login();
    const failed = await save(session, { ...criteriaToForm(fullCriteria()), "stack.dealBreakers": ["TypeScript"] });
    expect(failed.headers.get("location")).toBe(`${portal}/conta/criterios?aviso=criterios_invalidos`);
    expect(api.requests).toHaveLength(0);
    const draft = (failed.headers.getSetCookie()[0] as string).split(";")[0] as string;
    const html = await (await get("/conta/criterios?aviso=criterios_invalidos", { headers: { cookie: `${COOKIE_NAMES.sessao}=${session}; ${draft}` } })).text();
    expect(html).toContain('data-campo="stack"');
    expect(html).toContain("Tecnologias: até 15 obrigatórias");
    expect(html).not.toMatch(/tecnologia_em_mais_de_uma_lista|Invalid|expected/);
  });

  it("formulário fora do tipo: formulario_recusado, sem rede e sem rascunho", async () => {
    const session = await login();
    const response = await save(session, criteriaToForm(fullCriteria()), { "content-type": "text/plain" });
    expect(response.headers.get("location")).toBe(`${portal}/conta/criterios?aviso=formulario_recusado`);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(api.requests).toHaveLength(0);
  });

  it("nenhum parâmetro ou cabeçalho muda o destino da gravação (sem open redirect)", async () => {
    const session = await login();
    for (const path of [`${SAVE}?redirect_to=https://evil.invalid`, `${SAVE}?next=//evil.invalid`, `${SAVE}?aviso=../../evil`]) {
      const response = await save(session, criteriaToForm(fullCriteria()), { referer: "https://evil.invalid/" }, path);
      const location = response.headers.get("location") as string;
      expect(location.startsWith(`${portal}/conta/criterios?aviso=`), path).toBe(true);
      expect(location, path).not.toContain("evil");
    }
  });

  it("a API fora na leitura: a página diz indisponível e não mostra o formulário de padrões", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" };
    const html = await (await get("/conta/criterios", { headers: { cookie: `${COOKIE_NAMES.sessao}=${session}` } })).text();
    expect(html).toContain('data-criterios="indisponivel"');
    expect(html).not.toContain("<form");
  });
});

describe("sair de todos os dispositivos (ADR-027 §9.3)", () => {
  const PAGE = "/conta/sair-de-tudo";
  const ROUTE = "/auth/sair-de-tudo";
  const CLEARED = [`${COOKIE_NAMES.sessao}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`];
  const post = (path: string, session: string | null, over: Record<string, string> = {}, body?: string) => {
    const headers = Object.fromEntries(
      Object.entries({ ...(session === null ? {} : { cookie: `${COOKIE_NAMES.sessao}=${session}` }), origin: portal, "sec-fetch-site": "same-origin", ...over }).filter(([, value]) => value !== ""),
    );
    return fetch(`${portal}${path}`, { method: "POST", redirect: "manual", headers, ...(body === undefined ? {} : { body }) });
  };
  const logoutCalls = () => fake.requests.filter((request) => request.url.startsWith("/auth/v1/logout"));
  const withSession = (session: string) => ({ headers: { cookie: `${COOKIE_NAMES.sessao}=${session}` } });

  beforeEach(() => {
    fake.requests.length = 0;
    fake.logouts.length = 0;
  });

  it("(8) a página e a rota: cabeçalhos uma vez cada, no-store e nonce em todo script", async () => {
    const session = await login();
    const page = await get(PAGE, withSession(session));
    expect(page.status).toBe(200);
    expectSecurityHeaders(page, PAGE);
    expect(page.headers.get("cache-control")).toContain("no-store");
    const nonce = /'nonce-([^']+)'/.exec(page.headers.get("content-security-policy") ?? "")?.[1];
    const html = await page.text();
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    const cases: Array<readonly [string, Promise<Response>, number]> = [
      ["POST com Origin", post(ROUTE, session), 303],
      ["POST sem Origin", post(ROUTE, session, { origin: "" }), 403],
      ["GET da rota", get(ROUTE), 405],
      ["a página sem sessão", get(PAGE), 307],
    ];
    for (const [where, pending, status] of cases) {
      const response = await pending;
      expect(response.status, where).toBe(status);
      expectSecurityHeaders(response, where);
      if (status !== 405 && status !== 307) expect(response.headers.get("cache-control"), where).toBe("no-store");
    }
  });

  it("(4) a página de confirmação tem o próprio formulário e o Voltar; abrir a página não encerra nada", async () => {
    const session = await login();
    const live = fake.liveSessions.size;
    fake.requests.length = 0;
    const html = await (await get(PAGE, withSession(session))).text();
    const forms = [...html.matchAll(/<form\b[^>]*>/g)].map((match) => match[0]);
    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain('method="post"');
    expect(forms[0]).toContain('action="/auth/sair-de-tudo"');
    // Sem campo que escolha o escopo: o formulário só tem o botão.
    expect(html).not.toMatch(/<input\b/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Sair de todos os dispositivos<\/button>/);
    expect(html).toMatch(/<a[^>]*href="\/conta"[^>]*>Voltar para a sua conta<\/a>/);
    expect(html).toContain("em até 15 minutos");
    // O GET (e o HEAD) da página nunca chama o logout, e a sessão segue viva.
    await fetch(`${portal}${PAGE}`, { method: "HEAD", redirect: "manual", headers: { cookie: `${COOKIE_NAMES.sessao}=${session}` } });
    expect(logoutCalls()).toHaveLength(0);
    expect(fake.liveSessions.size).toBe(live);
    expect((await get("/conta", withSession(session))).status).toBe(200);
  });

  it("(4) sem sessão, a página de confirmação vai para a página inicial, sem formulário", async () => {
    const response = await get(PAGE);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/");
    expect(await response.text()).not.toContain('action="/auth/sair-de-tudo"');
    const garbage = await get(PAGE, withSession("s1.a1.AAAA.BBBB.CCCC"));
    expect(garbage.status).toBe(307);
    expect(logoutCalls()).toHaveLength(0);
  });

  it("a /conta leva à página de confirmação por link, e o único formulário dela é o Sair comum", async () => {
    const html = await (await get("/conta", withSession(await login()))).text();
    expect(html).toMatch(/<a[^>]*href="\/conta\/sair-de-tudo"[^>]*>Sair de todos os dispositivos<\/a>/);
    const forms = [...html.matchAll(/<form\b[^>]*>/g)].map((match) => match[0]);
    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain('action="/auth/sair"');
    expect(html).not.toContain("/auth/sair-de-tudo");
  });

  it("(1, 6) o sair de tudo pede o global: a 2ª sessão do usuário cai na renovação seguinte, em 'Sua sessão expirou'", async () => {
    fake.expiresIn = 30;
    const first = await login();
    const second = await login();
    expect((await get("/conta", withSession(second))).status).toBe(200);
    fake.requests.length = 0;
    const out = await post(ROUTE, first);
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe(`${portal}/?aviso=saiu_de_tudo`);
    expect(out.headers.getSetCookie()).toEqual(CLEARED);
    expect(logoutCalls().map((request) => `${request.method} ${request.url}`)).toEqual(["POST /auth/v1/logout?scope=global"]);
    expect(fake.logouts.map((logout) => logout.scope)).toEqual(["global"]);
    // A 2ª sessão faz o papel da extensão: o access dela está no fim, e a renovação é recusada.
    const dropped = await get("/conta", withSession(second));
    expect(dropped.status).toBe(307);
    expect(dropped.headers.get("location")).toBe("/?aviso=sessao_expirada");
    expect(dropped.headers.getSetCookie()).toEqual(CLEARED);
    const home = await (await get("/?aviso=saiu_de_tudo")).text();
    expect(home).toContain("Você saiu de todos os dispositivos. A extensão e os outros navegadores param de funcionar em até 15 minutos.");
  });

  it("(1, 6) o Sair comum pede o local: a 2ª sessão continua viva e renova", async () => {
    fake.expiresIn = 30;
    const first = await login();
    const second = await login();
    fake.requests.length = 0;
    const out = await post("/auth/sair", first);
    expect(out.headers.get("location")).toBe(`${portal}/?aviso=saiu`);
    expect(logoutCalls().map((request) => request.url)).toEqual(["/auth/v1/logout?scope=local"]);
    expect(fake.logouts.map((logout) => logout.scope)).toEqual(["local"]);
    const alive = await get("/conta", withSession(second));
    expect(alive.status).toBe(200);
    expect(cookieValue(alive, COOKIE_NAMES.sessao)).toMatch(/^s1\./);
  });

  it("(2) nada do pedido escolhe o escopo: query, corpo e cabeçalhos hostis não mudam o endereço chamado", async () => {
    const hostile = { "content-type": "application/x-www-form-urlencoded", "x-scope": "local", "x-http-method-override": "GET", referer: "https://evil.invalid/?scope=local" };
    const everywhere = await post(`${ROUTE}?scope=local&escopo=local`, await login(), hostile, "scope=local&escopo=local");
    expect(everywhere.headers.get("location")).toBe(`${portal}/?aviso=saiu_de_tudo`);
    expect(logoutCalls().map((request) => request.url)).toEqual(["/auth/v1/logout?scope=global"]);
    fake.requests.length = 0;
    const common = await post("/auth/sair?scope=global", await login(), { ...hostile, "x-scope": "global" }, "scope=global");
    expect(common.headers.get("location")).toBe(`${portal}/?aviso=saiu`);
    expect(logoutCalls().map((request) => request.url)).toEqual(["/auth/v1/logout?scope=local"]);
  });

  it.each([
    ["sem Origin", { origin: "" }],
    ["outra origem", { origin: "https://evil.invalid" }],
    ["Origin null", { origin: "null" }],
    ["cross-site", { "sec-fetch-site": "cross-site" }],
    ["same-site", { "sec-fetch-site": "same-site" }],
    ["sem Sec-Fetch-Site", { "sec-fetch-site": "" }],
  ])("(3) CSRF (%s): 403, cookie intacto e nenhuma chamada ao GoTrue", async (_caso, over) => {
    const session = await login();
    const live = fake.liveSessions.size;
    fake.requests.length = 0;
    const response = await post(ROUTE, session, over);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Proibido.");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(fake.requests).toHaveLength(0);
    expect(fake.liveSessions.size).toBe(live);
  });

  it("(3) o GET da rota dá 405 e não encerra nada, com ou sem o Origin", async () => {
    const session = await login();
    const live = fake.liveSessions.size;
    fake.requests.length = 0;
    for (const headers of [{}, { origin: portal, "sec-fetch-site": "same-origin" }]) {
      const response = await get(ROUTE, { headers: { cookie: `${COOKIE_NAMES.sessao}=${session}`, ...headers } });
      expect(response.status).toBe(405);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(fake.requests).toHaveLength(0);
    expect(fake.liveSessions.size).toBe(live);
  });

  it.each([
    ["403 session_not_found", { kind: "responde", status: 403, body: JSON.stringify({ error_code: "session_not_found" }) }],
    ["401", { kind: "responde", status: 401, body: JSON.stringify({ error_code: "no_authorization" }) }],
    ["429", { kind: "responde", status: 429, body: "" }],
    ["503", { kind: "responde", status: 503, body: "" }],
    ["redirecionamento", { kind: "redireciona", location: "http://127.0.0.1:1/" }],
    ["resposta cortada", { kind: "corta" }],
  ] as const)("(5, 7) %s: o cookie some, o aviso não promete nada e há um POST só", async (_caso, mode) => {
    const session = await login();
    fake.requests.length = 0;
    fake.mode = mode;
    const out = await post(ROUTE, session);
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe(`${portal}/?aviso=saiu_sem_confirmar`);
    expect(out.headers.getSetCookie()).toEqual(CLEARED);
    expect(fake.requests.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /auth/v1/logout?scope=global"]);
    fake.mode = { kind: "normal" };
    const home = await (await get("/?aviso=saiu_sem_confirmar")).text();
    expect(home).toContain("não conseguimos confirmar a saída dos outros dispositivos");
    expect(home).not.toContain("Você saiu de todos os dispositivos");
  });

  it("(5) sem sessão que abra: o cookie some, sem rede e sem prometer", async () => {
    for (const session of [null, "s1.a1.AAAA.BBBB.CCCC"]) {
      const out = await post(ROUTE, session);
      expect(out.headers.get("location")).toBe(`${portal}/?aviso=saiu_sem_confirmar`);
      expect(out.headers.getSetCookie()).toEqual(CLEARED);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("(8) nenhum parâmetro ou cabeçalho muda o destino (sem open redirect)", async () => {
    for (const path of [`${ROUTE}?redirect_to=https://evil.invalid`, `${ROUTE}?next=//evil.invalid`, `${ROUTE}?aviso=../../evil`]) {
      const response = await post(path, await login(), { referer: "https://evil.invalid/" });
      expect(response.headers.get("location"), path).toBe(`${portal}/?aviso=saiu_de_tudo`);
    }
    for (const path of [`${PAGE}?redirect_to=https://evil.invalid`, `${PAGE}?next=//evil.invalid`]) {
      const response = await get(path, { headers: { referer: "https://evil.invalid/" } });
      expect(response.headers.get("location"), path).toBe("/");
    }
  });
});

describe("exportar e excluir a conta (ADR-029 D9, SR-16 e SR-28)", () => {
  const DADOS = "/conta/dados";
  const EXPORTAR = "/conta/dados/exportar";
  const EXCLUIR = "/conta/dados/excluir";
  const CONFIRMAR = "/conta/dados/excluir/confirmar";
  const FORM = "application/x-www-form-urlencoded";
  const PHRASE = "excluir minha conta";
  const ANALYSIS = { id: "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b", createdAt: "2026-11-15T11:00:00.000Z", decisionPath: "extracao_llm", verdict: "neutro", score: 50 } as const;
  const CLEARED = [
    `${COOKIE_NAMES.sessao}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    `${COOKIE_NAMES.rascunho}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  ];
  const withSession = (session: string) => ({ headers: { cookie: `${COOKIE_NAMES.sessao}=${session}` } });
  const post = (path: string, session: string | null, over: Record<string, string> = {}, body?: string) => {
    const headers = Object.fromEntries(
      Object.entries({ ...(session === null ? {} : { cookie: `${COOKIE_NAMES.sessao}=${session}` }), origin: portal, "sec-fetch-site": "same-origin", ...over }).filter(([, value]) => value !== ""),
    );
    return fetch(`${portal}${path}`, { method: "POST", redirect: "manual", headers, ...(body === undefined ? {} : { body }) });
  };
  const confirm = (session: string | null, typed: string = PHRASE, over: Record<string, string> = {}, path = CONFIRMAR, extra = "") =>
    post(path, session, { "content-type": FORM, ...over }, `${new URLSearchParams({ confirmacao: typed }).toString()}${extra}`);
  const deletes = () => api.requests.filter((request) => request.method === "POST");
  const forms = (html: string) => [...html.matchAll(/<form\b[^>]*>/g)].map((match) => match[0]);
  const inputs = (html: string) => [...html.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);

  it("(13) as páginas e as rotas: cabeçalhos uma vez cada, no-store, nonce em todo script e os status de cada caminho", async () => {
    const session = await login();
    for (const path of [DADOS, EXCLUIR]) {
      const page = await get(path, withSession(session));
      expect(page.status, path).toBe(200);
      expectSecurityHeaders(page, path);
      expect(page.headers.get("cache-control"), path).toContain("no-store");
      const nonce = /'nonce-([^']+)'/.exec(page.headers.get("content-security-policy") ?? "")?.[1];
      const scripts = [...(await page.text()).matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
      expect(scripts.length, path).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag, path).toContain(`nonce="${nonce}"`);
    }
    const cases: Array<readonly [string, Promise<Response>, number]> = [
      ["/conta/dados sem sessão", get(DADOS), 307],
      ["/conta/dados/excluir sem sessão", get(EXCLUIR), 307],
      ["GET da exportação", get(EXPORTAR, withSession(session)), 405],
      ["GET da confirmação", get(CONFIRMAR, withSession(session)), 405],
      ["POST da exportação sem Origin", post(EXPORTAR, session, { origin: "" }), 403],
      ["POST da confirmação sem Origin", confirm(session, PHRASE, { origin: "" }), 403],
      ["POST da exportação", post(EXPORTAR, session), 200],
      ["POST da confirmação com a frase errada", confirm(session, "errada"), 303],
    ];
    for (const [where, pending, status] of cases) {
      const response = await pending;
      expect(response.status, where).toBe(status);
      expectSecurityHeaders(response, where);
    }
    for (const path of [DADOS, EXCLUIR]) expect((await get(path)).headers.get("location"), path).toBe("/");
    // Os GET nas rotas não exportaram nem excluíram nada.
    expect(api.deletions).toEqual([]);
  });

  it("(14) a /conta leva aos dados por link; a página de dados só posta na exportação, e a exclusão é um link", async () => {
    const session = await login();
    const conta = await (await get("/conta", withSession(session))).text();
    expect(conta).toMatch(/<a[^>]*href="\/conta\/dados"[^>]*>Seus dados<\/a>/);
    const html = await (await get(DADOS, withSession(session))).text();
    expect(forms(html)).toHaveLength(1);
    expect(forms(html)[0]).toContain('method="post"');
    expect(forms(html)[0]).toContain('action="/conta/dados/exportar"');
    expect(inputs(html)).toEqual([]);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Baixar meus dados<\/button>/);
    expect(html).toMatch(/<a[^>]*href="\/conta\/dados\/excluir"[^>]*>Excluir minha conta<\/a>/);
    expect(html).not.toContain("/conta/dados/excluir/confirmar");
    expect(html).toContain("não entram no arquivo");
    // Abrir as duas páginas não chama a API.
    await get(EXCLUIR, withSession(session));
    expect(api.requests).toHaveLength(0);
  });

  it("(14) a página de confirmação: um formulário só, com um campo só, a frase a digitar e os avisos de que não há volta", async () => {
    const session = await login();
    const html = await (await get(EXCLUIR, withSession(session))).text();
    expect(forms(html)).toHaveLength(1);
    expect(forms(html)[0]).toContain('method="post"');
    expect(forms(html)[0]).toContain('action="/conta/dados/excluir/confirmar"');
    expect(inputs(html)).toHaveLength(1);
    expect(inputs(html)[0]).toContain('name="confirmacao"');
    expect(inputs(html)[0]).toContain('type="text"');
    expect(inputs(html)[0]).not.toContain("value=");
    expect(html).toContain("Para confirmar, digite a frase: excluir minha conta");
    expect(html).toContain("Não há como desfazer.");
    expect(html).toContain("em até 15 minutos");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Excluir minha conta definitivamente<\/button>/);
    expect(html).toMatch(/<a[^>]*href="\/conta\/dados"[^>]*>Voltar para os seus dados<\/a>/);
    expect(html).not.toContain('data-excluir="login-antigo"');
  });

  it("(SR-28) a exportação: o JSON do contrato como anexo, com a pretensão, sem cache, e a API só recebe a lista fechada de cabeçalhos", async () => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    api.analyses.push(ANALYSIS);
    const browser = { cookie: `outro=1; ${COOKIE_NAMES.sessao}=${session}`, referer: `${portal}/conta/dados`, "x-forwarded-for": "203.0.113.9", "user-agent": "CANARIO-UA" };
    const response = await post(EXPORTAR, session, browser);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="trampo-meus-dados.json"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("location")).toBeNull();
    const document = AccountExportSchema.parse(JSON.parse(await response.text()));
    expect(document.criteria).toEqual(fullCriteria());
    expect(document.criteria?.salary?.minimum).toBe(SALARY_CANARY);
    expect(document.analyses).toEqual([ANALYSIS]);
    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /v1/account/export"]);
    const [request] = api.requests;
    for (const name of ["cookie", "origin", "referer", "x-forwarded-for", "x-real-ip", "forwarded", "apikey", "content-type"]) expect(request?.headers[name], name).toBeUndefined();
    expect(request?.headers["user-agent"]).not.toContain("CANARIO");
    expect(request?.headers["authorization"]).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("a exportação que falha: 303 para o aviso do catálogo, sem arquivo e sem dado na URL", async () => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    api.mode = { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" };
    const response = await post(EXPORTAR, session);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${portal}/conta/dados?aviso=exportacao_indisponivel`);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.text()).toBe("");
    api.mode = { kind: "normal" };
    const html = await (await get(`${DADOS}?aviso=exportacao_indisponivel`, withSession(session))).text();
    expect(html).toContain("Não deu para gerar o arquivo agora.");
    expect(html).not.toContain(SALARY_CANARY_TEXT);
    // Aviso de outro catálogo não vira texto nesta página.
    expect(await (await get(`${DADOS}?aviso=conta_excluida`, withSession(session))).text()).not.toContain('role="status"');
  });

  it.each([
    ["sem Origin", { origin: "" }],
    ["outra origem", { origin: "https://evil.invalid" }],
    ["Origin null", { origin: "null" }],
    ["cross-site", { "sec-fetch-site": "cross-site" }],
    ["same-site", { "sec-fetch-site": "same-site" }],
    ["sem Sec-Fetch-Site", { "sec-fetch-site": "" }],
  ])("(13) CSRF (%s): 403 nas duas rotas, nenhum cookie e nenhuma chamada à API", async (_caso, over) => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    for (const response of [await post(EXPORTAR, session, over), await confirm(session, PHRASE, over)]) {
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Proibido.");
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(api.requests).toHaveLength(0);
    expect(api.rows.size).toBe(1);
  });

  it("(15) excluir com a frase certa: um POST na API, os cookies apagados, e a página inicial diz que a conta foi excluída", async () => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    const response = await confirm(session);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${portal}/?aviso=conta_excluida`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual(CLEARED);
    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /v1/account/delete"]);
    expect(JSON.parse(deletes()[0]?.body ?? "")).toEqual({ schemaVersion: 1, confirmation: PHRASE });
    for (const name of ["cookie", "origin", "referer", "x-forwarded-for"]) expect(deletes()[0]?.headers[name], name).toBeUndefined();
    expect(api.deletions).toEqual([GOTRUE_CANARIES.userId]);
    expect(api.rows.size).toBe(0);
    const home = await (await get("/?aviso=conta_excluida")).text();
    expect(home).toContain("Sua conta e os seus dados foram excluídos.");
  });

  it.each([["errada"], [""], ["excluir"], ["excluir minha conta agora"]])("(14) a frase %j não chega à API: volta para a confirmação com o aviso, sem cookie", async (typed) => {
    const session = await login();
    const response = await confirm(session, typed);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${portal}/conta/dados/excluir?aviso=exclusao_frase_errada`);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(api.requests).toHaveLength(0);
    const html = await (await get(`${EXCLUIR}?aviso=exclusao_frase_errada`, withSession(session))).text();
    expect(html).toContain("A frase de confirmação não confere.");
  });

  it("(14) campo a mais, campo repetido e corpo de outro tipo não chegam à API", async () => {
    const session = await login();
    const attempts = [
      await confirm(session, PHRASE, {}, CONFIRMAR, "&confirmacao=excluir+minha+conta"),
      await confirm(session, PHRASE, {}, CONFIRMAR, "&user_id=outro"),
      await confirm(session, PHRASE, { "content-type": "application/json" }),
      await post(CONFIRMAR, session, { "content-type": FORM }),
    ];
    for (const response of attempts) expect(response.headers.get("location")).toBe(`${portal}/conta/dados/excluir?aviso=exclusao_frase_errada`);
    expect(api.requests).toHaveLength(0);
  });

  it("(15) o banco diz login antigo: aviso próprio, a sessão fica e nada some", async () => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    api.deleteResult = "login_antigo";
    const response = await confirm(session);
    expect(response.headers.get("location")).toBe(`${portal}/conta/dados?aviso=exclusao_pede_login`);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(api.rows.size).toBe(1);
    expect(deletes()).toHaveLength(1);
    const html = await (await get(`${DADOS}?aviso=exclusao_pede_login`, withSession(session))).text();
    expect(html).toContain("a exclusão só vale nos 10 minutos depois de entrar");
    expect(html).toContain("Nada foi excluído.");
  });

  it.each([
    ["503", { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" }, "exclusao_nao_confirmada", "Não conseguimos confirmar a exclusão."],
    ["resposta cortada", { kind: "corta" }, "exclusao_nao_confirmada", "Não conseguimos confirmar a exclusão."],
    ["429", { kind: "responde", status: 429, code: "LIMITE_DE_TAXA", retryAfter: 9 }, "exclusao_indisponivel", "Nada foi excluído."],
    ["redirecionamento", { kind: "redireciona", location: "http://127.0.0.1:1/" }, "exclusao_indisponivel", "Nada foi excluído."],
  ] as const)("(15) %s na exclusão: %s, a sessão fica, um POST só, e o texto não promete o que não confirmou", async (_caso, mode, notice, text) => {
    const session = await login();
    api.mode = mode;
    const response = await confirm(session);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${portal}/conta/dados?aviso=${notice}`);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(deletes()).toHaveLength(1);
    api.mode = { kind: "normal" };
    const html = await (await get(`${DADOS}?aviso=${notice}`, withSession(session))).text();
    expect(html).toContain(text);
    expect(html).not.toContain("foram excluídos");
    if (notice === "exclusao_nao_confirmada") expect(html).not.toContain("Nada foi excluído.");
  });

  it("(15) o 401 da API: com o GoTrue recusando a renovação, a página inicial com 'Sua sessão expirou'; aceitando, indisponível com a sessão renovada", async () => {
    const refused = await login();
    api.mode = { kind: "responde", status: 401, code: "NAO_AUTENTICADO" };
    fake.hookRefuses = true;
    const gone = await confirm(refused);
    expect(gone.headers.get("location")).toBe(`${portal}/?aviso=sessao_expirada`);
    expect(gone.headers.getSetCookie()).toEqual([`${COOKIE_NAMES.sessao}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`]);
    fake.hookRefuses = false;
    api.requests.length = 0;
    const kept = await confirm(await login());
    expect(kept.headers.get("location")).toBe(`${portal}/conta/dados?aviso=exclusao_indisponivel`);
    expect(cookieValue(kept, COOKIE_NAMES.sessao)).toMatch(/^s1\./);
    expect(deletes()).toHaveLength(1);
  });

  it("sem sessão: as duas rotas vão para a página inicial, sem chamar a API", async () => {
    for (const response of [await post(EXPORTAR, null), await confirm(null)]) {
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${portal}/`);
    }
    expect(api.requests).toHaveLength(0);
  });

  it("nenhum parâmetro ou cabeçalho muda o destino nem o alvo (sem open redirect)", async () => {
    for (const query of ["?redirect_to=https://evil.invalid", "?next=//evil.invalid", "?aviso=../../evil", "?user_id=outro&uid=outro"]) {
      const removed = await confirm(await login(), PHRASE, { referer: "https://evil.invalid/", "x-user-id": "outro" }, `${CONFIRMAR}${query}`);
      expect(removed.headers.get("location"), query).toBe(`${portal}/?aviso=conta_excluida`);
      const failed = await confirm(await login(), "errada", { referer: "https://evil.invalid/" }, `${CONFIRMAR}${query}`);
      expect(failed.headers.get("location"), query).toBe(`${portal}/conta/dados/excluir?aviso=exclusao_frase_errada`);
    }
    expect(new Set(api.deletions)).toEqual(new Set([GOTRUE_CANARIES.userId]));
    for (const path of [`${DADOS}?redirect_to=https://evil.invalid`, `${EXCLUIR}?next=//evil.invalid`]) {
      expect((await get(path, { headers: { referer: "https://evil.invalid/" } })).headers.get("location"), path).toBe("/");
    }
  });
});

describe("SR-12", () => {
  it("nada sensível na saída do processo do portal", () => {
    expect(secrets.size).toBeGreaterThan(Object.keys(GOTRUE_CANARIES).length - 1);
    for (const secret of secrets) expect(output).not.toContain(secret);
    // ADR-028 condição 10: a pretensão nunca vai a log.
    expect(output).not.toContain(SALARY_CANARY_TEXT);
    expect(output).not.toContain("RASCUNHO-DE-TESTE");
  });
});
