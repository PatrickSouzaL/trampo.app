// F1-EXT-05c, 05c-2 (ADR-004 §4.4, cenários 7, 8, 9 e 14): o login e o logout contra um IdP falso hostil, pelo roteiro
// do canal de controle, no build de PRODUÇÃO com as duas origens locais e a chave efêmera (modo 1 do P20). O roteiro só
// age depois das barreiras dos falsos (o authorize confere os 4 parâmetros; o 503 do logout exige o Bearer vivo), então
// os falsos ficam mais hostis e nunca mais permissivos (condição 2 do [APPSEC]). Cada "0" tem o seu controle positivo.
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";

import { SESSION_STORAGE_KEY } from "../../src/auth/session-schema";
import { LOGOUT_UNCONFIRMED_TEXT, SESSION_ACTION_LABELS, SESSION_TEXTS, SIGN_IN_LABELS, type SessionText } from "../../src/panel/texts";
import { loadExtension, unload, type Loaded } from "./browser";
import { bffRequests, chromiumappHits, expectedLines, observeSessions, panelDump, sessionButtons, sessionLines, storage } from "./session";
import { findCanaries } from "./support/canaries";
import type { AuthorizeScript } from "./support/fake-auth";
import { extensionOriginRequests, fakeControl } from "./support/fake-servers";

const cfg = inject("e2e");
const control = fakeControl(cfg.control.url, cfg.control.token);
const ORIGIN = `chrome-extension://${cfg.extensionId}`;
const ENTRAR = [SIGN_IN_LABELS.github, SIGN_IN_LABELS.google];

declare const chrome: (typeof import("wxt/browser"))["browser"];

/** Tudo o que a extensão guarda em `chrome.storage`, numa string só, para o coletor de canários. */
const storageDump = async (l: Loaded) => JSON.stringify([await storage(l, "session"), await storage(l, "local"), await storage(l, "sync")]);

describe("retorno adulterado e cancelamento no IdP falso (ADR-004 §4.4, cenários 7 e 8)", () => {
  let l: Loaded | undefined;
  let sessoes: () => Promise<unknown[]>;
  beforeAll(async () => {
    await control.reset();
    l = await loadExtension(cfg.extAuth, { chromiumappPort: cfg.chromiumappPort });
    // O handshake do painel terminou: os botões de Entrar só aparecem depois da `sessao` (o expect.poll não roda aqui).
    await l.panel.getByRole("button", { name: SIGN_IN_LABELS.github }).waitFor();
    sessoes = await observeSessions(l);
  });
  afterAll(() => unload(l));

  /**
   * "Entrar com GitHub" com o roteiro armado: espera a `sessao` da tentativa (o fim do "entrando", D12) e confere a tela, os
   * botões de volta, nenhuma janela nova, o storage vazio e nenhum canário no painel nem no storage.
   */
  async function attempt(script: AuthorizeScript, view: { autenticado: false; erro: "ERRO_INTERNO" | null }, texto: SessionText) {
    await control.script({ authorize: script });
    const before = (await sessoes()).length;
    const pages = l!.ctx.pages().length;
    await l!.panel.getByRole("button", { name: SIGN_IN_LABELS.github }).click();
    await expect.poll(sessoes, { timeout: 15_000 }).toHaveLength(before + 1);
    expect((await sessoes()).at(-1)).toEqual(view);
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(texto));
    expect(await sessionButtons(l!)).toEqual(ENTRAR);
    expect(l!.ctx.pages()).toHaveLength(pages);
    const state = await control.state();
    expect(state.auth.roteiro.at(-1)).toBe(`authorize:${script}`);
    expect(await storage(l!, "session")).toEqual({});
    expect(await storage(l!, "local")).toEqual({});
    expect(await storage(l!, "sync")).toEqual({});
    expect(findCanaries(await panelDump(l!), state.auth.canaries)).toEqual([]);
    expect(findCanaries(await storageDump(l!), state.auth.canaries)).toEqual([]);
    expect(extensionOriginRequests(state, "supabase")).toEqual([]);
    return state;
  }

  test("cenário 7, outro caminho: o código certo em /outro dá { false, ERRO_INTERNO }, 0 pedidos na troca e o storage vazio", async () => {
    const state = await attempt("outro_caminho", { autenticado: false, erro: "ERRO_INTERNO" }, SESSION_TEXTS.desconectado.ERRO_INTERNO);
    expect(bffRequests(state, "/v1/auth/exchange")).toEqual([]);
    expect(state.auth.counters.exchange).toEqual({ ok: 0, recusado: 0 });
    expect(chromiumappHits(state, ["/outro"])).toBeLessThanOrEqual(1);
  });

  test("cenário 7, fragmento: o código certo com #access_token= dá { false, ERRO_INTERNO } e 0 pedidos na troca; o token não aparece", async () => {
    const state = await attempt("fragmento", { autenticado: false, erro: "ERRO_INTERNO" }, SESSION_TEXTS.desconectado.ERRO_INTERNO);
    expect(bffRequests(state, "/v1/auth/exchange")).toEqual([]);
    expect(state.auth.counters.exchange).toEqual({ ok: 0, recusado: 0 });
    // O access do fragmento entrou nos canários (o coletor acima o procurou): 3 segmentos e o token inteiro.
    expect(state.auth.canaries.filter((c) => c.split(".").length === 3)).toHaveLength(1);
    expect(chromiumappHits(state, ["/outro", "/auth"])).toBeLessThanOrEqual(2);
  });

  test("cenário 7, código de outro challenge: a troca acontece e o BFF falso recusa (o controle positivo dos dois 0 acima)", async () => {
    const state = await attempt("outro_challenge", { autenticado: false, erro: "ERRO_INTERNO" }, SESSION_TEXTS.desconectado.ERRO_INTERNO);
    expect(bffRequests(state, "/v1/auth/exchange").filter((r) => r.method === "POST")).toEqual([
      { server: "bff", method: "POST", path: "/v1/auth/exchange", origin: ORIGIN, authorization: false, cookie: false },
    ]);
    expect(state.auth.counters.exchange).toEqual({ ok: 0, recusado: 1 });
    expect(state.auth.refusals).toEqual(["exchange:verifier_divergente"]);
    expect(state.auth.verifiers).toHaveLength(1);
  });

  test("cenário 8: o IdP nega com error_description=CANARIO-ERR-<uuid>; dá { false, null }, sem o texto na tela nem no storage", async () => {
    const state = await attempt("cancelar", { autenticado: false, erro: null }, SESSION_TEXTS.desconectado.nenhum);
    const erro = state.auth.canaries.filter((c) => c.startsWith("CANARIO-ERR-"));
    expect(erro).toHaveLength(1);
    expect(findCanaries(`${await panelDump(l!)}\n${await storageDump(l!)}`, erro)).toEqual([]);
    expect(state.auth.counters.exchange).toEqual({ ok: 0, recusado: 1 });
    expect(bffRequests(state, "/v1/auth/exchange").filter((r) => r.method === "POST")).toHaveLength(1);
  });

  test("depois dos roteiros, um login comum completa: cada roteiro valeu para um authorize só, e o leitor do storage vê a sessão", async () => {
    await l!.panel.getByRole("button", { name: SIGN_IN_LABELS.github }).click();
    await expect.poll(() => sessionLines(l!), { timeout: 15_000 }).toEqual(expectedLines(SESSION_TEXTS.conectado.nenhum));
    const state = await control.state();
    expect(state.auth.roteiro).toEqual(["authorize:outro_caminho", "authorize:fragmento", "authorize:outro_challenge", "authorize:cancelar"]);
    expect(state.auth.counters).toMatchObject({ authorize: { ok: 5, recusado: 0 }, exchange: { ok: 1, recusado: 1 } });
    expect((await storage(l!, "session"))[SESSION_STORAGE_KEY]).toMatchObject({ accessToken: state.auth.accessTokens[0] });
    expect((await sessoes()).at(-1)).toEqual({ autenticado: true, erro: null });
  });

  test("cenário 14: o BFF falso responde 503 ao logout; 2 chamadas com Bearer e { false, SERVICO_INDISPONIVEL } com o Tentar sair de novo", async () => {
    await control.script({ logout503: 2 });
    const before = (await sessoes()).length;
    await l!.panel.getByRole("button", { name: SESSION_ACTION_LABELS.sair }).click();
    // O logout local é imediato e incondicional (D11.5 passo 1): o storage já está vazio antes da rede responder.
    await expect.poll(async () => (await storage(l!, "session"))[SESSION_STORAGE_KEY]).toBeUndefined();
    await expect.poll(sessoes, { timeout: 10_000 }).toHaveLength(before + 2);
    expect((await sessoes()).slice(before)).toEqual([
      { autenticado: false, erro: null },
      { autenticado: false, erro: "SERVICO_INDISPONIVEL" },
    ]);
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(LOGOUT_UNCONFIRMED_TEXT));
    expect(await sessionButtons(l!)).toEqual([SESSION_ACTION_LABELS.tentar_sair, ...ENTRAR]);

    // Mais que os 2 s da repetição: nenhuma 3ª chamada sozinha, e nenhuma renovação.
    await l!.panel.waitForTimeout(2_500);
    let state = await control.state();
    const logoutPost = { server: "bff", method: "POST", path: "/v1/auth/logout", origin: ORIGIN, authorization: true, cookie: false };
    expect(bffRequests(state, "/v1/auth/logout").filter((r) => r.method === "POST")).toEqual([logoutPost, logoutPost]);
    expect(state.auth.roteiro.slice(-2)).toEqual(["logout:503", "logout:503"]);
    expect(state.auth.counters.logout).toEqual({ ok: 0, recusado: 2 });
    expect(bffRequests(state, "/v1/auth/refresh")).toEqual([]);
    expect(await storage(l!, "session")).toEqual({});

    // "Tentar sair de novo": a sessão guardada só na memória do SW encerra no servidor com o mesmo Bearer, que seguia vivo.
    await l!.panel.getByRole("button", { name: SESSION_ACTION_LABELS.tentar_sair }).click();
    await expect.poll(async () => (await control.state()).auth.counters.logout).toEqual({ ok: 1, recusado: 2 });
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
    expect(await sessionButtons(l!)).toEqual(ENTRAR);
    state = await control.state();
    expect(bffRequests(state, "/v1/auth/logout").filter((r) => r.method === "POST")).toEqual([logoutPost, logoutPost, logoutPost]);
    expect(findCanaries(await panelDump(l!), state.auth.canaries)).toEqual([]);
    expect(await storage(l!, "session")).toEqual({});
  });
});

describe("canais externos fechados no build com a chave (ADR-004 §4.4, cenário 9)", () => {
  let l: Loaded | undefined;
  beforeAll(async () => {
    l = await loadExtension(cfg.extAuth, { chromiumappPort: cfg.chromiumappPort });
  });
  afterAll(() => unload(l));

  /** Roda na página: diz se ela enxerga o `sendMessage` do runtime (a forma de falar com uma extensão). */
  const sendMessageType = () => typeof (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome?.runtime?.sendMessage;

  test("runtime.sendMessage avulso, com ou sem o ID, falha com 'Receiving end does not exist': o canal único é a porta", async () => {
    const errors = await l!.panel.evaluate(async (id) => {
      const attempt = async (send: () => Promise<unknown>) => {
        try {
          await send();
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      };
      return [
        await attempt(() => chrome.runtime.sendMessage({ kind: "hello", protocolVersion: 1 })),
        await attempt(() => chrome.runtime.sendMessage(id, { kind: "entrar", provedor: "github" })),
      ];
    }, cfg.extensionId);
    for (const error of errors) expect(error).toMatch(/Receiving end does not exist/);
  });

  test("uma página de outra origem não enxerga o runtime da extensão (externally_connectable vazio); o painel enxerga (controle)", async () => {
    expect(await l!.panel.evaluate(sendMessageType)).toBe("function");
    await l!.ctx.route("https://outra-origem.test/**", (route) => route.fulfill({ body: "<!doctype html><title>outra</title><p>outra origem</p>", contentType: "text/html" }));
    const page = await l!.ctx.newPage();
    try {
      await page.goto("https://outra-origem.test/pagina");
      expect(await page.evaluate(sendMessageType)).toBe("undefined");
    } finally {
      await page.close();
      await l!.ctx.unroute("https://outra-origem.test/**");
    }
  });
});
