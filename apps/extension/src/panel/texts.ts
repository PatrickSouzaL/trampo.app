// Catálogo de textos do Side Panel (pt-BR; ADR-025 D4). Cada enum do contrato tem um Record exaustivo:
// um valor novo no contrato quebra a compilação até ganhar texto. Os erros saem SÓ daqui, pelo `code`;
// o `message` do servidor não é exibido (ADR-025 D5). A sessão (ADR-004 D12) também sai só daqui, pelo booleano e
// pelo código da SessaoView, sem conta nem provedor.
import type { AnalysisWarning, DecisionPath, DimensionOutcome, ScoreDimension, Verdict } from "@trampo/contracts/analysis-report";
import type { ApiErrorCode } from "@trampo/contracts/api";

import type { AuthProvider, CaptureView, SessaoErro, SessaoView } from "../messaging/protocol";
import { logoutUnconfirmed, type AcaoSessao, type AnaliseView, type BloqueioAnalise, type PanelState } from "./panel-state";

export type Stage = Extract<AnaliseView, { estado: "andamento" }>["etapa"];

export function describeConnection(state: Pick<PanelState, "conexao" | "queda">): string {
  switch (state.conexao) {
    case "conectando":
      return "Conectando ao Trampo…";
    case "pronto":
      return "Pronto. Abra uma vaga e clique no ícone do Trampo na barra do navegador para analisá-la.";
    case "desconectado":
      return state.queda === "resposta_invalida"
        ? "Recebemos uma resposta fora do formato esperado e paramos por segurança. Feche e abra o painel de novo."
        : "A conexão com o Trampo caiu. Feche e abra o painel de novo.";
  }
}

const CAPTURE_FAILURES: Record<Extract<CaptureView, { estado: "falhou" }>["motivo"], string> = {
  sem_acesso: "O Trampo não pode ler esta página. Clique no ícone do Trampo com a aba da vaga aberta, ou cole o texto da vaga abaixo.",
  texto_insuficiente: "Não encontramos o texto da vaga. Cole o texto da vaga abaixo.",
  erro: "Não foi possível ler a vaga. Cole o texto da vaga abaixo.",
};

export function describeCapture(captura: CaptureView): string | null {
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
      return CAPTURE_FAILURES[captura.motivo];
  }
}

/** A ordem do funil (ADR-001 §4): a etapa N de 6. */
export const STAGE_ORDER: readonly Stage[] = ["recebido", "normalizando", "triagem_deterministica", "consultando_cache", "extraindo_fatos", "pontuando"];

export const STAGE_LABELS: Record<Stage, string> = {
  recebido: "Pedido recebido",
  normalizando: "Preparando o texto da vaga",
  triagem_deterministica: "Conferindo os critérios eliminatórios",
  consultando_cache: "Procurando uma leitura recente desta vaga",
  extraindo_fatos: "Lendo os fatos da vaga com IA",
  pontuando: "Calculando a nota",
};

export function describeStage(etapa: Stage, elapsedMs: number): string {
  const posicao = STAGE_ORDER.indexOf(etapa) + 1;
  return `Etapa ${posicao} de ${STAGE_ORDER.length}: ${STAGE_LABELS[etapa]} (${formatSeconds(elapsedMs)})`;
}

export const VERDICT_LABELS: Record<Verdict, string> = {
  altamente_recomendado: "Altamente recomendada",
  recomendado: "Recomendada",
  neutro: "Neutra",
  baixo_alinhamento: "Baixo alinhamento",
  foge: "Foge dos seus critérios",
};

export const DIMENSION_LABELS: Record<ScoreDimension, string> = {
  stack: "Tecnologias",
  modelo_trabalho: "Modelo de trabalho",
  senioridade: "Senioridade",
  contrato: "Contrato",
  salario: "Salário",
  localizacao: "Localização",
  idiomas: "Idiomas",
  beneficios: "Benefícios",
  red_flags: "Sinais de alerta",
};

export const OUTCOME_LABELS: Record<DimensionOutcome, string> = {
  atende: "Atende",
  atende_parcialmente: "Atende em parte",
  nao_atende: "Não atende",
  nao_informado: "Não informado",
  conflito: "Informação contraditória",
  ignorado: "Ignorado",
};

export const WARNING_LABELS: Record<AnalysisWarning, string> = {
  possivel_prompt_injection: "A vaga parece ter instruções escondidas para a IA. Confira os fatos com atenção.",
  informacao_contraditoria: "A vaga se contradiz em algum ponto. Os campos em conflito ficaram como não informados.",
  baixa_confianca_extracao: "A leitura da vaga teve baixa confiança. Confira os fatos antes de decidir.",
  texto_truncado: "O texto da vaga era longo e foi cortado no limite. O fim da vaga não entrou na análise.",
  analise_degradada: "A leitura com IA falhou, e a nota usou só a leitura automática da vaga.",
  decisao_sem_ia: "Os seus critérios eliminatórios decidiram a nota sem precisar da IA.",
};

export const DECISION_PATH_LABELS: Record<DecisionPath, string> = {
  triagem_deterministica: "Decidida pelos seus critérios eliminatórios, sem IA.",
  cache_jobfacts: "Fatos de uma leitura recente da mesma vaga.",
  extracao_llm: "Fatos lidos pela IA nesta análise.",
  fallback_deterministico: "Só com a leitura automática: a IA não estava disponível.",
};

export interface ErrorText {
  readonly titulo: string;
  readonly acao: string;
}

export const ERROR_TEXTS: Record<ApiErrorCode, ErrorText> = {
  NAO_AUTENTICADO: { titulo: "Sua sessão expirou.", acao: "Entre de novo na sua conta do Trampo e tente outra vez." },
  PROIBIDO: { titulo: "Sua conta não tem acesso a esta análise.", acao: "Se achar que é um engano, fale com o suporte do Trampo." },
  PAYLOAD_GRANDE_DEMAIS: { titulo: "O texto da vaga ficou grande demais para enviar.", acao: "Cole só a descrição da vaga e tente de novo." },
  PAYLOAD_INVALIDO: { titulo: "O pedido saiu com um formato inválido.", acao: "Clique no ícone do Trampo para ler a vaga de novo." },
  TEXTO_CURTO_DEMAIS: { titulo: "O texto da vaga é curto demais para analisar.", acao: "Abra a página completa da vaga ou cole o texto inteiro." },
  CRITERIOS_NAO_CONFIGURADOS: { titulo: "Você ainda não configurou os seus critérios.", acao: "Configure os critérios no portal do Trampo e analise de novo." },
  LIMITE_DE_TAXA: { titulo: "Muitas análises em pouco tempo.", acao: "Espere um pouco e tente de novo." },
  COTA_DIARIA_ESGOTADA: { titulo: "Você usou todas as análises de hoje.", acao: "A cota volta amanhã." },
  SERVICO_INDISPONIVEL: { titulo: "O serviço do Trampo está fora do ar agora.", acao: "Tente de novo em alguns minutos." },
  ERRO_INTERNO: { titulo: "Algo deu errado do nosso lado.", acao: "Tente de novo. Se continuar, informe o código do pedido ao suporte." },
};

/** O que a área da sessão mostra: a linha do estado e, se houver, o problema e o que fazer (ADR-004 D12). */
export interface SessionText {
  readonly estado: string;
  readonly erro: ErrorText | null;
}

type ErroComSessao = NonNullable<Extract<SessaoView, { autenticado: true }>["erro"]>;

const CONECTADO = "Conectado à sua conta do Trampo.";
const ENTRE = "Entre com a sua conta do GitHub ou do Google para analisar vagas.";
/** O ERROR_TEXTS fala de análises no LIMITE_DE_TAXA; na sessão, o limite é do login ou da renovação (emenda do 05b-2). */
const LIMITE_DA_SESSAO: ErrorText = { titulo: "Muitas tentativas em pouco tempo.", acao: "Espere um pouco e tente de novo." };

/**
 * Texto de cada `SessaoView` (ADR-004 D12), exaustivo: um código novo no SessaoErroSchema quebra a compilação. Os
 * códigos reaproveitam o ERROR_TEXTS, menos o ERRO_INTERNO, que não pede o código do pedido (a SessaoView não tem
 * `requestId`), e o LIMITE_DE_TAXA. Nenhum texto mostra conta nem provedor da sessão (residual "conta trocada", §3).
 */
export const SESSION_TEXTS: {
  readonly conectado: Record<ErroComSessao | "nenhum", SessionText>;
  readonly desconectado: Record<SessaoErro | "nenhum", SessionText>;
} = {
  conectado: {
    nenhum: { estado: CONECTADO, erro: null },
    SERVICO_INDISPONIVEL: { estado: CONECTADO, erro: ERROR_TEXTS.SERVICO_INDISPONIVEL },
    LIMITE_DE_TAXA: { estado: CONECTADO, erro: LIMITE_DA_SESSAO },
  },
  desconectado: {
    nenhum: { estado: ENTRE, erro: null },
    NAO_AUTENTICADO: { estado: ENTRE, erro: ERROR_TEXTS.NAO_AUTENTICADO },
    SERVICO_INDISPONIVEL: { estado: ENTRE, erro: ERROR_TEXTS.SERVICO_INDISPONIVEL },
    LIMITE_DE_TAXA: { estado: ENTRE, erro: LIMITE_DA_SESSAO },
    ERRO_INTERNO: { estado: ENTRE, erro: { titulo: "Algo deu errado do nosso lado.", acao: "Tente de novo. Se continuar, fale com o suporte do Trampo." } },
  },
};

/** `{ false, SERVICO_INDISPONIVEL }` depois do clique em "Sair" (D11.5 passo 4), com o botão "Tentar sair de novo". */
export const LOGOUT_UNCONFIRMED_TEXT: SessionText = {
  estado: "Você saiu neste navegador, mas o servidor não confirmou o encerramento da sessão. Tente de novo.",
  erro: null,
};

/** O "entrando…", estado local do painel (D12). */
export const SIGNING_IN_TEXT: SessionText = { estado: "Entrando… Conclua o acesso na janela que abriu.", erro: null };

/** O texto da sessão agora; null antes da conexão pronta e da `sessao` do handshake (como o consentimento null). */
export function describeSession(state: PanelState): SessionText | null {
  if (state.conexao !== "pronto" || state.sessao === null) return null;
  if (state.entrandoDesde !== null) return SIGNING_IN_TEXT;
  if (logoutUnconfirmed(state)) return LOGOUT_UNCONFIRMED_TEXT;
  return state.sessao.autenticado ? SESSION_TEXTS.conectado[state.sessao.erro ?? "nenhum"] : SESSION_TEXTS.desconectado[state.sessao.erro ?? "nenhum"];
}

/** Botões, nunca links (D12). Um provedor novo na AUTH_PROVIDERS quebra a compilação até ganhar rótulo. */
export const SIGN_IN_LABELS: Record<AuthProvider, string> = { github: "Entrar com GitHub", google: "Entrar com Google" };

export const SESSION_ACTION_LABELS: Record<Exclude<AcaoSessao, "entrar"> | "reconectar", string> = {
  sair: "Sair da conta",
  tentar_sair: "Tentar sair de novo",
  reconectar: "Reconectar",
};

/** Por que o "Analisar" está desabilitado (D12). O `sem_api` é o aviso de hoje (ADR-025 D5). */
export const ANALYZE_BLOCKED_TEXTS: Record<BloqueioAnalise, string> = {
  sem_api: "A ligação com o servidor do Trampo ainda não está ativa nesta versão.",
  sem_consentimento: "Aceite o aviso de envio para analisar a vaga.",
  sem_sessao: "Entre com a sua conta para analisar a vaga.",
};

function plural(n: number, singular: string, varios: string): string {
  return `${n} ${n === 1 ? singular : varios}`;
}

/** "Tente de novo em 2 minutos." a partir do `retryAfterSeconds` (0 a 86.400) do contrato. */
export function formatRetry(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return `Tente de novo em ${plural(seconds, "segundo", "segundos")}.`;
  if (seconds < 3600) return `Tente de novo em ${plural(Math.ceil(seconds / 60), "minuto", "minutos")}.`;
  return `Tente de novo em ${plural(Math.ceil(seconds / 3600), "hora", "horas")}.`;
}

/** Contribuição assinada de uma dimensão: "+12", "-5", "0". */
export function formatPoints(points: number): string {
  return points > 0 ? `+${points}` : String(points);
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}
