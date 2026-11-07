// Troca do código PKCE por uma sessão (ADR-004 D4, `ExchangeSession`). Ordem fixa, do mais barato para o mais caro:
// formato (sem rede) → chaves do JWKS (D6, M-10) → orçamento de saída e *bulkhead* (D8 item 5) → GoTrue, uma chamada
// só e sem nova tentativa → verificação antes de repassar e selagem (auth-session.ts). Código puro: a rota (07g)
// mapeia o resultado para HTTP pelo D7. Nunca rejeita.
import { AuthExchangeRequestSchema } from "@trampo/contracts/auth";

import type { AccessTokenVerifier } from "../ports/access-token-verifier.js";
import type { AuthTokenGateway, AuthTokenResult } from "../ports/auth-token-gateway.js";
import type { RefreshSealer } from "../ports/refresh-sealer.js";

import {
  INVALID_INPUT,
  callGotrue,
  issueSession,
  keysReady,
  rejected,
  unavailable,
  type AuthSessionOutcome,
} from "./auth-session.js";
import type { GotrueEgress } from "./gotrue-egress.js";

export interface ExchangeSessionDeps {
  readonly gateway: AuthTokenGateway;
  readonly sealer: RefreshSealer;
  readonly verifier: AccessTokenVerifier;
  readonly egress: GotrueEgress;
  /** Relógio de parede, epoch em ms (`Date.now` em produção): `sst`, `iat` e a idade do token. */
  readonly now: () => number;
}

export interface ExchangeSessionInput {
  /** O corpo da rota, `{ schemaVersion, authCode, codeVerifier }`: conferido de novo aqui, antes da rede. */
  readonly request: unknown;
  /** O `Origin` da extensão, que a borda já exigiu e conferiu (D8 item 2). Entra no AAD do envelope. */
  readonly origin: string;
}

/** A porta rejeitou (quebrou a promessa): 503, sem nova tentativa. */
const GATEWAY_THREW: AuthTokenResult = { ok: false, reason: "nao_recebido" };

export class ExchangeSession {
  readonly #deps: ExchangeSessionDeps;

  constructor(deps: ExchangeSessionDeps) {
    this.#deps = deps;
  }

  async execute(input: ExchangeSessionInput): Promise<AuthSessionOutcome> {
    const deps = this.#deps;
    // 1. Formato antes da rede: nada abaixo roda, nem o orçamento, com a entrada fora do contrato.
    const request = AuthExchangeRequestSchema.safeParse(input.request);
    if (!request.success) return INVALID_INPUT;

    // 2. Sem chaves para verificar o token que viria, o código não é gasto: 503 sem chamar o GoTrue (D6).
    if (!(await keysReady(deps.verifier))) return unavailable("auth_chaves_indisponiveis");

    // 3 e 4. Orçamento da partição `troca` e *bulkhead*; negado, o GoTrue não é chamado e nada é consumido.
    const { authCode, codeVerifier } = request.data;
    const outcome = await callGotrue(
      deps.egress,
      "troca",
      () => deps.gateway.exchangePkce(authCode, codeVerifier),
      GATEWAY_THREW,
    );
    if (!outcome.ok) return unavailable("auth_provedor_indisponivel", outcome.retryAfterSeconds);

    const result = outcome.value;
    if (!result.ok) {
      // Código inválido, verifier errado, reuso ou vencido: um único motivo (D7). O resto é 503, sem nova tentativa
      // (uma 2ª chamada ao GoTrue gastaria o balde de sign-in, e o código PKCE é de uso único).
      return result.reason === "recusado" ? rejected("auth_troca_recusada") : unavailable("auth_provedor_indisponivel");
    }

    // 5 a 8. Verificação antes de repassar, política dos 900 s e selagem da sessão nova.
    return issueSession(deps, { tokens: result.tokens, origin: input.origin, nowMs: deps.now(), previous: null });
  }
}
