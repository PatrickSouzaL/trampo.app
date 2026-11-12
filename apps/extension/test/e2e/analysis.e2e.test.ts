// F1-EXT-04 parte 2, 04b-3 (ADR-025 §6.5; ADR-004 §4.4, cenários 3, 4, 5 e 12): o envio da vaga de ponta a ponta no build
// de PRODUÇÃO com as duas origens locais e a chave efêmera, contra o BFF falso do global-setup. O Service Worker é o real:
// o consentimento, a vaga, o token da sessão, o `POST /v1/analyze` em SSE, o 401 com a renovação e o reenvio, o leitor
// estrito e o cancelamento imediato. Nada gasta cota de LLM nem chama o Supabase real. Cada "0" tem o seu controle positivo.
import { request } from "node:https";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";

import { SESSION_STORAGE_KEY } from "../../src/auth/session-schema";
import { CAPTURE_STORAGE_KEY } from "../../src/capture/capture-service";
import { PANEL_PORT_NAME } from "../../src/messaging/protocol";
import { ANALYZE_LABELS, ERROR_TEXTS, SENDING_TEXT, SESSION_TEXTS, SIGN_IN_LABELS } from "../../src/panel/texts";
import { REPORT } from "../fixtures/stream";
import { browserPath, loadExtension, unload, type Loaded } from "./browser";
import { bffRequests, expectedLines, observeSessions, panelDump, sessionLines, storage } from "./session";
import { findCanaries } from "./support/canaries";
import { type AnalyzeScript, textDigest } from "./support/fake-auth";
import { ANALYZE_PATH, type FakeState, fakeControl } from "./support/fake-servers";
import { requestViolations } from "./support/leaks";
import { p20ModeFor } from "./support/p20";

const cfg = inject("e2e");
const control = fakeControl(cfg.control.url, cfg.control.token);
const ORIGIN = `chrome-extension://${cfg.extensionId}`;
const options = { chromiumappPort: cfg.chromiumappPort };

// Navegador fora da tabela do P20 não roda o E2E de login (§4.4, "Emenda do 05c-1").
p20ModeFor(String(browserPath));

declare const chrome: (typeof import("wxt/browser"))["browser"];

const jobText = (marca: string) => `Vaga de pessoa desenvolvedora TypeScript, ${marca}. ${"Requisitos e responsabilidades da vaga. ".repeat(8)}`;

/** Espera uma condição sem o `expect.poll`, que não roda em `beforeAll` (cuidado 23 do TRILHAS). */
async function until(what: string, condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`não aconteceu em ${timeoutMs} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function signIn(l: Loaded): Promise<void> {
  await l.panel.getByRole("button", { name: SIGN_IN_LABELS.github }).click();
  const conectado = JSON.stringify(expectedLines(SESSION_TEXTS.conectado.nenhum));
  await until("a sessão aberta na tela", async () => JSON.stringify(await sessionLines(l)) === conectado);
}

/** Texto colado por uma 2ª porta da própria página do painel (o caminho confiável), até a captura ficar pronta com ele. */
async function paste(l: Loaded, texto: string): Promise<string> {
  await l.panel.evaluate(
    ([name, text]) => {
      const port = chrome.runtime.connect({ name });
      port.postMessage({ kind: "hello", protocolVersion: 1 });
      port.postMessage({ kind: "colar", texto: text });
    },
    [PANEL_PORT_NAME, texto] as const,
  );
  await until("a captura com o texto colado", async () => (await capturedText(l)) === texto.trim());
  return texto.trim();
}

/** O texto da vaga guardado no SW (ADR-024 D4): é o que a análise manda. */
const capturedText = async (l: Loaded): Promise<string | undefined> =>
  ((await storage(l, "session"))[CAPTURE_STORAGE_KEY] as { vaga?: { text?: string } } | undefined)?.vaga?.text;

const storedAccess = async (l: Loaded) => ((await storage(l, "session"))[SESSION_STORAGE_KEY] as { accessToken?: string } | undefined)?.accessToken;

async function consent(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Concordo/ }).click();
  await until("o aviso de consentimento fora da tela", async () => (await page.locator("[data-consentimento]").count()) === 0);
}

const analysisButton = (page: Page) => page.locator("[data-acao] button");
const report = (page: Page) => page.locator('[data-analise="concluida"]');
const errorOf = (page: Page, code: keyof typeof ERROR_TEXTS) => page.locator(`[data-erro="${code}"]`);
const analyzePosts = (state: FakeState) => bffRequests(state, ANALYZE_PATH).filter((r) => r.method === "POST");
const refreshPosts = (state: FakeState) => bffRequests(state, "/v1/auth/refresh").filter((r) => r.method === "POST");

/** Clica no botão da análise que a tela oferece ("Analisar vaga" ou "Reanalisar com IA"). */
async function clickAnalyze(page: Page): Promise<void> {
  await until("o botão da análise na tela", async () => (await analysisButton(page).count()) === 1);
  await analysisButton(page).click();
}

describe("envio da vaga com o BFF falso em SSE (ADR-025 §6.5 D22 e D23)", () => {
  let l: Loaded | undefined;
  let texto = "";
  beforeAll(async () => {
    await control.reset();
    l = await loadExtension(cfg.extAuth, options);
    await signIn(l);
    texto = await paste(l, jobText("primeira"));
    await consent(l.panel);
  });
  afterAll(() => unload(l));

  const scripted = async (...steps: AnalyzeScript[]) => {
    await control.script({ analyze: steps });
    const before = (await control.state()).auth.analyses.length;
    await clickAnalyze(l!.panel);
    return before;
  };

  test("Analisar vaga: os estágios e o relatório do stream; o BFF falso recebe o pedido do contrato, com o Bearer da sessão gravada", async () => {
    const panel = l!.panel;
    expect(await analysisButton(panel).innerText()).toBe(ANALYZE_LABELS.auto);
    await clickAnalyze(panel);
    await expect.poll(() => report(panel).count(), { timeout: 10_000 }).toBe(1);
    expect(await report(panel).locator("[data-nota]").innerText()).toBe(String(REPORT.score));
    expect(await report(panel).innerText()).toContain(REPORT.summary);

    const state = await control.state();
    expect(state.auth.analyses).toEqual([
      {
        requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        mode: "auto",
        platform: "texto_colado",
        extractorVersion: expect.any(String),
        clientTruncated: false,
        textLength: texto.length,
        textDigest: textDigest(texto),
        access: 0,
        resposta: "stream",
      },
    ]);
    // Cenário 12: o access da análise é exatamente o da sessão gravada, e o pedido leva só a origem e o Bearer.
    expect(state.auth.accessTokens[0]).toBe(await storedAccess(l!));
    expect(analyzePosts(state)).toEqual([{ server: "bff", method: "POST", path: ANALYZE_PATH, origin: ORIGIN, authorization: true, cookie: false }]);
    expect(state.auth.counters).toMatchObject({ analyze: { ok: 1, recusado: 0 }, refresh: { ok: 0, recusado: 0 } });
    expect(findCanaries(await panelDump(l!), state.auth.canaries)).toEqual([]);
    // O texto da vaga não chega ao painel (ADR-024 D4).
    expect(await panelDump(l!)).not.toContain("Requisitos e responsabilidades");
  });

  test("Reanalisar com IA: o modo aprofundada, com outro requestId", async () => {
    const panel = l!.panel;
    expect(await analysisButton(panel).innerText()).toBe(ANALYZE_LABELS.aprofundada);
    await clickAnalyze(panel);
    await expect.poll(async () => (await control.state()).auth.analyses.length).toBe(2);
    await expect.poll(() => report(panel).count(), { timeout: 10_000 }).toBe(1);
    const [first, second] = (await control.state()).auth.analyses;
    expect(second).toMatchObject({ mode: "aprofundada", access: 0, textDigest: textDigest(texto), resposta: "stream" });
    expect(second?.requestId).not.toBe(first?.requestId);
  });

  test("401 uma vez (D11.4): uma renovação, e o reenvio leva o mesmo requestId e o token renovado, que é o da sessão gravada", async () => {
    const before = await scripted("401");
    await expect.poll(async () => (await control.state()).auth.analyses.length, { timeout: 10_000 }).toBe(before + 2);
    await expect.poll(() => report(l!.panel).count(), { timeout: 10_000 }).toBe(1);
    const state = await control.state();
    const [sent, resent] = state.auth.analyses.slice(before);
    expect(sent).toMatchObject({ resposta: "401", access: 0 });
    expect(resent).toMatchObject({ resposta: "stream", access: 1, requestId: sent?.requestId, mode: sent?.mode, textDigest: sent?.textDigest });
    expect(state.auth.counters.refresh).toEqual({ ok: 1, recusado: 0 });
    expect(state.auth.accessTokens).toHaveLength(2);
    expect(state.auth.accessTokens[1]).toBe(await storedAccess(l!));
    expect(await sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.conectado.nenhum));
  });

  test("503 com o ApiError do servidor: o texto do catálogo pelo código, sem renovação e com o botão de volta", async () => {
    const before = await scripted("503");
    const aviso = errorOf(l!.panel, "SERVICO_INDISPONIVEL");
    await expect.poll(() => aviso.count(), { timeout: 10_000 }).toBe(1);
    expect(await aviso.innerText()).toContain(ERROR_TEXTS.SERVICO_INDISPONIVEL.titulo);
    expect(await l!.panel.locator("main").innerText()).not.toContain("Recusado pelo BFF falso");
    const state = await control.state();
    expect(state.auth.analyses.slice(before).map((a) => a.resposta)).toEqual(["503"]);
    // O código do pedido que a tela mostra é o do pedido que saiu.
    expect(await aviso.innerText()).toContain(String(state.auth.analyses.at(-1)?.requestId));
    expect(state.auth.counters.refresh).toEqual({ ok: 1, recusado: 0 });
    expect(await analysisButton(l!.panel).innerText()).toBe(ANALYZE_LABELS.auto);
  });

  test("corpo de erro fora do contrato: o código sai do status, e o texto do servidor não chega à tela", async () => {
    const before = await scripted("fora_do_contrato");
    await expect.poll(() => errorOf(l!.panel, "SERVICO_INDISPONIVEL").count(), { timeout: 10_000 }).toBe(1);
    const state = await control.state();
    expect(state.auth.analyses.slice(before).map((a) => a.resposta)).toEqual(["fora_do_contrato"]);
    const canario = state.auth.canaries.at(-1);
    expect(canario).toMatch(/^CANARIO-ERR-/);
    expect(findCanaries(await panelDump(l!), state.auth.canaries)).toEqual([]);
  });

  test.each(["keep_alive", "depois_do_resultado", "event_divergente", "grande_demais"] as const)(
    "stream fora da forma do servidor (%s): ERRO_INTERNO, sem relatório na tela, um pedido só e a porta de pé",
    async (step) => {
      const before = await scripted(step);
      await expect.poll(() => errorOf(l!.panel, "ERRO_INTERNO").count(), { timeout: 10_000 }).toBe(1);
      expect(await report(l!.panel).count()).toBe(0);
      const state = await control.state();
      expect(state.auth.analyses.slice(before).map((a) => a.resposta)).toEqual([step]);
      expect(state.auth.roteiro.at(-1)).toBe(`analyze:${step}`);
      expect(await l!.panel.locator("[data-connection]").getAttribute("data-connection")).toBe("pronto");
      expect(await analysisButton(l!.panel).innerText()).toBe(ANALYZE_LABELS.auto);
    },
  );

  test("servidor em silêncio e o consentimento retirado: o SW fecha a conexão na hora, e o aviso volta sem erro na tela (§6.3 D17)", async () => {
    const panel = l!.panel;
    const abortadas = (await control.state()).analises.abortadas;
    await scripted("silencio");
    await expect.poll(async () => (await control.state()).analises.abertas).toBe(1);
    await expect.poll(() => panel.locator('[data-analise="andamento"]').count()).toBe(1);
    const inicio = Date.now();
    await panel.getByRole("button", { name: "Retirar o consentimento de envio" }).click();
    await expect.poll(async () => (await control.state()).analises, { timeout: 5_000 }).toEqual({ abertas: 0, abortadas: abortadas + 1 });
    // Muito antes do prazo de inatividade de 20 s do SW: o abort é do cancelamento, não do relógio.
    expect(Date.now() - inicio).toBeLessThan(10_000);
    await expect.poll(() => panel.locator("[data-consentimento]").count()).toBe(1);
    expect(await panel.locator("[data-analise]").count()).toBe(0);
    await consent(panel);
    expect(await analysisButton(panel).innerText()).toBe(ANALYZE_LABELS.auto);
  });

  test("servidor em silêncio e a vaga que muda: a conexão fecha na hora, a tela limpa, e a análise nova leva o texto novo (§6.3 D16)", async () => {
    const panel = l!.panel;
    const abortadas = (await control.state()).analises.abortadas;
    await scripted("silencio");
    await expect.poll(async () => (await control.state()).analises.abertas).toBe(1);
    const inicio = Date.now();
    texto = await paste(l!, jobText("segunda"));
    await expect.poll(async () => (await control.state()).analises, { timeout: 5_000 }).toEqual({ abertas: 0, abortadas: abortadas + 1 });
    expect(Date.now() - inicio).toBeLessThan(10_000);
    await expect.poll(() => panel.locator("[data-analise]").count()).toBe(0);
    await clickAnalyze(panel);
    await expect.poll(() => report(panel).count(), { timeout: 10_000 }).toBe(1);
    expect((await control.state()).auth.analyses.at(-1)).toMatchObject({ textDigest: textDigest(texto), resposta: "stream" });
  });

  // O prazo de inatividade do SW é real (20 s, `ANALYZE_STREAM_POLICY.idleMs`): o relógio do SW não é controlável pelo
  // teste, então este é o único caso que espera o prazo inteiro, com o tempo medido.
  test("servidor em silêncio até o prazo de 20 s do SW: SERVICO_INDISPONIVEL, e o SW fecha a conexão", async () => {
    const panel = l!.panel;
    const abortadas = (await control.state()).analises.abortadas;
    await scripted("silencio");
    await expect.poll(() => panel.locator('[data-analise="andamento"]').count()).toBe(1);
    const inicio = Date.now();
    await expect.poll(() => errorOf(panel, "SERVICO_INDISPONIVEL").count(), { timeout: 35_000, interval: 500 }).toBe(1);
    const decorrido = Date.now() - inicio;
    expect(decorrido).toBeGreaterThan(15_000);
    expect(decorrido).toBeLessThan(30_000);
    await expect.poll(async () => (await control.state()).analises).toEqual({ abertas: 0, abortadas: abortadas + 1 });
    expect(await sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.conectado.nenhum));
  });

  test("cenário 12: no total, o Authorization só em /v1/analyze e /v1/auth/logout; a troca e a renovação nunca o levam", async () => {
    const state = await control.state();
    expect(requestViolations(state, ORIGIN)).toEqual([]);
    expect(analyzePosts(state).length).toBeGreaterThan(8);
    expect(analyzePosts(state).every((r) => r.authorization && !r.cookie && r.origin === ORIGIN)).toBe(true);
    expect(refreshPosts(state)).toEqual([{ server: "bff", method: "POST", path: "/v1/auth/refresh", origin: ORIGIN, authorization: false, cookie: false }]);
    expect(bffRequests(state, "/v1/auth/exchange").filter((r) => r.method === "POST")).toEqual([
      { server: "bff", method: "POST", path: "/v1/auth/exchange", origin: ORIGIN, authorization: false, cookie: false },
    ]);

    // Controle positivo: uma renovação com Authorization, mandada pelo teste, fere a regra (e o falso a recusa pelo corpo).
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${cfg.apiOrigin}/v1/auth/refresh`,
        { method: "POST", rejectUnauthorized: false, headers: { origin: ORIGIN, "content-type": "application/json", authorization: "Bearer controle" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(400);
    expect(requestViolations(await control.state(), ORIGIN)).toEqual(["bff POST /v1/auth/refresh: Authorization fora do logout e da análise"]);
  });
});

describe("cenário 3 redesenhado: uma renovação só, com 5 painéis e duas análises que a dividem (ADR-025 §6.5 D24)", () => {
  let l: Loaded | undefined;
  let panels: Page[] = [];
  beforeAll(async () => {
    await control.reset();
    // Abaixo do limiar de 60 s do SW: todo accessToken() renova antes de usar.
    await control.script({ expiresIn: 30 });
    l = await loadExtension(cfg.extAuth, options);
    await signIn(l);
    await paste(l, jobText("terceira"));
    await consent(l.panel);
    panels = [l.panel];
    for (let i = 0; i < 4; i += 1) {
      const page = await l.ctx.newPage();
      await page.goto(`chrome-extension://${l.id}/sidepanel.html`);
      panels.push(page);
    }
    for (const page of panels) await until("o botão da análise em cada painel", async () => (await analysisButton(page).count()) === 1);
  });
  afterAll(() => unload(l));

  const clickAll = () => Promise.all(panels.map((page) => analysisButton(page).click()));

  test("5 cliques simultâneos dão 1 análise; a análise nova depois da vaga trocada se junta à mesma renovação presa: exatamente 1 no BFF falso", async () => {
    await control.script({ refresh: ["segurar"] });
    await clickAll();
    await expect.poll(async () => (await control.state()).segurados).toBe(1);
    for (const page of panels) await expect.poll(() => page.locator('[data-analise="enviando"]').allInnerTexts()).toEqual([SENDING_TEXT]);

    // A vaga muda com o accessToken() da 1ª análise ainda esperando a renovação: ela é cancelada, e os botões voltam.
    const texto = await paste(l!, jobText("quarta"));
    for (const page of panels) await expect.poll(() => analysisButton(page).count()).toBe(1);
    await clickAll();
    for (const page of panels) await expect.poll(() => page.locator('[data-analise="enviando"]').count()).toBe(1);
    await l!.panel.waitForTimeout(500);
    const held = await control.state();
    expect(held.segurados).toBe(1);
    expect(refreshPosts(held)).toHaveLength(1);
    expect(analyzePosts(held)).toHaveLength(0);
    // O token canário segue fora do painel com a análise em curso.
    expect(findCanaries(await panelDump(l!), held.auth.canaries)).toEqual([]);

    expect(await control.release()).toBe(1);
    for (const page of panels) await expect.poll(() => report(page).count(), { timeout: 10_000 }).toBe(1);
    const state = await control.state();
    expect(state.auth.counters).toMatchObject({ refresh: { ok: 1, recusado: 0 }, analyze: { ok: 1, recusado: 0 } });
    expect(refreshPosts(state)).toHaveLength(1);
    expect(analyzePosts(state)).toHaveLength(1);
    // A única análise é a nova, com o texto novo e o access renovado, que é o da sessão gravada.
    expect(state.auth.analyses).toHaveLength(1);
    expect(state.auth.analyses[0]).toMatchObject({ textDigest: textDigest(texto), access: 1, resposta: "stream" });
    expect(state.auth.accessTokens[1]).toBe(await storedAccess(l!));
    expect(state.auth.roteiro).toEqual(["refresh:segurar"]);
    expect(findCanaries(await panelDump(l!), state.auth.canaries)).toEqual([]);
  });

  // Um painel só: sem a renovação presa a análise termina em milissegundos, e cliques seguidos seriam análises seguidas.
  test("controle positivo do 1: sem a renovação presa, cada análise faz a sua renovação", async () => {
    await analysisButton(l!.panel).click();
    for (const page of panels) await expect.poll(() => report(page).count(), { timeout: 10_000 }).toBe(1);
    await expect.poll(async () => (await control.state()).auth.analyses.length).toBe(2);
    const state = await control.state();
    expect(state.auth.counters).toMatchObject({ refresh: { ok: 2, recusado: 0 }, analyze: { ok: 2, recusado: 0 } });
    expect(state.auth.analyses[1]).toMatchObject({ mode: "aprofundada", access: 2 });
    expect(requestViolations(state, ORIGIN)).toEqual([]);
  });
});

describe("cenários 4 e 5: revogação e BFF fora, pelo caminho da análise (ADR-004 §4.4)", () => {
  let l: Loaded | undefined;
  let sessoes: () => Promise<unknown[]>;
  beforeAll(async () => {
    await control.reset();
    l = await loadExtension(cfg.extAuth, options);
    await signIn(l);
    await paste(l, jobText("quinta"));
    await consent(l.panel);
    sessoes = await observeSessions(l);
  });
  afterAll(() => unload(l));

  const authorizes = (state: FakeState) => state.requests.filter((r) => r.server === "supabase").length;

  test("cenário 4: a sessão revogada no servidor; a análise leva 401, a renovação leva 401, a sessão é apagada e a tela pede o login", async () => {
    expect(await control.revoke()).toBe(1);
    const before = await control.state();
    await clickAnalyze(l!.panel);
    await expect.poll(() => errorOf(l!.panel, "NAO_AUTENTICADO").count(), { timeout: 10_000 }).toBe(1);
    expect((await sessoes()).at(-1)).toEqual({ autenticado: false, erro: "NAO_AUTENTICADO" });
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.desconectado.NAO_AUTENTICADO));
    expect((await storage(l!, "session"))[SESSION_STORAGE_KEY]).toBeUndefined();
    const state = await control.state();
    // Um envio (recusado pelo Bearer) e uma renovação (recusada pelo envelope): nenhum reenvio.
    expect(analyzePosts(state)).toHaveLength(analyzePosts(before).length + 1);
    expect(state.auth.refusals.slice(before.auth.refusals.length)).toEqual(["analyze:bearer", "refresh:envelope_desconhecido"]);
    expect(state.auth.analyses).toEqual([]);
    expect(await l!.panel.locator("[data-bloqueio]").getAttribute("data-bloqueio")).toBe("sem_sessao");
  });

  test("cenário 4 pela análise: 401, renovação 200 e 401 de novo; o onUnauthorized(2) apaga a sessão, sem 3º envio", async () => {
    await signIn(l!);
    await control.script({ analyze: ["401", "401"] });
    const before = await control.state();
    await clickAnalyze(l!.panel);
    await expect.poll(() => errorOf(l!.panel, "NAO_AUTENTICADO").count(), { timeout: 10_000 }).toBe(1);
    expect((await sessoes()).at(-1)).toEqual({ autenticado: false, erro: "NAO_AUTENTICADO" });
    expect((await storage(l!, "session"))[SESSION_STORAGE_KEY]).toBeUndefined();
    await l!.panel.waitForTimeout(500);
    const state = await control.state();
    const [sent, resent, ...rest] = state.auth.analyses;
    expect(rest).toEqual([]);
    expect(sent).toMatchObject({ resposta: "401" });
    expect(resent).toMatchObject({ resposta: "401", requestId: sent?.requestId, access: (sent?.access ?? 0) + 1 });
    expect(state.auth.counters.refresh.ok).toBe(before.auth.counters.refresh.ok + 1);
    expect(analyzePosts(state)).toHaveLength(analyzePosts(before).length + 2);
  });

  test("cenário 4 pela renovação antes do envio: a sessão é apagada, nada sai para a análise, e ela diz SERVICO_INDISPONIVEL (D10, portão 4)", async () => {
    await control.script({ expiresIn: 30 });
    await signIn(l!);
    // A sessão do teste anterior morreu só no SW (o onUnauthorized(2) é local): no falso ela ainda vivia.
    expect(await control.revoke()).toBe(2);
    const before = await control.state();
    await clickAnalyze(l!.panel);
    await expect.poll(() => errorOf(l!.panel, "SERVICO_INDISPONIVEL").count(), { timeout: 10_000 }).toBe(1);
    expect((await sessoes()).at(-1)).toEqual({ autenticado: false, erro: "NAO_AUTENTICADO" });
    expect((await storage(l!, "session"))[SESSION_STORAGE_KEY]).toBeUndefined();
    const state = await control.state();
    expect(analyzePosts(state)).toHaveLength(analyzePosts(before).length);
    expect(refreshPosts(state)).toHaveLength(refreshPosts(before).length + 1);
  });

  test("cenário 5, 503 na renovação: a sessão fica com SERVICO_INDISPONIVEL, a análise mostra o mesmo, 0 hits novos no authorize, e a seguinte se recupera", async () => {
    // Um segundo de vida: quando a renovação falhar, o token guardado já venceu, e nada sai para a análise.
    await control.script({ expiresIn: 1 });
    await signIn(l!);
    await l!.panel.waitForTimeout(1_200);
    await control.script({ refresh: ["503"] });
    const before = await control.state();
    const access = await storedAccess(l!);
    await clickAnalyze(l!.panel);
    await expect.poll(() => errorOf(l!.panel, "SERVICO_INDISPONIVEL").count(), { timeout: 10_000 }).toBe(1);
    expect((await sessoes()).at(-1)).toEqual({ autenticado: true, erro: "SERVICO_INDISPONIVEL" });
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.conectado.SERVICO_INDISPONIVEL));
    expect(await storedAccess(l!)).toBe(access);
    const state = await control.state();
    expect(authorizes(state)).toBe(authorizes(before));
    expect(analyzePosts(state)).toHaveLength(analyzePosts(before).length);
    expect(state.auth.roteiro.at(-1)).toBe("refresh:503");

    // Controle positivo: sem o roteiro, a mesma sessão renova, a análise sai e a tela volta ao "Conectado".
    await clickAnalyze(l!.panel);
    await expect.poll(() => report(l!.panel).count(), { timeout: 10_000 }).toBe(1);
    expect((await sessoes()).at(-1)).toEqual({ autenticado: true, erro: null });
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.conectado.nenhum));
    expect(authorizes(await control.state())).toBe(authorizes(before));
  });

  // O prazo da renovação é real: 10 s do api-client, 2 s de espera e mais 10 s da única nova tentativa (D11.3).
  test("cenário 5, prazo na renovação: as duas tentativas sem resposta mantêm a sessão com SERVICO_INDISPONIVEL, sem login novo", async () => {
    await l!.panel.waitForTimeout(1_200);
    await control.script({ refresh: ["segurar", "segurar"] });
    const before = await control.state();
    const access = await storedAccess(l!);
    await clickAnalyze(l!.panel);
    await expect.poll(async () => (await control.state()).segurados).toBe(1);
    await expect.poll(() => errorOf(l!.panel, "SERVICO_INDISPONIVEL").count(), { timeout: 40_000, interval: 500 }).toBe(1);
    expect((await sessoes()).at(-1)).toEqual({ autenticado: true, erro: "SERVICO_INDISPONIVEL" });
    expect(await storedAccess(l!)).toBe(access);
    const state = await control.state();
    // O SW desistiu das duas: nenhuma renovação ficou presa, nada girou, e nenhum authorize novo saiu.
    expect(state.segurados).toBe(0);
    expect(refreshPosts(state)).toHaveLength(refreshPosts(before).length + 2);
    expect(state.auth.counters.refresh.ok).toBe(before.auth.counters.refresh.ok);
    expect(authorizes(state)).toBe(authorizes(before));
    expect(analyzePosts(state)).toHaveLength(analyzePosts(before).length);
    expect(requestViolations(state, ORIGIN)).toEqual([]);
  });
});
