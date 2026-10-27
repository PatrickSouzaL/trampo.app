// LlmProviderRouter, Camada 3 do funil (ADR-001 §5.5, C9; ADR-009).
//
// Percorre a cadeia de provedores com prazo global, no máximo 2 chamadas de LLM por análise, retry só para
// erro transitório, troca imediata no 429, circuit breaker por provedor e reserva de cota que falha fechado
// (threat-model T7, T28, T30 e T39). Todo resultado ok passou pelo LlmOutputGuard AQUI, não no adapter.
// Nunca lança, não tem logger e a trilha só carrega enums: nada do prompt nem da resposta sai (SR-12).
import type { LlmProviderId } from "@trampo/contracts";
import type { JobFacts } from "@trampo/contracts/job-facts";
import { JobFactsCacheEntrySchema } from "@trampo/contracts/job-facts";

import type { Clock, Deadline } from "../ports/clock.js";
import type {
  JobFactsExtractor,
  LlmJobPayload,
  ProviderCallOutcome,
  TokenUsage,
} from "../ports/job-facts-extractor.js";
import type { ProviderStateStore } from "../ports/provider-state-store.js";
import type { QuotaDecision, QuotaLedger } from "../ports/quota-ledger.js";
import type { Random } from "../ports/random.js";
import { admit, recordFailure, recordRateLimit, recordSuccess, releaseProbe } from "./circuit-breaker.js";
import {
  LlmOutputGuard,
  type LlmOutputRejection,
  type LlmOutputSanitization,
} from "./llm-output-guard.js";

/**
 * Teto de cada tentativa, por provedor (ADR-009 §5; ADR-022 D9). O tipo total obriga quem acrescentar um provedor ao
 * enum a decidir o teto dele. O Groq (máximo medido de 1,39 s) fica em 3 s: travado, deixa 8,7 s à Workers AI.
 */
export type AttemptTimeoutMaxMs = Readonly<Record<LlmProviderId, number>>;

/** Hipóteses do ADR-001 §5.5, calibradas no S-1 e alteradas só por ADR (ADR-009 D4 e D5). */
export const ROUTER_POLICY = {
  analysisDeadlineMs: 12_000,
  attemptTimeoutMaxMs: Object.freeze({
    groq: 3_000,
    cloudflare_workers_ai: 10_000,
    ollama: 10_000,
    google_ai_studio: 10_000,
  }) satisfies AttemptTimeoutMaxMs,
  deadlineReserveMs: 300,
  minAttemptMs: 2_500,
  maxLlmCallsPerAnalysis: 2,
  retryJitterMinMs: 200,
  retryJitterMaxMs: 600,
  ledgerTimeoutMs: 250,
} as const;

export type ExtractionFailureReason =
  | "timeout"
  | "limite_de_taxa"
  | "saida_invalida"
  | "erro_provedor"
  | "circuito_aberto"
  | "cota_esgotada";

export interface RouterTrailEntry {
  readonly provider: LlmProviderId;
  readonly outcome: "ok" | ExtractionFailureReason;
  /** false quando o provedor foi pulado sem chamada (resfriamento, circuito, cota ou prazo). */
  readonly called: boolean;
  readonly guardRejection?: LlmOutputRejection;
}

export type ExtractionOutcome =
  | {
      readonly ok: true;
      readonly facts: JobFacts;
      readonly sanitization: LlmOutputSanitization;
      readonly provider: LlmProviderId;
      readonly model: string;
      readonly usage: TokenUsage;
      readonly trail: readonly RouterTrailEntry[];
    }
  | { readonly ok: false; readonly reason: ExtractionFailureReason; readonly trail: readonly RouterTrailEntry[] };

export interface LlmProviderRouterDeps {
  /** Cadeia já validada por parseLlmProviderChain. */
  readonly chain: readonly LlmProviderId[];
  readonly extractors: readonly JobFactsExtractor[];
  readonly clock: Clock;
  readonly random: Random;
  readonly ledger: QuotaLedger;
  readonly states: ProviderStateStore;
  readonly guard?: LlmOutputGuard;
  /** Só para os testes (propriedades com tetos sorteados). O padrão é `ROUTER_POLICY.attemptTimeoutMaxMs`. */
  readonly attemptTimeoutMaxMs?: AttemptTimeoutMaxMs;
}

export class RouterConfigError extends Error {
  override readonly name = "RouterConfigError";
}

const MODEL_ID = JobFactsCacheEntrySchema.shape.model;
const QUOTA_DECISIONS: ReadonlySet<unknown> = new Set<QuotaDecision>(["permitido", "provedor_esgotado", "global_esgotado"]);

type CallResult =
  | { readonly kind: "ok"; readonly raw: string; readonly usage: TokenUsage }
  | { readonly kind: "limite_de_taxa"; readonly retryAfterMs: number | null }
  | { readonly kind: "erro_transitorio" | "erro_permanente" | "timeout" };

/** Etapa que encerra a cadeia inteira: prazo insuficiente ou cota global (ou ledger fora do ar). */
class StopChain {
  constructor(readonly reason: ExtractionFailureReason) {}
}

export class LlmProviderRouter {
  readonly #chain: readonly JobFactsExtractor[];
  readonly #clock: Clock;
  readonly #random: Random;
  readonly #ledger: QuotaLedger;
  readonly #states: ProviderStateStore;
  readonly #guard: LlmOutputGuard;
  readonly #attemptTimeoutMaxMs: AttemptTimeoutMaxMs;

  /** Lança no boot se a cadeia não casa com os adapters (ADR-009 D7). Em requisição, nunca lança. */
  constructor(deps: LlmProviderRouterDeps) {
    if (deps.chain.length === 0) throw new RouterConfigError("cadeia de provedores vazia");
    this.#chain = deps.chain.map((provider) => {
      const matches = deps.extractors.filter((extractor) => extractor.provider === provider);
      if (matches.length !== 1) throw new RouterConfigError(`esperado 1 adapter para ${provider}, há ${matches.length}`);
      const [extractor] = matches as [JobFactsExtractor];
      if (!MODEL_ID.safeParse(extractor.model).success) throw new RouterConfigError(`modelo inválido para ${provider}`);
      return extractor;
    });
    this.#clock = deps.clock;
    this.#random = deps.random;
    this.#ledger = deps.ledger;
    this.#states = deps.states;
    this.#guard = deps.guard ?? new LlmOutputGuard();
    this.#attemptTimeoutMaxMs = deps.attemptTimeoutMaxMs ?? ROUTER_POLICY.attemptTimeoutMaxMs;
  }

  async extract(payload: LlmJobPayload, deadline: Deadline): Promise<ExtractionOutcome> {
    const trail: RouterTrailEntry[] = [];
    try {
      return await this.#route(payload, deadline, trail);
    } catch {
      // Adapter, ledger ou store fora do contrato: falha fechado, sem ecoar a exceção.
      return { ok: false, reason: "erro_provedor", trail };
    }
  }

  async #route(payload: LlmJobPayload, deadline: Deadline, trail: RouterTrailEntry[]): Promise<ExtractionOutcome> {
    const budget = { calls: 0 };
    let last: ExtractionFailureReason = "timeout";
    for (const extractor of this.#chain) {
      // Orçamento gasto: o próximo provedor nem é consultado.
      if (budget.calls >= ROUTER_POLICY.maxLlmCallsPerAnalysis) break;
      const step = await this.#tryProvider(extractor, payload, deadline, budget, trail);
      if (step instanceof StopChain) return { ok: false, reason: step.reason, trail };
      if (step.ok) return step;
      last = step.reason;
    }
    return { ok: false, reason: last, trail };
  }

  /**
   * Um provedor, com no máximo um retry: com orçamento de 2, o retry só cabe depois da 1ª chamada da análise.
   * Devolve o resultado, a falha que passa ao próximo provedor, ou StopChain.
   */
  async #tryProvider(
    extractor: JobFactsExtractor,
    payload: LlmJobPayload,
    deadline: Deadline,
    budget: { calls: number },
    trail: RouterTrailEntry[],
  ): Promise<ExtractionOutcome | StopChain> {
    const { provider } = extractor;
    const skip = (reason: ExtractionFailureReason): ExtractionOutcome => {
      trail.push({ provider, outcome: reason, called: false });
      return { ok: false, reason, trail };
    };
    for (;;) {
      if (this.#remaining(deadline) < ROUTER_POLICY.minAttemptMs) return new StopChain("timeout");

      const admission = admit(this.#states.get(provider), this.#clock.nowMs());
      if (!admission.admitted) return skip(admission.reason);
      this.#states.set(provider, admission.state);

      const quota = await this.#reserve(provider);
      if (quota !== "permitido" || this.#remaining(deadline) < ROUTER_POLICY.minAttemptMs) {
        this.#states.set(provider, releaseProbe(this.#states.get(provider)));
        if (quota === "provedor_esgotado") return skip("cota_esgotada");
        return new StopChain(quota === "permitido" ? "timeout" : "cota_esgotada");
      }

      budget.calls += 1;
      // O retry no mesmo provedor usa o mesmo teto (ADR-009 §5.2).
      const timeoutMs = Math.min(
        this.#attemptTimeoutMaxMs[provider],
        this.#remaining(deadline) - ROUTER_POLICY.deadlineReserveMs,
      );
      const result = await this.#call(extractor, payload, timeoutMs);
      const now = this.#clock.nowMs();
      const state = this.#states.get(provider);

      if (result.kind === "ok") {
        this.#recordUsage(provider, result.usage);
        const inspected = this.#guard.inspect(result.raw);
        if (inspected.ok) {
          this.#states.set(provider, recordSuccess(state));
          trail.push({ provider, outcome: "ok", called: true });
          return {
            ok: true,
            facts: inspected.facts,
            sanitization: inspected.sanitization,
            provider,
            model: extractor.model,
            usage: result.usage,
            trail,
          };
        }
        this.#states.set(provider, recordFailure(state, now));
        trail.push({ provider, outcome: "saida_invalida", called: true, guardRejection: inspected.reason });
        return { ok: false, reason: "saida_invalida", trail };
      }

      if (result.kind === "limite_de_taxa") {
        this.#states.set(provider, recordRateLimit(state, now, result.retryAfterMs));
        trail.push({ provider, outcome: "limite_de_taxa", called: true });
        return { ok: false, reason: "limite_de_taxa", trail };
      }

      this.#states.set(provider, recordFailure(state, now));
      const reason: ExtractionFailureReason = result.kind === "timeout" ? "timeout" : "erro_provedor";
      trail.push({ provider, outcome: reason, called: true });
      // Retry só para rede ou 5xx, uma vez, dentro do orçamento e do prazo (ADR-009 D5).
      if (result.kind !== "erro_transitorio" || budget.calls >= ROUTER_POLICY.maxLlmCallsPerAnalysis) {
        return { ok: false, reason, trail };
      }
      const jitterMs = this.#jitterMs();
      if (this.#remaining(deadline) - jitterMs < ROUTER_POLICY.minAttemptMs) return { ok: false, reason, trail };
      await this.#clock.sleep(jitterMs);
    }
  }

  /** Corrida entre a chamada e o timeout da tentativa. O perdedor é abortado; rejeição tardia é absorvida. */
  async #call(extractor: JobFactsExtractor, payload: LlmJobPayload, timeoutMs: number): Promise<CallResult> {
    const controller = new AbortController();
    const call = Promise.resolve()
      .then(() => extractor.call(payload, { signal: controller.signal, timeoutMs }))
      .then(toCallResult)
      .catch((): CallResult => ({ kind: "erro_permanente" }));
    const timer = this.#clock.sleep(timeoutMs, controller.signal).then((): CallResult => ({ kind: "timeout" }));
    try {
      return await Promise.race([call, timer]);
    } finally {
      controller.abort();
    }
  }

  /** Reserva de cota com teto de tempo. Exceção, valor desconhecido ou demora: negado (T39). */
  async #reserve(provider: LlmProviderId): Promise<QuotaDecision> {
    const controller = new AbortController();
    const reservation = Promise.resolve()
      .then(() => this.#ledger.reserve(provider, controller.signal))
      .then(
        (decision): QuotaDecision => (QUOTA_DECISIONS.has(decision) ? decision : "global_esgotado"),
        (): QuotaDecision => "global_esgotado",
      );
    const timer = this.#clock
      .sleep(ROUTER_POLICY.ledgerTimeoutMs, controller.signal)
      .then((): QuotaDecision => "global_esgotado");
    try {
      return await Promise.race([reservation, timer]);
    } finally {
      controller.abort();
    }
  }

  /** Melhor esforço, sem bloquear a resposta: a contabilidade não derruba uma análise que deu certo. */
  #recordUsage(provider: LlmProviderId, usage: TokenUsage): void {
    Promise.resolve()
      .then(() => this.#ledger.recordUsage(provider, usage))
      .catch(() => undefined);
  }

  #remaining(deadline: Deadline): number {
    return deadline.atMs - this.#clock.nowMs();
  }

  #jitterMs(): number {
    const { retryJitterMinMs: min, retryJitterMaxMs: max } = ROUTER_POLICY;
    const unit = Math.min(Math.max(this.#random.next(), 0), 1);
    return Number.isFinite(unit) ? min + Math.round(unit * (max - min)) : max;
  }
}

/** Exceção ou resposta fora do contrato do adapter vira erro permanente: sem retry (ADR-009 D3). */
function toCallResult(outcome: ProviderCallOutcome): CallResult {
  if (outcome.ok) return { kind: "ok", raw: outcome.raw, usage: outcome.usage };
  if (outcome.failure === "limite_de_taxa") return { kind: "limite_de_taxa", retryAfterMs: outcome.retryAfterMs };
  return { kind: outcome.failure === "erro_transitorio" ? "erro_transitorio" : "erro_permanente" };
}
