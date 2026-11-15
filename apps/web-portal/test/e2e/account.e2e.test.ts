// E2E de exportar e excluir a conta no navegador do sistema (ADR-029 §4; cuidado 36): pelos links e botões reais, sem
// JS próprio, contra o GoTrue e a API simulados, com o build de produção no `next start`. O arquivo baixado é lido do
// disco e conferido pelo contrato; a exclusão passa pela página de confirmação e pela frase digitada. Cada "0" tem
// controle positivo. Rodar com o portal construído:
// pnpm --filter @trampo/web-portal build && pnpm --filter @trampo/web-portal test:e2e
import { readFile } from "node:fs/promises";

import { AccountExportSchema } from "@trampo/contracts/account";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COOKIE_NAMES } from "../../src/server/cookies";
import { ACCOUNT_NOTICES, ACCOUNT_PAGE_TEXTS, NOTICES } from "../../src/server/notices";
import { SALARY_CANARY, SALARY_CANARY_TEXT, fullCriteria } from "../support/criteria-fixtures";
import { GOTRUE_CANARIES } from "../support/fake-gotrue";
import { cspMessages, openTab, secretsIn, startStack, type Stack, type Tab } from "./support/stack";

const PHRASE = "excluir minha conta";
const ANALYSIS = { id: "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b", createdAt: "2026-11-15T11:00:00.000Z", decisionPath: "extracao_llm", verdict: "neutro", score: 50 } as const;
let stack: Stack;
let tab: Tab;

const sessionCookie = async () => (await tab.context.cookies(stack.portal)).find((cookie) => cookie.name === COOKIE_NAMES.sessao);
const apiCalls = () => stack.api.requests.map((request) => `${request.method} ${request.url}`);
const landed = (): string => {
  const url = new URL(tab.page.url());
  return url.pathname + url.search;
};

/** Login pelo botão e a página de dados pelo link da /conta, como o usuário faria. */
async function openData(): Promise<void> {
  await tab.page.goto(`${stack.portal}/`);
  await tab.page.getByRole("link", { name: "Entrar com GitHub" }).click();
  await tab.page.waitForURL((url) => url.pathname === "/conta", { timeout: 10_000 });
  await tab.page.getByRole("link", { name: "Seus dados" }).click();
  await tab.page.waitForURL((url) => url.pathname === "/conta/dados", { timeout: 10_000 });
  await tab.page.getByRole("heading", { name: ACCOUNT_PAGE_TEXTS.titulo }).waitFor({ timeout: 10_000 });
  stack.api.requests.length = 0;
}

/** Da página de dados à de confirmação, pelo link. */
async function openConfirmation(): Promise<void> {
  await tab.page.getByRole("link", { name: ACCOUNT_PAGE_TEXTS.excluirLink }).click();
  await tab.page.waitForURL((url) => url.pathname === "/conta/dados/excluir", { timeout: 10_000 });
  await tab.page.getByRole("heading", { name: ACCOUNT_PAGE_TEXTS.excluirTitulo }).waitFor({ timeout: 10_000 });
}

/** Digita a frase e clica no botão; espera a navegação do 303 terminar. */
async function confirm(typed: string): Promise<string> {
  const before = tab.page.url();
  await tab.page.locator('input[name="confirmacao"]').fill(typed);
  await tab.page.getByRole("button", { name: ACCOUNT_PAGE_TEXTS.excluirBotao }).click();
  await tab.page.waitForURL((url) => url.href !== before && url.search.includes("aviso="), { timeout: 10_000 });
  return landed();
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
  stack.api.mode = { kind: "normal" };
  stack.api.deleteResult = "excluida";
  stack.api.rows.clear();
  stack.api.analyses.length = 0;
  stack.api.deletions.length = 0;
  stack.api.requests.length = 0;
  stack.api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
  tab = await openTab(stack);
});

afterEach(async () => {
  try {
    await tab.settle();
    // Nenhum bloqueio de CSP nem erro de script: os formulários e os 303 passaram pela `form-action 'self'`.
    expect(cspMessages(tab)).toEqual([]);
    expect(tab.pageErrors).toEqual([]);
    // Os dados exportados e a frase nunca vão a uma URL do navegador. Controle no teste da exportação.
    expect(secretsIn(tab.urls.join("\n"), [SALARY_CANARY_TEXT, PHRASE])).toEqual([]);
  } finally {
    await tab.close();
  }
});

describe("exportar e excluir a conta no Edge (ADR-029 D9)", () => {
  it("baixar meus dados pelo botão: um arquivo JSON do contrato, com a pretensão, sem sair da página e sem dado em URL", async () => {
    stack.api.analyses.push(ANALYSIS);
    await openData();
    expect(await tab.page.locator("[data-dados=exportar-fora]").innerText()).toBe(ACCOUNT_PAGE_TEXTS.exportarFora);
    const [download] = await Promise.all([tab.page.waitForEvent("download", { timeout: 10_000 }), tab.page.getByRole("button", { name: ACCOUNT_PAGE_TEXTS.baixar }).click()]);
    expect(download.suggestedFilename()).toBe("trampo-meus-dados.json");
    const text = await readFile(await download.path(), "utf8");
    const document = AccountExportSchema.parse(JSON.parse(text));
    expect(document.criteria).toEqual(fullCriteria());
    expect(document.criteria?.salary?.minimum).toBe(SALARY_CANARY);
    expect(document.analyses).toEqual([ANALYSIS]);
    // O navegador ficou na página de dados (anexo), e só uma leitura foi à API, sem o cookie nem o Origin do navegador.
    expect(landed()).toBe("/conta/dados");
    expect(apiCalls()).toEqual(["GET /v1/account/export"]);
    for (const name of ["cookie", "origin", "referer"]) expect(stack.api.requests[0]?.headers[name], name).toBeUndefined();
    // Controles: o arquivo tem o canário, e o detector das URLs o acharia.
    expect(text).toContain(SALARY_CANARY_TEXT);
    expect(secretsIn(`${tab.urls.join("\n")}?x=${SALARY_CANARY_TEXT}`, [SALARY_CANARY_TEXT])).toEqual([SALARY_CANARY_TEXT]);
    expect(await sessionCookie()).toBeDefined();
  });

  it("a exportação com a API fora: aviso do catálogo na página de dados, nenhum arquivo e a sessão mantida", async () => {
    await openData();
    stack.api.mode = { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" };
    let downloads = 0;
    tab.page.on("download", () => (downloads += 1));
    await tab.page.getByRole("button", { name: ACCOUNT_PAGE_TEXTS.baixar }).click();
    await tab.page.waitForURL((url) => url.search.includes("aviso="), { timeout: 10_000 });
    expect(landed()).toBe("/conta/dados?aviso=exportacao_indisponivel");
    expect(await tab.page.getByRole("status").innerText()).toBe(ACCOUNT_NOTICES.exportacao_indisponivel);
    expect(downloads).toBe(0);
    expect(await sessionCookie()).toBeDefined();
  });

  it("a página de confirmação não exclui nada; o Voltar devolve aos dados", async () => {
    await openData();
    await openConfirmation();
    expect(await tab.page.locator("[data-excluir=sem-volta]").innerText()).toBe(ACCOUNT_PAGE_TEXTS.excluirSemVolta);
    expect(await tab.page.locator("form").count()).toBe(1);
    expect(await tab.page.locator("form").getAttribute("action")).toBe("/conta/dados/excluir/confirmar");
    expect(await tab.page.locator("input, select, textarea").count()).toBe(1);
    expect(await tab.page.locator('input[name="confirmacao"]').inputValue()).toBe("");
    await tab.page.getByRole("link", { name: ACCOUNT_PAGE_TEXTS.voltarDados }).click();
    await tab.page.waitForURL((url) => url.pathname === "/conta/dados", { timeout: 10_000 });
    expect(apiCalls()).toEqual([]);
    expect(stack.api.rows.size).toBe(1);
  });

  it("excluir pelo botão real, com a frase digitada: a conta some, o navegador sai e a /conta volta para a página inicial", async () => {
    await openData();
    await openConfirmation();
    expect(await confirm(PHRASE)).toBe("/?aviso=conta_excluida");
    expect(await tab.page.getByRole("status").innerText()).toBe(NOTICES.conta_excluida);
    await tab.page.getByRole("link", { name: "Entrar com GitHub" }).waitFor({ timeout: 10_000 });
    expect(await sessionCookie()).toBeUndefined();
    expect(apiCalls()).toEqual(["POST /v1/account/delete"]);
    expect(JSON.parse(stack.api.requests[0]?.body ?? "")).toEqual({ schemaVersion: 1, confirmation: PHRASE });
    expect(stack.api.deletions).toEqual([GOTRUE_CANARIES.userId]);
    expect(stack.api.rows.size).toBe(0);
    await tab.page.goto(`${stack.portal}/conta`);
    await tab.page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });
  });

  it("a frase com maiúsculas e espaços nas pontas vale", async () => {
    await openData();
    await openConfirmation();
    expect(await confirm("  Excluir Minha Conta ")).toBe("/?aviso=conta_excluida");
    expect(stack.api.deletions).toHaveLength(1);
  });

  it.each([["excluir"], [""]])("a frase errada (%j): volta para a confirmação com o aviso, a API não é chamada e a conta fica", async (typed) => {
    await openData();
    await openConfirmation();
    expect(await confirm(typed)).toBe("/conta/dados/excluir?aviso=exclusao_frase_errada");
    expect(await tab.page.getByRole("status").innerText()).toBe(ACCOUNT_NOTICES.exclusao_frase_errada);
    expect(await tab.page.locator('input[name="confirmacao"]').inputValue()).toBe("");
    expect(apiCalls()).toEqual([]);
    expect(stack.api.rows.size).toBe(1);
    expect(await sessionCookie()).toBeDefined();
  });

  it("o banco diz que o login não é recente: aviso próprio, a sessão fica e nada some", async () => {
    await openData();
    await openConfirmation();
    stack.api.deleteResult = "login_antigo";
    expect(await confirm(PHRASE)).toBe("/conta/dados?aviso=exclusao_pede_login");
    expect(await tab.page.getByRole("status").innerText()).toBe(ACCOUNT_NOTICES.exclusao_pede_login);
    expect(stack.api.rows.size).toBe(1);
    expect(await sessionCookie()).toBeDefined();
    await tab.page.goto(`${stack.portal}/conta`);
    await tab.page.locator("[data-sessao=ativa]").waitFor({ timeout: 10_000 });
  });

  it("a API responde 503 na exclusão: o aviso não promete nem nega, um POST só, e a sessão fica", async () => {
    await openData();
    await openConfirmation();
    stack.api.mode = { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" };
    expect(await confirm(PHRASE)).toBe("/conta/dados?aviso=exclusao_nao_confirmada");
    const text = await tab.page.getByRole("status").innerText();
    expect(text).toBe(ACCOUNT_NOTICES.exclusao_nao_confirmada);
    expect(text).not.toMatch(/nada foi exclu|foram exclu/i);
    expect(apiCalls()).toEqual(["POST /v1/account/delete"]);
    expect(await sessionCookie()).toBeDefined();
  });

  it("o GET na rota de confirmação (link, imagem ou navegação de outro site) dá 405 e não exclui nada", async () => {
    await openData();
    const target = `${stack.portal}/conta/dados/excluir/confirmar`;
    const [response] = await Promise.all([tab.page.waitForResponse((candidate) => candidate.url() === target), tab.page.goto(target).catch(() => null)]);
    expect(response.status()).toBe(405);
    expect(apiCalls()).toEqual([]);
    expect(stack.api.rows.size).toBe(1);
    // Numa aba nova do mesmo contexto: a página de erro do 405 interromperia outro `goto` (cuidado 36).
    const again = await tab.context.newPage();
    await again.goto(`${stack.portal}/conta`);
    await again.locator("[data-sessao=ativa]").waitFor({ timeout: 10_000 });
  });
});
