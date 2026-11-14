// Avisos do portal (ADR-027 D7; os dos critérios, ADR-028 D5). O `?aviso=` só escolhe um texto de um catálogo
// fechado: nenhum texto do GoTrue, do IdP, da API ou do pedido vai à tela.

export const NOTICES = Object.freeze({
  entrada_recusada: "Não foi possível começar a entrada. Use os botões desta página.",
  login_falhou: "Não deu para entrar. Tente de novo.",
  servico_indisponivel: "O serviço de login está indisponível agora. Tente de novo em instantes.",
  sessao_expirada: "Sua sessão expirou. Entre de novo.",
  saiu: "Você saiu.",
  saiu_local: "Você saiu deste navegador, mas não conseguimos confirmar com o servidor. A sessão expira sozinha em até 24 horas.",
} as const);

export type Notice = keyof typeof NOTICES;

export function parseNotice(value: unknown): Notice | null {
  return typeof value === "string" && Object.hasOwn(NOTICES, value) ? (value as Notice) : null;
}

/** Avisos da página de critérios (ADR-028 D5 e D6), num catálogo próprio: o `?aviso=` da `/conta/criterios` só escolhe daqui. */
export const CRITERIA_NOTICES = Object.freeze({
  criterios_salvos: "Critérios salvos.",
  criterios_invalidos: "Alguns campos precisam de ajuste. Veja as marcações no formulário.",
  criterios_recusados: "O servidor recusou os critérios enviados. Revise os campos e salve de novo.",
  criterios_indisponiveis: "Não deu para salvar agora: o serviço está indisponível. Tente de novo em instantes.",
  criterios_nao_confirmados: "Não conseguimos confirmar se salvou. Confira os valores e salve de novo.",
  formulario_recusado: "O formulário chegou incompleto ou alterado. Recarregue a página e tente de novo.",
} as const);

export type CriteriaNotice = keyof typeof CRITERIA_NOTICES;

/** Os avisos de uma gravação que falhou: só eles vêm com rascunho (ADR-028 D8). */
export const DRAFT_NOTICES: ReadonlySet<CriteriaNotice> = new Set(["criterios_invalidos", "criterios_recusados", "criterios_indisponiveis", "criterios_nao_confirmados"]);

export function parseCriteriaNotice(value: unknown): CriteriaNotice | null {
  return typeof value === "string" && Object.hasOwn(CRITERIA_NOTICES, value) ? (value as CriteriaNotice) : null;
}

/** Os textos fixos da página de critérios. */
export const CRITERIA_PAGE_TEXTS = Object.freeze({
  rascunho: "Este é o rascunho que você enviou. Ele ainda não está salvo.",
  rascunhoPerdido: "Não deu para guardar o rascunho. O formulário mostra o que está salvo.",
  padroes: "Você ainda não salvou critérios. O formulário mostra os padrões.",
  indisponivel: "Não deu para carregar seus critérios agora. Tente de novo em instantes.",
} as const);

/**
 * Um texto fixo por campo do contrato (ADR-028 D7). O erro de validação mostra só o nome do campo e este texto: nunca
 * o texto do Zod nem o valor recebido. `criterios` é o teto de 12.288 bytes do documento inteiro.
 */
export const CRITERIA_FIELD_ERRORS = Object.freeze({
  workModel: "Modelo de trabalho: marque pelo menos uma opção e escolha a importância.",
  seniority: "Senioridade: marque pelo menos uma opção e escolha a importância.",
  contractType: "Tipo de contrato: marque pelo menos uma opção e escolha a importância.",
  salary: "Pretensão salarial: um valor maior que zero e até 10.000.000, com no máximo duas casas decimais.",
  location: "Localização: escolha pelo menos um estado ou uma cidade (até 10 cidades, uma por linha, sem links nem os sinais de menor e maior).",
  stack: "Tecnologias: até 15 obrigatórias, 30 desejáveis e 15 eliminatórias, uma por linha, sem repetir entre as listas.",
  languages: "Idiomas: no máximo 8, cada um com o nível.",
  benefits: "Benefícios: marque pelo menos um e escolha a importância.",
  redFlagTolerance: "Sinais de alerta: escolha uma opção para cada sinal.",
  notes: "Observações: até 500 caracteres, sem links nem os sinais de menor e maior.",
  criterios: "Os critérios passaram do tamanho máximo. Encurte as listas ou as observações.",
} as const);
