// Side Panel. Só texto via React (zero innerHTML, AGENTS §1.3). Tudo o que chega do Service Worker é
// revalidado com Zod antes de mudar o estado (ADR-001 §5.0, item 6); mensagem fora do contrato derruba
// a porta e nada dela é renderizado. O painel nunca recebe o texto da vaga (ADR-024 D4). O estado é
// o redutor puro de src/panel (ADR-025 D3); aqui só a ligação com a porta e o layout.
import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import { browser } from "wxt/browser";

import { CONSENT_VERSION, PANEL_PORT_NAME, PASTE_MAX_UTF16, PROTOCOL_VERSION, type PanelToWorker } from "../../messaging/protocol";
import { INITIAL_PANEL_STATE, parseWorkerMessage, reducePanel, type PanelState } from "../../panel/panel-state";
import { describeCapture, describeConnection } from "../../panel/texts";
import { AnalyzeButton, Consent, ErrorNotice, Progress, Report } from "./Analysis";

type Port = ReturnType<typeof browser.runtime.connect>;
type Post = (message: PanelToWorker) => void;

function PasteForm({ post }: { post: Post }) {
  const [texto, setTexto] = useState("");
  const colar = (event: FormEvent): void => {
    event.preventDefault();
    post({ kind: "colar", texto: texto.slice(0, PASTE_MAX_UTF16) });
    setTexto("");
  };
  return (
    <form onSubmit={colar}>
      <label htmlFor="texto-da-vaga">Texto da vaga</label>
      <textarea id="texto-da-vaga" value={texto} maxLength={PASTE_MAX_UTF16} rows={10} onChange={(e) => setTexto(e.target.value)} />
      <button type="submit" disabled={texto.trim() === ""}>
        Usar este texto
      </button>
    </form>
  );
}

function AnalysisArea({ state, post }: { state: PanelState; post: Post }) {
  const { analise } = state;
  switch (analise.estado) {
    case "andamento":
      return <Progress analise={analise} />;
    case "erro":
      return <ErrorNotice error={analise.error} />;
    case "concluida":
      return (
        <>
          <Report report={analise.report} />
          <AnalyzeButton label="Reanalisar com IA" />
        </>
      );
    case "nenhuma":
      if (state.captura.estado !== "pronto" || state.consentimento === null) return null;
      if (!state.consentimento) return <Consent onAccept={() => post({ kind: "consentir", versao: CONSENT_VERSION })} />;
      return <AnalyzeButton label="Analisar vaga" />;
  }
}

export function App() {
  const [state, dispatch] = useReducer(reducePanel, INITIAL_PANEL_STATE);
  const portRef = useRef<Port | null>(null);

  useEffect(() => {
    const port = browser.runtime.connect({ name: PANEL_PORT_NAME });
    portRef.current = port;
    port.onMessage.addListener((raw: unknown) => {
      const message = parseWorkerMessage(raw);
      if (message === null) {
        // Fora do contrato: não é renderizada e a porta cai (fail closed).
        portRef.current = null;
        port.disconnect();
        dispatch({ type: "recusada" });
        return;
      }
      dispatch({ type: "mensagem", message });
    });
    port.onDisconnect.addListener(() => {
      portRef.current = null;
      dispatch({ type: "desconectou" });
    });
    const hello: PanelToWorker = { kind: "hello", protocolVersion: PROTOCOL_VERSION };
    port.postMessage(hello);
    return () => {
      portRef.current = null;
      port.disconnect();
    };
  }, []);

  const post: Post = (message) => portRef.current?.postMessage(message);
  const online = state.conexao === "pronto";
  const status = describeCapture(state.captura);
  return (
    <main>
      <h1>Trampo</h1>
      <p data-connection={state.conexao}>{describeConnection(state)}</p>
      {status !== null && <p data-captura={state.captura.estado}>{status}</p>}
      {online && state.captura.estado === "falhou" && <PasteForm post={post} />}
      {online && <AnalysisArea state={state} post={post} />}
      {online && state.consentimento === true && (
        <p className="rodape">
          <button type="button" className="secundario" onClick={() => post({ kind: "revogar" })}>
            Retirar o consentimento de envio
          </button>
        </p>
      )}
    </main>
  );
}
