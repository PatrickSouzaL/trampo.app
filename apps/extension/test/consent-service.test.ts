// F1-EXT-04 parte 1 (ADR-025 D2): o consentimento antes da 1ª transmissão é imposto pelo Service
// Worker, fica só em storage.session e vale só para a versão vigente do aviso.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

import { CONSENT_STORAGE_KEY, ConsentRecordSchema, createConsentService } from "../src/consent/consent-service";
import { CONSENT_VERSION, type WorkerToPanel } from "../src/messaging/protocol";
import { sessionStore } from "../src/messaging/session-store";
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

function setup() {
  const service = createConsentService({ store: sessionStore(CONSENT_STORAGE_KEY, ConsentRecordSchema), now: () => 1234 });
  const stored = async () => (await fakeBrowser.storage.session.get(CONSENT_STORAGE_KEY))[CONSENT_STORAGE_KEY] as unknown;
  return { service, stored };
}

const consent = (dado: boolean): WorkerToPanel => ({ kind: "consentimento", dado });

describe("consentimento no Service Worker", () => {
  beforeEach(() => fakeBrowser.reset());

  test("sem aceite, o portão do envio fica fechado e o painel vê 'não dado'", async () => {
    const { service } = setup();
    const p = fakePort();
    await service.attach(p.port);
    expect(p.received).toEqual([consent(false)]);
    expect(await service.isGranted()).toBe(false);
  });

  test("o aceite grava a versão do aviso e a hora em storage.session e avisa o painel", async () => {
    const { service, stored } = setup();
    const p = fakePort();
    await service.attach(p.port);
    await service.grant();
    expect(await stored()).toEqual({ versao: CONSENT_VERSION, dadoEm: 1234 });
    expect(p.received).toEqual([consent(false), consent(true)]);
    expect(await service.isGranted()).toBe(true);
    // eslint-disable-next-line no-restricted-syntax -- só leitura no fake, para provar que nada persiste em disco
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
  });

  test("revogar apaga o registro, fecha o portão e avisa o painel", async () => {
    const { service, stored } = setup();
    await service.grant();
    const p = fakePort();
    await service.attach(p.port);
    await service.revoke();
    expect(await stored()).toBeUndefined();
    expect(p.received).toEqual([consent(true), consent(false)]);
    expect(await service.isGranted()).toBe(false);
  });

  test("o painel que conecta depois vê o aceite guardado", async () => {
    const { service } = setup();
    await service.grant();
    const p = fakePort();
    await service.attach(p.port);
    expect(p.received).toEqual([consent(true)]);
  });

  test("aceite de um aviso antigo (ou adulterado) não vale e é apagado", async () => {
    const { service, stored } = setup();
    await fakeBrowser.storage.session.set({ [CONSENT_STORAGE_KEY]: { versao: "aviso-0", dadoEm: 1 } });
    expect(await service.isGranted()).toBe(false);
    expect(await stored()).toBeUndefined();
    await fakeBrowser.storage.session.set({ [CONSENT_STORAGE_KEY]: { versao: CONSENT_VERSION, dadoEm: 1, escopo: "tudo" } });
    expect(await service.isGranted()).toBe(false);
  });

  test("porta desconectada deixa de receber; as outras continuam", async () => {
    const { service } = setup();
    const a = fakePort();
    const b = fakePort();
    await service.attach(a.port);
    await service.attach(b.port);
    a.disconnect();
    await service.grant();
    expect(a.received).toEqual([consent(false)]);
    expect(b.received).toEqual([consent(false), consent(true)]);
  });

  test("porta que lança no envio sai da lista e não derruba as outras", async () => {
    const { service } = setup();
    let fail = false;
    const a = fakePort(() => {
      if (fail) throw new Error("porta fechada");
    });
    const b = fakePort();
    await service.attach(a.port);
    await service.attach(b.port);
    fail = true;
    await service.grant();
    await service.revoke();
    expect(a.port.postMessage).toHaveBeenCalledTimes(2);
    expect(b.received).toEqual([consent(false), consent(true), consent(false)]);
  });

  test("porta que cai antes de ler o estado não recebe nada", async () => {
    const { service } = setup();
    const p = fakePort();
    const pending = service.attach(p.port);
    p.disconnect();
    await pending;
    expect(p.received).toEqual([]);
  });
});
