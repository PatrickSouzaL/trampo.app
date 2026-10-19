// Side Panel. Só texto via React (zero innerHTML, AGENTS §1.3). Tudo o que chega do Service Worker é
// revalidado com Zod antes de mudar o estado (ADR-001 §5.0, item 6). A tela de consentimento, os
// estágios do stream e o relatório entram na F1-EXT-04.
import { useEffect, useState } from "react";
import { browser } from "wxt/browser";

import { PANEL_PORT_NAME, PROTOCOL_VERSION, WorkerToPanelSchema, type PanelToWorker } from "../../messaging/protocol";

type Connection = "conectando" | "pronto" | "desconectado";

const LABELS: Record<Connection, string> = {
  conectando: "Conectando ao Trampo…",
  pronto: "Pronto. Abra uma vaga e clique no ícone do Trampo na barra do navegador para analisá-la.",
  desconectado: "A conexão com o Trampo caiu. Feche e abra o painel de novo.",
};

export function App() {
  const [connection, setConnection] = useState<Connection>("conectando");

  useEffect(() => {
    const port = browser.runtime.connect({ name: PANEL_PORT_NAME });
    port.onMessage.addListener((raw: unknown) => {
      const parsed = WorkerToPanelSchema.safeParse(raw);
      if (!parsed.success) {
        // Mensagem fora do contrato: não é renderizada e a porta cai (fail closed).
        port.disconnect();
        setConnection("desconectado");
        return;
      }
      if (parsed.data.kind === "ready") setConnection("pronto");
    });
    port.onDisconnect.addListener(() => setConnection("desconectado"));
    const hello: PanelToWorker = { kind: "hello", protocolVersion: PROTOCOL_VERSION };
    port.postMessage(hello);
    return () => port.disconnect();
  }, []);

  return (
    <main>
      <h1>Trampo</h1>
      <p data-connection={connection}>{LABELS[connection]}</p>
    </main>
  );
}
