// F1-EXT-02 no navegador real (SR-10): o handshake do painel funciona com o `sender` VERDADEIRO do
// Chrome/Edge, e as recusas (porta com nome errado, mensagem fora do contrato) derrubam a porta.
// Complementa os testes de unidade, que usam portas falsas. F1-EXT-05b, 05b-1 (ADR-004 D12 e CA-14): o handshake
// termina na sessão, e "entrar" e "sair" chegam ao Service Worker real pela porta.
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

/** Como o openPort, mas só envia as mensagens depois do handshake inteiro (4 mensagens), para não correr com ele. */
const afterHandshake = async ([name, messages]: [string, unknown[]]): Promise<PortOutcome> => {
  const port = chrome.runtime.connect({ name });
  const received: unknown[] = [];
  let disconnected = false;
  port.onMessage.addListener((m: unknown) => received.push(m));
  port.onDisconnect.addListener(() => {
    disconnected = true;
  });
  port.postMessage({ kind: "hello", protocolVersion: 1 });
  for (const start = Date.now(); received.length < 4 && Date.now() - start < 5000; ) await new Promise((r) => setTimeout(r, 20));
  for (const m of messages) port.postMessage(m);
  await new Promise((r) => setTimeout(r, 500));
  return { received, disconnected };
};

const READY = { kind: "ready", protocolVersion: 1 };
const OCIOSO = { kind: "captura", captura: { estado: "ocioso" } };
const SEM_CONSENTIMENTO = { kind: "consentimento", dado: false };
const sessao = (autenticado: boolean, erro: string | null) => ({ kind: "sessao", sessao: { autenticado, erro } });
const HANDSHAKE = [READY, OCIOSO, SEM_CONSENTIMENTO, sessao(false, null)];

describe("porta do painel no navegador real", () => {
  let l: Loaded | undefined;
  beforeAll(async () => {
    l = await loadExtension(cfg.extNoOrigin);
  });
  afterAll(() => unload(l));

  test("o painel real mostra 'Pronto' (handshake hello → ready)", async () => {
    await expect.poll(() => l!.panel.locator("[data-connection]").getAttribute("data-connection"), { timeout: 5000 }).toBe("pronto");
  });

  test("hello válido recebe exatamente [ready, captura, consentimento, sessao], e a porta continua aberta (D12, CA-14)", async () => {
    const out = await l!.panel.evaluate(openPort, [PANEL_PORT_NAME, [{ kind: "hello", protocolVersion: 1 }]] as [string, unknown[]]);
    expect(out).toEqual({ received: HANDSHAKE, disconnected: false });
  });

  test("entrar no build sem as origens dá { false, ERRO_INTERNO } sem abrir janela de login (D12, 'Build sem origem')", async () => {
    const pages = l!.ctx.pages().length;
    const out = await l!.panel.evaluate(afterHandshake, [PANEL_PORT_NAME, [{ kind: "entrar", provedor: "github" }]] as [string, unknown[]]);
    expect(out).toEqual({ received: [...HANDSHAKE, sessao(false, "ERRO_INTERNO")], disconnected: false });
    expect(l!.ctx.pages()).toHaveLength(pages);
  });

  test("sair sem sessão emite { false, null }, e a porta continua aberta (D12, '\"Sair\"')", async () => {
    const out = await l!.panel.evaluate(afterHandshake, [PANEL_PORT_NAME, [{ kind: "sair" }]] as [string, unknown[]]);
    expect(out).toEqual({ received: [...HANDSHAKE, sessao(false, null)], disconnected: false });
  });

  test.each([
    ["provedor fora da lista", { kind: "entrar", provedor: "facebook" }],
    ["entrar com URL de retorno", { kind: "entrar", provedor: "github", redirectTo: "https://evil.example/" }],
    ["sair com payload", { kind: "sair", escopo: "local" }],
    ["sessao vinda do painel", { kind: "sessao", sessao: { autenticado: true, erro: null } }],
  ])("%s derruba a porta depois do handshake, sem resposta", async (_caso, message) => {
    const out = await l!.panel.evaluate(afterHandshake, [PANEL_PORT_NAME, [message]] as [string, unknown[]]);
    expect(out).toEqual({ received: HANDSHAKE, disconnected: true });
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
