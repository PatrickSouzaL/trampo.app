// Renovação da sessão pelo envelope selado (ADR-004 D4, `RefreshSession`). Ordem fixa: formato → `open` do envelope →
// idade máxima → inatividade, as quatro sem rede e sem orçamento (M-09; operador "orçamento antes do `open`" do
// M-16) → chaves do JWKS (D6, M-10) → orçamento da partição `renovacao` e *bulkhead* (D8 item 5) → GoTrue, com no
// máximo **uma** nova tentativa quando ele pode ter rotacionado → verificação, `sid` igual e nova selagem com o mesmo
// `sst` (auth-session.ts). Código puro: a rota (07g) mapeia o resultado para HTTP pelo D7. Nunca rejeita.
import { AuthRefreshRequestSchema } from "@trampo/contracts/auth";

import type { AccessTokenVerifier } from "../ports/access-token-verifier.js";
import type { AuthTokenGateway, AuthTokenResult } from "../ports/auth-token-gateway.js";
import type { Clock } from "../ports/clock.js";
import type { RefreshOpenResult, RefreshSealer } from "../ports/refresh-sealer.js";
import { withDeadline } from "../shared/with-deadline.js";

import {
  INVALID_INPUT,
  callGotrue,
  issueSession,
  keysReady,
  rejected,
  unavailable,
  type AuthSessionOutcome,
} from "./auth-session.js";
import type { EgressOutcome, GotrueEgress } from "./gotrue-egress.js";

export const REFRESH_SESSION_POLICY = {
  /** Prazo da nova tentativa com o mesmo refresh (D4 passo 6; §4.2): cabe nas exceções de reuso do GoTrue (P10). */
  retryTimeoutMs: 2_000,
} as const;

/** As idades da sessão do BFF (D5), já validadas no boot pelo `readAuthSessionEnv` (07b). */
export interface SessionAges {
  readonly maxAgeSeconds: number;
  readonly idleSeconds: number;
}

export interface RefreshSessionDeps {
  readonly gateway: AuthTokenGateway;
  readonly sealer: RefreshSealer;
  readonly verifier: AccessTokenVerifier;
  readonly egress: GotrueEgress;
  /** Relógio monotônico: só o prazo da nova tentativa. */
  readonly clock: Clock;
  /** Relógio de parede, epoch em ms (`Date.now` em produção): idade, inatividade, `iat` novo e idade do token. */
  readonly now: () => number;
  readonly ages: SessionAges;
}

export interface RefreshSessionInput {
  /** O corpo da rota, `{ schemaVersion, refreshToken }`: conferido de novo aqui, antes do `open`. */
  readonly request: unknown;
  /** O `Origin` da extensão, que a borda já exigiu e conferiu (D8 item 2). Entra no AAD do envelope. */
  readonly origin: string;
}

export class RefreshSessionConfigError extends Error {
  constructor() {
    super("idades da sessão do BFF inválidas");
    this.name = "RefreshSessionConfigError";
  }
}

/** A porta rejeitou (quebrou a promessa): 503, sem nova tentativa. */
const GATEWAY_THREW: AuthTokenResult = { ok: false, reason: "nao_recebido" };
/** A nova tentativa estourou o prazo de 2 s: a resposta se perdeu de novo. */
const RETRY_LOST: EgressOutcome<AuthTokenResult> = { ok: true, value: { ok: false, reason: "pode_ter_rotacionado" } };
const MS_PER_SECOND = 1_000;

function openSafely(sealer: RefreshSealer, envelope: string, origin: string): RefreshOpenResult {
  try {
    return sealer.open(envelope, origin);
  } catch {
    return { ok: false };
  }
}

const positiveInt = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

export class RefreshSession {
  readonly #deps: RefreshSessionDeps;

  constructor(deps: RefreshSessionDeps) {
    const { maxAgeSeconds, idleSeconds } = deps.ages;
    // Falha fechada na montagem: sem idades coerentes, nenhuma sessão seria limitada.
    if (!positiveInt(maxAgeSeconds) || !positiveInt(idleSeconds) || idleSeconds > maxAgeSeconds) {
      throw new RefreshSessionConfigError();
    }
    this.#deps = deps;
  }

  async execute(input: RefreshSessionInput): Promise<AuthSessionOutcome> {
    const deps = this.#deps;
    // 1. Formato antes de tudo.
    const request = AuthRefreshRequestSchema.safeParse(input.request);
    if (!request.success) return INVALID_INPUT;

    // 2. O AEAD barra o forjado com custo local: nenhum orçamento, nenhuma chamada (D8 item 3; M-16).
    const opened = openSafely(deps.sealer, request.data.refreshToken, input.origin);
    if (!opened.ok) return rejected("auth_envelope_invalido");
    const { rt, sid, sst, iat } = opened.session;

    // 3 e 4. Idade máxima e inatividade, sem rede (D5). Os limites são inclusivos: só passar deles é recusado (M-09).
    const nowSeconds = deps.now() / MS_PER_SECOND;
    if (nowSeconds - sst > deps.ages.maxAgeSeconds) return rejected("auth_sessao_idade_maxima");
    if (nowSeconds - iat > deps.ages.idleSeconds) return rejected("auth_sessao_inativa");

    // 5. Sem chaves, o refresh não é consumido: a sessão sobrevive à queda do JWKS (D6).
    if (!(await keysReady(deps.verifier))) return unavailable("auth_chaves_indisponiveis");

    // 6. GoTrue, pela partição `renovacao`.
    let outcome = await callGotrue(deps.egress, "renovacao", () => deps.gateway.refresh(rt), GATEWAY_THREW);
    if (outcome.ok && !outcome.value.ok && outcome.value.reason === "pode_ter_rotacionado") {
      // O GoTrue pode ter rotacionado e a resposta se perdeu: **uma** nova tentativa, com o mesmo `rt`, dentro das
      // exceções de reuso do GoTrue (§1.1, P10). Ela passa de novo pelo orçamento e pelo *bulkhead* (07e) e tem
      // prazo de cerca de 2 s: vencido, o `signal` aborta a chamada e o resultado é 503.
      outcome = await withDeadline(
        deps.clock,
        REFRESH_SESSION_POLICY.retryTimeoutMs,
        (signal) => callGotrue(deps.egress, "renovacao", () => deps.gateway.refresh(rt, signal), GATEWAY_THREW),
        RETRY_LOST,
      );
      // Qualquer falha da nova tentativa é 503, inclusive a recusa: o 1º pedido pode ter rotacionado, e um 401 aqui
      // derrubaria uma sessão que o GoTrue talvez ainda reconheça (D4 passo 6: "se falhar, 503").
      if (outcome.ok && !outcome.value.ok) return unavailable("auth_provedor_indisponivel");
    }
    if (!outcome.ok) return unavailable("auth_provedor_indisponivel", outcome.retryAfterSeconds);

    const result = outcome.value;
    if (!result.ok) {
      // Refresh revogado, reusado fora da janela ou de sessão encerrada: um único motivo (D7). O resto é 503.
      return result.reason === "recusado" ? rejected("auth_renovacao_recusada") : unavailable("auth_provedor_indisponivel");
    }

    // 7 e 8. Verificação, `sid` igual ao do envelope (senão 401 sem selar o refresh novo) e nova selagem com o mesmo
    // `sst` e um `iat` novo.
    return issueSession(deps, { tokens: result.tokens, origin: input.origin, nowMs: deps.now(), previous: { sid, sst } });
  }
}
