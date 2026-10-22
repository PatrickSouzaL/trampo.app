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
  },
} as const satisfies { windowMs: number; classes: Record<RateLimitClass, { user: number; address: number }> };

/** A classe mais estrita: vale para qualquer valor de `config.rateLimit` fora do conjunto fechado. */
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
}

export const LEDGER_POLICY = {
  /** Folga de 15% abaixo do limite publicado (ADR-001 §5.5). */
  headroom: 0.85,
  /** Breaker diário global de LLM (T7, mitigação 10): chamadas por dia UTC, somando os provedores. */
  globalCallsPerDay: 400,
  /** Provedor fora desta tabela (o Gemini, HITL-012) é sempre `provedor_esgotado`. */
  providers: {
    groq: { rpm: 30, rpd: 1_000, tpm: 8_000, tpd: 200_000 },
    // Hipótese: o limite real é de 10.000 neurons por dia; os neurons por chamada só saem no S-1.
    cloudflare_workers_ai: { rpm: 60, rpd: 200, tpm: null, tpd: null },
    ollama: { rpm: null, rpd: null, tpm: null, tpd: null },
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
