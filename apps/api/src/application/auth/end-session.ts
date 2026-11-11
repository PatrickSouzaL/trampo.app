// Encerramento da sessão no GoTrue (ADR-004 D4, `EndSession`). A rota é protegida (07g): o Bearer já foi verificado
// e o rate limit da classe `padrao` já passou. Aqui só o `logout?scope=global` com o Bearer do usuário, pelo
// *bulkhead* (D8 item 5; o logout não tem orçamento até o 07h conferir o balde dele). Código puro: a rota mapeia o
// resultado para HTTP. Nunca rejeita.
import type { AuthLogoutResult, AuthTokenGateway } from "../ports/auth-token-gateway.js";

import { callGotrue, unavailable, type AuthUnavailable } from "./auth-session.js";
import type { GotrueEgress } from "./gotrue-egress.js";

export interface EndSessionDeps {
  readonly gateway: AuthTokenGateway;
  readonly egress: GotrueEgress;
}

export interface EndSessionInput {
  /** O Bearer da requisição, já verificado pela borda. Vai só no cabeçalho do GoTrue (adapter do 07c). */
  readonly accessToken: string;
}

/** 204: a sessão não está mais viva no GoTrue (2xx, ou 403 `session_not_found`, que o adapter já trata como `ok`). */
export interface SessionEnded {
  readonly kind: "encerrada";
}

/** Resultado do logout: 204 ou 503. */
export type EndSessionOutcome = SessionEnded | AuthUnavailable;

const ENDED: SessionEnded = { kind: "encerrada" };
/** A porta rejeitou (quebrou a promessa): não se sabe se a sessão caiu, então 503. */
const GATEWAY_THREW: AuthLogoutResult = { ok: false, reason: "nao_recebido" };

export class EndSession {
  readonly #deps: EndSessionDeps;

  constructor(deps: EndSessionDeps) {
    this.#deps = deps;
  }

  async execute(input: EndSessionInput): Promise<EndSessionOutcome> {
    const deps = this.#deps;
    const outcome = await callGotrue(deps.egress, "logout", () => deps.gateway.logout(input.accessToken), GATEWAY_THREW);
    if (!outcome.ok) return unavailable("auth_provedor_indisponivel", outcome.retryAfterSeconds);
    // Qualquer falha (5xx, prazo, rede, 401 ou recusa que não seja o `session_not_found`) é 503: o 204 só sai com a
    // sessão de fato encerrada.
    return outcome.value.ok ? ENDED : unavailable("auth_provedor_indisponivel");
  }
}
