// F1-EXT-03 parte 1 (ADR-024 D4): a última captura fica em storage.session, o painel recebe só a
// visão (sem o texto), dois cliques seguidos não se atropelam e a aba fechada leva a captura junto.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

import { CAPTURE_STORAGE_KEY, CaptureStateSchema, captureView, createCaptureService, type CaptureState } from "../src/capture/capture-service";
import type { ExtractorRunner } from "../src/capture/capture";
import type { WorkerToPanel } from "../src/messaging/protocol";
import { sessionStore } from "../src/messaging/session-store";
import type { PanelPort } from "../src/messaging/worker-port";

const SECRET = "CANARIO-TEXTO-DA-VAGA";
const PAGE_TEXT = `${SECRET} ${"a".repeat(250)}`;
const okFrames = (texto: string) => [
  {
    frameId: 0,
    result: {
      ok: true,
      versao: "ge1",
      raiz: "main",
      texto,
      truncado: false,
      descartes: { naoTexto: 0, ruido: 0, naoRenderizado: 0, ariaHidden: 0, opacidade: 0, recorte: 0, visibilidade: 0, fonteMinuscula: 0, tamanhoZero: 0, foraDaTela: 0, cortado: 0, corDoFundo: 0 },
    },
  },
];

function fakePort() {
  const onDisconnect: Array<() => void> = [];
  const received: WorkerToPanel[] = [];
  const port = {
    name: "p",
    postMessage: vi.fn((m: WorkerToPanel) => {
      received.push(m);
    }),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: (l: () => void) => onDisconnect.push(l) },
  } satisfies PanelPort;
  return { port, received, disconnect: () => onDisconnect.forEach((l) => l()) };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(runExtractor: ExtractorRunner = () => Promise.resolve(okFrames(PAGE_TEXT))) {
  const store = sessionStore(CAPTURE_STORAGE_KEY, CaptureStateSchema);
  const logFailure = vi.fn();
  let clock = 100;
  const service = createCaptureService({ store, runExtractor, now: () => clock++, logFailure });
  const stored = async () => (await fakeBrowser.storage.session.get(CAPTURE_STORAGE_KEY))[CAPTURE_STORAGE_KEY] as CaptureState | undefined;
  return { service, store, logFailure, stored };
}

const views = (received: WorkerToPanel[]) => received.map((m) => (m.kind === "captura" ? m.captura : m));

describe("captureView", () => {
  test("mapeia cada estado sem levar o texto", () => {
    expect(captureView(undefined)).toEqual({ estado: "ocioso" });
    expect(captureView({ estado: "lendo", tabId: 1 })).toEqual({ estado: "lendo" });
    expect(captureView({ estado: "falhou", tabId: null, motivo: "erro" })).toEqual({ estado: "falhou", motivo: "erro" });
    const vaga = { tabId: 1, capturedAt: 0, platform: "generico" as const, extractorVersion: "ge1", text: "\u{1F600}".repeat(300), truncated: true };
    expect(captureView({ estado: "pronto", vaga })).toEqual({ estado: "pronto", origem: "pagina", caracteres: 300, truncado: true });
    expect(captureView({ estado: "pronto", vaga: { ...vaga, platform: "texto_colado", tabId: null, truncated: false } })).toEqual({
      estado: "pronto",
      origem: "texto_colado",
      caracteres: 300,
      truncado: false,
    });
  });
});

describe("createCaptureService", () => {
  beforeEach(() => fakeBrowser.reset());

  test("a plataforma do clique chega ao extrator e à vaga guardada (ADR-023 D11)", async () => {
    const frames = okFrames(PAGE_TEXT);
    const runExtractor = vi.fn<ExtractorRunner>(() => Promise.resolve([{ ...frames[0]!, result: { ...frames[0]!.result, versao: "li1", raiz: "plataforma" } }]));
    const { service, stored } = setup(runExtractor);
    await service.captureTab(4, "linkedin");
    expect(runExtractor).toHaveBeenCalledWith(4, "linkedin");
    expect(await stored()).toMatchObject({ estado: "pronto", vaga: { tabId: 4, platform: "linkedin", extractorVersion: "li1" } });
  });

  test("o painel ligado recebe o estado atual, depois lendo e pronto; o texto fica só no storage.session", async () => {
    const { service, stored, logFailure } = setup();
    const p = fakePort();
    await service.attach(p.port);
    await service.captureTab(9, "generico");
    expect(views(p.received)).toEqual([
      { estado: "ocioso" },
      { estado: "lendo" },
      { estado: "pronto", origem: "pagina", caracteres: PAGE_TEXT.length, truncado: false },
    ]);
    expect(JSON.stringify(p.received)).not.toContain(SECRET);
    expect(await stored()).toEqual({
      estado: "pronto",
      vaga: { tabId: 9, capturedAt: 100, platform: "generico", extractorVersion: "ge1", text: PAGE_TEXT, truncated: false },
    });
    expect(logFailure).not.toHaveBeenCalled();
    // eslint-disable-next-line no-restricted-syntax -- só leitura no fake, para provar que local ficou vazio
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
  });

  test("falha grava o motivo com a aba e registra só o motivo", async () => {
    const { service, stored, logFailure } = setup(() => Promise.reject(new Error(`Cannot access ${SECRET}`)));
    const p = fakePort();
    await service.attach(p.port);
    await service.captureTab(4, "generico");
    expect(await stored()).toEqual({ estado: "falhou", tabId: 4, motivo: "sem_acesso" });
    expect(views(p.received).at(-1)).toEqual({ estado: "falhou", motivo: "sem_acesso" });
    expect(logFailure.mock.calls).toEqual([["sem_acesso"]]);
  });

  test("dois cliques seguidos: só a captura mais recente grava, mesmo que a primeira termine depois", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const runs = [first, second];
    const { service, stored } = setup(() => runs.shift()!.promise);
    const p = fakePort();
    await service.attach(p.port);
    const a = service.captureTab(1, "generico");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const b = service.captureTab(2, "generico");
    await vi.waitFor(() => expect(runs).toHaveLength(0));
    second.resolve(okFrames(`segunda ${"b".repeat(250)}`));
    await b;
    first.resolve(okFrames(`primeira ${"c".repeat(250)}`));
    await a;
    const state = await stored();
    expect(state?.estado === "pronto" && state.vaga.tabId).toBe(2);
    expect(views(p.received).at(-1)).toMatchObject({ estado: "pronto" });
    expect(p.received.filter((m) => m.kind === "captura" && m.captura.estado === "pronto")).toHaveLength(1);
  });

  test("texto colado vira a vaga atual, sem aba, e passa à frente de uma leitura em curso", async () => {
    const pending = deferred<unknown>();
    const { service, stored } = setup(() => pending.promise);
    const p = fakePort();
    await service.attach(p.port);
    const reading = service.captureTab(3, "generico");
    await service.paste(`  ${"colado ".repeat(40)}\u0000`);
    pending.resolve(okFrames(PAGE_TEXT));
    await reading;
    const state = await stored();
    expect(state).toMatchObject({ estado: "pronto", vaga: { tabId: null, platform: "texto_colado", extractorVersion: "colado-1" } });
    expect(state?.estado === "pronto" && state.vaga.text.endsWith("colado")).toBe(true);
    expect(views(p.received).at(-1)).toEqual({ estado: "pronto", origem: "texto_colado", caracteres: 279, truncado: false });
  });

  test("texto colado curto demais vira falha sem aba e registra só o motivo", async () => {
    const { service, stored, logFailure } = setup();
    await service.paste(SECRET);
    expect(await stored()).toEqual({ estado: "falhou", tabId: null, motivo: "texto_insuficiente" });
    expect(logFailure.mock.calls).toEqual([["texto_insuficiente"]]);
  });

  test("porta desconectada deixa de receber; as outras continuam", async () => {
    const { service } = setup();
    const a = fakePort();
    const b = fakePort();
    await service.attach(a.port);
    await service.attach(b.port);
    a.disconnect();
    await service.captureTab(1, "generico");
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(3);
  });

  test("porta que lança no envio sai da lista e não derruba as outras", async () => {
    const { service } = setup();
    const broken = fakePort();
    const ok = fakePort();
    await service.attach(broken.port);
    await service.attach(ok.port);
    broken.port.postMessage.mockImplementation(() => {
      throw new Error("Attempting to use a disconnected port object");
    });
    await service.captureTab(1, "generico");
    expect(broken.port.postMessage).toHaveBeenCalledTimes(2);
    expect(ok.received).toHaveLength(3);
  });

  test("porta que cai antes de ler o estado não recebe nada", async () => {
    const { service } = setup();
    const p = fakePort();
    const attaching = service.attach(p.port);
    p.disconnect();
    await attaching;
    expect(p.port.postMessage).not.toHaveBeenCalled();
  });

  test("o painel que conecta depois vê a captura guardada", async () => {
    const { service } = setup();
    await service.captureTab(5, "generico");
    const p = fakePort();
    await service.attach(p.port);
    expect(views(p.received)).toEqual([{ estado: "pronto", origem: "pagina", caracteres: PAGE_TEXT.length, truncado: false }]);
  });

  test("estado adulterado no storage é apagado e visto como ocioso", async () => {
    await fakeBrowser.storage.session.set({ [CAPTURE_STORAGE_KEY]: { estado: "pronto", vaga: { text: SECRET } } });
    const { service, stored } = setup();
    const p = fakePort();
    await service.attach(p.port);
    expect(views(p.received)).toEqual([{ estado: "ocioso" }]);
    expect(await stored()).toBeUndefined();
  });

  test("fechar a aba da captura apaga o estado e avisa o painel", async () => {
    const { service, stored } = setup();
    const p = fakePort();
    await service.attach(p.port);
    await service.captureTab(8, "generico");
    await service.tabClosed(8);
    expect(await stored()).toBeUndefined();
    expect(views(p.received).at(-1)).toEqual({ estado: "ocioso" });
  });

  test("fechar a aba de uma falha também apaga", async () => {
    const { service, stored } = setup(() => Promise.reject(new Error("x")));
    await service.captureTab(8, "generico");
    await service.tabClosed(8);
    expect(await stored()).toBeUndefined();
  });

  test("fechar outra aba, ou qualquer aba com texto colado, não apaga", async () => {
    const { service, stored } = setup();
    const p = fakePort();
    await service.attach(p.port);
    await service.tabClosed(1);
    await service.captureTab(8, "generico");
    await service.tabClosed(7);
    expect((await stored())?.estado).toBe("pronto");
    await service.paste("x".repeat(300));
    await service.tabClosed(8);
    expect(await stored()).toMatchObject({ estado: "pronto", vaga: { tabId: null } });
    expect(p.received).toHaveLength(4);
  });

  test("fechar a aba durante a leitura descarta o resultado que chegar depois", async () => {
    const pending = deferred<unknown>();
    const { service, stored } = setup(() => pending.promise);
    const reading = service.captureTab(6, "generico");
    await vi.waitFor(async () => expect(await stored()).toEqual({ estado: "lendo", tabId: 6 }));
    await service.tabClosed(6);
    pending.resolve(okFrames(PAGE_TEXT));
    await reading;
    expect(await stored()).toBeUndefined();
  });
});
