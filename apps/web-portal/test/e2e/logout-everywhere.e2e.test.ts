// E2E do "Sair de todos os dispositivos" no navegador do sistema (ADR-027 §9.3 condições 4, 6 e 8; cuidado 36): dois
// contextos do navegador com a mesma conta. O 1º usa o link e o botão reais; o 2º faz o papel da extensão (outra sessão
// do mesmo usuário, com o access perto do fim, que renova na navegação seguinte). Cada "0" tem controle positivo.
// Rodar com o portal construído: pnpm --filter @trampo/web-portal build && pnpm --filter @trampo/web-portal test:e2e
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COOKIE_NAMES } from "../../src/server/cookies";
import { LOGOUT_EVERYWHERE_TEXTS, NOTICES } from "../../src/server/notices";
import { cspMessages, openTab, startStack, type Stack, type Tab } from "./support/stack";

let stack: Stack;
/** O navegador do usuário. */
let tab: Tab;
/** Outro contexto, sem nenhum cookie em comum: a extensão ou outro navegador. */
let other: Tab;

const sessionCookie = async (which: Tab) => (await which.context.cookies(stack.portal)).find((cookie) => cookie.name === COOKIE_NAMES.sessao);
const logoutCalls = () => stack.fake.requests.filter((request) => request.url.startsWith("/auth/v1/logout")).map((request) => `${request.method} ${request.url}`);

/** Login pelos botões da página, como o usuário faria, até a `/conta` com a sessão. */
async function login(which: Tab): Promise<void> {
  await which.page.goto(`${stack.portal}/`);
  await which.page.getByRole("link", { name: "Entrar com GitHub" }).click();
  await which.page.waitForURL((url) => url.pathname === "/conta", { timeout: 10_000 });
  await which.page.locator("[data-sessao=ativa]").waitFor({ timeout: 10_000 });
}

/** A navegação terminou na página inicial: devolve o `?aviso=`. */
async function landedHome(which: Tab): Promise<string | null> {
  await which.page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });
  return new URL(which.page.url()).searchParams.get("aviso");
}

/** Da `/conta` à página de confirmação, pelo link. */
async function openConfirmation(): Promise<void> {
  await tab.page.getByRole("link", { name: "Sair de todos os dispositivos" }).click();
  await tab.page.waitForURL((url) => url.pathname === "/conta/sair-de-tudo", { timeout: 10_000 });
  await tab.page.getByRole("heading", { name: LOGOUT_EVERYWHERE_TEXTS.titulo }).waitFor({ timeout: 10_000 });
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
  // O access dura 30 s: toda navegação de página renova (o proxy renova com até 60 s pela frente), como a extensão
  // renovaria no fim do access dela.
  stack.fake.expiresIn = 30;
  tab = await openTab(stack);
  other = await openTab(stack);
  await login(tab);
  await login(other);
  stack.fake.requests.length = 0;
  stack.fake.logouts.length = 0;
});

afterEach(async () => {
  try {
    for (const which of [tab, other]) {
      await which.settle();
      // Nenhum bloqueio de CSP nem erro de script: o formulário e o 303 passaram pela `form-action 'self'`.
      expect(cspMessages(which)).toEqual([]);
      expect(which.pageErrors).toEqual([]);
    }
  } finally {
    await tab.close();
    await other.close();
  }
});

describe("sair de todos os dispositivos no Edge (ADR-027 §9)", () => {
  it("as duas sessões são do mesmo usuário e não dividem cookie (controle do cenário)", async () => {
    const [mine, theirs] = [await sessionCookie(tab), await sessionCookie(other)];
    expect(mine?.value).toBeDefined();
    expect(theirs?.value).toBeDefined();
    expect(mine?.value).not.toBe(theirs?.value);
    expect(stack.fake.liveSessions.size).toBeGreaterThanOrEqual(2);
  });

  it("(4) o link leva à página de confirmação, que não encerra nada; o Voltar devolve à conta", async () => {
    await openConfirmation();
    expect(await tab.page.locator("[data-sair-de-tudo=prazo]").innerText()).toBe(LOGOUT_EVERYWHERE_TEXTS.prazo);
    // A página não tem campo nenhum: só o botão do próprio formulário.
    expect(await tab.page.locator("form").count()).toBe(1);
    expect(await tab.page.locator("form").getAttribute("action")).toBe("/auth/sair-de-tudo");
    expect(await tab.page.locator("input, select, textarea").count()).toBe(0);
    expect(logoutCalls()).toEqual([]);
    await tab.page.getByRole("link", { name: LOGOUT_EVERYWHERE_TEXTS.voltar }).click();
    await tab.page.waitForURL((url) => url.pathname === "/conta", { timeout: 10_000 });
    await tab.page.locator("[data-sessao=ativa]").waitFor({ timeout: 10_000 });
    expect(logoutCalls()).toEqual([]);
    // Controle: a outra sessão também segue viva.
    await other.page.goto(`${stack.portal}/conta`);
    await other.page.locator("[data-sessao=ativa]").waitFor({ timeout: 10_000 });
  });

  it("(6) sair de tudo pelo botão real: este navegador sai, e o outro cai em 'Sua sessão expirou' na navegação seguinte", async () => {
    await openConfirmation();
    await tab.page.getByRole("button", { name: LOGOUT_EVERYWHERE_TEXTS.confirmar }).click();
    expect(await landedHome(tab)).toBe("saiu_de_tudo");
    expect(await tab.page.getByRole("status").innerText()).toBe(NOTICES.saiu_de_tudo);
    expect(await sessionCookie(tab)).toBeUndefined();
    // Um POST só, com o escopo global (a renovação antes dele é do /token, não do /logout).
    expect(logoutCalls()).toEqual(["POST /auth/v1/logout?scope=global"]);
    expect(stack.fake.logouts).toHaveLength(1);
    expect(stack.fake.logouts[0]?.scope).toBe("global");
    expect(stack.fake.logouts[0]?.revoked.length).toBeGreaterThanOrEqual(2);

    // O outro contexto ainda tem o cookie dele, mas a renovação é recusada: "entre de novo".
    expect(await sessionCookie(other)).toBeDefined();
    await other.page.goto(`${stack.portal}/conta`);
    expect(await landedHome(other)).toBe("sessao_expirada");
    expect(await other.page.getByRole("status").innerText()).toBe(NOTICES.sessao_expirada);
    await other.page.getByRole("link", { name: "Entrar com Google" }).waitFor({ timeout: 10_000 });
    expect(await sessionCookie(other)).toBeUndefined();
  });

  it("(6) com o Sair comum, o outro navegador continua conectado (escopo local)", async () => {
    await tab.page.getByRole("button", { name: "Sair", exact: true }).click();
    expect(await landedHome(tab)).toBe("saiu");
    expect(await sessionCookie(tab)).toBeUndefined();
    expect(logoutCalls()).toEqual(["POST /auth/v1/logout?scope=local"]);
    await other.page.goto(`${stack.portal}/conta`);
    await other.page.locator("[data-sessao=ativa]").waitFor({ timeout: 10_000 });
    expect(new URL(other.page.url()).pathname).toBe("/conta");
    expect(await sessionCookie(other)).toBeDefined();
  });

  it("(5) o GoTrue fora no logout: este navegador sai, o aviso não promete nada e o outro continua conectado", async () => {
    await openConfirmation();
    // O GoTrue cai depois de a página abrir: a renovação antes do logout e o logout recebem 503.
    stack.fake.mode = { kind: "responde", status: 503, body: "" };
    await tab.page.getByRole("button", { name: LOGOUT_EVERYWHERE_TEXTS.confirmar }).click();
    expect(await landedHome(tab)).toBe("saiu_sem_confirmar");
    expect(await tab.page.getByRole("status").innerText()).toBe(NOTICES.saiu_sem_confirmar);
    expect(await sessionCookie(tab)).toBeUndefined();
    expect(logoutCalls()).toEqual(["POST /auth/v1/logout?scope=global"]);
    stack.fake.mode = { kind: "normal" };
    await other.page.goto(`${stack.portal}/conta`);
    await other.page.locator("[data-sessao=ativa]").waitFor({ timeout: 10_000 });
  });

  it("(3) o GET em /auth/sair-de-tudo (link, imagem ou navegação de outro site) dá 405 e não encerra nenhuma sessão", async () => {
    const before = (await sessionCookie(tab))?.value;
    // O 405 sem corpo vira `ERR_HTTP_RESPONSE_CODE_FAILURE` na navegação: o status se lê na resposta.
    const [response] = await Promise.all([
      tab.page.waitForResponse((candidate) => candidate.url() === `${stack.portal}/auth/sair-de-tudo`),
      tab.page.goto(`${stack.portal}/auth/sair-de-tudo`).catch(() => null),
    ]);
    expect(response.status()).toBe(405);
    expect(logoutCalls()).toEqual([]);
    expect((await sessionCookie(tab))?.value).toBe(before);
    // Numa aba nova do mesmo contexto: a página de erro do 405 interromperia outro `goto` (cuidado 36).
    const again = await tab.context.newPage();
    await again.goto(`${stack.portal}/conta`);
    await again.locator("[data-sessao=ativa]").waitFor({ timeout: 10_000 });
    await other.page.goto(`${stack.portal}/conta`);
    await other.page.locator("[data-sessao=ativa]").waitFor({ timeout: 10_000 });
  });
});
