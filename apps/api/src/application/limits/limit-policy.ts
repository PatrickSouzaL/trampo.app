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
 * Neurons por chamada da Workers AI medidos no aceite do p3/g4 (spike-metrics §2.8: 83 chamadas em 6k com o modelo
 * do ADR-020 D10, pelos tokens de `usage` e o preço publicado por milhão). Calibram o `rpd` do ledger (emenda ao
 * ADR-020 D9, Trilha W1) e mudam só com uma medida nova. A estimativa anterior, de 182 por chamada no pior caso do
 * orçamento (2.200 tokens de entrada e 600 de saída), fica registrada no ADR.
 */
export const WORKERS_AI_NEURON_MEASUREMENT = {
  /** Cota gratuita da Workers AI, que reinicia às 00:00 UTC. */
  neuronsPerDay: 10_000,
  neuronsPerCallMean: 74,
  neuronsPerCallP95: 101,
} as const;

/** O que entra na conta do `rpd` (a medida inteira, ou uma sintética nos testes da fórmula). */
export interface NeuronBudgetBasis {
  readonly neuronsPerDay: number;
  readonly neuronsPerCallP95: number;
}

/**
 * Chamadas por dia que cabem nos neurons gratuitos, ANTES da folga, pelo p95 medido: `floor(10.000 ÷ 101)` = 99. A
 * tabela do ledger guarda o limite publicado, e o `effectiveLimit` aplica os 15% uma vez só: `floor(99 × 0,85)` = 84
 * por dia. O p95, e não a média, para que um dia de vagas longas não estoure a cota antes do teto do ledger.
 */
export function workersAiCallsPerDay(measured: NeuronBudgetBasis = WORKERS_AI_NEURON_MEASUREMENT): number {
  return Math.floor(measured.neuronsPerDay / measured.neuronsPerCallP95);
}

/**
 * Tokens por chamada do Groq medidos no aceite do p3/g4 (spike-metrics §2.8: 83 chamadas `ok` em 6k, `usage` do
 * provedor). Calibram a reserva pessimista do ledger (ADR-022 D7.2) e mudam só com uma medida nova.
 */
export const GROQ_TOKEN_MEASUREMENT = {
  inputTokensP95: 2_509,
  outputTokensP50: 331,
  totalTokensP95: 2_939,
  totalTokensMax: 3_683,
  /** A reserva sobe para o múltiplo seguinte deste passo: folga para a variação do provedor sem reserva fracionada. */
  roundingStep: 500,
} as const;

/** O que entra na conta da reserva (a medida inteira, ou uma sintética nos testes da fórmula). */
export interface TokenReserveBasis {
  readonly inputTokensP95: number;
  readonly outputTokensP50: number;
  readonly roundingStep: number;
}

/**
 * Reserva do Groq (ADR-022 D7.2, recalibrada na Trilha L1): entrada p95 mais saída p50 (2.509 + 331 = 2.840),
 * arredondada para cima no passo de 500, dá 3.000, que também cobre o total p95 medido (2.939). A cauda (máx.
 * 3.683) passa da reserva e é reconciliada pelo `recordUsage` com o uso real.
 */
export function groqReservedTokensPerCall(measured: TokenReserveBasis = GROQ_TOKEN_MEASUREMENT): number {
  const base = measured.inputTokensP95 + measured.outputTokensP50;
  return Math.ceil(base / measured.roundingStep) * measured.roundingStep;
}

export const LEDGER_POLICY = {
  /** Folga de 15% abaixo do limite publicado (ADR-001 §5.5). */
  headroom: 0.85,
  /** Breaker diário global de LLM (T7, mitigação 10): chamadas por dia UTC, somando os provedores. */
  globalCallsPerDay: 400,
  /** Provedor fora desta tabela (o Gemini, HITL-012) é sempre `provedor_esgotado`. */
  providers: {
    // Reserva calibrada pela medida do aceite do p3 (`groqReservedTokensPerCall`, ADR-022 D7.2): 3.000 tokens.
    groq: { rpm: 30, rpd: 1_000, tpm: 8_000, tpd: 200_000, reservedTokensPerCall: groqReservedTokensPerCall() },
    // O limite real é de 10.000 neurons por dia; o `rpd` vem do p95 medido de neurons por chamada (S-1, emenda ao
    // ADR-020 D9): 99 publicado, 84 efetivo. O `rpm` fica bem abaixo dos 300 por minuto documentados.
    cloudflare_workers_ai: { rpm: 60, rpd: workersAiCallsPerDay(), tpm: null, tpd: null, reservedTokensPerCall: null },
    ollama: { rpm: null, rpd: null, tpm: null, tpd: null, reservedTokensPerCall: null },
  } satisfies Partial<Record<LlmProviderId, ProviderLimits>>,
  minuteTtlSeconds: 120,
  dayTtlSeconds: 172_800,
  /** Teto de tokens aceitos num `recordUsage` (acima disso o uso é ignorado como fora da forma). */
  maxTokensPerCall: 1_000_000,
  /**
   * Bloqueio compartilhado por `Retry-After` (ADR-022 D7.3): `null` ou inválido vira 60 s, e o valor fica em
   * [1 s, 1 h]. O teto de 1 h passa dos 887 s medidos no TPD do Groq (S-1).
   */
  rateLimitBlock: { defaultMs: 60_000, minMs: 1_000, maxMs: 3_600_000 },
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
