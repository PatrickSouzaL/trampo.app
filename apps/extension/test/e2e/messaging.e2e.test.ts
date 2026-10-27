// F1-EXT-02 no navegador real (SR-10): o handshake do painel funciona com o `sender` VERDADEIRO do
// Chrome/Edge, e as recusas (porta com nome errado, mensagem fora do contrato) derrubam a porta.
// Complementa os testes de unidade, que usam portas falsas.
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";

import { PANEL_PORT_NAME } from "../../src/messaging/protocol";
import { loadExtension, unload, type Loaded } from "./browser";

const cfg = inject("e2e");

// As funções passadas ao `evaluate` rodam DENTRO da página da extensão, onde `chrome` existe.
declare const chrome: (typeof import("wxt/browser"))["browser"];

type PortOutcome = { received: unknown[]; disconnected: boolean };

/** Abre uma porta a partir da página do painel, envia mensagens e observa por um tempo curto. */
const openPort = async ([name, messages]: [string, unknown[]]): Promise<PortOutcome> => {
  const port = chrome.runtime.connect({ name });
  const received: unknown[] = [];
  let disconnected = false;
  port.onMessage.addListener((m: unknown) => received.push(m));
  port.onDisconnect.addListener(() => {
    disconnected = true;
  });
  for (const m of messages) port.postMessage(m);
  await new Promise((r) => setTimeout(r, 500));
  return { received, disconnected };
};

describe("porta do painel no navegador real", () => {
  let l: Loaded | undefined;
  beforeAll(async () => {
    l = await loadExtension(cfg.extNoOrigin);
  });
  afterAll(() => unload(l));

  test("o painel real mostra 'Pronto' (handshake hello → ready)", async () => {
    await expect.poll(() => l!.panel.locator("[data-connection]").getAttribute("data-connection"), { timeout: 5000 }).toBe("pronto");
  });

  test("hello válido recebe ready e o estado da captura, e a porta continua aberta", async () => {
    const out = await l!.panel.evaluate(openPort, [PANEL_PORT_NAME, [{ kind: "hello", protocolVersion: 1 }]] as [string, unknown[]]);
    const ready = { kind: "ready", protocolVersion: 1 };
    expect(out).toEqual({ received: [ready, { kind: "captura", captura: { estado: "ocioso" } }], disconnected: false });
  });

  test("porta com nome errado é derrubada sem resposta", async () => {
    const out = await l!.panel.evaluate(openPort, ["outra-porta", [{ kind: "hello", protocolVersion: 1 }]] as [string, unknown[]]);
    expect(out).toEqual({ received: [], disconnected: true });
  });

  test("mensagem fora do contrato derruba a porta sem resposta", async () => {
    const out = await l!.panel.evaluate(openPort, [PANEL_PORT_NAME, [{ kind: "hello", protocolVersion: 1, token: "x" }]] as [string, unknown[]]);
    expect(out).toEqual({ received: [], disconnected: true });
  });

  test("runtime.sendMessage avulso não tem handler (canal único é a porta)", async () => {
    const error = await l!.panel.evaluate(async () => {
      try {
        await chrome.runtime.sendMessage({ kind: "hello", protocolVersion: 1 });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    expect(error).toMatch(/Receiving end does not exist/);
  });
});
