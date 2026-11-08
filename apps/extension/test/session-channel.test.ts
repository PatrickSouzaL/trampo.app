// F1-EXT-05b, 05b-1 (ADR-004 D10 B6 e D12): o canal da sessão leva ao painel só a SessaoView saneada, a todas as
// portas, e o handshake nunca sobrescreve um estado novo com uma leitura velha.
import { describe, expect, test, vi } from "vitest";

import type { SessaoView, WorkerToPanel } from "../src/messaging/protocol";
import { createSessionChannel } from "../src/messaging/session-channel";
import type { PanelPort } from "../src/messaging/worker-port";

function fakePort(postMessage: (m: WorkerToPanel) => void = () => undefined) {
  const onDisconnect: Array<() => void> = [];
  const received: WorkerToPanel[] = [];
  const port = {
    name: "p",
    postMessage: vi.fn((m: WorkerToPanel) => {
      postMessage(m);
      received.push(m);
    }),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: (l: () => void) => onDisconnect.push(l) },
  } satisfies PanelPort;
  return { port, received, disconnect: () => onDisconnect.forEach((l) => l()) };
}

/** Uma leitura da visão atual que só resolve quando o teste mandar. */
function deferredView() {
  let resolve: (view: SessaoView) => void = () => undefined;
  const promise = new Promise<SessaoView>((r) => {
    resolve = r;
  });
  return { current: () => promise, resolve };
}

const sessao = (view: SessaoView): WorkerToPanel => ({ kind: "sessao", sessao: view });
const NAO_LOGADO: SessaoView = { autenticado: false, erro: null };
const LOGADO: SessaoView = { autenticado: true, erro: null };

describe("canal da sessão", () => {
  test("o handshake entrega a visão atual à porta que entrou", async () => {
    const channel = createSessionChannel();
    const p = fakePort();
    await channel.attach(p.port, async () => LOGADO);
    expect(p.received).toStrictEqual([sessao(LOGADO)]);
  });

  test("cada emissão vai a todas as portas do canal, e só a elas", async () => {
    const channel = createSessionChannel();
    const a = fakePort();
    const b = fakePort();
    const fora = fakePort();
    await channel.attach(a.port, async () => NAO_LOGADO);
    await channel.attach(b.port, async () => NAO_LOGADO);
    channel.emit({ autenticado: true, erro: "SERVICO_INDISPONIVEL" });
    const esperado = [sessao(NAO_LOGADO), sessao({ autenticado: true, erro: "SERVICO_INDISPONIVEL" })];
    expect(a.received).toStrictEqual(esperado);
    expect(b.received).toStrictEqual(esperado);
    expect(fora.received).toStrictEqual([]);
  });

  test("a porta que caiu sai do canal", async () => {
    const channel = createSessionChannel();
    const a = fakePort();
    const b = fakePort();
    await channel.attach(a.port, async () => NAO_LOGADO);
    await channel.attach(b.port, async () => NAO_LOGADO);
    a.disconnect();
    channel.emit(LOGADO);
    expect(a.received).toStrictEqual([sessao(NAO_LOGADO)]);
    expect(b.received).toStrictEqual([sessao(NAO_LOGADO), sessao(LOGADO)]);
  });

  test("a porta que cai durante a leitura não recebe o handshake", async () => {
    const channel = createSessionChannel();
    const a = fakePort();
    const leitura = deferredView();
    const attached = channel.attach(a.port, leitura.current);
    a.disconnect();
    leitura.resolve(LOGADO);
    await attached;
    expect(a.received).toStrictEqual([]);
  });

  test("emissão durante a leitura do handshake: a porta fica com a emissão, e a leitura velha não vai por cima", async () => {
    const channel = createSessionChannel();
    const a = fakePort();
    const leitura = deferredView();
    const attached = channel.attach(a.port, leitura.current);
    // O login termina enquanto o storage é lido: a emissão já alcança a porta, que entrou antes da leitura.
    channel.emit(LOGADO);
    leitura.resolve(NAO_LOGADO);
    await attached;
    expect(a.received).toStrictEqual([sessao(LOGADO)]);
  });

  test("uma emissão não cancela o handshake de uma porta que entra depois dela", async () => {
    const channel = createSessionChannel();
    channel.emit(LOGADO);
    const a = fakePort();
    await channel.attach(a.port, async () => LOGADO);
    expect(a.received).toStrictEqual([sessao(LOGADO)]);
  });

  test("uma porta que lança no envio sai do canal sem derrubar as outras", async () => {
    const channel = createSessionChannel();
    let falhar = false;
    const quebrada = fakePort(() => {
      if (falhar) throw new Error("porta desconectada");
    });
    const boa = fakePort();
    await channel.attach(quebrada.port, async () => NAO_LOGADO);
    await channel.attach(boa.port, async () => NAO_LOGADO);
    falhar = true;
    channel.emit(LOGADO);
    channel.emit(NAO_LOGADO);
    expect(quebrada.port.postMessage).toHaveBeenCalledTimes(2);
    expect(boa.received).toStrictEqual([sessao(NAO_LOGADO), sessao(LOGADO), sessao(NAO_LOGADO)]);
  });

  test("emissão e handshake saem saneados: campo a mais nunca chega à porta (D10 B6)", async () => {
    const channel = createSessionChannel();
    const a = fakePort();
    const vazada = { autenticado: true, erro: null, accessToken: "CANARIO.TOKEN.um", refreshToken: "r1.CANARIO" } as unknown as SessaoView;
    await channel.attach(a.port, async () => vazada);
    channel.emit(vazada);
    expect(a.received).toStrictEqual([sessao(LOGADO), sessao(LOGADO)]);
    expect(JSON.stringify(a.port.postMessage.mock.calls)).not.toContain("CANARIO");
  });

  test("valor fora do schema chega à porta como { false, ERRO_INTERNO }", async () => {
    const channel = createSessionChannel();
    const a = fakePort();
    const incoerente = { autenticado: true, erro: "NAO_AUTENTICADO" } as unknown as SessaoView;
    await channel.attach(a.port, async () => incoerente);
    channel.emit(incoerente);
    const falha = sessao({ autenticado: false, erro: "ERRO_INTERNO" });
    expect(a.received).toStrictEqual([falha, falha]);
  });
});
