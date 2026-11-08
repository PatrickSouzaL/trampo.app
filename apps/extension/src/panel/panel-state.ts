// Estado do Side Panel (F1-EXT-04 parte 1; ADR-025 D3). Lógica pura, sem React e sem navegador: o
// App.tsx só liga a porta a este redutor e renderiza texto. Tudo o que chega do Service Worker passa
// pelo WorkerToPanelSchema antes de virar estado (ADR-001 §5.0 passo 6).
import type { AnalysisReport } from "@trampo/contracts/analysis-report";
import type { ApiError, AnalysisStreamEvent } from "@trampo/contracts/api";

import { WorkerToPanelSchema, type CaptureView, type SessaoView, type WorkerToPanel } from "../messaging/protocol";

export type Conexao = "conectando" | "pronto" | "desconectado";

/** Por que a conexão caiu: a porta fechou, ou o painel a derrubou por mensagem fora do contrato. */
export type Queda = "porta_fechada" | "resposta_invalida";

export type AnaliseView =
  | { readonly estado: "nenhuma" }
  | { readonly estado: "andamento"; readonly etapa: Extract<AnalysisStreamEvent, { type: "stage" }>["stage"]; readonly elapsedMs: number }
  | { readonly estado: "concluida"; readonly report: AnalysisReport }
  | { readonly estado: "erro"; readonly error: ApiError };

export interface PanelState {
  readonly conexao: Conexao;
  readonly queda: Queda | null;
  readonly captura: CaptureView;
  /** null enquanto o Service Worker não disse. */
  readonly consentimento: boolean | null;
  /** Só um booleano e um código do catálogo (ADR-004 D10 B6); null até o fim do handshake. */
  readonly sessao: SessaoView | null;
  readonly analise: AnaliseView;
}

export const INITIAL_PANEL_STATE: PanelState = {
  conexao: "conectando",
  queda: null,
  captura: { estado: "ocioso" },
  consentimento: null,
  sessao: null,
  analise: { estado: "nenhuma" },
};

export type PanelAction =
  | { readonly type: "mensagem"; readonly message: WorkerToPanel }
  /** Mensagem fora do contrato: o App derruba a porta e nada dela é renderizado (fail closed). */
  | { readonly type: "recusada" }
  | { readonly type: "desconectou" };

/** Revalida o que chegou pela porta. `null` = fora do contrato. */
export function parseWorkerMessage(raw: unknown): WorkerToPanel | null {
  const parsed = WorkerToPanelSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function reduceStream(event: AnalysisStreamEvent): AnaliseView {
  switch (event.type) {
    case "stage":
      return { estado: "andamento", etapa: event.stage, elapsedMs: event.elapsedMs };
    case "result":
      return { estado: "concluida", report: event.report };
    case "error":
      return { estado: "erro", error: event.error };
  }
}

function reduceMessage(state: PanelState, message: WorkerToPanel): PanelState {
  switch (message.kind) {
    case "ready":
      return { ...state, conexao: "pronto" };
    case "captura":
      // Captura nova (ou o fim dela): a análise mostrada era de outra vaga e sai da tela.
      return { ...state, captura: message.captura, analise: { estado: "nenhuma" } };
    case "consentimento":
      return { ...state, consentimento: message.dado };
    case "sessao":
      return { ...state, sessao: message.sessao };
    case "stream":
      return { ...state, analise: reduceStream(message.event) };
  }
}

export function reducePanel(state: PanelState, action: PanelAction): PanelState {
  // Depois da queda, nada mais muda a tela: o usuário precisa abrir o painel de novo.
  if (state.conexao === "desconectado") return state;
  switch (action.type) {
    case "mensagem":
      return reduceMessage(state, action.message);
    case "recusada":
      return { ...state, conexao: "desconectado", queda: "resposta_invalida", analise: { estado: "nenhuma" } };
    case "desconectou":
      return { ...state, conexao: "desconectado", queda: "porta_fechada" };
  }
}
