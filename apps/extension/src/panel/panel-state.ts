// Estado do Side Panel (F1-EXT-04 parte 1; ADR-025 D3). Lógica pura, sem React e sem navegador: o
// App.tsx só liga a porta a este redutor e renderiza texto. Tudo o que chega do Service Worker passa
// pelo WorkerToPanelSchema antes de virar estado (ADR-001 §5.0 passo 6). F1-EXT-05b, 05b-2 (ADR-004 D12):
// o estado local da sessão ("entrando" e o último "Sair"), o "Reconectar" e o portão do "Analisar". 05b-3: a geração
// da porta, que o App segue para abrir uma porta nova. F1-EXT-04 parte 2, 04b-2 (ADR-025 §6.4): o `ready.envio` como
// fonte do portão da API, o que a área da análise oferece, o clique em "Analisar" e o "enviando" com teto.
import type { AnalysisReport } from "@trampo/contracts/analysis-report";
import type { ApiError, AnalysisStreamEvent } from "@trampo/contracts/api";

import { WorkerToPanelSchema, type AnalysisMode, type CaptureView, type SessaoView, type WorkerToPanel } from "../messaging/protocol";

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

/**
 * Teto do "enviando" (ADR-025 §6.4 D20): o prazo total do stream no SW (45 s, `ANALYZE_STREAM_POLICY.totalMs`) e mais
 * 10 s de folga. O SW sempre termina o `analisar` aceito com um terminal; o teto cobre só o terminal que se perde. O
 * painel nunca importa src/api: um teste prende os dois valores. O tique é o mesmo do "entrando".
 */
export const ENVIANDO_TETO_MS = 55_000;

/**
 * O erro local do teto do "enviando": a tela mostra só o texto do catálogo, pelo `code` (ADR-025 D5), e não há
 * `requestId`, porque o painel não conhece o pedido.
 */
export const SENDING_TIMEOUT_ERROR: ApiError = Object.freeze({
  code: "SERVICO_INDISPONIVEL",
  message: "O painel não recebeu a resposta da análise a tempo.",
  requestId: null,
  retryAfterSeconds: null,
});

export interface PanelState {
  /**
   * Geração da porta (F1-EXT-05b, 05b-3): o App abre uma porta nova quando ela muda. Só o "Reconectar" aceito pelo
   * redutor a muda, então nenhuma mensagem, tique nem clique ignorado reabre a porta (sem laço, condição 3 do [APPSEC]).
   */
  readonly geracao: number;
  readonly conexao: Conexao;
  readonly queda: Queda | null;
  /** O Service Worker tem a API (o `envio` do `ready`): o painel não lê o build (ADR-025 §6.4 D18). */
  readonly api: boolean;
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
  /**
   * "Enviando" (ADR-025 §6.4 D20): a hora do clique aceito em "Analisar", no relógio do App. Desliga no terminal do
   * stream, na captura, sem consentimento, sem sessão, na queda e no teto. Estado local: nada dele vai ao Service Worker.
   */
  readonly enviandoDesde: number | null;
  readonly analise: AnaliseView;
}

export const INITIAL_PANEL_STATE: PanelState = {
  geracao: 0,
  conexao: "conectando",
  queda: null,
  api: false,
  captura: { estado: "ocioso" },
  consentimento: null,
  sessao: null,
  entrandoDesde: null,
  pediuSair: false,
  enviandoDesde: null,
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
  /** Clique em "Analisar vaga" (auto) ou em "Reanalisar com IA" (aprofundada). `agora` vem do relógio do App. */
  | { readonly type: "analisar"; readonly mode: AnalysisMode; readonly agora: number }
  /** Relógio do App: desliga o "entrando" e o "enviando" no teto de cada um. */
  | { readonly type: "tique"; readonly agora: number }
  /** Clique em "Reconectar": o App abre uma porta nova, e o handshake recomeça do zero. */
  | { readonly type: "reconectar" };

/** Os botões da sessão (ADR-004 D12). "entrar" vira um botão por provedor. */
export type AcaoSessao = "entrar" | "sair" | "tentar_sair";

/** Por que o "Analisar" está desabilitado. */
export type BloqueioAnalise = "sem_api" | "sem_consentimento" | "sem_sessao";

/**
 * O que a área da análise oferece (ADR-025 §6.4 D19): nada (`null`), o aviso de consentimento ou o botão, com o modo
 * que ele manda e o motivo do bloqueio (`null` = habilitado).
 */
export type ControleAnalise = null | "aviso" | { readonly mode: AnalysisMode; readonly bloqueio: BloqueioAnalise | null };

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
 * (`autenticado: true`, com ou sem erro transitório da renovação). `api` é o `PanelState.api`, que vem do `ready` do
 * Service Worker: o painel não lê o build. `null` = habilitado.
 */
export function analyzeBlock(api: boolean, state: Pick<PanelState, "consentimento" | "sessao">): BloqueioAnalise | null {
  if (!api) return "sem_api";
  if (state.consentimento !== true) return "sem_consentimento";
  if (state.sessao?.autenticado !== true) return "sem_sessao";
  return null;
}

/**
 * O controle da área da análise agora. O redutor aceita o clique só com o botão oferecido aqui, no mesmo modo e sem
 * bloqueio. O modo é "aprofundada" com um relatório na tela e "auto" nos outros casos, inclusive depois de um erro.
 */
export function analysisControl(state: PanelState): ControleAnalise {
  if (state.conexao !== "pronto" || state.captura.estado !== "pronto" || state.consentimento === null) return null;
  if (state.enviandoDesde !== null || state.analise.estado === "andamento") return null;
  if (!state.consentimento) return "aviso";
  return { mode: state.analise.estado === "concluida" ? "aprofundada" : "auto", bloqueio: analyzeBlock(state.api, state) };
}

/** O teto venceu, ou o relógio voltou: o estado local desliga e os botões voltam (o SW ignora o clique com fluxo pendente). */
function expired(desde: number, agora: number, teto: number): boolean {
  const decorrido = agora - desde;
  return !(decorrido >= 0 && decorrido < teto);
}

const NENHUMA: AnaliseView = { estado: "nenhuma" };

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
      // O envio em curso não sobrevive a um `ready` que diga que não há API.
      return { ...state, conexao: "pronto", api: message.envio, enviandoDesde: message.envio ? state.enviandoDesde : null };
    case "captura":
      // Captura nova (ou o fim dela): a análise mostrada era de outra vaga e sai da tela, com o envio em curso.
      return { ...state, captura: message.captura, analise: NENHUMA, enviandoDesde: null };
    case "consentimento":
      if (message.dado) return { ...state, consentimento: true };
      // Retirado (ADR-025 §6.3 D17): o SW cancelou a análise em curso, e o andamento sai da tela. O relatório fica.
      return { ...state, consentimento: false, enviandoDesde: null, analise: state.analise.estado === "andamento" ? NENHUMA : state.analise };
    case "sessao":
      // A próxima `sessao` encerra o "entrando": o SW emite no fim de cada tentativa, mesmo sem mudança. Uma sessão
      // autenticada encerra também o efeito do último "Sair". Sem sessão, o "enviando" desliga: o botão volta
      // bloqueado, e o terminal da análise que já saiu ainda aparece (o "Sair" não a cancela, ADR-025 §6.3 D17).
      return {
        ...state,
        sessao: message.sessao,
        entrandoDesde: null,
        pediuSair: state.pediuSair && !message.sessao.autenticado,
        enviandoDesde: message.sessao.autenticado ? state.enviandoDesde : null,
      };
    case "stream":
      // Só o terminal encerra o envio; o stage troca o "enviando" pelo progresso.
      return { ...state, analise: reduceStream(message.event), enviandoDesde: message.event.type === "stage" ? state.enviandoDesde : null };
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
      return { ...state, conexao: "desconectado", queda: "resposta_invalida", analise: NENHUMA, enviandoDesde: null };
    case "desconectou":
      return { ...state, conexao: "desconectado", queda: "porta_fechada", enviandoDesde: null };
    case "entrar":
      return sessionActions(state).includes("entrar") ? { ...state, entrandoDesde: action.agora, pediuSair: false } : state;
    case "sair":
      // O "Tentar sair de novo" chega com o pedido já ligado (o `logoutUnconfirmed` exige o `pediuSair`): nada muda.
      return sessionActions(state).includes("sair") ? { ...state, pediuSair: true } : state;
    case "analisar": {
      // Só o botão que a tela oferece, no modo dele e sem bloqueio. A análise anterior sai da tela.
      const controle = analysisControl(state);
      const aceito = controle !== null && controle !== "aviso" && controle.bloqueio === null && controle.mode === action.mode;
      return aceito ? { ...state, enviandoDesde: action.agora, analise: NENHUMA } : state;
    }
    case "tique": {
      const entrou = state.entrandoDesde !== null && expired(state.entrandoDesde, action.agora, ENTRANDO_TETO_MS);
      const enviou = state.enviandoDesde !== null && expired(state.enviandoDesde, action.agora, ENVIANDO_TETO_MS);
      if (!entrou && !enviou) return state;
      const semEntrando = entrou ? { ...state, entrandoDesde: null } : state;
      // No teto do envio, o botão volta com o erro do catálogo; o terminal que ainda chegar vale (D20).
      return enviou ? { ...semEntrando, enviandoDesde: null, analise: { estado: "erro", error: SENDING_TIMEOUT_ERROR } } : semEntrando;
    }
    case "reconectar":
      return state;
  }
}
