// Consentimento antes da 1ª transmissão (ADR-001 §5.0 passo 7; Limited Use da Chrome Web Store; ADR-025 D2).
// Quem impõe é o Service Worker, o único que falará com a API: o painel só mostra o aviso e pede.
import { z } from "zod";

import { createPanelHub } from "../messaging/panel-hub";
import { CONSENT_VERSION } from "../messaging/protocol";
import type { SessionStore } from "../messaging/session-store";
import type { PanelPort } from "../messaging/worker-port";

/** storage.session: some ao fechar o navegador, e o aviso volta na sessão seguinte (ADR-025 D2). */
export const CONSENT_STORAGE_KEY = "trampo/consentimento/v1";

/** A versão é literal: o registro de um aviso antigo falha na leitura e é apagado pelo sessionStore. */
export const ConsentRecordSchema = z.strictObject({
  versao: z.literal(CONSENT_VERSION),
  dadoEm: z.int().min(0),
});

export interface ConsentServiceDeps {
  readonly store: SessionStore<typeof ConsentRecordSchema>;
  readonly now: () => number;
  /**
   * O consentimento vai ser retirado (ADR-025 §6.3 D17): chamado antes de apagar o registro e de avisar o painel, para
   * a análise em curso parar antes de o `consentimento` chegar à tela.
   */
  readonly onRevoke?: () => void;
}

export interface ConsentService {
  /** Porta confiável do painel: recebe o estado atual e as mudanças seguintes. */
  attach(port: PanelPort): Promise<void>;
  /** Ação afirmativa no painel, depois do aviso da versão vigente. */
  grant(): Promise<void>;
  /** O usuário retirou o consentimento: nada mais é enviado até um novo aceite. */
  revoke(): Promise<void>;
  /** Portão do envio à API (F1-EXT-04 parte 2): sem consentimento vigente, nada sai. */
  isGranted(): Promise<boolean>;
}

export function createConsentService(deps: ConsentServiceDeps): ConsentService {
  const hub = createPanelHub();
  const isGranted = async (): Promise<boolean> => (await deps.store.get()) !== undefined;

  return {
    async attach(port) {
      hub.add(port);
      const dado = await isGranted();
      if (hub.has(port)) hub.send(port, { kind: "consentimento", dado });
    },
    async grant() {
      await deps.store.set({ versao: CONSENT_VERSION, dadoEm: deps.now() });
      hub.broadcast({ kind: "consentimento", dado: true });
    },
    async revoke() {
      deps.onRevoke?.();
      await deps.store.remove();
      hub.broadcast({ kind: "consentimento", dado: false });
    },
    isGranted,
  };
}
