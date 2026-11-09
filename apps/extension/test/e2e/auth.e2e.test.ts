// F1-EXT-05c, 05c-1 (ADR-004 §4.4, §4.5 e §1.4): o login de ponta a ponta no build de PRODUÇÃO com as duas origens
// locais e a chave efêmera, contra o IdP falso do global-setup. O `launchWebAuthFlow` é o real (modo 1 do P20): o
// Supabase falso valida o `authorize` e responde 302 para o chromiumapp, o navegador intercepta o retorno, e o BFF falso
// confere o PKCE e emite os canários. É a prova em runtime do P3: o login completa com o manifesto do D13, sem
// `host_permissions` e com o `connect-src` só na API. Cenários 1, 2 e 10 do §4.4, e os itens 2, 8 e 10 do §4.5 neles.
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";

import { SESSION_STORAGE_KEY } from "../../src/auth/session-schema";
import { PANEL_PORT_NAME } from "../../src/messaging/protocol";
import { SESSION_ACTION_LABELS, SESSION_TEXTS, SIGN_IN_LABELS, type SessionText } from "../../src/panel/texts";
import { browserPath, loadExtension, unload, type Loaded } from "./browser";
import { findCanaries } from "./support/canaries";
import { s256 } from "./support/fake-auth";
import { type FakeState, extensionOriginRequests, fakeControl } from "./support/fake-servers";
import { p20ModeFor } from "./support/p20";

const cfg = inject("e2e");
const control = fakeControl(cfg.control.url, cfg.control.token);
const ORIGIN = `chrome-extension://${cfg.extensionId}`;

declare const chrome: (typeof import("wxt/browser"))["browser"];

type Area = "session" | "local" | "sync";
/**
 * O storage por CDP `Extensions.getStorageItems`, como o §4.4 pede: nada roda dentro da extensão para ler. No Edge 157, a
 * sessão do navegador responde "No associated browser context", e a de uma página comum, "Extension not found": só a
 * sessão anexada a uma página da própria extensão (o painel) lê.
 */
const storage = async (l: Loaded, storageArea: Area) => {
  const cdp = await l.ctx.newCDPSession(l.panel);
  try {
    return ((await cdp.send("Extensions.getStorageItems" as never, { id: l.id, storageArea } as never)) as { data: Record<string, unknown> }).data;
  } finally {
    await cdp.detach();
  }
};

const sessionLines = (l: Loaded) => l.panel.locator("[data-sessao] p:not(.acoes)").allInnerTexts();
const sessionButtons = (l: Loaded) => l.panel.locator("[data-sessao] button").allInnerTexts();
const expectedLines = (texto: SessionText) => [texto.estado, ...(texto.erro === null ? [] : [texto.erro.titulo, texto.erro.acao])];

/** Tudo o que o painel mostra ou guarda no DOM: o texto e o valor de cada atributo (§4.5 item 2). */
const panelDump = (l: Loaded) =>
  l.panel.evaluate(() =>
    [document.body.innerText, ...[...document.querySelectorAll("*")].flatMap((el) => [...el.attributes].map((a) => `${a.name}=${a.value}`))].join("\n"),
  );

const bffRequests = (state: FakeState, path: string) => state.requests.filter((r) => r.server === "bff" && r.path === path);

/** Os pedidos que chegaram ao chromiumapp local: só o GET do próprio retorno, sem origem, Authorization nem Cookie. */
function chromiumappHits(state: FakeState): number {
  const hits = state.requests.filter((r) => r.server === "chromiumapp");
  const retorno = { server: "chromiumapp", method: "GET", path: "/auth", origin: null, authorization: false, cookie: false };
  for (const hit of hits) expect(hit).toEqual(retorno);
  return hits.length;
}

/** O handshake de uma porta nova aberta na página do painel (cenário 10). */
const handshake = ([name]: [string]) =>
  new Promise<unknown[]>((resolve) => {
    const port = chrome.runtime.connect({ name });
    const received: unknown[] = [];
    port.onMessage.addListener((m: unknown) => {
      received.push(m);
      if (received.length === 4) setTimeout(() => resolve(received), 300);
    });
    port.postMessage({ kind: "hello", protocolVersion: 1 });
    setTimeout(() => resolve(received), 5_000);
  });

describe("login com o IdP falso no build com as origens e a chave efêmera (ADR-004 §4.4; P3, P17 e P20)", () => {
  let l: Loaded | undefined;
  beforeAll(async () => {
    await control.reset();
    l = await loadExtension(cfg.extAuth, { chromiumappPort: cfg.chromiumappPort });
  });
  afterAll(() => unload(l));

  test("P17: o ID do loadUnpacked é o derivado da chave efêmera, e o getRedirectURL dá o chromiumapp exato", async () => {
    expect(l!.id).toBe(cfg.extensionId);
    expect(await l!.worker.evaluate(() => chrome.identity.getRedirectURL("auth"))).toBe(`https://${cfg.extensionId}.chromiumapp.org/auth`);
  });

  test("P20: o navegador está na tabela, no modo 1 (o login real em headless), e o registro do CA-16 sai daqui", () => {
    expect(p20ModeFor(String(browserPath))).toBe(1);
    console.info(`[CA-16] navegador ${String(browserPath)}; versão ${String(l!.ctx.browser()?.version())}; modo do P20: 1; headless`);
  });

  test("P3, parte estática no runtime: o manifesto carregado é o do D13 (sem host_permissions, connect-src só na API)", async () => {
    const manifest = (await l!.worker.evaluate(() => chrome.runtime.getManifest())) as unknown as Record<string, unknown>;
    expect([...(manifest["permissions"] as string[])].sort()).toEqual(["activeTab", "identity", "scripting", "sidePanel", "storage"]);
    for (const key of ["host_permissions", "optional_host_permissions", "optional_permissions", "oauth2", "content_scripts", "web_accessible_resources"]) {
      expect(manifest, key).not.toHaveProperty(key);
    }
    expect(manifest["externally_connectable"]).toEqual({ ids: [], matches: [] });
    expect(manifest["key"]).toEqual(expect.any(String));
    const csp = (manifest["content_security_policy"] as { extension_pages: string }).extension_pages;
    expect(csp).toBe(`script-src 'self'; object-src 'self'; default-src 'self'; connect-src ${cfg.apiOrigin}`);
    expect(csp).not.toContain(cfg.supabaseOrigin);
  });

  // Outro host do chromiumapp: o controle não aquece a conexão do host do retorno. Mesmo frio, o navegador pode mandar o
  // GET do retorno antes de abortar a navegação; o que vale é o login sair da URL interceptada (§4.4, "Emenda do 05c-1").
  test("controle do chromiumapp: o --host-resolver-rules leva o *.chromiumapp.org ao servidor local", async () => {
    const page = await l!.ctx.newPage();
    await page.goto("https://controle.chromiumapp.org/controle?x=1").catch(() => undefined);
    await page.close();
    expect((await control.state()).requests).toEqual([
      { server: "chromiumapp", method: "GET", path: "/controle", origin: null, authorization: false, cookie: false },
    ]);
    await control.reset();
  });

  test("cenário 1 e P3: Entrar com GitHub completa o login real, sem janela, com o PKCE conferido no BFF falso", async () => {
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
    const pages = l!.ctx.pages().length;
    await l!.panel.getByRole("button", { name: SIGN_IN_LABELS.github }).click();
    await expect.poll(() => sessionLines(l!), { timeout: 15_000 }).toEqual(expectedLines(SESSION_TEXTS.conectado.nenhum));
    expect(await sessionButtons(l!)).toEqual([SESSION_ACTION_LABELS.sair]);
    // O modo 1 não abre janela nem aba: o 302 imediato resolve o launchWebAuthFlow.
    expect(l!.ctx.pages()).toHaveLength(pages);

    const state = await control.state();
    expect(state.auth.counters).toEqual({
      authorize: { ok: 1, recusado: 0 },
      exchange: { ok: 1, recusado: 0 },
      refresh: { ok: 0, recusado: 0 },
      logout: { ok: 0, recusado: 0 },
    });
    expect(state.auth.refusals).toEqual([]);
    // O BFF falso conferiu S256(verifier) contra o challenge do authorize; o verifier tem a forma do SW (32 bytes).
    expect(state.auth.verifiers).toHaveLength(1);
    expect(state.auth.verifiers[0]).toMatch(/^[\w-]{43}$/);
    expect(s256(state.auth.verifiers[0]!)).toMatch(/^[\w-]{43}$/);

    // SR-02 e P3: a janela é navegação. Nenhum pedido do Supabase falso tem Origin de extensão nem Authorization.
    expect(state.requests.filter((r) => r.server === "supabase")).toEqual([
      { server: "supabase", method: "GET", path: "/auth/v1/authorize", origin: null, authorization: false, cookie: false },
    ]);
    expect(extensionOriginRequests(state, "supabase")).toEqual([]);
    // O navegador intercepta o retorno, mas pode já ter mandado o GET dele (com o código) ao endereço do chromiumapp, que
    // aqui responde 404. O login sai da URL interceptada, nunca da resposta; no mundo real o host não resolve (NXDOMAIN).
    expect(chromiumappHits(state)).toBeLessThanOrEqual(1);
    // §4.5 item 10: a troca chega sem Authorization e sem Cookie, com a origem exata da extensão.
    expect(bffRequests(state, "/v1/auth/exchange").filter((r) => r.method === "POST")).toEqual([
      { server: "bff", method: "POST", path: "/v1/auth/exchange", origin: ORIGIN, authorization: false, cookie: false },
    ]);

    // A sessão fica só no storage.session, com o par exato que o BFF falso emitiu; local e sync vazios (cenário 1).
    const stored = (await storage(l!, "session"))[SESSION_STORAGE_KEY] as { accessToken: string; refreshToken: string };
    expect(stored).toMatchObject({ v: 1, accessToken: state.auth.accessTokens[0] });
    expect(state.auth.canaries).toContain(stored.refreshToken);
    expect(await storage(l!, "local")).toEqual({});
    expect(await storage(l!, "sync")).toEqual({});
    // §4.5 item 2: nenhum canário (access e segmentos, envelope e cifrado, código, verifier) no DOM do painel.
    expect(findCanaries(await panelDump(l!), state.auth.canaries)).toEqual([]);
  });

  test("cenário 10: com a sessão aberta, uma porta nova recebe exatamente [ready, captura, consentimento, sessao{ true, null }]", async () => {
    expect(await l!.panel.evaluate(handshake, [PANEL_PORT_NAME] as [string])).toEqual([
      { kind: "ready", protocolVersion: 1 },
      { kind: "captura", captura: { estado: "ocioso" } },
      { kind: "consentimento", dado: false },
      { kind: "sessao", sessao: { autenticado: true, erro: null } },
    ]);
  });

  test("cenário 2: Sair apaga o storage, o BFF falso recebe o logout com Bearer, e nenhuma renovação sai depois", async () => {
    const before = (await control.state()).auth.accessTokens.at(-1);
    await l!.panel.getByRole("button", { name: SESSION_ACTION_LABELS.sair }).click();
    await expect.poll(async () => (await storage(l!, "session"))[SESSION_STORAGE_KEY]).toBeUndefined();
    await expect.poll(async () => (await control.state()).auth.counters.logout).toEqual({ ok: 1, recusado: 0 });
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
    expect(await sessionButtons(l!)).toEqual([SIGN_IN_LABELS.github, SIGN_IN_LABELS.google]);
    // Mais que a repetição de 2 s do D11.5: nenhuma renovação com o envelope antigo, nem antes nem depois do Sair.
    await l!.panel.waitForTimeout(2_500);
    const state = await control.state();
    expect(bffRequests(state, "/v1/auth/refresh")).toEqual([]);
    expect(state.auth.counters.logout).toEqual({ ok: 1, recusado: 0 });
    // §4.5 item 10: o logout leva o Bearer do access emitido (o BFF falso só aceita esse) e nenhum Cookie.
    expect(bffRequests(state, "/v1/auth/logout").filter((r) => r.method === "POST")).toEqual([
      { server: "bff", method: "POST", path: "/v1/auth/logout", origin: ORIGIN, authorization: true, cookie: false },
    ]);
    expect(before).toEqual(expect.any(String));
    expect(await storage(l!, "session")).toEqual({});
    expect(findCanaries(await panelDump(l!), state.auth.canaries)).toEqual([]);
  });

  test("um novo login com o Google depois do Sair: código e verifier novos, e o código antigo nunca volta à troca", async () => {
    await l!.panel.getByRole("button", { name: SIGN_IN_LABELS.google }).click();
    await expect.poll(() => sessionLines(l!), { timeout: 15_000 }).toEqual(expectedLines(SESSION_TEXTS.conectado.nenhum));
    const state = await control.state();
    expect(state.auth.counters).toMatchObject({ authorize: { ok: 2, recusado: 0 }, exchange: { ok: 2, recusado: 0 } });
    expect(state.auth.refusals).toEqual([]);
    expect(new Set(state.auth.verifiers).size).toBe(2);
    expect(extensionOriginRequests(state, "supabase")).toEqual([]);
    expect(chromiumappHits(state)).toBeLessThanOrEqual(2);
    expect(await storage(l!, "local")).toEqual({});
    expect(await storage(l!, "sync")).toEqual({});
    expect(findCanaries(await panelDump(l!), state.auth.canaries)).toEqual([]);
  });
});
