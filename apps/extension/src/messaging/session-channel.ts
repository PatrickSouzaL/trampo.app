// Canal da sessão com o Side Panel (ADR-004 D10 B6 e D12; F1-EXT-05b). Recebe a SessaoView do auth-service e a
// leva às portas confiáveis, sempre pelo toSessaoView: o painel só vê um booleano e um código do catálogo. Não
// importa src/auth: quem liga o canal ao serviço é a composição (src/auth/worker-auth.ts).
import { createPanelHub } from "./panel-hub";
import { type SessaoView, toSessaoView } from "./protocol";
import type { PanelPort } from "./worker-port";

export interface SessionChannel {
  /** O `emit` do auth-service: cada mudança vai a todas as portas, depois do saneamento. */
  emit(view: SessaoView): void;
  /**
   * Handshake (último passo de `[ready, captura, consentimento, sessao]`): a porta entra no canal e recebe a
   * visão atual. Se uma emissão chegar às portas enquanto a visão é lida, ela já é a mais nova, e a leitura,
   * que pode ser de antes da mudança, não é enviada por cima dela.
   */
  attach(port: PanelPort, current: () => Promise<SessaoView>): Promise<void>;
}

export function createSessionChannel(): SessionChannel {
  const hub = createPanelHub();
  let emissions = 0;
  return {
    emit(view) {
      emissions += 1;
      hub.broadcast({ kind: "sessao", sessao: toSessaoView(view) });
    },
    async attach(port, current) {
      hub.add(port);
      const before = emissions;
      const view = await current();
      if (emissions === before && hub.has(port)) hub.send(port, { kind: "sessao", sessao: toSessaoView(view) });
    },
  };
}
