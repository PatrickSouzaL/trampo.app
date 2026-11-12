// F1-EXT-05c, 05c-3 (ADR-004 §4.5, SR-23, CA-04): as provas negativas depois de todos os cenários, no build de PRODUÇÃO
// com as duas origens locais e a chave efêmera (modo 1 do P20). Cada arquivo E2E tem o seu navegador, então "depois de
// todos" quer dizer: num navegador só, com os coletores ligados antes do load (o CDP próprio do `cdp-tap.ts`) e antes do
// `goto` do painel (o espião, por `addInitScript`), o teste refaz em sequência os cenários que geram canário (1 com o
// GitHub, 13, 14, 8, 7 nas três formas, 1 com o Google e a captura com a sessão ativa) e só então confere os itens 1 a 4
// e 6 a 10 do §4.5. O 6 (recarga e reinício) troca o navegador e o 9 não gera canário: ficam nos arquivos deles. Cada "0"
// tem o seu controle positivo (condição 3 do [APPSEC]), e os controles nunca são canários.
// F1-EXT-04 parte 2, 04b-3 (ADR-025 §6.5 D25): os cenários 12, 3, 5 e 4 do envio entram na sequência, com a vaga capturada
// na aba e um texto de vaga canário. Ele chega ao BFF falso (controle positivo, pelo hash) e fica só no storage.session do
// SW e na própria aba: nunca na porta, no DOM nem no heap do painel, no console de nenhum alvo, nem em local e sync.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";

import { CAPTURE_STORAGE_KEY } from "../../src/capture/capture-service";
import { SESSION_STORAGE_KEY } from "../../src/auth/session-schema";
import { LOGOUT_UNCONFIRMED_TEXT, SESSION_ACTION_LABELS, SESSION_TEXTS, SIGN_IN_LABELS, type SessionText } from "../../src/panel/texts";
import { REPORT } from "../fixtures/stream";
import { browserPath, clickAction, loadExtension, stopWorker, unload, type Loaded } from "./browser";
import type { TapEvent, TapRequest } from "./cdp-tap";
import { SPIED_APIS, SPY_CONTROL_CALLS, dumpWorld, exerciseSpiedApis, heapText, inIsolated, isolatedDump, panelSpy, spyReport } from "./probes";
import { connection, expectedLines, observeSessions, originStorage, panelDump, removeStorage, sessionButtons, sessionLines, setStorage, storage } from "./session";
import { LONG_TOKEN, findCanaries } from "./support/canaries";
import { type AuthorizeScript, textDigest } from "./support/fake-auth";
import { ANALYZE_PATH, fakeControl } from "./support/fake-servers";
import { canaryFragments, consoleText, findCanaryFragments, requestViolations } from "./support/leaks";
import { p20ModeFor } from "./support/p20";

const cfg = inject("e2e");
const control = fakeControl(cfg.control.url, cfg.control.token);
const ORIGIN = `chrome-extension://${cfg.extensionId}`;
const ENTRAR = [SIGN_IN_LABELS.github, SIGN_IN_LABELS.google];
/** Os retornos do chromiumapp que o roteiro produz: o `/auth` de sempre e o `/outro` do cenário 7. */
const CHROMIUMAPP_PATHS = ["/auth", "/outro"] as const;

// Navegador fora da tabela do P20 não roda o E2E de login (§4.4, "Emenda do 05c-1").
p20ModeFor(String(browserPath));

declare const chrome: (typeof import("wxt/browser"))["browser"];

/** Controle positivo: nunca canário, sempre novo, e com cara de texto do teste. */
const newControl = (what: string) => `CONTROLE-${what}-${randomBytes(12).toString("hex")}`;

/** O texto de vaga canário (04b-3), montado em tempo de execução: vai à API falsa e nunca ao painel. */
const JOB_CANARY = `CANARIO-VAGA-${randomBytes(12).toString("hex")}`;
const JOB_TEXT =
  "Buscamos pessoa desenvolvedora TypeScript pleno para o time de plataforma. Você vai manter a API em Node.js, " +
  `escrever testes automatizados e revisar código com o time. Requisitos: TypeScript, React, Node.js e filas. Regime CLT, remoto. Referência ${JOB_CANARY}.`;
const JOB_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Vaga</title></head>
<body><main><h1>Desenvolvedora TypeScript Pleno</h1><p>${JOB_TEXT}</p></main></body></html>`;

let server: Server;
let jobUrl = "";
let l: Loaded | undefined;
let sessoes: () => Promise<unknown[]>;
/** Os controles plantados na aba pelo item 6, que o item 3 procura no heap da aba. */
const planted = { main: "", isolated: "" };

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url !== "/vaga") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(JOB_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  jobUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/vaga`;

  await control.reset();
  l = await loadExtension(cfg.extAuth, { chromiumappPort: cfg.chromiumappPort, tap: true,
    beforePanel: async (panel) => {
      await panel.addInitScript(panelSpy);
    },
  });
  // Um cookie para o host das duas origens falsas (cookie não separa porta): o perfil o tem, e o api-client do SW
  // (`credentials: "omit"`) nunca o manda ao BFF. O controle positivo, no item 10, é uma navegação comum que o leva.
  await l.ctx.addCookies([{ name: "trampo_e2e", value: randomBytes(16).toString("hex"), domain: "localhost", path: "/", secure: true, sameSite: "None" }]);
  await l.panel.getByRole("button", { name: SIGN_IN_LABELS.github }).waitFor();
  sessoes = await observeSessions(l);
});
afterAll(async () => {
  await unload(l);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function signIn(provider: "github" | "google"): Promise<void> {
  await l!.panel.getByRole("button", { name: SIGN_IN_LABELS[provider] }).click();
  await expect.poll(() => sessionLines(l!), { timeout: 15_000 }).toEqual(expectedLines(SESSION_TEXTS.conectado.nenhum));
}

/** "Entrar com GitHub" com o roteiro armado (cenários 7 e 8), até a `sessao` da tentativa. */
async function scripted(script: AuthorizeScript, view: { autenticado: false; erro: "ERRO_INTERNO" | null }, texto: SessionText): Promise<void> {
  await control.script({ authorize: script });
  const before = (await sessoes()).length;
  await l!.panel.getByRole("button", { name: SIGN_IN_LABELS.github }).click();
  await expect.poll(sessoes, { timeout: 15_000 }).toHaveLength(before + 1);
  expect((await sessoes()).at(-1)).toEqual(view);
  await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(texto));
  expect((await control.state()).auth.roteiro.at(-1)).toBe(`authorize:${script}`);
}

const canaries = async () => (await control.state()).auth.canaries;
/** O que nunca pode aparecer no painel nem em log: os canários dos falsos e o texto de vaga canário. */
const secrets = async () => [...(await canaries()), JOB_CANARY];

const analysisButton = () => l!.panel.locator("[data-acao] button");
const report = () => l!.panel.locator('[data-analise="concluida"]');
/** Clica no botão da análise que a tela oferece e espera o que o teste disser. */
async function analyze(): Promise<void> {
  await expect.poll(() => analysisButton().count()).toBe(1);
  await analysisButton().click();
}
const capturedText = async () => ((await storage(l!, "session"))[CAPTURE_STORAGE_KEY] as { vaga?: { text?: string } } | undefined)?.vaga?.text;
const panelTargetId = async (): Promise<string> => {
  const cdp = await l!.ctx.newCDPSession(l!.panel);
  try {
    return (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
  } finally {
    await cdp.detach();
  }
};

describe("os cenários que geram canário, em sequência, no mesmo navegador (ADR-004 §4.4)", () => {
  test("cenário 1: Entrar com GitHub completa o login, e o espião e o coletor já estavam ligados", async () => {
    await signIn("github");
    expect((await storage(l!, "session"))[SESSION_STORAGE_KEY]).toMatchObject({ accessToken: (await control.state()).auth.accessTokens[0] });
    expect(l!.tap?.targets().some((t) => t.type === "service_worker" && t.url.startsWith(`${ORIGIN}/`))).toBe(true);
  });

  // O SW parado volta no mesmo alvo CDP (o Chromium mantém o agente do SW entre a parada e a partida), então o `Worker`
  // do Playwright e a sessão do coletor seguem os mesmos. A marca global que some prova que o SW reiniciou de fato.
  test("cenário 13: com sessão, o SW parado e o Reconectar; a sessão sobrevive no SW reiniciado", async () => {
    await l!.worker.evaluate(() => {
      (globalThis as unknown as { __trampoMarca?: number }).__trampoMarca = 1;
    });
    await stopWorker(l!);
    await expect.poll(() => connection(l!)).toBe("desconectado");
    await l!.panel.getByRole("button", { name: SESSION_ACTION_LABELS.reconectar }).click();
    await expect.poll(() => connection(l!), { timeout: 10_000 }).toBe("pronto");
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.conectado.nenhum));
    expect(await l!.worker.evaluate(() => (globalThis as unknown as { __trampoMarca?: number }).__trampoMarca)).toBeUndefined();
    expect(l!.ctx.serviceWorkers().filter((w) => w.url().startsWith(`${ORIGIN}/`))).toEqual([l!.worker]);
    // A porta do observador caiu com o SW: um observador novo, no SW reiniciado.
    sessoes = await observeSessions(l!);
  });

  test("cenário 14: dois 503 no logout, o Tentar sair de novo e o encerramento com o mesmo Bearer", async () => {
    await control.script({ logout503: 2 });
    await l!.panel.getByRole("button", { name: SESSION_ACTION_LABELS.sair }).click();
    await expect.poll(() => sessionLines(l!), { timeout: 10_000 }).toEqual(expectedLines(LOGOUT_UNCONFIRMED_TEXT));
    await l!.panel.getByRole("button", { name: SESSION_ACTION_LABELS.tentar_sair }).click();
    await expect.poll(async () => (await control.state()).auth.counters.logout).toEqual({ ok: 1, recusado: 2 });
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
    expect(await sessionButtons(l!)).toEqual(ENTRAR);
  });

  test("cenário 8: o cancelamento com error_description=CANARIO-ERR-<uuid>", async () => {
    await scripted("cancelar", { autenticado: false, erro: null }, SESSION_TEXTS.desconectado.nenhum);
  });

  test.each(["outro_caminho", "fragmento", "outro_challenge"] as const)("cenário 7: o retorno adulterado (%s)", async (script) => {
    await scripted(script, { autenticado: false, erro: "ERRO_INTERNO" }, SESSION_TEXTS.desconectado.ERRO_INTERNO);
  });

  test("cenário 1 com o Google e a captura na aba da vaga com a sessão ativa", async () => {
    await signIn("google");
    const tab = await l!.ctx.newPage();
    await tab.goto(jobUrl);
    await clickAction(l!, jobUrl);
    const captured = () =>
      l!.worker.evaluate(async (key) => ((await chrome.storage.session.get(key))[key] as { estado?: string } | undefined)?.estado, CAPTURE_STORAGE_KEY);
    await expect.poll(captured, { timeout: 10_000 }).toBe("pronto");
    await expect.poll(() => l!.panel.locator("[data-captura]").getAttribute("data-captura")).toBe("pronto");
    const state = await control.state();
    expect(state.auth.counters).toEqual({
      authorize: { ok: 6, recusado: 0 },
      exchange: { ok: 2, recusado: 1 },
      refresh: { ok: 0, recusado: 0 },
      logout: { ok: 1, recusado: 2 },
      analyze: { ok: 0, recusado: 0 },
    });
    expect(state.auth.roteiro).toEqual(["logout:503", "logout:503", "authorize:cancelar", "authorize:outro_caminho", "authorize:fragmento", "authorize:outro_challenge"]);
  });

  test("cenário 12 e o envio: a vaga capturada na aba vai à API falsa com o Bearer da sessão, e o texto canário chega lá (controle positivo)", async () => {
    await l!.panel.getByRole("button", { name: /^Concordo/ }).click();
    await analyze();
    await expect.poll(() => report().count(), { timeout: 10_000 }).toBe(1);
    const captured = await capturedText();
    // O canário está no texto capturado, e o hash do que o BFF falso recebeu é o dele.
    expect(captured).toContain(JOB_CANARY);
    const state = await control.state();
    expect(state.auth.analyses).toHaveLength(1);
    expect(state.auth.analyses[0]).toMatchObject({ textDigest: textDigest(String(captured)), textLength: String(captured).length, platform: "generico", resposta: "stream" });
    expect(state.auth.accessTokens[state.auth.analyses[0]?.access ?? -1]).toBe(((await storage(l!, "session"))[SESSION_STORAGE_KEY] as { accessToken: string }).accessToken);
  });

  test("cenário 3: o 401 com a renovação e o reenvio, e depois a renovação presa com a análise em curso; os canários seguem fora do painel", async () => {
    await control.script({ expiresIn: 30, analyze: ["401"] });
    await analyze();
    await expect.poll(async () => (await control.state()).auth.analyses.length, { timeout: 10_000 }).toBe(3);
    await expect.poll(() => report().count(), { timeout: 10_000 }).toBe(1);

    // O par novo vive 30 s: o próximo accessToken() renova, e a renovação fica presa com a análise em curso.
    await control.script({ refresh: ["segurar"] });
    await analyze();
    await expect.poll(async () => (await control.state()).segurados).toBe(1);
    await expect.poll(() => l!.panel.locator('[data-analise="enviando"]').count()).toBe(1);
    expect(findCanaries(await panelDump(l!), await secrets())).toEqual([]);
    expect(await control.release()).toBe(1);
    await expect.poll(() => report().count(), { timeout: 10_000 }).toBe(1);
    expect((await control.state()).auth.counters).toMatchObject({ refresh: { ok: 2, recusado: 0 }, analyze: { ok: 3, recusado: 1 } });
    expect(findCanaries(await panelDump(l!), await secrets())).toEqual([]);
  });

  test("cenário 5: 503 na renovação com a sessão viva, a recuperação na análise seguinte, e um erro fora do contrato com texto canário", async () => {
    await control.script({ refresh: ["503"] });
    const before = (await sessoes()).length;
    await analyze();
    await expect.poll(sessoes, { timeout: 10_000 }).toHaveLength(before + 1);
    expect((await sessoes()).at(-1)).toEqual({ autenticado: true, erro: "SERVICO_INDISPONIVEL" });
    // O token guardado ainda não venceu: a análise sai com ele.
    await expect.poll(() => report().count(), { timeout: 10_000 }).toBe(1);
    await analyze();
    await expect.poll(sessoes, { timeout: 10_000 }).toHaveLength(before + 2);
    expect((await sessoes()).at(-1)).toEqual({ autenticado: true, erro: null });
    await expect.poll(() => report().count(), { timeout: 10_000 }).toBe(1);

    await control.script({ analyze: ["fora_do_contrato"] });
    await analyze();
    await expect.poll(() => l!.panel.locator('[data-erro="SERVICO_INDISPONIVEL"]').count(), { timeout: 10_000 }).toBe(1);
    expect((await canaries()).at(-1)).toMatch(/^CANARIO-ERR-/);
  });

  test("cenário 4: a sessão revogada no servidor; a renovação leva 401, a sessão é apagada, e um login novo volta a analisar", async () => {
    expect(await control.revoke()).toBe(1);
    await analyze();
    await expect.poll(() => sessionLines(l!), { timeout: 10_000 }).toEqual(expectedLines(SESSION_TEXTS.desconectado.NAO_AUTENTICADO));
    expect((await sessoes()).at(-1)).toEqual({ autenticado: false, erro: "NAO_AUTENTICADO" });
    expect((await storage(l!, "session"))[SESSION_STORAGE_KEY]).toBeUndefined();

    // As provas contam com a sessão aberta e com um relatório na tela: o prazo volta aos 900 s para o par novo.
    await control.script({ expiresIn: 900 });
    await signIn("github");
    await analyze();
    await expect.poll(() => report().count(), { timeout: 10_000 }).toBe(1);
    const state = await control.state();
    expect(state.auth.counters).toEqual({
      authorize: { ok: 7, recusado: 0 },
      exchange: { ok: 3, recusado: 1 },
      refresh: { ok: 4, recusado: 2 },
      logout: { ok: 1, recusado: 2 },
      analyze: { ok: 6, recusado: 2 },
    });
    expect(state.auth.roteiro.slice(6)).toEqual(["analyze:401", "refresh:segurar", "refresh:503", "analyze:fora_do_contrato", "revogar"]);
  });
});

describe("provas negativas do §4.5, depois de todos os cenários (SR-23, CA-04)", () => {
  const tab = () => {
    const page = l!.ctx.pages().find((p) => p.url() === jobUrl);
    if (page === undefined) throw new Error("a aba da vaga fechou");
    return page;
  };

  test("item 10: no total, a troca e a renovação sem Authorization nem Cookie, o logout com Bearer e o Supabase sem Authorization", async () => {
    const state = await control.state();
    expect(requestViolations(state, ORIGIN, CHROMIUMAPP_PATHS)).toEqual([]);
    const posts = (path: string) => state.requests.filter((r) => r.server === "bff" && r.method === "POST" && r.path === path).length;
    expect({ exchange: posts("/v1/auth/exchange"), logout: posts("/v1/auth/logout"), refresh: posts("/v1/auth/refresh"), analyze: posts(ANALYZE_PATH) }).toEqual({
      exchange: 4,
      logout: 3,
      refresh: 6,
      analyze: 8,
    });
    const authorize = state.requests.filter((r) => r.server === "supabase");
    expect(authorize).toHaveLength(7);
    // Observação para o P14 (cookies do perfil no fluxo do IdP), sem asserção: o Supabase falso pode ver o cookie.
    console.info(`[05c-3] authorize com o cookie do perfil: ${authorize.filter((r) => r.cookie).length} de ${authorize.length}`);

    // Controle positivo: o cookie existe no perfil, e uma navegação comum ao BFF falso o leva (e não tem a origem certa).
    expect(await l!.ctx.cookies(cfg.apiOrigin)).toHaveLength(1);
    const page = await l!.ctx.newPage();
    await page.goto(`${cfg.apiOrigin}/v1/health`).catch(() => undefined);
    await page.close();
    expect(requestViolations(await control.state(), ORIGIN, CHROMIUMAPP_PATHS)).toEqual(["bff GET /v1/health: origem diferente da extensão", "bff GET /v1/health: Cookie"]);
  });

  test("item 1: o espião do painel registrou a porta nas duas direções, sem canário, e 0 chamadas em todo o resto", async () => {
    const report = await spyReport(l!.panel);
    expect(report.missing).toEqual([]);
    expect(Object.fromEntries(SPIED_APIS.map((name) => [name, report.calls[name]]))).toEqual(Object.fromEntries(SPIED_APIS.map((name) => [name, 0])));
    // A porta do painel, a do observador e a do Reconectar: o espião viu o tráfego (o controle positivo do registro).
    expect(report.calls["runtime.connect"]).toBeGreaterThanOrEqual(3);
    expect(report.messages.filter((m) => m.startsWith("in ") && m.includes('"kind":"sessao"')).length).toBeGreaterThan(5);
    expect(report.messages.filter((m) => m.startsWith("out ") && m.includes('"kind":"entrar"')).length).toBe(7);
    // Os 8 cliques da análise saíram só com o modo, e os eventos do stream chegaram (controle positivo do registro).
    expect(report.messages.filter((m) => m.startsWith("out ") && m.includes('"kind":"analisar"')).length).toBe(8);
    expect(report.messages.filter((m) => m.startsWith("in ") && m.includes('"kind":"stream"')).length).toBeGreaterThan(8);
    const text = report.messages.join("\n");
    expect(findCanaries(text, await secrets())).toEqual([]);
    expect(text).not.toMatch(LONG_TOKEN);
  });

  test("item 2: o texto e os atributos do DOM do painel, no fim, sem canário", async () => {
    const dump = await panelDump(l!);
    expect(dump).toContain(SESSION_TEXTS.conectado.nenhum.estado);
    // O relatório da última análise está na tela (controle positivo), sem o texto da vaga.
    expect(dump).toContain(REPORT.summary);
    expect(findCanaries(dump, await secrets())).toEqual([]);
    expect(dump).not.toMatch(LONG_TOKEN);
  });

  test("item 6: a aba da vaga, nos mundos MAIN e ISOLATED, sem canário; cada mundo vê o seu controle e não o do outro", async () => {
    const all = await canaries();
    const main = await tab().evaluate(dumpWorld);
    const isolated = await isolatedDump(l!.ctx, tab(), cfg.extensionId);
    for (const dump of [main, isolated]) {
      expect(dump).toContain(JOB_TEXT);
      expect(findCanaries(dump, all)).toEqual([]);
      expect(dump).not.toMatch(LONG_TOKEN);
    }
    planted.main = newControl("MAIN");
    planted.isolated = newControl("ISOLATED");
    await tab().evaluate((value) => {
      (globalThis as unknown as Record<string, string>)["__trampoControleMain"] = value;
    }, planted.main);
    expect(await inIsolated(l!, jobUrl, "plantar", planted.isolated)).toEqual({ plantado: "ok" });
    const mainAfter = await tab().evaluate(dumpWorld);
    const isolatedAfter = await isolatedDump(l!.ctx, tab(), cfg.extensionId);
    expect(findCanaries(mainAfter, [planted.main, planted.isolated])).toEqual([planted.main]);
    expect(findCanaries(isolatedAfter, [planted.main, planted.isolated])).toEqual([planted.isolated]);
  });

  test("item 3: o heap snapshot do painel e o da aba sem nenhum trecho de 16 caracteres de canário; os controles aparecem", async () => {
    const fragments = canaryFragments(await canaries());
    // O painel tem um canário a mais para não ter: o texto da vaga, que a aba tem por definição.
    const panelFragments = canaryFragments(await secrets());
    const panelControl = newControl("HEAP");
    // A forma em que um canário chegaria ao painel: texto plano de mensagem ou de JSON.
    await l!.panel.evaluate((value) => {
      (globalThis as unknown as Record<string, string>)["__trampoControleHeap"] = (JSON.parse(JSON.stringify({ value })) as { value: string }).value;
    }, panelControl);
    const panelHeap = await heapText(l!.ctx, l!.panel);
    const tabHeap = await heapText(l!.ctx, tab());
    expect(findCanaryFragments(panelHeap, panelFragments)).toEqual([]);
    expect(findCanaryFragments(tabHeap, fragments)).toEqual([]);
    // Controles: o do painel no heap do painel; os dois mundos da aba (item 6) no heap da aba, que é um só para os dois.
    expect(findCanaryFragments(panelHeap, canaryFragments([panelControl]))).toEqual([panelControl]);
    expect(findCanaryFragments(tabHeap, canaryFragments([planted.isolated, planted.main]))).toEqual([planted.isolated, planted.main]);
    console.info(`[05c-3] heap do painel ${(panelHeap.length / 1e6).toFixed(1)} MB e da aba ${(tabHeap.length / 1e6).toFixed(1)} MB; ${fragments.canaries.length} canários`);
  });

  test("item 7: no mundo ISOLATED da aba, o storage.session.get e o getKeys falham por contexto; o storage.local responde", async () => {
    expect(await inIsolated(l!, jobUrl, "storage")).toEqual({
      "session.get": "Access to storage is not allowed from this context.",
      "session.getKeys": "Access to storage is not allowed from this context.",
      "local.get": "ok",
    });
  });

  test("item 8: a origem da extensão sem resto (local, sync, localStorage, IndexedDB e CacheStorage); cada leitor vê o seu controle", async () => {
    expect(await storage(l!, "local")).toEqual({});
    expect(await storage(l!, "sync")).toEqual({});
    expect(await originStorage(l!)).toEqual({ localStorage: [], indexedDB: [], cacheStorage: [] });
    // O texto da vaga fica só no storage.session do SW (ADR-024 D4): o controle positivo do leitor para o canário dele.
    expect(findCanaries(JSON.stringify(await storage(l!, "session")), [JOB_CANARY])).toEqual([JOB_CANARY]);

    for (const area of ["local", "sync"] as const) {
      await setStorage(l!, area, { controle: "1" });
      expect(await storage(l!, area)).toEqual({ controle: "1" });
      await removeStorage(l!, area, ["controle"]);
      expect(await storage(l!, area)).toEqual({});
    }
    await l!.panel.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          localStorage.setItem("controle", "1");
          const open = indexedDB.open("controle");
          open.onsuccess = () => {
            open.result.close();
            void caches.open("controle").then(() => resolve(), reject);
          };
          open.onerror = () => reject(new Error("IndexedDB"));
        }),
    );
    expect(await originStorage(l!)).toEqual({ localStorage: [["controle", "1"]], indexedDB: ["controle"], cacheStorage: ["controle"] });
    await l!.panel.evaluate(
      () =>
        new Promise<void>((resolve) => {
          localStorage.clear();
          indexedDB.deleteDatabase("controle").onsuccess = () => void caches.delete("controle").then(() => resolve());
        }),
    );
    expect(await originStorage(l!)).toEqual({ localStorage: [], indexedDB: [], cacheStorage: [] });
  });

  test("item 4: a rede do painel, ligada antes do goto, tem só a própria origem; o fetch proposital depois sai barrado, com 0 hits", async () => {
    const panelId = await panelTargetId();
    const requests = l!.tap!.requests();
    // O painel e os filhos dele (worker, iframe). O SW da extensão também aparece como filho da sessão do painel (o
    // auto-attach da página pega o SW do escopo dela), e a rede do SW não é a do painel: ele fala com a API.
    const ofPanel = (r: TapRequest) => r.target.targetId === panelId || (r.target.parentId === panelId && r.target.type !== "service_worker");
    const panel = requests.filter(ofPanel).map((r) => r.url);
    // Controle positivo: o 1º pedido é o próprio sidepanel.html, então o Network estava ligado antes do goto.
    expect(panel[0]).toBe(`${ORIGIN}/sidepanel.html`);
    expect(panel.filter((url) => !url.startsWith(`${ORIGIN}/`))).toEqual([]);
    // Controle positivo do filtro: o mesmo coletor registrou a aba da vaga, uma URL de fora.
    expect(requests.some((r) => r.url === jobUrl && r.target.targetId !== panelId)).toBe(true);

    // §4.5 item 5, depois da medida: o fetch do painel ao BFF falso sai barrado pela meta CSP, e o BFF não vê nada.
    const fetchControl = newControl("FETCH");
    const outcome = await l!.panel.evaluate(async (url) => {
      try {
        await fetch(url);
        return "ok";
      } catch (error) {
        return error instanceof Error ? error.name : String(error);
      }
    }, `${cfg.apiOrigin}/v1/health/${fetchControl}`);
    expect(outcome).toBe("TypeError");
    expect((await control.state()).requests.filter((r) => r.path.includes(fetchControl))).toEqual([]);
    console.info(`[05c-3] rede do painel: ${panel.length} pedidos, todos em ${ORIGIN}/`);
  });

  test("item 9: o console de cada SW e de cada página sem canário; os controles do SW, do painel, da aba e do Log aparecem", async () => {
    const swControl = newControl("SW");
    const panelControl = newControl("PAINEL");
    const exceptionControl = newControl("EXCECAO");
    // O controle do SW sai depois do reinício do cenário 13: o coletor seguiu o SW reiniciado.
    await l!.worker.evaluate((value) => console.log(value), swControl);
    await l!.panel.evaluate(
      ([log, thrown]) => {
        console.log(log);
        setTimeout(() => {
          throw new Error(thrown);
        }, 0);
      },
      [panelControl, exceptionControl] as const,
    );
    const panelId = await panelTargetId();
    const has = (method: string, value: string, where: (e: TapEvent) => boolean) =>
      l!.tap!.console().some((e) => e.method === method && where(e) && consoleText(e).includes(value));
    const inPanel = (e: TapEvent) => e.target.targetId === panelId;
    await expect.poll(() => has("Runtime.exceptionThrown", exceptionControl, inPanel)).toBe(true);
    expect(has("Runtime.consoleAPICalled", swControl, (e) => e.target.type === "service_worker")).toBe(true);
    expect(has("Runtime.consoleAPICalled", panelControl, inPanel)).toBe(true);
    // O fetch barrado do item 4 deixou o seu Log no painel, e o console.log do ISOLATED (item 6) ficou na aba.
    expect(has("Log.entryAdded", "CONTROLE-FETCH-", inPanel)).toBe(true);
    expect(has("Runtime.consoleAPICalled", planted.isolated, (e) => e.target.type === "page" && !inPanel(e))).toBe(true);

    const events = l!.tap!.console();
    const text = events.map(consoleText).join("\n");
    expect(findCanaries(text, await secrets())).toEqual([]);
    expect(text).not.toMatch(LONG_TOKEN);
    console.info(`[05c-3] console: ${events.length} eventos de ${new Set(events.map((e) => e.target.targetId)).size} alvos, sem canário`);
  });

  test("item 1, controle positivo (por último, porque o get do controle traz a sessão ao painel): cada API envolvida conta", async () => {
    await exerciseSpiedApis(l!.panel);
    const report = await spyReport(l!.panel);
    expect(Object.fromEntries(SPIED_APIS.map((name) => [name, report.calls[name]]))).toEqual(SPY_CONTROL_CALLS);
  });
});
