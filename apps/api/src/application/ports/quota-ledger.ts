// Contabilidade de cota por provedor e breaker diário global de LLM (ADR-001 §5.5; ADR-009 D6;
// threat-model T7). A implementação em Redis, com a folga de 15%, espera o HITL-007.
import type { LlmProviderId } from "@trampo/contracts";

import type { TokenUsage } from "./job-facts-extractor.js";

/**
 * `provedor_esgotado`: pula para o próximo provedor antes de tomar 429.
 * `global_esgotado`: o teto diário de LLM do serviço inteiro, encerra a cadeia.
 */
export type QuotaDecision = "permitido" | "provedor_esgotado" | "global_esgotado";

export interface QuotaLedger {
  /** Reserva uma chamada. Erro, valor desconhecido ou demora significam negado (T39). */
  reserve(provider: LlmProviderId, signal: AbortSignal): Promise<QuotaDecision>;
  /** Tokens gastos numa chamada que respondeu. Melhor esforço: a falha não derruba a análise. */
  recordUsage(provider: LlmProviderId, usage: TokenUsage): Promise<void>;
}
