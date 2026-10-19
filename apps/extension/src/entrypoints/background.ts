// Service Worker: o único contexto que falará com a API e conhecerá o token (ADR-001 §5.0, item 6).
// Proibido registrar handler do evento `fetch` (brecha de CSP, crbug 1463420; ADR-001 §5.0.1).
export default defineBackground(() => {
  // setPanelBehavior é upsert: um valor antigo persistiria entre versões, então é forçado sempre.
  // Com openPanelOnActionClick: true, o clique no ícone não dispara onClicked nem concede activeTab.
  const forcePanelBehavior = (): void => {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  };
  browser.runtime.onInstalled.addListener(forcePanelBehavior);
  browser.runtime.onStartup.addListener(forcePanelBehavior);

  browser.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    // Primeira instrução do handler: sidePanel.open exige gesto do usuário e não pode vir depois de
    // um await. A extração (scripting.executeScript) entra na F1-EXT-02/03.
    void browser.sidePanel.open({ tabId: tab.id });
  });
});
