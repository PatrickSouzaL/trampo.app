// E2E dos critérios no navegador do sistema (ADR-028 §4.3; cuidado 36): o formulário preenchido e salvo pelo botão
// real, sem JS próprio, contra o GoTrue e a API simulados, com o build de produção no `next start`. Cada "0" tem
// controle positivo. Rodar com o portal construído:
// pnpm --filter @trampo/web-portal build && pnpm --filter @trampo/web-portal test:e2e
import type { UserCriteria } from "@trampo/contracts/user-criteria";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COOKIE_NAMES } from "../../src/server/cookies";
import { CRITERIA_FIELD_ERRORS, CRITERIA_NOTICES, CRITERIA_PAGE_TEXTS, NOTICES } from "../../src/server/notices";
import { SALARY_CANARY_TEXT } from "../support/criteria-fixtures";
import { GOTRUE_CANARIES } from "../support/fake-gotrue";
import { cspMessages, openTab, secretsIn, startStack, type Stack, type Tab } from "./support/stack";

/** O que o teste digita na pretensão: o canário, na forma brasileira (vírgula). */
const SALARY_TYPED = `${SALARY_CANARY_TEXT},87`;
const DRAFT_NOTE = "RASCUNHO-E2E-CANARIO";
let stack: Stack;
let tab: Tab;
/** Os segredos de todos os testes do arquivo, para a prova da saída do processo. */
const seen = new Set<string>([...Object.values(GOTRUE_CANARIES), SALARY_CANARY_TEXT, DRAFT_NOTE]);

const cookieNamed = async (name: string) => (await tab.context.cookies(stack.portal)).find((cookie) => cookie.name === name);
const field = (name: string) => tab.page.locator(`[name="${name}"]`);
const savedRow = () => stack.api.rows.get(GOTRUE_CANARIES.userId) as UserCriteria | undefined;
const puts = () => stack.api.requests.filter((request) => request.method === "PUT");

async function harvest(): Promise<void> {
  await tab.settle();
  for (const { accessToken, refreshToken } of stack.fake.issued) seen.add(accessToken).add(refreshToken);
  for (const value of tab.cookieValues) seen.add(value);
}

/** Login pelo botão e a página de critérios pelo link da /conta, como o usuário faria. */
async function openCriteria(): Promise<void> {
  await tab.page.goto(`${stack.portal}/`);
  await tab.page.getByRole("link", { name: "Entrar com GitHub" }).click();
  await tab.page.waitForURL((url) => url.pathname === "/conta", { timeout: 10_000 });
  await tab.page.getByRole("link", { name: "Seus critérios" }).click();
  await tab.page.waitForURL((url) => url.pathname === "/conta/criterios", { timeout: 10_000 });
  await tab.page.locator("section[data-origem]").waitFor({ timeout: 10_000 });
}

/** Preenche como o usuário: a pretensão, um modelo a menos, tecnologias e uma observação. */
async function fill(note = "Prefiro times pequenos."): Promise<void> {
  await tab.page.getByLabel("Usar a pretensão salarial").check();
  await field("salary.minimum").fill(SALARY_TYPED);
  await field("salary.importance").selectOption("eliminatorio");
  await tab.page.locator('input[name="workModel.accepted"][value="presencial"]').uncheck();
  await field("stack.mustHave").fill("TypeScript\nNode.js");
  await field("notes").fill(note);
}

/** Clica em "Salvar critérios" e espera a navegação do 303 terminar. */
async function save(): Promise<URL> {
  const before = tab.page.url();
  await tab.page.getByRole("button", { name: "Salvar critérios" }).click();
  await tab.page.waitForURL((url) => url.href !== before && url.search.includes("aviso="), { timeout: 10_000 });
  return new URL(tab.page.url());
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
  stack.api.rows.clear();
  stack.api.requests.length = 0;
  tab = await openTab(stack);
});

afterEach(async () => {
  try {
    await harvest();
    // Nenhum bloqueio de CSP nem erro de script nas páginas novas: o nonce valeu no navegador.
    expect(cspMessages(tab)).toEqual([]);
    expect(tab.pageErrors).toEqual([]);
    // A pretensão e o rascunho nunca vão a uma URL do navegador (condição 10). Controle no primeiro teste.
    expect(secretsIn(tab.urls.join("\n"), [SALARY_CANARY_TEXT, DRAFT_NOTE])).toEqual([]);
  } finally {
    await tab.close();
  }
});

describe("critérios no Edge (ADR-028 §4.3)", () => {
  it("preencher e salvar pelo botão: o valor salvo volta ao abrir de novo", async () => {
    await openCriteria();
    expect(await tab.page.locator("section[data-origem]").getAttribute("data-origem")).toBe("padroes");
    expect(await tab.page.getByText(CRITERIA_PAGE_TEXTS.padroes).count()).toBe(1);
    await fill();
    const landed = await save();
    expect(landed.pathname + landed.search).toBe("/conta/criterios?aviso=criterios_salvos");
    expect(await tab.page.getByRole("status").innerText()).toBe(CRITERIA_NOTICES.criterios_salvos);

    // O que a API gravou é o que o usuário escolheu, com a pretensão em número.
    const row = savedRow();
    expect(row?.salary).toEqual({ minimum: 73_519.87, currency: "BRL", period: "mes", importance: { level: "eliminatorio" } });
    expect(row?.workModel.accepted).toEqual(["remoto", "hibrido"]);
    expect(row?.stack.mustHave).toEqual(["TypeScript", "Node.js"]);
    expect(puts()).toHaveLength(1);
    // O PUT saiu do servidor do portal, sem o cookie, o Origin ou o Referer do navegador.
    for (const name of ["cookie", "origin", "referer"]) expect(puts()[0]?.headers[name], name).toBeUndefined();

    // Reabrir: o valor salvo volta da API.
    await tab.page.goto(`${stack.portal}/conta/criterios`);
    expect(await tab.page.locator("section[data-origem]").getAttribute("data-origem")).toBe("salvos");
    expect(await field("salary.minimum").inputValue()).toBe("73519.87");
    expect(await field("salary.importance").inputValue()).toBe("eliminatorio");
    expect(await tab.page.locator('input[name="workModel.accepted"][value="presencial"]').isChecked()).toBe(false);
    expect(await field("stack.mustHave").inputValue()).toBe("TypeScript\nNode.js");
    expect(await cookieNamed(COOKIE_NAMES.rascunho)).toBeUndefined();

    // Controle positivo da prova das URLs: o detector acha o canário quando ele está lá.
    expect(secretsIn(`${tab.urls.join("\n")}?v=${SALARY_TYPED}`, [SALARY_CANARY_TEXT])).toEqual([SALARY_CANARY_TEXT]);
  });

  it("o 503 do PUT mantém a sessão e devolve o rascunho, de uso único", async () => {
    await openCriteria();
    const session = (await cookieNamed(COOKIE_NAMES.sessao))?.value;
    await fill(DRAFT_NOTE);
    stack.api.mode = { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" };
    const landed = await save();
    expect(landed.searchParams.get("aviso")).toBe("criterios_nao_confirmados");
    expect(await tab.page.getByRole("status").innerText()).toBe(CRITERIA_NOTICES.criterios_nao_confirmados);
    expect(await tab.page.locator("section[data-origem]").getAttribute("data-origem")).toBe("rascunho");
    expect(await field("notes").inputValue()).toBe(DRAFT_NOTE);
    expect(await field("salary.minimum").inputValue()).toBe(SALARY_TYPED);
    // A sessão é a mesma (o 503 nunca apaga, T30), e o rascunho já foi apagado pela página que o mostrou.
    expect((await cookieNamed(COOKIE_NAMES.sessao))?.value).toBe(session);
    expect(await cookieNamed(COOKIE_NAMES.rascunho)).toBeUndefined();
    expect(puts()).toHaveLength(1);

    // De novo, com a API de volta: o rascunho não volta, e a página diz que ele se perdeu.
    stack.api.mode = { kind: "normal" };
    await tab.page.reload();
    expect(await tab.page.locator("section[data-origem]").getAttribute("data-origem")).toBe("padroes");
    expect(await tab.page.getByRole("status").innerText()).toBe(`${CRITERIA_NOTICES.criterios_nao_confirmados} ${CRITERIA_PAGE_TEXTS.rascunhoPerdido}`);
  });

  it("o 401 da API com o GoTrue recusando a renovação vira 'entre de novo', e o cookie some", async () => {
    await openCriteria();
    await fill();
    stack.api.mode = { kind: "responde", status: 401, code: "NAO_AUTENTICADO" };
    stack.fake.hookRefuses = true;
    const landed = await save();
    expect(landed.pathname + landed.search).toBe("/?aviso=sessao_expirada");
    expect(await tab.page.getByRole("status").innerText()).toBe(NOTICES.sessao_expirada);
    await tab.page.getByRole("link", { name: "Entrar com Google" }).waitFor({ timeout: 10_000 });
    expect(await cookieNamed(COOKIE_NAMES.sessao)).toBeUndefined();
    expect(puts()).toHaveLength(1);
  });

  it("o 401 da API com o GoTrue aceitando: indisponível, o rascunho e a sessão renovada, sem repetir o PUT (T30)", async () => {
    await openCriteria();
    const session = (await cookieNamed(COOKIE_NAMES.sessao))?.value;
    await fill(DRAFT_NOTE);
    stack.api.mode = { kind: "responde", status: 401, code: "NAO_AUTENTICADO" };
    const landed = await save();
    expect(landed.searchParams.get("aviso")).toBe("criterios_indisponiveis");
    expect(await tab.page.locator("section[data-origem]").getAttribute("data-origem")).toBe("rascunho");
    expect(await field("notes").inputValue()).toBe(DRAFT_NOTE);
    const renewed = (await cookieNamed(COOKIE_NAMES.sessao))?.value;
    expect(renewed).toBeDefined();
    expect(renewed).not.toBe(session);
    expect(puts()).toHaveLength(1);
  });

  it("erro de validação: o campo marcado com o texto do catálogo, o rascunho de volta e nenhum PUT", async () => {
    await openCriteria();
    await fill();
    await field("stack.dealBreakers").fill("typescript");
    const landed = await save();
    expect(landed.searchParams.get("aviso")).toBe("criterios_invalidos");
    expect(await tab.page.locator('[data-erro="stack"]').innerText()).toBe(CRITERIA_FIELD_ERRORS.stack);
    expect(await tab.page.locator('fieldset[data-secao="stack"]').getAttribute("aria-invalid")).toBe("true");
    expect(await field("stack.dealBreakers").inputValue()).toBe("typescript");
    expect(puts()).toHaveLength(0);
  });

  it("nada sensível na saída do processo do portal: nem a pretensão, nem o rascunho, nem os tokens (SR-12)", () => {
    const output = stack.output();
    expect(output).toContain("Ready");
    expect(seen.size).toBeGreaterThan(Object.keys(GOTRUE_CANARIES).length + 10);
    expect(secretsIn(output, seen)).toEqual([]);
    expect(secretsIn(`${output}${SALARY_CANARY_TEXT}`, seen)).toEqual([SALARY_CANARY_TEXT]);
  });
});
