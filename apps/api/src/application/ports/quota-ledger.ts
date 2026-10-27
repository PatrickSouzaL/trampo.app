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
  /**
   * Tokens gastos numa chamada que respondeu: ajusta a reserva pessimista ao uso real (ADR-022 D7.2). Melhor
   * esforço: a falha não derruba a análise.
   */
  recordUsage(provider: LlmProviderId, usage: TokenUsage): Promise<void>;
  /**
   * HTTP 429 do provedor: bloqueia o provedor pelo `Retry-After` (ou 60 s), entre instâncias e além de um restart
   * (ADR-022 D7.3). Melhor esforço, nunca rejeita; o resfriamento por processo do router continua igual.
   */
  recordRateLimit(provider: LlmProviderId, retryAfterMs: number | null): Promise<void>;
}
