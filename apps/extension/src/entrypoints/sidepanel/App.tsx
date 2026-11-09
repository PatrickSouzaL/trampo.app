// Side Panel. Só texto via React (zero innerHTML, AGENTS §1.3). Tudo o que chega do Service Worker é
// revalidado com Zod antes de mudar o estado (ADR-001 §5.0, item 6); mensagem fora do contrato derruba
// a porta e nada dela é renderizado. O painel nunca recebe o texto da vaga (ADR-024 D4). O estado é
// o redutor puro de src/panel (ADR-025 D3); aqui só a ligação com a porta, o relógio e o layout.
import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import { browser } from "wxt/browser";

import { CONSENT_VERSION, PANEL_PORT_NAME, PASTE_MAX_UTF16, PROTOCOL_VERSION, type AuthProvider, type PanelToWorker } from "../../messaging/protocol";
import { ENTRANDO_TIQUE_MS, INITIAL_PANEL_STATE, analyzeBlock, canReconnect, parseWorkerMessage, reducePanel, type PanelState } from "../../panel/panel-state";
import { SESSION_ACTION_LABELS, describeCapture, describeConnection } from "../../panel/texts";
import { AnalyzeButton, Consent, ErrorNotice, Progress, Report } from "./Analysis";
import { Session } from "./Session";

type Port = ReturnType<typeof browser.runtime.connect>;
type Post = (message: PanelToWorker) => void;

/**
 * O envio à API só existe na F1-EXT-04 parte 2: até lá, o "Analisar" fica sempre desabilitado (ADR-004 D12). O painel
 * não lê o build, e a fonte deste valor passa pelo [APPSEC] (ADR-004 D10 B6).
 */
const API_DO_ENVIO = false;

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
  const bloqueio = analyzeBlock(API_DO_ENVIO, state);
  switch (analise.estado) {
    case "andamento":
      return <Progress analise={analise} />;
    case "erro":
      return <ErrorNotice error={analise.error} />;
    case "concluida":
      return (
        <>
          <Report report={analise.report} />
          <AnalyzeButton label="Reanalisar com IA" bloqueio={bloqueio} />
        </>
      );
    case "nenhuma":
      if (state.captura.estado !== "pronto" || state.consentimento === null) return null;
      if (!state.consentimento) return <Consent onAccept={() => post({ kind: "consentir", versao: CONSENT_VERSION })} />;
      return <AnalyzeButton label="Analisar vaga" bloqueio={bloqueio} />;
  }
}

export function App() {
  const [state, dispatch] = useReducer(reducePanel, INITIAL_PANEL_STATE);
  const portRef = useRef<Port | null>(null);

  // Uma porta por geração: a primeira na abertura do painel, e uma nova a cada "Reconectar" aceito pelo redutor
  // (05b-3). Quando a porta cai ou é derrubada, ela deixa de valer: o que ainda chegar por ela é ignorado.
  useEffect(() => {
    let ativa = true;
    const port = browser.runtime.connect({ name: PANEL_PORT_NAME });
    portRef.current = port;
    const encerrar = (): void => {
      ativa = false;
      portRef.current = null;
    };
    port.onMessage.addListener((raw: unknown) => {
      if (!ativa) return;
      const message = parseWorkerMessage(raw);
      if (message === null) {
        // Fora do contrato: não é renderizada e a porta cai (fail closed).
        encerrar();
        port.disconnect();
        dispatch({ type: "recusada" });
        return;
      }
      dispatch({ type: "mensagem", message });
    });
    port.onDisconnect.addListener(() => {
      if (!ativa) return;
      encerrar();
      dispatch({ type: "desconectou" });
    });
    const hello: PanelToWorker = { kind: "hello", protocolVersion: PROTOCOL_VERSION };
    port.postMessage(hello);
    return () => {
      if (!ativa) return;
      encerrar();
      port.disconnect();
    };
  }, [state.geracao]);

  // O relógio do "entrando" (ADR-004 D12): armado só enquanto ele estiver ligado. O tique não sai do painel.
  const entrando = state.entrandoDesde !== null;
  useEffect(() => {
    if (!entrando) return;
    const timer = setInterval(() => dispatch({ type: "tique", agora: Date.now() }), ENTRANDO_TIQUE_MS);
    return () => clearInterval(timer);
  }, [entrando]);

  const post: Post = (message) => portRef.current?.postMessage(message);
  // Os botões da sessão só existem quando o sessionActions os oferece; o redutor confere de novo.
  const entrar = (provedor: AuthProvider): void => {
    dispatch({ type: "entrar", agora: Date.now() });
    post({ kind: "entrar", provedor });
  };
  const sair = (): void => {
    dispatch({ type: "sair" });
    post({ kind: "sair" });
  };
  const online = state.conexao === "pronto";
  const status = describeCapture(state.captura);
  return (
    <main>
      <h1>Trampo</h1>
      <p data-connection={state.conexao}>{describeConnection(state)}</p>
      {canReconnect(state) && (
        <p>
          <button type="button" onClick={() => dispatch({ type: "reconectar" })}>
            {SESSION_ACTION_LABELS.reconectar}
          </button>
        </p>
      )}
      <Session state={state} onEntrar={entrar} onSair={sair} />
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
