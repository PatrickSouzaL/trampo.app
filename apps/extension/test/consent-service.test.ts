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

  describe("onRevoke (ADR-025 §6.3 D17): a análise em curso para antes de o registro sair", () => {
    function withHook() {
      const p = fakePort();
      const onRevoke = vi.fn();
      const store = sessionStore(CONSENT_STORAGE_KEY, ConsentRecordSchema);
      const remove = vi.spyOn(store, "remove");
      const service = createConsentService({ store, now: () => 1234, onRevoke });
      return { service, onRevoke, remove, p };
    }

    test("o revoke chama o gancho uma vez, antes de apagar o registro e de avisar o painel", async () => {
      const { service, onRevoke, remove, p } = withHook();
      await service.grant();
      await service.attach(p.port);
      const before = p.received.length;
      let painelNoGancho: number | undefined;
      let removeNoGancho: number | undefined;
      onRevoke.mockImplementation(() => {
        painelNoGancho = p.received.length;
        removeNoGancho = remove.mock.calls.length;
      });
      await service.revoke();
      expect(onRevoke).toHaveBeenCalledTimes(1);
      expect(removeNoGancho).toBe(0);
      expect(painelNoGancho).toBe(before);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(p.received.at(-1)).toEqual(consent(false));
    });

    test("o aceite, a leitura e a conexão do painel não chamam o gancho", async () => {
      const { service, onRevoke, p } = withHook();
      await service.grant();
      await service.attach(p.port);
      await service.isGranted();
      expect(onRevoke).not.toHaveBeenCalled();
    });

    test("o registro de um aviso antigo, apagado na leitura, não chama o gancho", async () => {
      const { service, onRevoke } = withHook();
      await fakeBrowser.storage.session.set({ [CONSENT_STORAGE_KEY]: { versao: "aviso-0", dadoEm: 1 } });
      expect(await service.isGranted()).toBe(false);
      expect(onRevoke).not.toHaveBeenCalled();
    });
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
