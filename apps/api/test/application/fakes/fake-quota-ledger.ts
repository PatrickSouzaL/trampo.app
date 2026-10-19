// QuotaLedger em memória: decisões roteirizadas por provedor, com latência no relógio falso e modos de
// falha (lança, rejeita, trava, valor desconhecido) para provar que o router falha fechado (T39).
import type { LlmProviderId } from "@trampo/contracts";

import type { Clock, QuotaDecision, QuotaLedger, TokenUsage } from "../../../src/application/index.js";

export type LedgerBehavior =
  | QuotaDecision
  | { readonly kind: "lanca" | "rejeita" | "trava" }
  | { readonly kind: "lento"; readonly latencyMs: number; readonly decision: QuotaDecision }
  | { readonly kind: "lixo"; readonly value: unknown };

export class FakeQuotaLedger implements QuotaLedger {
  readonly reservations: LlmProviderId[] = [];
  readonly usage: { provider: LlmProviderId; usage: TokenUsage }[] = [];
  failUsage = false;

  constructor(
    readonly clock: Clock,
    readonly behavior: (provider: LlmProviderId, nth: number) => LedgerBehavior = () => "permitido",
  ) {}

  reserve(provider: LlmProviderId, signal: AbortSignal): Promise<QuotaDecision> {
    const behavior = this.behavior(provider, this.reservations.length);
    this.reservations.push(provider);
    if (typeof behavior === "string") return Promise.resolve(behavior);
    switch (behavior.kind) {
      case "lanca":
        throw new Error("redis fora do ar");
      case "rejeita":
        return Promise.reject(new Error("redis fora do ar"));
      case "trava":
        return new Promise<QuotaDecision>(() => undefined);
      case "lento":
        return this.clock.sleep(behavior.latencyMs, signal).then(() => behavior.decision);
      default:
        return Promise.resolve(behavior.value as QuotaDecision);
    }
  }

  recordUsage(provider: LlmProviderId, usage: TokenUsage): Promise<void> {
    this.usage.push({ provider, usage });
    if (this.failUsage) throw new Error("redis fora do ar");
    return Promise.resolve();
  }
}
