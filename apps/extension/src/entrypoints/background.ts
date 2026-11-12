// Service Worker: o único contexto que falará com a API e conhecerá o token (ADR-001 §5.0, item 6).
// Proibido registrar handler do evento `fetch` (brecha de CSP, crbug 1463420; ADR-001 §5.0.1).
// Canal único com o painel: a porta PANEL_PORT_NAME. Nenhum onMessage, onMessageExternal nem
// onConnectExternal é registrado (SR-10).
import { createAnalysisService } from "../api/analysis-service";
import { createWorkerAuth } from "../auth/worker-auth";
import { extractorRunner, platformForUrl } from "../capture/capture";
import { CAPTURE_STORAGE_KEY, CaptureStateSchema, createCaptureService, readyJob } from "../capture/capture-service";
import { CONSENT_STORAGE_KEY, ConsentRecordSchema, createConsentService } from "../consent/consent-service";
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

  // Consentimento antes da 1ª transmissão (ADR-025 D2). O envio à API consulta consent.isGranted().
  const consent = createConsentService({ store: sessionStore(CONSENT_STORAGE_KEY, ConsentRecordSchema), now: Date.now });
  const consentFailure = (): void => console.warn("[trampo] falha interna no consentimento");

  // Sessão (ADR-004 D3, D11 e D12): o token vive só aqui e no storage.session. O config só existe com as duas
  // origens do build. O painel recebe só a SessaoView, pelo canal da sessão, e pede "entrar" e "sair" pela porta.
  // O log leva só o motivo da lista fechada (T23).
  const auth = createWorkerAuth(
    { apiOrigin: import.meta.env.TRAMPO_API_ORIGIN, supabaseOrigin: import.meta.env.TRAMPO_SUPABASE_ORIGIN },
    { log: (motivo) => console.warn("[trampo] sessão:", motivo) },
  );
  const sessionFailure = (): void => console.warn("[trampo] falha interna na sessão");

  // Envio da vaga (F1-EXT-04 parte 2; ADR-025 §6 D10 a D13): o consentimento, a vaga pronta e o token da mesma sessão,
  // pelo api-client da composição. O painel recebe só eventos do contrato; o log, só o motivo da lista fechada (T23).
  const captureStore = sessionStore(CAPTURE_STORAGE_KEY, CaptureStateSchema);
  const analysis = createAnalysisService({
    api: auth.api,
    auth,
    consent,
    job: readyJob(captureStore),
    randomUUID: () => crypto.randomUUID(),
    log: (motivo) => console.warn("[trampo] análise:", motivo),
  });
  const analysisFailure = (): void => console.warn("[trampo] falha interna na análise");

  // Os logs levam só motivos de lista fechada, nunca texto de vaga nem URL (T23; ADR-024 D6). A captura que muda
  // cancela a análise em curso antes de gravar e de avisar o painel (ADR-025 §6 D10).
  const capture = createCaptureService({
    store: captureStore,
    runExtractor: extractorRunner(browser.scripting),
    now: Date.now,
    logFailure: (motivo) => console.warn("[trampo] captura falhou:", motivo),
    onChange: () => analysis.cancel(),
  });
  const internalFailure = (): void => console.warn("[trampo] falha interna na captura");

  browser.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    // Primeira instrução do handler: sidePanel.open exige gesto do usuário e não pode vir depois de
    // um await. A leitura vem depois, com o activeTab já concedido pelo clique (ADR-024 D2).
    void browser.sidePanel.open({ tabId: tab.id });
    // O activeTab entrega a URL da aba no clique; só o host vira a plataforma (ADR-023 D11).
    capture.captureTab(tab.id, platformForUrl(tab.url)).catch(internalFailure);
  });
  // Sem a permissão "tabs": onRemoved só entrega o id, o bastante para apagar a captura da aba.
  browser.tabs.onRemoved.addListener((tabId) => {
    capture.tabClosed(tabId).catch(internalFailure);
  });

  const ctx = {
    runtimeId: browser.runtime.id,
    extensionBaseUrl: browser.runtime.getURL("/"),
    logRejection: (reason: string) => console.warn("[trampo] porta ou mensagem recusada:", reason),
    // Em sequência, para o painel receber sempre [ready, captura, consentimento, sessao] nesta ordem (ADR-004 D12).
    onReady: (port: Parameters<typeof capture.attach>[0]) => {
      capture
        .attach(port)
        .then(() => consent.attach(port))
        .then(() => auth.attach(port))
        // Depois do handshake: a porta só recebe os eventos das análises seguintes (o handshake não muda).
        .then(() => analysis.attach(port))
        .catch(internalFailure);
    },
    onPaste: (texto: string) => {
      capture.paste(texto).catch(internalFailure);
    },
    onConsent: () => {
      consent.grant().catch(consentFailure);
    },
    onRevoke: () => {
      consent.revoke().catch(consentFailure);
    },
    // Os dois nunca rejeitam e sempre terminam com uma SessaoView no canal; o catch é só a segunda trava.
    onLogin: (provedor: Parameters<typeof auth.login>[0]) => {
      auth.login(provedor).catch(sessionFailure);
    },
    onLogout: () => {
      auth.logout().catch(sessionFailure);
    },
    // Nunca rejeita e sempre termina com um terminal no painel (ou é ignorado com outra em curso); o catch é a 2ª trava.
    onAnalyze: (mode: Parameters<typeof analysis.analyze>[0]) => {
      analysis.analyze(mode).catch(analysisFailure);
    },
  };
  browser.runtime.onConnect.addListener((port) => handlePanelConnection(port, ctx));
});
