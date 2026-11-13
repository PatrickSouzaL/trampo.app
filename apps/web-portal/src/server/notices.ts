// Avisos do portal (ADR-027 D7). O `?aviso=` só escolhe um texto deste catálogo fechado: nenhum texto do GoTrue, do IdP
// ou do pedido vai à tela.

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
