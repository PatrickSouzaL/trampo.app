// Catálogo de textos do Side Panel (pt-BR; ADR-025 D4). Cada enum do contrato tem um Record exaustivo:
// um valor novo no contrato quebra a compilação até ganhar texto. Os erros saem SÓ daqui, pelo `code`;
// o `message` do servidor não é exibido (ADR-025 D5).
import type { AnalysisWarning, DecisionPath, DimensionOutcome, ScoreDimension, Verdict } from "@trampo/contracts/analysis-report";
import type { ApiErrorCode } from "@trampo/contracts/api";

import type { CaptureView } from "../messaging/protocol";
import type { AnaliseView, PanelState } from "./panel-state";

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
