// F1-EXT-04 parte 1 no navegador real, com o build de PRODUÇÃO (ADR-025 D6).
// 1) Porta falsa: um script de início troca o `browser` do painel (o wxt/browser usa
//    `globalThis.browser` quando ele tem `runtime.id`) por uma porta que entrega eventos de stream de
//    fixture do contrato, inclusive hostis. É o React minificado de verdade renderizando.
// 2) Porta real: o consentimento passa pelo Service Worker e fica só em storage.session.
// Nenhuma chamada de rede: a API ainda não está ligada (connect-src 'none').
// F1-EXT-05b, 05b-3 (ADR-004 D12 e §4.4; CA-14): a sessão no React de produção. A porta falsa aceita várias conexões
// e a queda pelo lado do Service Worker; os casos conferem as mensagens exatas enviadas, o texto de cada SessaoView,
// o "entrando" com o relógio do painel, o "Tentar sair de novo" e o "Reconectar", que refaz o handshake numa porta nova.
import { ApiErrorCodeSchema } from "@trampo/contracts/api";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";

import { SESSION_STORAGE_KEY } from "../../src/auth/session-schema";
import { CONSENT_STORAGE_KEY } from "../../src/consent/consent-service";
import { AUTH_PROVIDERS, CONSENT_VERSION, PANEL_PORT_NAME, SessaoErroSchema, SessaoViewSchema, type SessaoView } from "../../src/messaging/protocol";
import { ENTRANDO_TETO_MS } from "../../src/panel/panel-state";
import {
  ANALYZE_BLOCKED_TEXTS,
  ERROR_TEXTS,
  LOGOUT_UNCONFIRMED_TEXT,
  SESSION_ACTION_LABELS,
  SESSION_TEXTS,
  SIGNING_IN_TEXT,
  SIGN_IN_LABELS,
  WARNING_LABELS,
  describeConnection,
  type SessionText,
} from "../../src/panel/texts";
import { HOSTILE_CANARY, HOSTILE_REPORTS, REPORT, apiError, result, stage } from "../fixtures/stream";
import { loadExtension, unload, type Loaded } from "./browser";

const cfg = inject("e2e");

declare const chrome: (typeof import("wxt/browser"))["browser"];

interface FakePort {
  name: string;
  sent: unknown[];
  /** Quantas vezes o painel derrubou esta porta. */
  dropped: number;
}
interface FakeHandle {
  ports: FakePort[];
  /** Entrega a mensagem pela porta `i` (a última, sem `i`), como o Service Worker. */
  emit: (message: unknown, i?: number) => void;
  /** A porta `i` (a última, sem `i`) cai do lado do Service Worker: dispara o onDisconnect do painel. */
  fall: (i?: number) => void;
}
declare global {
  // Só existe na página de teste (instalado pelo installFakePort).
  var __trampoFake: FakeHandle | undefined;
  // Só existe na página de teste (instalado pelo trackIntervals): quantos setInterval estão vivos.
  var __trampoIntervals: (() => number) | undefined;
}

/**
 * Roda na página antes do bundle, depois do relógio falso: conta os `setInterval` vivos. O React não usa intervalo, então
 * a conta é só a do tique do "entrando".
 */
const trackIntervals = (): void => {
  const live = new Set<unknown>();
  const set = globalThis.setInterval.bind(globalThis);
  const clear = globalThis.clearInterval.bind(globalThis);
  globalThis.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id = set(handler, ms, ...args);
    live.add(id);
    return id;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((id?: Parameters<typeof clearInterval>[0]) => {
    live.delete(id);
    clear(id);
  }) as typeof globalThis.clearInterval;
  globalThis.__trampoIntervals = () => live.size;
};

/** Roda na página do painel antes do bundle: o `runtime.connect` falso que o App vai usar. Cada chamada abre uma porta. */
const installFakePort = (): void => {
  const ports: FakePort[] = [];
  const listeners: Array<{ onMessage: Array<(m: unknown) => void>; onDisconnect: Array<() => void> }> = [];
  const connect = ({ name }: { name: string }) => {
    const port: FakePort = { name, sent: [], dropped: 0 };
    const on = { onMessage: [] as Array<(m: unknown) => void>, onDisconnect: [] as Array<() => void> };
    ports.push(port);
    listeners.push(on);
    return {
      name,
      postMessage: (m: unknown) => port.sent.push(JSON.parse(JSON.stringify(m)) as unknown),
      disconnect: () => {
        port.dropped += 1;
      },
      onMessage: { addListener: (l: (m: unknown) => void) => on.onMessage.push(l) },
      onDisconnect: { addListener: (l: () => void) => on.onDisconnect.push(l) },
    };
  };
  const at = (i: number | undefined) => listeners[i ?? listeners.length - 1]!;
  Object.defineProperty(globalThis, "browser", { configurable: true, value: { runtime: { id: "porta-falsa-e2e", connect } } });
  globalThis.__trampoFake = {
    ports,
    emit: (m, i) => at(i).onMessage.forEach((l) => l(m)),
    fall: (i) => at(i).onDisconnect.forEach((l) => l()),
  };
};

const READY = { kind: "ready", protocolVersion: 1 };
const OCIOSO = { kind: "captura", captura: { estado: "ocioso" } };
const PRONTO = { kind: "captura", captura: { estado: "pronto", origem: "pagina", caracteres: 1800, truncado: false } };
const consentimento = (dado: boolean) => ({ kind: "consentimento", dado });
const sessao = (view: SessaoView) => ({ kind: "sessao", sessao: view });
const HELLO = { kind: "hello", protocolVersion: 1 };

const FORA: SessaoView = { autenticado: false, erro: null };
const DENTRO: SessaoView = { autenticado: true, erro: null };
const INDISPONIVEL: SessaoView = { autenticado: false, erro: "SERVICO_INDISPONIVEL" };
/** Handshake inteiro ([ready, captura, consentimento, sessao]) com a sessão dada. */
const handshake = (view: SessaoView, captura: unknown = OCIOSO, dado = false) => [READY, captura, consentimento(dado), sessao(view)];

/** Todas as SessaoView válidas: o produto de autenticado e erro que passa no schema (M-08). */
const VALID_VIEWS: SessaoView[] = [true, false].flatMap((autenticado) =>
  [null, ...SessaoErroSchema.options].flatMap((erro) => {
    const parsed = SessaoViewSchema.safeParse({ autenticado, erro });
    return parsed.success ? [parsed.data] : [];
  }),
);

const panelUrl = (l: Loaded) => `chrome-extension://${l.id}/sidepanel.html`;

/** Abre o painel com a porta falsa e espera o hello. O `before` roda antes do goto (o relógio falso, por exemplo). */
async function fakePanel(l: Loaded, ...initial: unknown[]): Promise<Page> {
  return fakePanelWith(l, async () => undefined, ...initial);
}

async function fakePanelWith(l: Loaded, before: (page: Page) => Promise<void>, ...initial: unknown[]): Promise<Page> {
  const page = await l.ctx.newPage();
  await before(page);
  await page.addInitScript(installFakePort);
  await page.goto(panelUrl(l));
  await expect.poll(() => page.evaluate(() => globalThis.__trampoFake?.ports[0]?.sent.length ?? 0)).toBe(1);
  for (const m of initial) await emit(page, m);
  return page;
}

const emit = (page: Page, message: unknown, i?: number) => page.evaluate(([m, n]) => globalThis.__trampoFake!.emit(m, n ?? undefined), [message, i ?? null] as const);
const fall = (page: Page, i?: number) => page.evaluate((n) => globalThis.__trampoFake!.fall(n ?? undefined), i ?? null);
const ports = (page: Page) => page.evaluate(() => globalThis.__trampoFake!.ports);
/** O que o painel mandou pela porta `i` (a última, sem `i`). */
const sent = async (page: Page, i?: number) => (await ports(page)).at(i ?? -1)!.sent;
const dropped = async (page: Page, i?: number) => (await ports(page)).at(i ?? -1)!.dropped;
const mainText = (page: Page) => page.locator("main").innerText();
const connection = (page: Page) => page.locator("[data-connection]");
/** Os rótulos de todos os botões da tela, na ordem. */
const buttons = (page: Page) => page.locator("main button").allInnerTexts();
const sessionButtons = (page: Page) => page.locator("[data-sessao] button").allInnerTexts();
/** O texto da área da sessão, parágrafo a parágrafo, sem a linha dos botões. */
const sessionLines = (page: Page) => page.locator("[data-sessao] p:not(.acoes)").allInnerTexts();
/** O que a área da sessão mostra para um texto do catálogo. */
const expectedLines = (texto: SessionText) => [texto.estado, ...(texto.erro === null ? [] : [texto.erro.titulo, texto.erro.acao])];
const ENTRAR_BOTOES = AUTH_PROVIDERS.map((p) => SIGN_IN_LABELS[p]);

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
      expect(await page.locator("[data-analise], [data-acao], [data-sessao], img").count()).toBe(0);
      expect(await linkLike(page)).toEqual([]);
      // A resposta inválida é definitiva: nenhum botão, nem o "Reconectar", e nenhuma porta nova (ADR-004 D12).
      expect(await buttons(page)).toEqual([]);
      expect(await ports(page)).toHaveLength(1);
      // Depois da queda, nem um relatório válido é renderizado.
      await emit(page, result(REPORT));
      expect(await page.locator('[data-analise="concluida"]').count()).toBe(0);
      await page.close();
    },
  );
});

describe("sessão no painel de produção, com a porta falsa (ADR-004 D12; CA-14)", () => {
  let l: Loaded | undefined;
  beforeAll(async () => {
    l = await loadExtension(cfg.extNoOrigin);
  });
  afterAll(() => unload(l));

  test("cada SessaoView mostra o texto do catálogo e só os botões oferecidos; com a sessão aberta, nem conta nem provedor", async () => {
    expect(VALID_VIEWS).toHaveLength(8);
    const page = await fakePanel(l!, ...handshake(FORA));
    for (const view of VALID_VIEWS) {
      await emit(page, sessao(view));
      const texto = view.autenticado ? SESSION_TEXTS.conectado[view.erro ?? "nenhum"] : SESSION_TEXTS.desconectado[view.erro ?? "nenhum"];
      const label = JSON.stringify(view);
      await expect.poll(() => sessionLines(page), { message: label }).toEqual(expectedLines(texto));
      expect(await sessionButtons(page), label).toEqual(view.autenticado ? [SESSION_ACTION_LABELS.sair] : ENTRAR_BOTOES);
      expect(await page.locator("[data-sessao-erro]").count(), label).toBe(texto.erro === null ? 0 : 1);
      if (view.autenticado) expect(await mainText(page), label).not.toMatch(/GitHub|Google|@/);
    }
    expect(await linkLike(page)).toEqual([]);
    // Mostrar a sessão não manda nada ao Service Worker: só o hello saiu.
    expect(await sent(page)).toEqual([HELLO]);
    await page.close();
  });

  test.each(AUTH_PROVIDERS.map((provedor) => [provedor] as const))(
    "Entrar com %s manda exatamente { entrar, provedor }, mostra o entrando sem botões, e a próxima sessao o desliga",
    async (provedor) => {
      const page = await fakePanel(l!, ...handshake(FORA));
      await page.getByRole("button", { name: SIGN_IN_LABELS[provedor] }).click();
      await expect.poll(() => sent(page)).toEqual([HELLO, { kind: "entrar", provedor }]);
      await expect.poll(() => sessionLines(page)).toEqual(expectedLines(SIGNING_IN_TEXT));
      expect(await sessionButtons(page)).toEqual([]);
      // O SW emite no fim de cada tentativa; o login concluído mostra só o "Conectado" e o "Sair da conta".
      await emit(page, sessao(DENTRO));
      await expect.poll(() => sessionLines(page)).toEqual(expectedLines(SESSION_TEXTS.conectado.nenhum));
      expect(await sessionButtons(page)).toEqual([SESSION_ACTION_LABELS.sair]);
      expect(await mainText(page)).not.toMatch(/GitHub|Google/);
      expect(await sent(page)).toEqual([HELLO, { kind: "entrar", provedor }]);
      await page.close();
    },
  );

  test("Sair manda { sair }; a falha remota depois do clique mostra o texto do D12 e o Tentar sair de novo, que reenvia sair", async () => {
    const page = await fakePanel(l!, ...handshake(DENTRO));
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole("button", { name: SESSION_ACTION_LABELS.sair }).click();
    await expect.poll(() => sent(page)).toEqual([HELLO, { kind: "sair" }]);
    // O SW apaga o local antes da rede e, depois da repetição automática, avisa que o servidor não confirmou (D11.5).
    await emit(page, sessao(FORA));
    await emit(page, sessao(INDISPONIVEL));
    await expect.poll(() => sessionLines(page)).toEqual(expectedLines(LOGOUT_UNCONFIRMED_TEXT));
    expect(await sessionButtons(page)).toEqual([SESSION_ACTION_LABELS.tentar_sair, ...ENTRAR_BOTOES]);
    expect(await overflowsHorizontally(page)).toBe(false);

    await page.getByRole("button", { name: SESSION_ACTION_LABELS.tentar_sair }).click();
    await expect.poll(() => sent(page)).toEqual([HELLO, { kind: "sair" }, { kind: "sair" }]);
    // O texto fica até a próxima resposta; a confirmação devolve o texto geral.
    expect(await sessionLines(page)).toEqual(expectedLines(LOGOUT_UNCONFIRMED_TEXT));
    await emit(page, sessao(FORA));
    await expect.poll(() => sessionLines(page)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
    expect(await sessionButtons(page)).toEqual(ENTRAR_BOTOES);
    expect(await linkLike(page)).toEqual([]);
    await page.close();
  });

  test("a mesma falha sem o clique em Sair tem o texto geral, sem o Tentar sair de novo", async () => {
    const page = await fakePanel(l!, ...handshake(INDISPONIVEL));
    await expect.poll(() => sessionLines(page)).toEqual(expectedLines(SESSION_TEXTS.desconectado.SERVICO_INDISPONIVEL));
    expect(await sessionButtons(page)).toEqual(ENTRAR_BOTOES);
    await page.close();
  });

  test("o entrando desliga no teto de 310 s pelo relógio do painel, e também com o relógio que volta, sem mandar nada ao SW", async () => {
    const inicio = Date.UTC(2026, 10, 9, 12);
    const page = await fakePanelWith(
      l!,
      async (p) => {
        await p.clock.install({ time: inicio });
        await p.addInitScript(trackIntervals);
      },
      ...handshake(FORA),
    );
    const intervals = () => page.evaluate(() => globalThis.__trampoIntervals!());
    await page.clock.pauseAt(inicio + 60_000);
    // O tique só fica armado durante o "entrando".
    expect(await intervals()).toBe(0);
    const entrando = expectedLines(SIGNING_IN_TEXT);
    await page.getByRole("button", { name: SIGN_IN_LABELS.github }).click();
    await expect.poll(() => sessionLines(page)).toEqual(entrando);
    await expect.poll(intervals).toBe(1);

    // Um segundo antes do teto, ainda entrando.
    await page.clock.runFor(ENTRANDO_TETO_MS - 1_000);
    await page.waitForTimeout(200);
    expect(await sessionLines(page)).toEqual(entrando);
    expect(await sessionButtons(page)).toEqual([]);
    // No teto, os botões e o texto da sessão voltam, e o tique é desarmado.
    await page.clock.runFor(1_000);
    await expect.poll(() => sessionButtons(page)).toEqual(ENTRAR_BOTOES);
    expect(await sessionLines(page)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
    await expect.poll(intervals).toBe(0);

    // Relógio que volta: o tique seguinte desliga o entrando (falha segura).
    await page.getByRole("button", { name: SIGN_IN_LABELS.google }).click();
    await expect.poll(() => sessionLines(page)).toEqual(entrando);
    await page.waitForTimeout(200);
    await page.clock.setSystemTime(inicio);
    await page.clock.runFor(1_000);
    await expect.poll(() => sessionButtons(page)).toEqual(ENTRAR_BOTOES);
    await expect.poll(intervals).toBe(0);
    // O relógio não manda nada: só os dois cliques saíram.
    expect(await sent(page)).toEqual([HELLO, { kind: "entrar", provedor: "github" }, { kind: "entrar", provedor: "google" }]);
    await page.close();
  });

  test("Reconectar só aparece na queda da porta e só age no clique: porta nova, hello novo, handshake refeito e a porta antiga ignorada", async () => {
    const page = await fakePanel(l!, ...handshake(DENTRO, PRONTO, true));
    await expect.poll(() => sessionButtons(page)).toEqual([SESSION_ACTION_LABELS.sair]);
    await fall(page);
    await expect.poll(() => connection(page).innerText()).toBe(describeConnection({ conexao: "desconectado", queda: "porta_fechada" }));
    // Na queda, o único botão é o Reconectar, e nada reconecta sozinho (condição 3 do [APPSEC]).
    expect(await buttons(page)).toEqual([SESSION_ACTION_LABELS.reconectar]);
    await page.waitForTimeout(1_000);
    expect(await ports(page)).toHaveLength(1);

    await page.getByRole("button", { name: SESSION_ACTION_LABELS.reconectar }).click();
    await expect.poll(async () => (await ports(page)).length).toBe(2);
    // A porta antiga já tinha caído: o painel não a derruba de novo nem manda nada por ela.
    expect(await ports(page)).toEqual([
      { name: PANEL_PORT_NAME, sent: [HELLO], dropped: 0 },
      { name: PANEL_PORT_NAME, sent: [HELLO], dropped: 0 },
    ]);
    await expect.poll(() => connection(page).getAttribute("data-connection")).toBe("conectando");
    expect(await buttons(page)).toEqual([]);

    // O que ainda chegar pela porta antiga é ignorado: nem mensagem nem queda mudam a tela.
    for (const m of handshake(DENTRO)) await emit(page, m, 0);
    await fall(page, 0);
    await page.waitForTimeout(200);
    expect(await connection(page).getAttribute("data-connection")).toBe("conectando");
    expect(await buttons(page)).toEqual([]);

    // O handshake novo vale, e o clique seguinte sai pela porta nova.
    for (const m of handshake(DENTRO, PRONTO, true)) await emit(page, m);
    await expect.poll(() => sessionButtons(page)).toEqual([SESSION_ACTION_LABELS.sair]);
    expect(await sessionLines(page)).toEqual(expectedLines(SESSION_TEXTS.conectado.nenhum));
    await page.getByRole("button", { name: SESSION_ACTION_LABELS.sair }).click();
    await expect.poll(() => sent(page)).toEqual([HELLO, { kind: "sair" }]);
    expect(await sent(page, 0)).toEqual([HELLO]);
    expect(await ports(page)).toHaveLength(2);
    await page.close();
  });

  test("com sessão e consentimento, o Analisar segue desabilitado pelo portão: o envio à API é da F1-EXT-04 parte 2", async () => {
    const page = await fakePanel(l!, ...handshake(DENTRO, PRONTO, true));
    const analisar = page.getByRole("button", { name: "Analisar vaga" });
    await expect.poll(() => analisar.count()).toBe(1);
    expect(await analisar.isDisabled()).toBe(true);
    expect(await page.locator("[data-bloqueio]").getAttribute("data-bloqueio")).toBe("sem_api");
    expect(await page.locator("[data-bloqueio]").innerText()).toBe(ANALYZE_BLOCKED_TEXTS.sem_api);
    await page.close();
  });
});

describe("sessão com o Service Worker real (build sem as origens)", () => {
  let l: Loaded | undefined;
  beforeAll(async () => {
    l = await loadExtension(cfg.extNoOrigin);
  });
  afterAll(() => unload(l));

  test("Entrar chega ao SW, que responde { false, ERRO_INTERNO } sem abrir janela: o painel mostra o texto do catálogo e os botões de volta", async () => {
    const panel = l!.panel;
    await expect.poll(() => sessionLines(panel)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
    expect(await sessionButtons(panel)).toEqual(ENTRAR_BOTOES);
    const pages = l!.ctx.pages().length;
    await panel.getByRole("button", { name: SIGN_IN_LABELS.github }).click();
    await expect.poll(() => sessionLines(panel)).toEqual(expectedLines(SESSION_TEXTS.desconectado.ERRO_INTERNO));
    expect(await sessionButtons(panel)).toEqual(ENTRAR_BOTOES);
    expect(l!.ctx.pages()).toHaveLength(pages);
    expect(await l!.worker.evaluate(async (key) => (await chrome.storage.session.get(key))[key] as unknown, SESSION_STORAGE_KEY)).toBeUndefined();
  });

  test("o SW parado por CDP derruba a porta; o Reconectar acorda o SW e refaz o handshake (ADR-004 §4.4, cenário 11)", async () => {
    const panel = l!.panel;
    await expect.poll(() => connection(panel).getAttribute("data-connection")).toBe("pronto");
    const { targetInfos } = (await l!.cdp.send("Target.getTargets" as never)) as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${l!.id}/`));
    expect(sw).toBeDefined();
    await l!.cdp.send("Target.closeTarget" as never, { targetId: sw!.targetId } as never);
    await expect.poll(() => connection(panel).getAttribute("data-connection")).toBe("desconectado");
    expect(await buttons(panel)).toEqual([SESSION_ACTION_LABELS.reconectar]);

    await panel.getByRole("button", { name: SESSION_ACTION_LABELS.reconectar }).click();
    await expect.poll(() => connection(panel).getAttribute("data-connection"), { timeout: 10_000 }).toBe("pronto");
    await expect.poll(() => sessionLines(panel)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
    expect(await sessionButtons(panel)).toEqual(ENTRAR_BOTOES);
  });
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
