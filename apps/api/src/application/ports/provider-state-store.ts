// Estado de saúde de cada provedor: circuit breaker e resfriamento do 429 (ADR-009 D1 e D6).
// Síncrono e por processo hoje (InMemoryProviderStateStore). Estado compartilhado entre instâncias é
// decisão do S-5, num ADR próprio.
import type { LlmProviderId } from "@trampo/contracts";

export type CircuitPhase = "fechado" | "aberto" | "meio_aberto";

export interface ProviderState {
  readonly phase: CircuitPhase;
  readonly consecutiveFailures: number;
  /** Últimas chamadas, da mais antiga para a mais nova: true é falha. No máximo a janela do breaker. */
  readonly recent: readonly boolean[];
  /** Fim do período aberto (relógio do Clock). */
  readonly openUntilMs: number;
  /** Meio-aberto com a sonda única já em voo. */
  readonly probeInFlight: boolean;
  /** Fim do resfriamento pelo 429. */
  readonly cooldownUntilMs: number;
}

export interface ProviderStateStore {
  get(provider: LlmProviderId): ProviderState;
  set(provider: LlmProviderId, state: ProviderState): void;
}
