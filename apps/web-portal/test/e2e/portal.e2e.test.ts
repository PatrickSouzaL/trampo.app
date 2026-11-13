// E2E do portal no navegador do sistema (ADR-027 §7; condições 1, 6, 8 e 9 do [APPSEC]): o build de produção no
// `next start`, o GoTrue simulado do portal e o Edge, tudo em 127.0.0.1. Cada "0" tem um controle positivo (cuidado 24).
// Rodar com o portal construído: pnpm --filter @trampo/web-portal build && pnpm --filter @trampo/web-portal test:e2e
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COOKIE_NAMES } from "../../src/server/cookies";
import { NOTICES } from "../../src/server/notices";
import { GOTRUE_CANARIES } from "../support/fake-gotrue";
import { cspMessages, openTab, secretsIn, startStack, type Stack, type Tab } from "./support/stack";

let stack: Stack;
let tab: Tab;
/** Só a prova do iframe espera uma violação de CSP no console (e ela é o controle positivo da prova g). */
let expectsCspViolation = false;
/** Os segredos de todos os testes do arquivo, para a prova da saída do processo (h). */
const seen = new Set<string>(Object.values(GOTRUE_CANARIES));

/** Os pares `{ auth_code, code_verifier }` que o portal mandou ao simulado na troca. */
function exchanges(): Array<{ readonly code: string; readonly verifier: string }> {
  return stack.fake.requests
    .filter((request) => request.url === "/auth/v1/token?grant_type=pkce")
    .map((request) => JSON.parse(request.body) as { auth_code: string; code_verifier: string })
    .map((body) => ({ code: body.auth_code, verifier: body.code_verifier }));
}

/** Junta ao conjunto os tokens emitidos, os códigos, os verifiers e o valor de todo cookie do portal. */
async function harvest(): Promise<void> {
  await tab.settle();
  for (const { accessToken, refreshToken } of stack.fake.issued) seen.add(accessToken).add(refreshToken);
  for (const { code, verifier } of exchanges()) seen.add(code).add(verifier);
  for (const value of tab.cookieValues) seen.add(value);
  for (const cookie of await tab.context.cookies(stack.portal)) if (cookie.name.startsWith("__Host-")) seen.add(cookie.value);
}

const sessionCookie = async () => (await tab.context.cookies(stack.portal)).find((cookie) => cookie.name === COOKIE_NAMES.sessao);

/** Login pelos botões da página, como o usuário faria, até a `/conta` com a sessão. */
async function login(provider: "GitHub" | "Google"): Promise<void> {
  await tab.page.goto(`${stack.portal}/`);
  await tab.page.getByRole("link", { name: `Entrar com ${provider}` }).click();
  await tab.page.waitForURL((url) => url.pathname === "/conta", { timeout: 10_000 });
  await tab.page.locator("[data-sessao=ativa]").waitFor({ timeout: 10_000 });
}

/** A navegação terminou na página inicial: devolve o `?aviso=`. */
async function landedHome(): Promise<string | null> {
  await tab.page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });
  return new URL(tab.page.url()).searchParams.get("aviso");
}

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.close();
});

beforeEach(async () => {
  stack.fake.mode = { kind: "normal" };
  stack.fake.hookRefuses = false;
  stack.fake.expiresIn = 900;
  expectsCspViolation = false;
  tab = await openTab(stack);
});

afterEach(async () => {
  try {
    await harvest();
    // (g) Nenhum bloqueio de CSP nem erro de script nas páginas do portal: o nonce valeu no navegador.
    if (!expectsCspViolation) expect(cspMessages(tab)).toEqual([]);
    expect(tab.pageErrors).toEqual([]);
  } finally {
    await tab.close();
  }
});

describe("portal no Edge (ADR-027 §7)", () => {
  it("(a, b, b', g) login pelo GitHub até a /conta, sem nada da sessão legível pelo JS nem na página", async () => {
    await login("GitHub");
    expect(tab.page.url()).toBe(`${stack.portal}/conta`);
    expect(await tab.page.locator("[data-sessao=ativa]").innerText()).toBe("Você está conectado.");
    // (g) Os scripts do Next rodaram: o navegador aceitou o nonce da CSP.
    expect(await tab.page.evaluate(() => Array.isArray((self as unknown as { __next_f?: unknown }).__next_f))).toBe(true);
    await harvest();

    // (b) O cookie da sessão existe, com os atributos do D3, e o JS não o vê. Controle: um cookie sem HttpOnly aparece.
    const session = await sessionCookie();
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/", domain: "127.0.0.1" });
    const lifetime = (session?.expires ?? 0) - Date.now() / 1_000;
    expect(lifetime).toBeGreaterThan(86_400 - 120);
    expect(lifetime).toBeLessThanOrEqual(86_400 + 5);
    expect((await tab.context.cookies(stack.portal)).map((cookie) => cookie.name)).not.toContain(COOKIE_NAMES.fluxo);
    const visible = await tab.page.evaluate(() => {
      document.cookie = "controle-e2e=visivel; Path=/";
      return document.cookie;
    });
    expect(visible).toContain("controle-e2e=visivel");
    expect(visible).not.toMatch(/trampo/i);
    expect(secretsIn(visible, seen)).toEqual([]);

    // (b) O HTML e os scripts do portal não trazem token, sub, e-mail, código, verifier nem o cookie. Controle: o mesmo
    // detector acha um segredo plantado.
    const page = [...tab.bodies, await tab.page.content()].join("\n");
    expect(tab.bodies.length).toBeGreaterThan(2);
    expect(secretsIn(page, seen)).toEqual([]);
    const access = stack.fake.issued.at(-1)?.accessToken as string;
    expect(secretsIn(`${page}${access}`, seen)).toEqual([access]);

    // (b') O verifier, os tokens e o cookie nunca vão a uma URL do navegador. Controle: o coletor vê o challenge no
    // authorize e o código no retorno.
    const { verifier } = exchanges().at(-1) as { verifier: string };
    const browserUrls = tab.urls.join("\n");
    expect(secretsIn(browserUrls, [verifier, access, ...stack.fake.issued.map((pair) => pair.refreshToken), session?.value as string])).toEqual([]);
    expect(tab.urls.some((url) => url.includes("/auth/v1/authorize?") && url.includes("code_challenge="))).toBe(true);
    expect(tab.urls.some((url) => url.startsWith(`${stack.portal}/auth/retorno?`) && new URL(url).searchParams.has("code"))).toBe(true);
  });

  it("(a) login pelo Google", async () => {
    await login("Google");
    expect(tab.urls.some((url) => url.includes("/auth/v1/authorize?provider=google&"))).toBe(true);
    expect(await sessionCookie()).toBeDefined();
  });

  it("(c) o portal num iframe de outra origem não carrega; a página sem cabeçalhos carrega (controle)", async () => {
    expectsCspViolation = true;
    await tab.page.goto(`${stack.framer}/controle`);
    const control = tab.page.frameLocator("#moldura").locator("#aberta");
    await control.waitFor({ timeout: 10_000 });
    expect(await control.innerText()).toBe("CONTROLE-ABERTO");

    await tab.page.goto(`${stack.framer}/portal`);
    await expect.poll(() => cspMessages(tab).some((line) => line.includes("frame-ancestors")), { timeout: 10_000 }).toBe(true);
    const frame = tab.page.frames().find((candidate) => candidate !== tab.page.mainFrame());
    expect(frame?.url()).toBe("chrome-error://chromewebdata/");
    const inside = (await frame?.evaluate(() => document.body?.innerText ?? "").catch(() => "")) ?? "";
    expect(inside).not.toContain("Entrar com");
    // A única mensagem de CSP é a da moldura.
    expect(cspMessages(tab).every((line) => line.includes("frame-ancestors"))).toBe(true);
  });

  it("(d) a recusa do hook vira 'Sua sessão expirou' com o botão de entrar, e o cookie some", async () => {
    stack.fake.expiresIn = 30;
    await login("GitHub");
    stack.fake.hookRefuses = true;
    await tab.page.goto(`${stack.portal}/conta`);
    expect(await landedHome()).toBe("sessao_expirada");
    expect(await tab.page.getByRole("status").innerText()).toBe(NOTICES.sessao_expirada);
    await tab.page.getByRole("link", { name: "Entrar com Google" }).waitFor({ timeout: 10_000 });
    expect(await sessionCookie()).toBeUndefined();
  });

  it("(e) o 503 do GoTrue mantém a sessão: aviso de indisponível, o mesmo cookie, e a /conta volta com o serviço", async () => {
    stack.fake.expiresIn = 30;
    await login("GitHub");
    const before = (await sessionCookie())?.value;
    expect(before).toBeDefined();
    stack.fake.mode = { kind: "responde", status: 503, body: "" };
    await tab.page.goto(`${stack.portal}/`);
    expect(await tab.page.getByRole("status").innerText()).toBe(NOTICES.servico_indisponivel);
    expect((await sessionCookie())?.value).toBe(before);
    // Controle: a sessão mantida continua valendo quando o serviço volta.
    stack.fake.mode = { kind: "normal" };
    await tab.page.goto(`${stack.portal}/conta`);
    await tab.page.locator("[data-sessao=ativa]").waitFor({ timeout: 10_000 });
    expect(new URL(tab.page.url()).pathname).toBe("/conta");
  });

  it("(f) o logout pelo botão leva ao 'Você saiu', apaga o cookie e encerra a sessão no GoTrue", async () => {
    await login("GitHub");
    const live = stack.fake.liveSessions.size;
    await tab.page.getByRole("button", { name: "Sair" }).click();
    expect(await landedHome()).toBe("saiu");
    expect(await tab.page.getByRole("status").innerText()).toBe(NOTICES.saiu);
    expect(await sessionCookie()).toBeUndefined();
    expect(stack.fake.liveSessions.size).toBe(live - 1);
    expect(stack.fake.requests.at(-1)?.url).toBe("/auth/v1/logout?scope=local");
  });

  it("(f') o GET em /auth/sair (link, imagem ou navegação de outro site) dá 405 e não encerra a sessão", async () => {
    await login("GitHub");
    const before = (await sessionCookie())?.value;
    const live = stack.fake.liveSessions.size;
    // O 405 sem corpo vira `ERR_HTTP_RESPONSE_CODE_FAILURE` na navegação: o status se lê na resposta.
    const [response] = await Promise.all([
      tab.page.waitForResponse((candidate) => candidate.url() === `${stack.portal}/auth/sair`),
      tab.page.goto(`${stack.portal}/auth/sair`).catch(() => null),
    ]);
    expect(response.status()).toBe(405);
    // Controle: a sessão segue valendo depois da tentativa.
    expect((await sessionCookie())?.value).toBe(before);
    expect(stack.fake.liveSessions.size).toBe(live);
    // Numa aba nova do mesmo contexto: no Chrome, a página de erro do 405 entra depois e interromperia outro `goto`.
    const again = await tab.context.newPage();
    await again.goto(`${stack.portal}/conta`);
    await again.locator("[data-sessao=ativa]").waitFor({ timeout: 10_000 });
  });

  it("(h) nada sensível na saída do processo do portal (SR-12)", () => {
    const output = stack.output();
    // Controles: a saída foi capturada, o conjunto tem os segredos de todos os testes, e o detector acha um plantado.
    expect(output).toContain("Ready");
    expect(seen.size).toBeGreaterThan(Object.keys(GOTRUE_CANARIES).length + 20);
    expect(secretsIn(output, seen)).toEqual([]);
    const planted = [...seen].at(-1) as string;
    expect(secretsIn(`${output}${planted}`, seen)).toEqual([planted]);
  });
});
