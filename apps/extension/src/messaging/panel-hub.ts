// Portas confiáveis do painel que recebem um tipo de estado do Service Worker (ADR-024 D4; ADR-025 D2).
// Uma porta que cai, ou que lança no envio, sai da lista sem derrubar as outras.
import type { WorkerToPanel } from "./protocol";
import type { PanelPort } from "./worker-port";

export interface PanelHub {
  add(port: PanelPort): void;
  has(port: PanelPort): boolean;
  send(port: PanelPort, message: WorkerToPanel): void;
  broadcast(message: WorkerToPanel): void;
}

export function createPanelHub(): PanelHub {
  const ports = new Set<PanelPort>();
  const send = (port: PanelPort, message: WorkerToPanel): void => {
    try {
      port.postMessage(message);
    } catch {
      // Porta desconectada entre o evento e o envio.
      ports.delete(port);
    }
  };
  return {
    add(port) {
      ports.add(port);
      port.onDisconnect.addListener(() => ports.delete(port));
    },
    has: (port) => ports.has(port),
    send,
    broadcast(message) {
      for (const port of ports) send(port, message);
    },
  };
}
