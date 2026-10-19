// Circuit breaker por provedor e resfriamento do 429 (ADR-001 §5.5; ADR-009 D5 e D6). Funções puras
// sobre ProviderState: o router lê o estado, aplica a transição e grava de volta, sem await no meio.
import type { LlmProviderId } from "@trampo/contracts";

import type { ProviderState, ProviderStateStore } from "../ports/provider-state-store.js";

export const BREAKER_POLICY = {
  /** Falhas seguidas que abrem o circuito. */
  consecutiveFailuresToOpen: 3,
  /** Janela de chamadas recentes e a fração de falha que abre o circuito com a janela cheia. */
  window: 10,
  failureRatioToOpen: 0.5,
  openMs: 60_000,
} as const;

export const RATE_LIMIT_COOLDOWN = {
  defaultMs: 60_000,
  minMs: 1_000,
  maxMs: 120_000,
} as const;

export const INITIAL_PROVIDER_STATE: ProviderState = Object.freeze({
  phase: "fechado",
  consecutiveFailures: 0,
  recent: Object.freeze([]),
  openUntilMs: 0,
  probeInFlight: false,
  cooldownUntilMs: 0,
});

export type Admission =
  | { readonly admitted: true; readonly state: ProviderState }
  | { readonly admitted: false; readonly reason: "limite_de_taxa" | "circuito_aberto" };

/** Pode chamar agora? Se o circuito passa a meio-aberto, a sonda única fica reservada para quem entrou. */
export function admit(state: ProviderState, nowMs: number): Admission {
  if (nowMs < state.cooldownUntilMs) return { admitted: false, reason: "limite_de_taxa" };
  if (state.phase === "fechado") return { admitted: true, state };
  if (state.phase === "aberto" && nowMs < state.openUntilMs) return { admitted: false, reason: "circuito_aberto" };
  if (state.phase === "meio_aberto" && state.probeInFlight) return { admitted: false, reason: "circuito_aberto" };
  return { admitted: true, state: { ...state, phase: "meio_aberto", probeInFlight: true } };
}

/** Admitido mas não chamou (cota negada ou prazo): devolve a sonda para outra análise. */
export function releaseProbe(state: ProviderState): ProviderState {
  return state.probeInFlight ? { ...state, probeInFlight: false } : state;
}

export function recordSuccess(state: ProviderState): ProviderState {
  if (state.phase === "meio_aberto") return { ...INITIAL_PROVIDER_STATE, cooldownUntilMs: state.cooldownUntilMs };
  return { ...state, consecutiveFailures: 0, recent: pushRecent(state.recent, false) };
}

export function recordFailure(state: ProviderState, nowMs: number): ProviderState {
  if (state.phase === "meio_aberto") return open(state, nowMs);
  const recent = pushRecent(state.recent, true);
  const consecutiveFailures = state.consecutiveFailures + 1;
  const failures = recent.filter(Boolean).length;
  const ratioTripped =
    recent.length === BREAKER_POLICY.window && failures >= BREAKER_POLICY.window * BREAKER_POLICY.failureRatioToOpen;
  if (consecutiveFailures >= BREAKER_POLICY.consecutiveFailuresToOpen || ratioTripped) return open(state, nowMs);
  return { ...state, consecutiveFailures, recent };
}

/**
 * HTTP 429: resfria pelo Retry-After, limitado a [1 s, 120 s]; ausente ou inválido, 60 s. Não é falha
 * do breaker (o provedor está vivo), mas devolve a sonda se ela estava em voo.
 */
export function recordRateLimit(state: ProviderState, nowMs: number, retryAfterMs: number | null): ProviderState {
  const cooldownMs =
    retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? Math.min(RATE_LIMIT_COOLDOWN.maxMs, Math.max(RATE_LIMIT_COOLDOWN.minMs, retryAfterMs))
      : RATE_LIMIT_COOLDOWN.defaultMs;
  return {
    ...releaseProbe(state),
    cooldownUntilMs: Math.max(state.cooldownUntilMs, nowMs + cooldownMs),
  };
}

function open(state: ProviderState, nowMs: number): ProviderState {
  return {
    ...INITIAL_PROVIDER_STATE,
    phase: "aberto",
    openUntilMs: nowMs + BREAKER_POLICY.openMs,
    cooldownUntilMs: state.cooldownUntilMs,
  };
}

function pushRecent(recent: readonly boolean[], failed: boolean): readonly boolean[] {
  return [...recent, failed].slice(-BREAKER_POLICY.window);
}

/** Estado por processo (ADR-009 D1). Provedor nunca visto começa fechado. */
export class InMemoryProviderStateStore implements ProviderStateStore {
  readonly #states = new Map<LlmProviderId, ProviderState>();

  get(provider: LlmProviderId): ProviderState {
    return this.#states.get(provider) ?? INITIAL_PROVIDER_STATE;
  }

  set(provider: LlmProviderId, state: ProviderState): void {
    this.#states.set(provider, state);
  }
}
