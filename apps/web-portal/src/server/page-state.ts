// O que as páginas mostram a partir do pedido (ADR-027 D6 e D7). O `?aviso=` vem primeiro (saída de uma rota de auth);
// sem ele, o estado que o proxy passou escolhe o aviso. Nenhum dos dois dá acesso: só a DAL dá.
import { parseNotice, type Notice } from "./notices";

export function noticeFor(aviso: unknown, sessionState: string | null): Notice | null {
  const explicit = parseNotice(aviso);
  if (explicit !== null) return explicit;
  if (sessionState === "expirada") return "sessao_expirada";
  if (sessionState === "indisponivel") return "servico_indisponivel";
  return null;
}

/** Para onde a `/conta` manda quem está sem sessão: a página inicial, com o aviso do estado, se houver. */
export function homeFor(sessionState: string | null): string {
  const notice = noticeFor(undefined, sessionState);
  return notice === null ? "/" : `/?aviso=${notice}`;
}
