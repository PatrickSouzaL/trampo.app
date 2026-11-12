// Telemetria do BFF de autenticação (ADR-004 D8 item 7; ADR-010 D5 e D6; F1-API-07 07i). Funções puras: o resultado de
// cada caso de uso vira um dos 4 valores do rótulo `resultado`, pelo mesmo mapa do D7 que a rota usa para o HTTP. O
// evento só leva a operação e o resultado: o motivo fica na linha de log amostrada, e código, verifier, tokens,
// envelope, `sub`, sessão, origem e IP não têm como entrar (SR-12).
import type { AuthSessionOutcome } from "../auth/auth-session.js";
import type { EndSessionOutcome } from "../auth/end-session.js";
import type { AuthEvent, AuthOperation, AuthResult } from "../ports/telemetry.js";

export function authEvent(operation: AuthOperation, result: AuthResult): AuthEvent {
  return { kind: "auth", operation, result };
}

/** Troca e renovação: 200 é `ok`; 401 e 400 (a segunda trava do Zod) são `recusado`; 503 é `indisponivel`. */
export function authSessionResult(outcome: AuthSessionOutcome): AuthResult {
  switch (outcome.kind) {
    case "sessao":
      return "ok";
    case "indisponivel":
      return "indisponivel";
    case "nao_autenticado":
    case "entrada_invalida":
      return "recusado";
  }
}

/** Logout: 204 é `ok`; qualquer outra coisa é 503, `indisponivel`. */
export function endSessionResult(outcome: EndSessionOutcome): AuthResult {
  return outcome.kind === "encerrada" ? "ok" : "indisponivel";
}
