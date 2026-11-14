import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resetPortalConfigForTests } from "../../src/server/config";
import { COOKIE_NAMES } from "../../src/server/cookies";
import { SESSION_STATE_HEADER, handleProxy, isPageRequest, toResponse } from "../../src/server/edge";
import { getPortalAuth, getPortalCriteria, resetPortalAuthForTests, runInBackground } from "../../src/server/runtime";
import type { PortalAuth, ResolvedSession } from "../../src/server/session";

const PORTAL = "https://portal.exemplo.invalid";

afterEach(() => {
  vi.unstubAllEnvs();
  resetPortalConfigForTests();
  resetPortalAuthForTests();
});

function stubEnv(): void {
  vi.stubEnv("PORTAL_ORIGIN", PORTAL);
  vi.stubEnv("SUPABASE_URL", "https://projeto.supabase.invalid");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", ["sb", "publishable", "x".repeat(20)].join("_"));
  vi.stubEnv("API_ORIGIN", "https://api.exemplo.invalid");
  vi.stubEnv("PORTAL_SEAL_KEYS", `a1:${randomBytes(32).toString("base64url")}`);
  vi.stubEnv("PORTAL_SEAL_ACTIVE_KEY", "a1");
}

function fakeAuth(resolved: ResolvedSession): PortalAuth & { calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  const unused = () => Promise.reject(new Error("não usado"));
  return {
    calls,
    startLogin: unused,
    completeLogin: unused,
    readSession: unused,
    logout: unused,
    apiAccess: unused,
    resolveSession: (cookie) => {
      calls.push(cookie);
      return Promise.resolve(resolved);
    },
  };
}

describe("isPageRequest (ADR-027 D6)", () => {
  it.each([
    ["GET", "/", true],
    ["GET", "/conta", true],
    ["HEAD", "/conta", false],
    ["POST", "/conta", false],
    ["GET", "/auth/entrar", false],
    ["GET", "/auth", true],
    ["GET", "/_next/static/chunks/a.js", false],
    ["GET", "/favicon.ico", false],
    ["GET", "/pasta.v2/pagina", true],
  ])("%s %s: %s", (method, pathname, expected) => {
    expect(isPageRequest(method, pathname)).toBe(expected);
  });
});

describe("handleProxy (ADR-027 D6 e D8)", () => {
  const input = (overrides: Partial<Parameters<typeof handleProxy>[0]> = {}): Parameters<typeof handleProxy>[0] => ({
    method: "GET",
    pathname: "/conta",
    headers: new Headers({ cookie: `a=1; ${COOKIE_NAMES.sessao}=velho`, [SESSION_STATE_HEADER]: "ativa", "content-security-policy": "forjada" }),
    nonce: "N0NCE",
    https: true,
    dev: false,
    auth: fakeAuth({ state: "ativa" }),
    ...overrides,
  });

  it("CSP com o nonce no pedido e na resposta; o x-trampo-sessao do cliente nunca passa", async () => {
    const result = await handleProxy(input({ method: "POST", pathname: "/auth/sair" }));
    expect(result.requestHeaders.get("content-security-policy")).toContain("'nonce-N0NCE'");
    expect(result.requestHeaders.get("x-nonce")).toBe("N0NCE");
    expect(result.requestHeaders.get(SESSION_STATE_HEADER)).toBeNull();
    expect(result.responseHeaders).toEqual([["Content-Security-Policy", result.requestHeaders.get("content-security-policy")]]);
  });

  it("página: o estado da sessão vai à página e nada muda sem cookie novo", async () => {
    const auth = fakeAuth({ state: "ativa" });
    const result = await handleProxy(input({ auth }));
    expect(auth.calls).toEqual(["velho"]);
    expect(result.requestHeaders.get(SESSION_STATE_HEADER)).toBe("ativa");
    expect(result.requestHeaders.get("cookie")).toBe(`a=1; ${COOKIE_NAMES.sessao}=velho`);
    expect(result.responseHeaders).toHaveLength(1);
  });

  it("renovada: troca o cookie do pedido e grava o da resposta", async () => {
    const result = await handleProxy(input({ auth: fakeAuth({ state: "ativa", cookie: { name: COOKIE_NAMES.sessao, value: "novo", maxAge: 100 } }) }));
    expect(result.requestHeaders.get("cookie")).toBe(`a=1; ${COOKIE_NAMES.sessao}=novo`);
    expect(result.responseHeaders[1]).toEqual(["Set-Cookie", `${COOKIE_NAMES.sessao}=novo; Path=/; Max-Age=100; HttpOnly; Secure; SameSite=Lax`]);
  });

  it("expirada: tira o cookie do pedido e apaga no navegador", async () => {
    const result = await handleProxy(input({ auth: fakeAuth({ state: "expirada", cookie: { name: COOKIE_NAMES.sessao, value: "", maxAge: 0 } }) }));
    expect(result.requestHeaders.get("cookie")).toBe("a=1");
    expect(result.requestHeaders.get(SESSION_STATE_HEADER)).toBe("expirada");
    expect(result.responseHeaders[1]?.[1]).toContain("Max-Age=0");
  });

  it("sem cabeçalho Cookie: ausente", async () => {
    const auth = fakeAuth({ state: "ausente" });
    const result = await handleProxy(input({ auth, headers: new Headers() }));
    expect(auth.calls).toEqual([undefined]);
    expect(result.requestHeaders.get(SESSION_STATE_HEADER)).toBe("ausente");
  });

  // ADR-028 D8: o rascunho é de uso único. A página o lê no mesmo pedido, e o navegador o apaga na resposta.
  it("rascunho numa página: fica no pedido e é apagado na resposta", async () => {
    const headers = new Headers({ cookie: `${COOKIE_NAMES.sessao}=velho; ${COOKIE_NAMES.rascunho}=r1.x` });
    const result = await handleProxy(input({ headers, pathname: "/conta/criterios" }));
    expect(result.requestHeaders.get("cookie")).toBe(`${COOKIE_NAMES.sessao}=velho; ${COOKIE_NAMES.rascunho}=r1.x`);
    expect(result.responseHeaders.slice(1)).toEqual([["Set-Cookie", `${COOKIE_NAMES.rascunho}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`]]);
  });

  it("rascunho com a sessão renovada: os dois cookies na resposta, o rascunho ainda no pedido", async () => {
    const headers = new Headers({ cookie: `${COOKIE_NAMES.sessao}=velho; ${COOKIE_NAMES.rascunho}=r1.x` });
    const result = await handleProxy(input({ headers, auth: fakeAuth({ state: "ativa", cookie: { name: COOKIE_NAMES.sessao, value: "novo", maxAge: 100 } }) }));
    expect(result.requestHeaders.get("cookie")).toBe(`${COOKIE_NAMES.rascunho}=r1.x; ${COOKIE_NAMES.sessao}=novo`);
    expect(result.responseHeaders.slice(1).map(([name, value]) => [name, value.split("=")[0]])).toEqual([
      ["Set-Cookie", COOKIE_NAMES.sessao],
      ["Set-Cookie", COOKIE_NAMES.rascunho],
    ]);
  });

  it("rascunho fora de página (a própria gravação, um estático): intacto", async () => {
    const headers = new Headers({ cookie: `${COOKIE_NAMES.rascunho}=r1.x` });
    for (const [method, pathname] of [["POST", "/conta/criterios/salvar"], ["GET", "/_next/static/a.js"]] as const) {
      const result = await handleProxy(input({ headers, method, pathname }));
      expect(result.responseHeaders).toHaveLength(1);
    }
  });
});

describe("toResponse", () => {
  it("redirecionamento 303 com Set-Cookie exatos e no-store", () => {
    const response = toResponse({ kind: "redirect", location: `${PORTAL}/conta`, cookies: [{ name: COOKIE_NAMES.fluxo, value: "", maxAge: 0 }, { name: COOKIE_NAMES.sessao, value: "s", maxAge: 9 }] });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${PORTAL}/conta`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual([
      `${COOKIE_NAMES.fluxo}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      `${COOKIE_NAMES.sessao}=s; Path=/; Max-Age=9; HttpOnly; Secure; SameSite=Lax`,
    ]);
  });

  it("proibido: 403 com corpo fixo, sem cookie", async () => {
    const response = toResponse({ kind: "forbidden" });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Proibido.");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("getPortalAuth", () => {
  it("monta uma vez a partir do ambiente", () => {
    stubEnv();
    const first = getPortalAuth();
    expect(getPortalAuth()).toBe(first);
  });

  it("falha fechado sem ambiente", () => {
    expect(() => getPortalAuth()).toThrow(/configuração do portal inválida/);
  });

  it("usa o SUPABASE_URL do ambiente no authorize", async () => {
    stubEnv();
    const start = await getPortalAuth().startLogin({ provider: "github", secFetchSite: "same-origin" });
    expect(start.location.startsWith("https://projeto.supabase.invalid/auth/v1/authorize?")).toBe(true);
  });

  it("getPortalCriteria: monta uma vez, com a mesma sessão, e falha fechado sem ambiente", async () => {
    expect(() => getPortalCriteria()).toThrow(/configuração do portal inválida/);
    stubEnv();
    const first = getPortalCriteria();
    expect(getPortalCriteria()).toBe(first);
    // Sem sessão, a página não chega à rede (a API do ambiente nem existe).
    expect(await first.page({ sessionCookie: undefined, draftCookie: undefined, aviso: undefined })).toEqual({ kind: "sem_sessao" });
  });

  it("runInBackground não espera a tarefa", () => {
    let settled = false;
    runInBackground(new Promise<void>((resolve) => setTimeout(() => ((settled = true), resolve()), 5)));
    expect(settled).toBe(false);
  });
});
