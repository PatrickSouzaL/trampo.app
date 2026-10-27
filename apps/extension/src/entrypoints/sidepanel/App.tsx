// Side Panel. Só texto via React (zero innerHTML, AGENTS §1.3). Tudo o que chega do Service Worker é
// revalidado com Zod antes de mudar o estado (ADR-001 §5.0, item 6). O painel nunca recebe o texto
// da vaga, só o estado da captura (ADR-024 D4). A tela de consentimento, os estágios do stream e o
// relatório entram na F1-EXT-04.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { browser } from "wxt/browser";

import { PANEL_PORT_NAME, PASTE_MAX_UTF16, PROTOCOL_VERSION, WorkerToPanelSchema, type CaptureView, type PanelToWorker } from "../../messaging/protocol";

type Connection = "conectando" | "pronto" | "desconectado";
type Port = ReturnType<typeof browser.runtime.connect>;

const LABELS: Record<Connection, string> = {
  conectando: "Conectando ao Trampo…",
  pronto: "Pronto. Abra uma vaga e clique no ícone do Trampo na barra do navegador para analisá-la.",
  desconectado: "A conexão com o Trampo caiu. Feche e abra o painel de novo.",
};

const FAILURES: Record<Extract<CaptureView, { estado: "falhou" }>["motivo"], string> = {
  sem_acesso: "O Trampo não pode ler esta página. Clique no ícone do Trampo com a aba da vaga aberta, ou cole o texto da vaga abaixo.",
  texto_insuficiente: "Não encontramos o texto da vaga. Cole o texto da vaga abaixo.",
  erro: "Não foi possível ler a vaga. Cole o texto da vaga abaixo.",
};

function describe(captura: CaptureView): string | null {
  switch (captura.estado) {
    case "ocioso":
      return null;
    case "lendo":
      return "Lendo a vaga…";
    case "pronto": {
      const origem = captura.origem === "pagina" ? "lida da página" : "colada";
      const corte = captura.truncado ? " O texto foi cortado no limite." : "";
      return `Vaga ${origem}: ${captura.caracteres} caracteres.${corte}`;
    }
    case "falhou":
      return FAILURES[captura.motivo];
  }
}

export function App() {
  const [connection, setConnection] = useState<Connection>("conectando");
  const [captura, setCaptura] = useState<CaptureView>({ estado: "ocioso" });
  const [texto, setTexto] = useState("");
  const portRef = useRef<Port | null>(null);

  useEffect(() => {
    const port = browser.runtime.connect({ name: PANEL_PORT_NAME });
    portRef.current = port;
    port.onMessage.addListener((raw: unknown) => {
      const parsed = WorkerToPanelSchema.safeParse(raw);
      if (!parsed.success) {
        // Mensagem fora do contrato: não é renderizada e a porta cai (fail closed).
        port.disconnect();
        setConnection("desconectado");
        return;
      }
      if (parsed.data.kind === "ready") setConnection("pronto");
      if (parsed.data.kind === "captura") setCaptura(parsed.data.captura);
    });
    port.onDisconnect.addListener(() => setConnection("desconectado"));
    const hello: PanelToWorker = { kind: "hello", protocolVersion: PROTOCOL_VERSION };
    port.postMessage(hello);
    return () => {
      portRef.current = null;
      port.disconnect();
    };
  }, []);

  const colar = (event: FormEvent): void => {
    event.preventDefault();
    const message: PanelToWorker = { kind: "colar", texto: texto.slice(0, PASTE_MAX_UTF16) };
    portRef.current?.postMessage(message);
    setTexto("");
  };

  const status = describe(captura);
  return (
    <main>
      <h1>Trampo</h1>
      <p data-connection={connection}>{LABELS[connection]}</p>
      {status !== null && <p data-captura={captura.estado}>{status}</p>}
      {captura.estado === "falhou" && connection === "pronto" && (
        <form onSubmit={colar}>
          <label htmlFor="texto-da-vaga">Texto da vaga</label>
          <textarea id="texto-da-vaga" value={texto} maxLength={PASTE_MAX_UTF16} rows={10} onChange={(e) => setTexto(e.target.value)} />
          <button type="submit" disabled={texto.trim() === ""}>
            Usar este texto
          </button>
        </form>
      )}
    </main>
  );
}
