// Estado do Side Panel (F1-EXT-04 parte 1; ADR-025 D3). Lógica pura, sem React e sem navegador: o
// App.tsx só liga a porta a este redutor e renderiza texto. Tudo o que chega do Service Worker passa
// pelo WorkerToPanelSchema antes de virar estado (ADR-001 §5.0 passo 6). F1-EXT-05b, 05b-2 (ADR-004 D12):
// o estado local da sessão ("entrando" e o último "Sair"), o "Reconectar" e o portão do "Analisar". 05b-3: a geração
// da porta, que o App segue para abrir uma porta nova.
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

/**
 * Teto do "entrando…" (ADR-004 D12): o prazo do login no SW (5 min, `AUTH_SERVICE_POLICY.loginDeadlineMs`) e mais
 * 10 s de folga. O SW sempre emite uma `sessao` no fim da tentativa; o teto cobre só a emissão que se perde (o SW
 * que morre no meio do login, D11.8). O painel nunca importa src/auth: um teste prende os dois valores.
 */
export const ENTRANDO_TETO_MS = 310_000;

/** Intervalo do tique do App enquanto o "entrando" estiver ligado: o teto vale com folga de 1 s, e o relógio que volta é visto no tique seguinte. */
export const ENTRANDO_TIQUE_MS = 1_000;

export interface PanelState {
  /**
   * Geração da porta (F1-EXT-05b, 05b-3): o App abre uma porta nova quando ela muda. Só o "Reconectar" aceito pelo
   * redutor a muda, então nenhuma mensagem, tique nem clique ignorado reabre a porta (sem laço, condição 3 do [APPSEC]).
   */
  readonly geracao: number;
  readonly conexao: Conexao;
  readonly queda: Queda | null;
  readonly captura: CaptureView;
  /** null enquanto o Service Worker não disse. */
  readonly consentimento: boolean | null;
  /** Só um booleano e um código do catálogo (ADR-004 D10 B6); null até o fim do handshake. */
  readonly sessao: SessaoView | null;
  /**
   * "Entrando…" (ADR-004 D12): a hora do clique em "Entrar", no relógio do App. Desliga na próxima `sessao` ou no
   * teto. Estado local: nada dele vai ao Service Worker.
   */
  readonly entrandoDesde: number | null;
  /** O último pedido de sessão foi "Sair": só então `{ false, SERVICO_INDISPONIVEL }` é a falha remota do logout (D11.5). */
  readonly pediuSair: boolean;
  readonly analise: AnaliseView;
}

export const INITIAL_PANEL_STATE: PanelState = {
  geracao: 0,
  conexao: "conectando",
  queda: null,
  captura: { estado: "ocioso" },
  consentimento: null,
  sessao: null,
  entrandoDesde: null,
  pediuSair: false,
  analise: { estado: "nenhuma" },
};

export type PanelAction =
  | { readonly type: "mensagem"; readonly message: WorkerToPanel }
  /** Mensagem fora do contrato: o App derruba a porta e nada dela é renderizado (fail closed). */
  | { readonly type: "recusada" }
  | { readonly type: "desconectou" }
  /** Clique em "Entrar com …". `agora` vem do relógio do App (injetado), para o teto do "entrando". */
  | { readonly type: "entrar"; readonly agora: number }
  /** Clique em "Sair da conta" ou em "Tentar sair de novo". */
  | { readonly type: "sair" }
  /** Relógio do App: desliga o "entrando" no teto. */
  | { readonly type: "tique"; readonly agora: number }
  /** Clique em "Reconectar": o App abre uma porta nova, e o handshake recomeça do zero. */
  | { readonly type: "reconectar" };

/** Os botões da sessão (ADR-004 D12). "entrar" vira um botão por provedor. */
export type AcaoSessao = "entrar" | "sair" | "tentar_sair";

/** Por que o "Analisar" está desabilitado. */
export type BloqueioAnalise = "sem_api" | "sem_consentimento" | "sem_sessao";

/** Revalida o que chegou pela porta. `null` = fora do contrato. */
export function parseWorkerMessage(raw: unknown): WorkerToPanel | null {
  const parsed = WorkerToPanelSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** O logout local já valeu, mas o servidor não confirmou (D11.5 passo 4). Só depois do clique em "Sair" deste painel. */
export function logoutUnconfirmed(state: Pick<PanelState, "sessao" | "pediuSair">): boolean {
  return state.pediuSair && state.sessao !== null && !state.sessao.autenticado && state.sessao.erro === "SERVICO_INDISPONIVEL";
}

/** Os botões da sessão que a tela oferece agora. O redutor ignora o clique que não está aqui. */
export function sessionActions(state: PanelState): readonly AcaoSessao[] {
  if (state.conexao !== "pronto" || state.sessao === null || state.entrandoDesde !== null) return [];
  if (state.sessao.autenticado) return ["sair"];
  return logoutUnconfirmed(state) ? ["tentar_sair", "entrar"] : ["entrar"];
}

/**
 * Só a queda da porta oferece "Reconectar"; com `resposta_invalida`, a queda continua definitiva (ADR-004 D12). A
 * `queda` só existe com a conexão desconectada: o redutor liga as duas juntas, e o "Reconectar" apaga as duas.
 */
export function canReconnect(state: Pick<PanelState, "queda">): boolean {
  return state.queda === "porta_fechada";
}

/**
 * Portão do "Analisar" (ADR-004 D12; ADR-025 D2): só com a API ligada, o consentimento dado e uma sessão local
 * (`autenticado: true`, com ou sem erro transitório da renovação). `api` vem do App, porque o painel não lê o build;
 * até o envio existir (F1-EXT-04 parte 2), é sempre false. `null` = habilitado.
 */
export function analyzeBlock(api: boolean, state: Pick<PanelState, "consentimento" | "sessao">): BloqueioAnalise | null {
  if (!api) return "sem_api";
  if (state.consentimento !== true) return "sem_consentimento";
  if (state.sessao?.autenticado !== true) return "sem_sessao";
  return null;
}

/** O teto venceu, ou o relógio voltou: o "entrando" desliga e os botões voltam (o SW ignora o clique com fluxo pendente). */
function signInExpired(desde: number, agora: number): boolean {
  const decorrido = agora - desde;
  return !(decorrido >= 0 && decorrido < ENTRANDO_TETO_MS);
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
      // A próxima `sessao` encerra o "entrando": o SW emite no fim de cada tentativa, mesmo sem mudança. Uma sessão
      // autenticada encerra também o efeito do último "Sair".
      return { ...state, sessao: message.sessao, entrandoDesde: null, pediuSair: state.pediuSair && !message.sessao.autenticado };
    case "stream":
      return { ...state, analise: reduceStream(message.event) };
  }
}

export function reducePanel(state: PanelState, action: PanelAction): PanelState {
  // Depois da queda, nada mais muda a tela: o usuário reabre o painel, ou, só com a porta fechada, clica em
  // "Reconectar", que recomeça do estado inicial com a porta da geração seguinte. Nenhuma mensagem nem tique
  // reconecta (sem laço).
  if (state.conexao === "desconectado") {
    return action.type === "reconectar" && canReconnect(state) ? { ...INITIAL_PANEL_STATE, geracao: state.geracao + 1 } : state;
  }
  switch (action.type) {
    case "mensagem":
      return reduceMessage(state, action.message);
    case "recusada":
      return { ...state, conexao: "desconectado", queda: "resposta_invalida", analise: { estado: "nenhuma" } };
    case "desconectou":
      return { ...state, conexao: "desconectado", queda: "porta_fechada" };
    case "entrar":
      return sessionActions(state).includes("entrar") ? { ...state, entrandoDesde: action.agora, pediuSair: false } : state;
    case "sair":
      // O "Tentar sair de novo" chega com o pedido já ligado (o `logoutUnconfirmed` exige o `pediuSair`): nada muda.
      return sessionActions(state).includes("sair") ? { ...state, pediuSair: true } : state;
    case "tique":
      return state.entrandoDesde !== null && signInExpired(state.entrandoDesde, action.agora) ? { ...state, entrandoDesde: null } : state;
    case "reconectar":
      return state;
  }
}
