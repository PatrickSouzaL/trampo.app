// Política de rate limit, cota diária e QuotaLedger (ADR-014 D4 a D6). São hipóteses da Fase 1 (uso
// pessoal), calibradas no S-1 e no S-5, e mudam só por ADR. Um teste fixa estes valores contra o ADR-014.
import type { LlmProviderId } from "@trampo/contracts";

import type { RateLimitClass } from "../ports/rate-limiter.js";

export const RATE_LIMIT_POLICY = {
  windowMs: 60_000,
  /** Requisições por janela, contando também as negadas (quem insiste continua bloqueado). */
  classes: {
    padrao: { user: 60, address: 120 },
    analise: { user: 5, address: 20 },
    /** Gravação dos critérios (o PUT /v1/criteria): cada requisição é uma cifragem e uma escrita no banco (ADR-021 D8.2). */
    criterios: { user: 10, address: 30 },
  },
} as const satisfies { windowMs: number; classes: Record<RateLimitClass, { user: number; address: number }> };

/** A classe mais estrita (a menor nas duas dimensões): vale para qualquer valor de `config.rateLimit` fora do conjunto fechado. */
export const STRICTEST_RATE_LIMIT_CLASS: RateLimitClass = "analise";

const RATE_LIMIT_CLASSES: ReadonlySet<unknown> = new Set(Object.keys(RATE_LIMIT_POLICY.classes));

/** `undefined` (rota sem classe) → `padrao`; valor conhecido → ele; qualquer outro → a mais estrita. */
export function resolveRateLimitClass(value: unknown): RateLimitClass {
  if (value === undefined) return "padrao";
  return RATE_LIMIT_CLASSES.has(value) ? (value as RateLimitClass) : STRICTEST_RATE_LIMIT_CLASS;
}

export const DAILY_QUOTA_POLICY = {
  analysesPerDay: 50,
  /** O dia da cota é o de Brasília (UTC−03:00, sem horário de verão desde 2019). */
  utcOffsetMinutes: -180,
  /** O set do dia expira sozinho depois de 2 dias (eviction desligado: o TTL é quem limpa). */
  keyTtlSeconds: 172_800,
} as const;

/** Limites publicados por provedor; `null` = sem limite conhecido nessa dimensão. */
export interface ProviderLimits {
  readonly rpm: number | null;
  readonly rpd: number | null;
  readonly tpm: number | null;
  readonly tpd: number | null;
  /**
   * Reserva pessimista de tokens por chamada (ADR-022 D7.2), somada ao TPM e ao TPD no `reserve` e reconciliada
   * pelo `recordUsage`. A chamada que não volta 200 fica com a reserva cheia. `null`: sem reserva (tokens lidos).
   */
  readonly reservedTokensPerCall: number | null;
}

/**
 * Estimativa de neurons por chamada da Workers AI com o modelo provisório (ADR-020 D9 e D10), no pior caso do
 * orçamento: 2.200 tokens de entrada a 26.668 neurons por milhão e 600 de saída a 204.805 por milhão, arredondado
 * para cima (≈ 58,7 + 122,9 = 181,6 → 182). A medida real é do S-1, e muda este valor por emenda ao ADR-020.
 */
export const WORKERS_AI_NEURON_BUDGET = {
  neuronsPerDay: 10_000,
  inputTokens: 2_200,
  outputTokens: 600,
  inputNeuronsPerMillion: 26_668,
  outputNeuronsPerMillion: 204_805,
} as const;

/**
 * Chamadas por dia que cabem nos neurons gratuitos, ANTES da folga: `floor(10.000 ÷ 182)` = 54. A tabela do ledger
 * guarda o limite publicado, e o `effectiveLimit` aplica os 15%: `floor(54 × 0,85)` = 45 por dia (emenda ao ADR-020
 * D9, que dava 46 já com a folga e, posto na tabela, teria a folga aplicada duas vezes).
 */
export function workersAiCallsPerDay(): number {
  const budget = WORKERS_AI_NEURON_BUDGET;
  const perCall = Math.ceil(
    (budget.inputTokens * budget.inputNeuronsPerMillion + budget.outputTokens * budget.outputNeuronsPerMillion) / 1_000_000,
  );
  return Math.floor(budget.neuronsPerDay / perCall);
}

export const LEDGER_POLICY = {
  /** Folga de 15% abaixo do limite publicado (ADR-001 §5.5). */
  headroom: 0.85,
  /** Breaker diário global de LLM (T7, mitigação 10): chamadas por dia UTC, somando os provedores. */
  globalCallsPerDay: 400,
  /** Provedor fora desta tabela (o Gemini, HITL-012) é sempre `provedor_esgotado`. */
  providers: {
    // Reserva de 3.000: entrada p95 de ~2,5k mais a saída p50 de ~0,4k (S-1), arredondada para cima. Recalibrada
    // com o p95 do aceite do p3 (ADR-022 D7.2).
    groq: { rpm: 30, rpd: 1_000, tpm: 8_000, tpd: 200_000, reservedTokensPerCall: 3_000 },
    // O limite real é de 10.000 neurons por dia; o `rpd` vem da estimativa de neurons por chamada (ADR-020 D9), e a
    // medida real é do S-1. O `rpm` fica bem abaixo dos 300 por minuto documentados.
    cloudflare_workers_ai: { rpm: 60, rpd: workersAiCallsPerDay(), tpm: null, tpd: null, reservedTokensPerCall: null },
    ollama: { rpm: null, rpd: null, tpm: null, tpd: null, reservedTokensPerCall: null },
  } satisfies Partial<Record<LlmProviderId, ProviderLimits>>,
  minuteTtlSeconds: 120,
  dayTtlSeconds: 172_800,
  /** Teto de tokens aceitos num `recordUsage` (acima disso o uso é ignorado como fora da forma). */
  maxTokensPerCall: 1_000_000,
} as const;

/** Prazo do guarda em volta da porta (o cliente REST tem o próprio teto, menor). */
export const LIMIT_GUARD_POLICY = { timeoutMs: 250 } as const;

export function providerLimits(provider: LlmProviderId): ProviderLimits | null {
  const table: Partial<Record<LlmProviderId, ProviderLimits>> = LEDGER_POLICY.providers;
  return table[provider] ?? null;
}

/** O limite efetivo com a folga: `floor(publicado × 0,85)`. */
export function effectiveLimit(published: number): number {
  return Math.floor(published * LEDGER_POLICY.headroom);
}
