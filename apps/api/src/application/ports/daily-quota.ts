// Cota diária de análises por usuário, idempotente por `requestId` (ADR-001 §5.1 item 4; ADR-014 D5).

/**
 * - `{ ok: true, repeated }`: `repeated` marca um `requestId` já contado hoje (retry de rede não cobra de novo).
 * - `esgotada`: o usuário passou da cota do dia → 429 com `Retry-After` até a meia-noite de Brasília.
 * - `indisponivel`: Redis com erro, lento ou fora do contrato → 503. Nunca libera (SR-06).
 */
export type DailyQuotaDecision =
  | { readonly ok: true; readonly repeated: boolean }
  | { readonly ok: false; readonly reason: "esgotada"; readonly retryAfterSeconds: number }
  | { readonly ok: false; readonly reason: "indisponivel" };

export interface DailyQuota {
  /** Consome uma análise do dia. Nunca deveria rejeitar; o guarda trata a rejeição como `indisponivel`. */
  consume(userId: string, requestId: string, signal: AbortSignal): Promise<DailyQuotaDecision>;
}
