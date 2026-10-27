// Service Worker: o único contexto que falará com a API e conhecerá o token (ADR-001 §5.0, item 6).
// Proibido registrar handler do evento `fetch` (brecha de CSP, crbug 1463420; ADR-001 §5.0.1).
// Canal único com o painel: a porta PANEL_PORT_NAME. Nenhum onMessage, onMessageExternal nem
// onConnectExternal é registrado (SR-10).
import { genericExtractorRunner } from "../capture/capture";
import { CAPTURE_STORAGE_KEY, CaptureStateSchema, createCaptureService } from "../capture/capture-service";
import { sessionStore } from "../messaging/session-store";
import { handlePanelConnection } from "../messaging/worker-port";

export default defineBackground(() => {
  // setPanelBehavior é upsert: um valor antigo persistiria entre versões, então é forçado sempre.
  // Com openPanelOnActionClick: true, o clique no ícone não dispara onClicked nem concede activeTab.
  const forcePanelBehavior = (): void => {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  };
  browser.runtime.onInstalled.addListener(forcePanelBehavior);
  browser.runtime.onStartup.addListener(forcePanelBehavior);

  // Os logs levam só motivos de lista fechada, nunca texto de vaga nem URL (T23; ADR-024 D6).
  const capture = createCaptureService({
    store: sessionStore(CAPTURE_STORAGE_KEY, CaptureStateSchema),
    runExtractor: genericExtractorRunner(browser.scripting),
    now: Date.now,
    logFailure: (motivo) => console.warn("[trampo] captura falhou:", motivo),
  });
  const internalFailure = (): void => console.warn("[trampo] falha interna na captura");

  browser.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    // Primeira instrução do handler: sidePanel.open exige gesto do usuário e não pode vir depois de
    // um await. A leitura vem depois, com o activeTab já concedido pelo clique (ADR-024 D2).
    void browser.sidePanel.open({ tabId: tab.id });
    capture.captureTab(tab.id).catch(internalFailure);
  });
  // Sem a permissão "tabs": onRemoved só entrega o id, o bastante para apagar a captura da aba.
  browser.tabs.onRemoved.addListener((tabId) => {
    capture.tabClosed(tabId).catch(internalFailure);
  });

  const ctx = {
    runtimeId: browser.runtime.id,
    extensionBaseUrl: browser.runtime.getURL("/"),
    logRejection: (reason: string) => console.warn("[trampo] porta ou mensagem recusada:", reason),
    onReady: (port: Parameters<typeof capture.attach>[0]) => {
      capture.attach(port).catch(internalFailure);
    },
    onPaste: (texto: string) => {
      capture.paste(texto).catch(internalFailure);
    },
  };
  browser.runtime.onConnect.addListener((port) => handlePanelConnection(port, ctx));
});
