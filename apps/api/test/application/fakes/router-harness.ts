// Monta o router com fakes: relógio de eventos discretos, extratores roteirizados e ledger em memória.
import type { LlmProviderId } from "@trampo/contracts";

import {
  type ExtractionOutcome,
  InMemoryProviderStateStore,
  type LlmJobPayload,
  LlmProviderRouter,
  type ProviderStateStore,
  ROUTER_POLICY,
  deadlineAfter,
} from "../../../src/application/index.js";
import { FakeClock } from "./fake-clock.js";
import { FakeQuotaLedger, type LedgerBehavior } from "./fake-quota-ledger.js";
import { ScriptedExtractor, type Step } from "./scripted-extractor.js";

export const PAYLOAD: LlmJobPayload = Object.freeze({ text: "Desenvolvedor Backend Pleno. Requisitos: Node.js." });

export const VALID_FACTS = {
  title: "Desenvolvedor Backend Pleno",
  seniorityLevels: ["pleno"],
  yearsExperienceMin: 3,
  workModels: ["remoto"],
  location: { city: "São Paulo", stateUf: "SP", countryIso2: "BR" },
  salary: { min: 8000, max: 12000, currency: "BRL", period: "mes" },
  contractTypes: ["clt"],
  stackRequired: ["TypeScript", "Node.js"],
  stackNiceToHave: ["Kubernetes"],
  benefits: ["plano_saude"],
  languageRequirements: [],
  redFlagSignals: [],
  extractionConfidence: 0.9,
} as const;

export const VALID_RAW = JSON.stringify(VALID_FACTS);

export interface HarnessOptions {
  readonly chain?: readonly LlmProviderId[];
  readonly scripts?: Partial<Record<LlmProviderId, readonly Step[]>>;
  readonly ledger?: (provider: LlmProviderId, nth: number) => LedgerBehavior;
  readonly random?: () => number;
  readonly states?: ProviderStateStore;
  readonly clock?: FakeClock;
}

export class Harness {
  readonly clock: FakeClock;
  readonly ledger: FakeQuotaLedger;
  readonly states: ProviderStateStore;
  readonly extractors: ReadonlyMap<LlmProviderId, ScriptedExtractor>;
  readonly router: LlmProviderRouter;

  constructor(options: HarnessOptions = {}) {
    const chain = options.chain ?? ["groq", "cloudflare_workers_ai"];
    this.clock = options.clock ?? new FakeClock();
    this.ledger = new FakeQuotaLedger(this.clock, options.ledger);
    this.states = options.states ?? new InMemoryProviderStateStore();
    this.extractors = new Map(
      chain.map((provider) => [provider, new ScriptedExtractor(provider, this.clock, options.scripts?.[provider] ?? [])]),
    );
    const random = options.random ?? (() => 0.5);
    this.router = new LlmProviderRouter({
      chain,
      extractors: [...this.extractors.values()],
      clock: this.clock,
      random: { next: random },
      ledger: this.ledger,
      states: this.states,
    });
  }

  extractor(provider: LlmProviderId): ScriptedExtractor {
    const extractor = this.extractors.get(provider);
    if (extractor === undefined) throw new Error(`sem extrator para ${provider}`);
    return extractor;
  }

  get totalCalls(): number {
    return [...this.extractors.values()].reduce((sum, extractor) => sum + extractor.calls.length, 0);
  }

  /** Uma análise com o prazo global a partir de agora (ou `remainingMs`). Devolve o resultado e a duração. */
  async analyze(
    remainingMs: number = ROUTER_POLICY.analysisDeadlineMs,
  ): Promise<{ outcome: ExtractionOutcome; elapsedMs: number; deadlineAtMs: number }> {
    const startedAt = this.clock.nowMs();
    const deadline = deadlineAfter(this.clock, remainingMs);
    const outcome = await this.clock.run(this.router.extract(PAYLOAD, deadline));
    return { outcome, elapsedMs: this.clock.nowMs() - startedAt, deadlineAtMs: deadline.atMs };
  }
}
