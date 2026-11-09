// Leitores do E2E de login (F1-EXT-05c; ADR-004 §4.4 e §4.5), divididos pelos arquivos de cenário. Precisam do
// navegador, então ficam fora do `support/` (que é lógica pura, na cobertura de 100% da extensão).
import { expect } from "vitest";

import { PANEL_PORT_NAME } from "../../src/messaging/protocol";
import type { SessionText } from "../../src/panel/texts";
import type { Loaded } from "./browser";
import type { FakeState } from "./support/fake-servers";

declare const chrome: (typeof import("wxt/browser"))["browser"];

type Area = "session" | "local" | "sync";
/**
 * O storage por CDP `Extensions.getStorageItems`, como o §4.4 pede: nada roda dentro da extensão para ler. No Edge 157, a
 * sessão do navegador responde "No associated browser context", e a de uma página comum, "Extension not found": só a
 * sessão anexada a uma página da própria extensão (o painel) lê.
 */
export async function storage(l: Loaded, storageArea: Area): Promise<Record<string, unknown>> {
  const cdp = await l.ctx.newCDPSession(l.panel);
  try {
    return ((await cdp.send("Extensions.getStorageItems" as never, { id: l.id, storageArea } as never)) as { data: Record<string, unknown> }).data;
  } finally {
    await cdp.detach();
  }
}

/** Grava e apaga no storage da extensão por CDP, também só pela sessão do painel: o controle positivo do leitor (§4.5 item 8). */
export async function setStorage(l: Loaded, storageArea: Area, values: Record<string, unknown>): Promise<void> {
  const cdp = await l.ctx.newCDPSession(l.panel);
  try {
    await cdp.send("Extensions.setStorageItems" as never, { id: l.id, storageArea, values } as never);
  } finally {
    await cdp.detach();
  }
}

export async function removeStorage(l: Loaded, storageArea: Area, keys: string[]): Promise<void> {
  const cdp = await l.ctx.newCDPSession(l.panel);
  try {
    await cdp.send("Extensions.removeStorageItems" as never, { id: l.id, storageArea, keys } as never);
  } finally {
    await cdp.detach();
  }
}

export interface OriginStorage {
  localStorage: string[][];
  indexedDB: string[];
  /** Os nomes dos caches do CacheStorage (05c-3, §4.5 item 8). */
  cacheStorage: string[];
}

/** O localStorage, os bancos IndexedDB e os caches do CacheStorage da origem da extensão, por CDP (cenário 6, P13; §4.5 item 8). */
export async function originStorage(l: Loaded): Promise<OriginStorage> {
  const cdp = await l.ctx.newCDPSession(l.panel);
  const storageKey = `chrome-extension://${l.id}/`;
  try {
    const local = (await cdp.send("DOMStorage.getDOMStorageItems" as never, { storageId: { storageKey, isLocalStorage: true } } as never)) as { entries: string[][] };
    const idb = (await cdp.send("IndexedDB.requestDatabaseNames" as never, { storageKey } as never)) as { databaseNames: string[] };
    const caches = (await cdp.send("CacheStorage.requestCacheNames" as never, { storageKey } as never)) as { caches: Array<{ cacheName: string }> };
    return { localStorage: local.entries, indexedDB: idb.databaseNames, cacheStorage: caches.caches.map((c) => c.cacheName) };
  } finally {
    await cdp.detach();
  }
}

export const sessionLines = (l: Loaded): Promise<string[]> => l.panel.locator("[data-sessao] p:not(.acoes)").allInnerTexts();
export const sessionButtons = (l: Loaded): Promise<string[]> => l.panel.locator("[data-sessao] button").allInnerTexts();
export const connection = (l: Loaded): Promise<string | null> => l.panel.locator("[data-connection]").getAttribute("data-connection");
export const expectedLines = (texto: SessionText): string[] => [texto.estado, ...(texto.erro === null ? [] : [texto.erro.titulo, texto.erro.acao])];

/** Tudo o que o painel mostra ou guarda no DOM: o texto e o valor de cada atributo (§4.5 item 2). */
export const panelDump = (l: Loaded): Promise<string> =>
  l.panel.evaluate(() =>
    [document.body.innerText, ...[...document.querySelectorAll("*")].flatMap((el) => [...el.attributes].map((a) => `${a.name}=${a.value}`))].join("\n"),
  );

export const bffRequests = (state: FakeState, path: string): FakeState["requests"] => state.requests.filter((r) => r.server === "bff" && r.path === path);

/**
 * Os pedidos que chegaram ao chromiumapp local: só o GET do próprio retorno (em `/auth` ou no caminho do roteiro), sem
 * origem, Authorization nem Cookie. O navegador intercepta o retorno, mas pode já ter mandado o GET (§4.4, "Emenda do 05c-1").
 */
export function chromiumappHits(state: FakeState, paths: readonly string[] = ["/auth"]): number {
  const hits = state.requests.filter((r) => r.server === "chromiumapp");
  for (const hit of hits) {
    expect(paths).toContain(hit.path);
    expect(hit).toEqual({ server: "chromiumapp", method: "GET", path: hit.path, origin: null, authorization: false, cookie: false });
  }
  return hits.length;
}

/** O handshake de uma porta nova aberta na página do painel (cenário 10): as 4 mensagens, ou o que chegar em 5 s. */
const handshakeIn = ([name]: [string]) =>
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

export const handshake = (l: Loaded): Promise<unknown[]> => l.panel.evaluate(handshakeIn, [PANEL_PORT_NAME] as [string]);

export const handshakeWith = (sessao: { autenticado: boolean; erro: string | null }): unknown[] => [
  { kind: "ready", protocolVersion: 1 },
  { kind: "captura", captura: { estado: "ocioso" } },
  { kind: "consentimento", dado: false },
  { kind: "sessao", sessao },
];

/**
 * Uma porta de observação na página do painel: guarda cada `sessao` que o SW emitir dali em diante (o hub emite para
 * todas as portas, 05b-1). Diz a `SessaoView` exata de cada tentativa, e não só o texto da tela.
 */
export async function observeSessions(l: Loaded): Promise<() => Promise<unknown[]>> {
  await l.panel.evaluate(
    ([name]) =>
      new Promise<void>((resolve) => {
        const scope = globalThis as unknown as { __trampoSessoes: unknown[] };
        scope.__trampoSessoes = [];
        let handshakeLeft = 4;
        const port = chrome.runtime.connect({ name });
        port.onMessage.addListener((m: { kind: string; sessao?: unknown }) => {
          if (handshakeLeft > 0) {
            handshakeLeft -= 1;
            if (handshakeLeft === 0) resolve();
            return;
          }
          if (m.kind === "sessao") scope.__trampoSessoes.push(m.sessao);
        });
        port.postMessage({ kind: "hello", protocolVersion: 1 });
      }),
    [PANEL_PORT_NAME] as [string],
  );
  return () => l.panel.evaluate(() => [...(globalThis as unknown as { __trampoSessoes: unknown[] }).__trampoSessoes]);
}
