// F1-EXT-05c, 05c-2 (ADR-004 §4.4, cenários 13 e 6; P13 e CA-10): o ciclo de vida da sessão no build de PRODUÇÃO com as
// duas origens locais e a chave efêmera (modo 1 do P20). O SW parado por CDP (`Target.closeTarget`, achado do 05b-3), o
// 302 do login segurado pelo roteiro do Supabase falso, as duas recargas da extensão (`runtime.reload()` e um novo
// `loadUnpacked` no mesmo caminho) e o reinício do navegador com o perfil preservado. Cada "0" tem o seu controle positivo.
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";

import { SESSION_STORAGE_KEY } from "../../src/auth/session-schema";
import { SESSION_ACTION_LABELS, SESSION_TEXTS, SIGNING_IN_TEXT, SIGN_IN_LABELS } from "../../src/panel/texts";
import { browserPath, loadExtension, relaunch, reloadByLoadUnpacked, reloadByRuntime, stopWorker, unload, type Loaded } from "./browser";
import { bffRequests, chromiumappHits, connection, expectedLines, handshake, handshakeWith, originStorage, sessionButtons, sessionLines, storage } from "./session";
import { fakeControl } from "./support/fake-servers";
import { type Brand, browserBrand, p20ModeFor } from "./support/p20";

const cfg = inject("e2e");
const control = fakeControl(cfg.control.url, cfg.control.token);
const ENTRAR = [SIGN_IN_LABELS.github, SIGN_IN_LABELS.google];
const options = { chromiumappPort: cfg.chromiumappPort };

declare const chrome: (typeof import("wxt/browser"))["browser"];

// Navegador fora da tabela do P20 não roda o E2E de login (§4.4, "Emenda do 05c-1").
p20ModeFor(String(browserPath));
/**
 * Se a recarga por `chrome.runtime.reload()` traz a extensão de volta, fixo por navegador e nunca sondado em runtime
 * (sondado no 05c-2): no Edge 157 o SW novo sobe em menos de 500 ms; no Chrome 156, a extensão do `Extensions.loadUnpacked`
 * recarregada assim fica bloqueada (`ERR_BLOCKED_BY_CLIENT`) até o fim do navegador, e nem um novo `loadUnpacked` a traz
 * de volta. É limite do harness (a extensão por CDP), não do produto. O §4.4 aceita as duas formas: no Chrome, o cenário 6
 * roda com o novo `loadUnpacked` e o reinício.
 */
const RUNTIME_RELOAD_RETURNS: Readonly<Record<Brand, boolean>> = { edge: true, chrome: false };
const runtimeReloadReturns = RUNTIME_RELOAD_RETURNS[browserBrand(String(browserPath)) as Brand];

/** O access guardado agora, ou `undefined`. */
const storedAccess = async (l: Loaded) => ((await storage(l, "session"))[SESSION_STORAGE_KEY] as { accessToken?: string } | undefined)?.accessToken;

async function login(l: Loaded): Promise<string> {
  await expect.poll(() => sessionLines(l)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
  await l.panel.getByRole("button", { name: SIGN_IN_LABELS.github }).click();
  await expect.poll(() => sessionLines(l), { timeout: 15_000 }).toEqual(expectedLines(SESSION_TEXTS.conectado.nenhum));
  const access = await storedAccess(l);
  expect(access).toBe((await control.state()).auth.accessTokens.at(-1));
  return String(access);
}

/** Queda da porta pelo SW parado e o clique em "Reconectar", que acorda um SW novo e refaz o handshake. */
async function stopAndReconnect(l: Loaded): Promise<void> {
  await stopWorker(l);
  await expect.poll(() => connection(l)).toBe("desconectado");
  // Na queda, o único botão da tela é o Reconectar (fora do bloco da sessão), e nada reconecta sozinho (05b-3).
  expect(await l.panel.getByRole("button").allInnerTexts()).toEqual([SESSION_ACTION_LABELS.reconectar]);
  await l.panel.getByRole("button", { name: SESSION_ACTION_LABELS.reconectar }).click();
  await expect.poll(() => connection(l), { timeout: 10_000 }).toBe("pronto");
}

describe("SW parado por CDP, com sessão e com o 302 do login segurado (ADR-004 §4.4, cenário 13)", () => {
  let l: Loaded | undefined;
  beforeAll(async () => {
    await control.reset();
    l = await loadExtension(cfg.extAuth, options);
  });
  afterAll(() => unload(l));

  test("o 302 segurado e solto com o SW vivo: o login completa (o controle positivo do segurar e da contagem de trocas)", async () => {
    await control.script({ authorize: "segurar" });
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
    await l!.panel.getByRole("button", { name: SIGN_IN_LABELS.github }).click();
    await expect.poll(async () => (await control.state()).segurados).toBe(1);
    expect(await sessionLines(l!)).toEqual(expectedLines(SIGNING_IN_TEXT));
    expect((await control.state()).auth.counters.exchange).toEqual({ ok: 0, recusado: 0 });
    expect(await control.release()).toBe(1);
    await expect.poll(() => sessionLines(l!), { timeout: 15_000 }).toEqual(expectedLines(SESSION_TEXTS.conectado.nenhum));
    const state = await control.state();
    expect(state.auth.roteiro).toEqual(["authorize:segurar"]);
    expect(state.auth.counters.exchange).toEqual({ ok: 1, recusado: 0 });
    expect(chromiumappHits(state)).toBeLessThanOrEqual(1);
  });

  test("com sessão, o SW parado: a sessão sobrevive ao handshake do Reconectar ({ true, null }, o mesmo par no storage)", async () => {
    const before = await storedAccess(l!);
    expect(before).toEqual(expect.any(String));
    await stopAndReconnect(l!);
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.conectado.nenhum));
    expect(await sessionButtons(l!)).toEqual([SESSION_ACTION_LABELS.sair]);
    expect(await handshake(l!)).toEqual(handshakeWith({ autenticado: true, erro: null }));
    expect(await storedAccess(l!)).toBe(before);
    // Nenhuma renovação nem troca nova: o SW novo só leu o storage.session.
    const state = await control.state();
    expect(state.auth.counters).toMatchObject({ exchange: { ok: 1, recusado: 0 }, refresh: { ok: 0, recusado: 0 } });

    await l!.panel.getByRole("button", { name: SESSION_ACTION_LABELS.sair }).click();
    await expect.poll(async () => (await control.state()).auth.counters.logout).toEqual({ ok: 1, recusado: 0 });
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
  });

  test("o 302 segurado com o SW parado: { false, null } depois do Reconectar e 0 trocas, mesmo com o 302 solto depois", async () => {
    await control.script({ authorize: "segurar" });
    const pages = l!.ctx.pages().length;
    await l!.panel.getByRole("button", { name: SIGN_IN_LABELS.github }).click();
    await expect.poll(async () => (await control.state()).segurados).toBe(1);
    const verifiers = (await control.state()).auth.verifiers.length;

    await stopAndReconnect(l!);
    await expect.poll(() => sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
    expect(await sessionButtons(l!)).toEqual(ENTRAR);
    expect(await handshake(l!)).toEqual(handshakeWith({ autenticado: false, erro: null }));

    // O verifier morreu com o SW: o retorno que chega agora não tem quem o troque.
    expect(await control.release()).toBe(1);
    await l!.panel.waitForTimeout(2_000);
    const state = await control.state();
    expect(state.auth.roteiro).toEqual(["authorize:segurar", "authorize:segurar"]);
    expect(state.auth.counters.exchange).toEqual({ ok: 1, recusado: 0 });
    expect(bffRequests(state, "/v1/auth/exchange").filter((r) => r.method === "POST")).toHaveLength(1);
    expect(state.auth.verifiers).toHaveLength(verifiers);
    expect(chromiumappHits(state)).toBeLessThanOrEqual(2);
    expect(await sessionLines(l!)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
    expect(await storage(l!, "session")).toEqual({});
    console.info(`[cenário 13] páginas antes do login segurado: ${pages}; depois do 302 solto: ${l!.ctx.pages().length}`);
  });
});

describe("recarga da extensão e reinício do navegador (ADR-004 §4.4, cenário 6; P13 e CA-10)", () => {
  let l: Loaded | undefined;
  beforeAll(async () => {
    await control.reset();
    l = await loadExtension(cfg.extAuth, options);
  });
  afterAll(() => unload(l));

  /** `{ false, null }` no handshake e na tela, e nada em `session`, `local`, `sync`, localStorage nem IndexedDB. */
  async function expectClean(current: Loaded) {
    expect(current.id).toBe(cfg.extensionId);
    expect(await handshake(current)).toEqual(handshakeWith({ autenticado: false, erro: null }));
    await expect.poll(() => sessionLines(current)).toEqual(expectedLines(SESSION_TEXTS.desconectado.nenhum));
    expect(await sessionButtons(current)).toEqual(ENTRAR);
    expect(await storage(current, "session")).toEqual({});
    expect(await storage(current, "local")).toEqual({});
    expect(await storage(current, "sync")).toEqual({});
    expect(await originStorage(current)).toEqual({ localStorage: [], indexedDB: [] });
  }

  test("controle positivo dos leitores: a sessão no storage.session, e o localStorage e o IndexedDB da origem quando há o que ler", async () => {
    await login(l!);
    await l!.panel.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          localStorage.setItem("controle", "1");
          const open = indexedDB.open("controle");
          open.onsuccess = () => {
            open.result.close();
            resolve();
          };
          open.onerror = () => reject(new Error("IndexedDB"));
        }),
    );
    expect(await originStorage(l!)).toEqual({ localStorage: [["controle", "1"]], indexedDB: ["controle"] });
    await l!.panel.evaluate(
      () =>
        new Promise<void>((resolve) => {
          localStorage.clear();
          indexedDB.deleteDatabase("controle").onsuccess = () => resolve();
        }),
    );
    expect(await originStorage(l!)).toEqual({ localStorage: [], indexedDB: [] });
  });

  test.runIf(runtimeReloadReturns)("chrome.runtime.reload(): o SW novo começa sem sessão, e a origem fica sem resto", async () => {
    expect(await storedAccess(l!)).toEqual(expect.any(String));
    l = await reloadByRuntime(l!);
    await expectClean(l);
  });

  test("novo loadUnpacked no mesmo caminho (a atualização): o mesmo ID, sem sessão e sem resto", async () => {
    // No Chrome a recarga anterior não roda, e a sessão do controle positivo segue aberta.
    if ((await storedAccess(l!)) === undefined) await login(l!);
    expect(await storedAccess(l!)).toEqual(expect.any(String));
    l = await reloadByLoadUnpacked(l!, cfg.extAuth);
    await expectClean(l);
  });

  test("reinício do navegador com o perfil preservado: o mesmo ID, sem sessão e sem resto, e o login volta a funcionar", async () => {
    await login(l!);
    const { loaded, persisted } = await relaunch(l!, cfg.extAuth, options);
    l = loaded;
    console.info(`[P13] a extensão do loadUnpacked voltou sozinha com o perfil relançado: ${String(persisted)}`);
    expect(await l.worker.evaluate(() => chrome.identity.getRedirectURL("auth"))).toBe(`https://${cfg.extensionId}.chromiumapp.org/auth`);
    await expectClean(l);
    await login(l);
    const state = await control.state();
    // Um login por recarga que rodou, mais o do reinício e o último: 4 no Edge e 3 no Chrome. Nenhuma renovação nem logout.
    expect(state.auth.counters).toMatchObject({ exchange: { ok: runtimeReloadReturns ? 4 : 3, recusado: 0 }, refresh: { ok: 0, recusado: 0 }, logout: { ok: 0, recusado: 0 } });
  });
});
