// F1-EXT-04 parte 1 no navegador real, com o build de PRODUÇÃO (ADR-025 D6).
// 1) Porta falsa: um script de início troca o `browser` do painel (o wxt/browser usa
//    `globalThis.browser` quando ele tem `runtime.id`) por uma porta que entrega eventos de stream de
//    fixture do contrato, inclusive hostis. É o React minificado de verdade renderizando.
// 2) Porta real: o consentimento passa pelo Service Worker e fica só em storage.session.
// Nenhuma chamada de rede: a API ainda não está ligada (connect-src 'none').
import { ApiErrorCodeSchema } from "@trampo/contracts/api";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";

import { CONSENT_STORAGE_KEY } from "../../src/consent/consent-service";
import { CONSENT_VERSION, PANEL_PORT_NAME } from "../../src/messaging/protocol";
import { ERROR_TEXTS, WARNING_LABELS } from "../../src/panel/texts";
import { HOSTILE_CANARY, HOSTILE_REPORTS, REPORT, apiError, result, stage } from "../fixtures/stream";
import { loadExtension, unload, type Loaded } from "./browser";

const cfg = inject("e2e");

declare const chrome: (typeof import("wxt/browser"))["browser"];

interface FakeHandle {
  sent: unknown[];
  dropped: () => number;
  emit: (message: unknown) => void;
}
declare global {
  // Só existe na página de teste (instalado pelo installFakePort).
  var __trampoFake: FakeHandle | undefined;
}

/** Roda na página do painel antes do bundle: a porta falsa que o App vai usar. */
const installFakePort = (portName: string): void => {
  const onMessage: Array<(m: unknown) => void> = [];
  const sent: unknown[] = [];
  let dropped = 0;
  const port = {
    name: portName,
    postMessage: (m: unknown) => sent.push(JSON.parse(JSON.stringify(m)) as unknown),
    disconnect: () => {
      dropped += 1;
    },
    onMessage: { addListener: (l: (m: unknown) => void) => onMessage.push(l) },
    onDisconnect: { addListener: () => undefined },
  };
  Object.defineProperty(globalThis, "browser", { configurable: true, value: { runtime: { id: "porta-falsa-e2e", connect: () => port } } });
  globalThis.__trampoFake = { sent, dropped: () => dropped, emit: (m) => onMessage.forEach((l) => l(m)) };
};

const READY = { kind: "ready", protocolVersion: 1 };
const PRONTO = { kind: "captura", captura: { estado: "pronto", origem: "pagina", caracteres: 1800, truncado: false } };
const consentimento = (dado: boolean) => ({ kind: "consentimento", dado });

async function fakePanel(l: Loaded, ...initial: unknown[]): Promise<Page> {
  const page = await l.ctx.newPage();
  await page.addInitScript(installFakePort, PANEL_PORT_NAME);
  await page.goto(`chrome-extension://${l.id}/sidepanel.html`);
  await expect.poll(() => page.evaluate(() => globalThis.__trampoFake?.sent.length ?? 0)).toBe(1);
  for (const m of initial) await emit(page, m);
  return page;
}

const emit = (page: Page, message: unknown) => page.evaluate((m) => globalThis.__trampoFake!.emit(m), message);
const sent = (page: Page) => page.evaluate(() => globalThis.__trampoFake!.sent);
const dropped = (page: Page) => page.evaluate(() => globalThis.__trampoFake!.dropped());
const mainText = (page: Page) => page.locator("main").innerText();

/** Nada no painel navega nem carrega recurso: nenhum elemento de link e nenhum atributo que aponte para fora. */
const linkLike = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("main, main *")].flatMap((el) => {
      const hits = ["a", "area", "img", "iframe", "object", "embed", "link"].includes(el.localName) ? [el.localName] : [];
      for (const attr of ["href", "src", "srcset", "action", "formaction", "xlink:href", "ping"]) if (el.hasAttribute(attr)) hits.push(`${el.localName}[${attr}]`);
      return hits;
    }),
  );

const overflowsHorizontally = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

describe("painel de produção com eventos de stream de fixture", () => {
  let l: Loaded | undefined;
  beforeAll(async () => {
    l = await loadExtension(cfg.extNoOrigin);
  });
  afterAll(() => unload(l));

  test("a porta falsa está de fato no lugar: o painel manda o hello por ela", async () => {
    const page = await fakePanel(l!);
    expect(await sent(page)).toEqual([{ kind: "hello", protocolVersion: 1 }]);
    await emit(page, READY);
    await expect.poll(() => page.locator("[data-connection]").getAttribute("data-connection")).toBe("pronto");
    await page.close();
  });

  test("consentimento: o aviso aparece antes de qualquer envio, e o aceite manda só a versão do aviso", async () => {
    const page = await fakePanel(l!, READY, PRONTO, consentimento(false));
    const aviso = page.locator("[data-consentimento]");
    await expect.poll(() => aviso.count()).toBe(1);
    expect(await aviso.innerText()).toMatch(/servidor do Trampo/);
    expect(await aviso.innerText()).toMatch(/provedor de inteligência artificial/);
    expect(await page.locator("[data-acao]").count()).toBe(0);

    await page.getByRole("button", { name: /^Concordo/ }).click();
    expect((await sent(page)).slice(1)).toEqual([{ kind: "consentir", versao: CONSENT_VERSION }]);

    // Só o Service Worker decide: o painel muda quando ele confirma.
    await emit(page, consentimento(true));
    await expect.poll(() => aviso.count()).toBe(0);
    const analisar = page.getByRole("button", { name: "Analisar vaga" });
    expect(await analisar.isDisabled()).toBe(true);
    expect(await mainText(page)).toMatch(/ainda não está ativa nesta versão/);

    await page.getByRole("button", { name: "Retirar o consentimento de envio" }).click();
    expect((await sent(page)).slice(2)).toEqual([{ kind: "revogar" }]);
    await page.close();
  });

  test("sem captura pronta, nem aviso nem botão de análise", async () => {
    const page = await fakePanel(l!, READY, { kind: "captura", captura: { estado: "lendo" } }, consentimento(false));
    await expect.poll(() => page.locator("[data-captura]").getAttribute("data-captura")).toBe("lendo");
    expect(await page.locator("[data-consentimento], [data-acao]").count()).toBe(0);
    await page.close();
  });

  test("estágios do stream: posição no funil e a etapa atual marcada", async () => {
    const page = await fakePanel(l!, READY, PRONTO, consentimento(true));
    await emit(page, stage("recebido", 10));
    await emit(page, stage("extraindo_fatos", 1250));
    const progresso = page.locator('[data-analise="andamento"]');
    await expect.poll(() => progresso.locator("p").innerText()).toBe("Etapa 5 de 6: Lendo os fatos da vaga com IA (1,3 s)");
    expect(await progresso.locator('[data-etapa="feita"]').count()).toBe(4);
    expect(await progresso.locator('[data-etapa="atual"]').innerText()).toBe("Lendo os fatos da vaga com IA");
    expect(await progresso.locator('[data-etapa="pendente"]').count()).toBe(1);
    await page.close();
  });

  test("relatório: só texto, nenhum link, nada de rolagem horizontal, e o Reanalisar desabilitado", async () => {
    const page = await fakePanel(l!, READY, PRONTO, consentimento(true));
    await page.setViewportSize({ width: 320, height: 800 });
    const longo = { ...REPORT, strengths: [{ dimension: "stack", text: "x".repeat(140) }] };
    await emit(page, result(longo));
    const relatorio = page.locator('[data-analise="concluida"]');
    await expect.poll(() => relatorio.count()).toBe(1);
    expect(await relatorio.locator("[data-nota]").innerText()).toBe("78");
    expect(await relatorio.locator("[data-veredito]").innerText()).toBe("Recomendada");
    const texto = await relatorio.innerText();
    expect(texto).toContain(REPORT.summary);
    expect(texto).toContain("Tecnologias: Atende (+30)");
    expect(texto).toContain("Sinais de alerta: Não atende (-7)");
    expect(texto).toContain("Salário: A vaga não informa a faixa salarial.");
    expect(texto).toContain(WARNING_LABELS.texto_truncado);
    expect(texto).toContain("Node.js, TypeScript");
    expect(await linkLike(page)).toEqual([]);
    expect(await overflowsHorizontally(page)).toBe(false);
    expect(await page.getByRole("button", { name: "Reanalisar com IA" }).isDisabled()).toBe(true);

    // Captura nova tira o relatório da tela.
    await emit(page, { kind: "captura", captura: { estado: "lendo" } });
    await expect.poll(() => relatorio.count()).toBe(0);
    await page.close();
  });

  test("erros: o texto sai do catálogo pelo código, nunca do message do servidor", async () => {
    const page = await fakePanel(l!, READY, PRONTO, consentimento(true));
    for (const code of ApiErrorCodeSchema.options) {
      await emit(page, apiError(code, code === "LIMITE_DE_TAXA" ? 120 : null));
      const aviso = page.locator(`[data-erro="${code}"]`);
      await expect.poll(() => aviso.count()).toBe(1);
      const texto = await aviso.innerText();
      expect(texto).toContain(ERROR_TEXTS[code].titulo);
      expect(texto).toContain(ERROR_TEXTS[code].acao);
      expect(texto).not.toContain("Mensagem do servidor");
      if (code === "LIMITE_DE_TAXA") expect(texto).toContain("Tente de novo em 2 minutos.");
    }
    expect(await dropped(page)).toBe(0);
    await page.close();
  });

  test.each(HOSTILE_REPORTS.map(([label, report]) => [label, report] as const))(
    "relatório hostil (%s): a porta cai e nada dele aparece",
    async (_label, report) => {
      const page = await fakePanel(l!, READY, PRONTO, consentimento(true));
      await emit(page, result(report));
      await expect.poll(() => page.locator("[data-connection]").getAttribute("data-connection")).toBe("desconectado");
      expect(await dropped(page)).toBe(1);
      const texto = await mainText(page);
      expect(texto).toMatch(/paramos por segurança/);
      expect(texto).not.toContain(HOSTILE_CANARY);
      expect(await page.locator("[data-analise], [data-acao], img").count()).toBe(0);
      expect(await linkLike(page)).toEqual([]);
      // Depois da queda, nem um relatório válido é renderizado.
      await emit(page, result(REPORT));
      expect(await page.locator('[data-analise="concluida"]').count()).toBe(0);
      await page.close();
    },
  );
});

describe("consentimento com o Service Worker real", () => {
  let l: Loaded | undefined;
  beforeAll(async () => {
    l = await loadExtension(cfg.extNoOrigin);
  });
  afterAll(() => unload(l));

  const stored = () => l!.worker.evaluate(async (key) => (await chrome.storage.session.get(key))[key] as unknown, CONSENT_STORAGE_KEY);

  test("aceite fica só em storage.session, vale para o painel reaberto, e revogar apaga", async () => {
    const panel = l!.panel;
    await expect.poll(() => panel.locator("[data-connection]").getAttribute("data-connection")).toBe("pronto");
    // Texto colado por uma segunda porta da própria página do painel (o caminho confiável).
    await panel.evaluate(
      ([name, texto]) => {
        const port = chrome.runtime.connect({ name });
        port.postMessage({ kind: "hello", protocolVersion: 1 });
        port.postMessage({ kind: "colar", texto });
      },
      [PANEL_PORT_NAME, `Vaga de pessoa desenvolvedora TypeScript. ${"Requisitos e responsabilidades da vaga. ".repeat(8)}`] as const,
    );
    await expect.poll(() => panel.locator("[data-consentimento]").count()).toBe(1);
    expect(await stored()).toBeUndefined();

    await panel.getByRole("button", { name: /^Concordo/ }).click();
    await expect.poll(stored).toEqual({ versao: CONSENT_VERSION, dadoEm: expect.any(Number) });
    await expect.poll(() => panel.locator("[data-consentimento]").count()).toBe(0);
    // eslint-disable-next-line no-restricted-syntax -- só leitura, para provar que nada foi para o disco
    expect(await l!.worker.evaluate(async () => chrome.storage.local.get(null))).toEqual({});

    await panel.reload();
    await expect.poll(() => panel.getByRole("button", { name: "Analisar vaga" }).count()).toBe(1);
    expect(await panel.getByRole("button", { name: "Analisar vaga" }).isDisabled()).toBe(true);
    expect(await linkLike(panel)).toEqual([]);

    await panel.getByRole("button", { name: "Retirar o consentimento de envio" }).click();
    await expect.poll(stored).toBeUndefined();
    await expect.poll(() => panel.locator("[data-consentimento]").count()).toBe(1);
  });
});
