// SR-10: o Service Worker rejeita porta ou mensagem de outra origem ou com forma inválida.
import { describe, expect, test, vi } from "vitest";

import { PANEL_PORT_NAME, WorkerToPanelSchema } from "../src/messaging/protocol";
import { checkPanelPort, handlePanelConnection, type PanelPort, type RejectReason } from "../src/messaging/worker-port";

const ID = "oniojmpioahjchcadecjkmekigalfack";
const BASE = `chrome-extension://${ID}/`;
const PANEL_URL = `chrome-extension://${ID}/sidepanel.html`;

type Sender = PanelPort["sender"];

function fakePort(name: string, sender: Sender) {
  const listeners: Array<(m: unknown) => void> = [];
  const port = {
    name,
    sender,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
  } satisfies PanelPort;
  const deliver = (m: unknown) => listeners.forEach((l) => l(m));
  return { port, deliver, listeners };
}

function connect(name: string, sender: Sender) {
  const rejections: RejectReason[] = [];
  const fp = fakePort(name, sender);
  handlePanelConnection(fp.port, { runtimeId: ID, extensionBaseUrl: BASE, logRejection: (r) => rejections.push(r) });
  return { ...fp, rejections };
}

describe("checkPanelPort", () => {
  test("aceita só a página de painel da própria extensão, com o nome de porta fixo", () => {
    expect(checkPanelPort({ name: PANEL_PORT_NAME, sender: { id: ID, url: PANEL_URL } }, ID, BASE)).toEqual({ trusted: true });
    // O painel aberto numa aba continua sendo código da extensão (tab não é critério).
    expect(checkPanelPort({ name: PANEL_PORT_NAME, sender: { id: ID, url: `${PANEL_URL}?x=1#y` } }, ID, BASE)).toEqual({ trusted: true });
  });

  const cases: Array<[string, string, Sender, RejectReason]> = [
    ["nome de porta errado", "outra-porta", { id: ID, url: PANEL_URL }, "nome_de_porta"],
    ["nome de porta parecido", `${PANEL_PORT_NAME} `, { id: ID, url: PANEL_URL }, "nome_de_porta"],
    ["sem remetente", PANEL_PORT_NAME, undefined, "sem_remetente"],
    ["remetente sem url", PANEL_PORT_NAME, { id: ID }, "sem_remetente"],
    ["outra extensão", PANEL_PORT_NAME, { id: "a".repeat(32), url: `chrome-extension://${"a".repeat(32)}/sidepanel.html` }, "extensao_diferente"],
    ["id certo, url de outra extensão", PANEL_PORT_NAME, { id: ID, url: `chrome-extension://${"b".repeat(32)}/sidepanel.html` }, "origem_diferente"],
    // Content script: tem tab e a url é a da página web; é dado de página, nunca comando.
    ["content script numa página web", PANEL_PORT_NAME, { id: ID, url: "https://www.linkedin.com/jobs/view/1/" }, "origem_diferente"],
    ["página web imitando o caminho", PANEL_PORT_NAME, { id: ID, url: "https://evil.example/sidepanel.html" }, "origem_diferente"],
    ["url malformada", PANEL_PORT_NAME, { id: ID, url: "::::" }, "origem_diferente"],
    ["outra página da extensão", PANEL_PORT_NAME, { id: ID, url: `chrome-extension://${ID}/background.js` }, "pagina_diferente"],
    ["caminho parecido", PANEL_PORT_NAME, { id: ID, url: `chrome-extension://${ID}/sidepanel.html/../x.html` }, "pagina_diferente"],
  ];
  test.each(cases)("rejeita: %s", (_label, name, sender, reason) => {
    expect(checkPanelPort({ name, sender }, ID, BASE)).toEqual({ trusted: false, reason });
  });
});

describe("handlePanelConnection", () => {
  test("hello válido recebe ready", () => {
    const c = connect(PANEL_PORT_NAME, { id: ID, url: PANEL_URL });
    c.deliver({ kind: "hello", protocolVersion: 1 });
    expect(c.port.postMessage).toHaveBeenCalledWith({ kind: "ready", protocolVersion: 1 });
    expect(c.port.disconnect).not.toHaveBeenCalled();
    expect(c.rejections).toEqual([]);
  });

  test("porta não confiável é desconectada antes de qualquer mensagem", () => {
    const c = connect(PANEL_PORT_NAME, { id: ID, url: "https://www.linkedin.com/jobs/view/1/" });
    expect(c.port.disconnect).toHaveBeenCalledOnce();
    expect(c.listeners).toHaveLength(0);
    expect(c.rejections).toEqual(["origem_diferente"]);
  });

  const invalid: Array<[string, unknown]> = [
    ["chave extra", { kind: "hello", protocolVersion: 1, token: "x" }],
    ["versão errada", { kind: "hello", protocolVersion: 2 }],
    ["tipo desconhecido", { kind: "analyze", url: "https://x" }],
    ["sem kind", { protocolVersion: 1 }],
    ["string", "hello"],
    ["null", null],
    ["__proto__", JSON.parse('{"kind":"hello","protocolVersion":1,"__proto__":{"x":1}}')],
  ];
  test.each(invalid)("mensagem inválida (%s) derruba a porta sem resposta", (_label, msg) => {
    const c = connect(PANEL_PORT_NAME, { id: ID, url: PANEL_URL });
    c.deliver(msg);
    expect(c.port.postMessage).not.toHaveBeenCalled();
    expect(c.port.disconnect).toHaveBeenCalledOnce();
    expect(c.rejections).toEqual(["forma_invalida"]);
  });

  test("o log de recusa recebe só o motivo, nunca o conteúdo", () => {
    const log = vi.fn();
    const { port, deliver } = fakePort(PANEL_PORT_NAME, { id: ID, url: PANEL_URL });
    handlePanelConnection(port, { runtimeId: ID, extensionBaseUrl: BASE, logRejection: log });
    deliver({ kind: "hello", protocolVersion: 1, segredo: "texto da vaga" });
    expect(log).toHaveBeenCalledWith("forma_invalida");
    expect(JSON.stringify(log.mock.calls)).not.toContain("texto da vaga");
  });
});

describe("WorkerToPanelSchema (revalidação no painel)", () => {
  test("aceita ready e eventos de stream do contrato público", () => {
    expect(WorkerToPanelSchema.safeParse({ kind: "ready", protocolVersion: 1 }).success).toBe(true);
    const stage = { type: "stage", stage: "extraindo_fatos", elapsedMs: 900 };
    expect(WorkerToPanelSchema.safeParse({ kind: "stream", event: stage }).success).toBe(true);
  });

  test("rejeita evento fora do contrato, HTML e chave extra", () => {
    expect(WorkerToPanelSchema.safeParse({ kind: "stream", event: { type: "debug", stack: "x" } }).success).toBe(false);
    const htmlError = { type: "error", error: { code: "ERRO_INTERNO", message: "<img src=x onerror=1>", requestId: null, retryAfterSeconds: null } };
    expect(WorkerToPanelSchema.safeParse({ kind: "stream", event: htmlError }).success).toBe(false);
    expect(WorkerToPanelSchema.safeParse({ kind: "ready", protocolVersion: 1, html: "<b>" }).success).toBe(false);
    expect(WorkerToPanelSchema.safeParse({ kind: "render", html: "<b>" }).success).toBe(false);
  });
});
