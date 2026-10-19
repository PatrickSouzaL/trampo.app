// Extrator roteirizado: cada chamada consome o próximo passo do roteiro, com latência no relógio falso.
import type { LlmProviderId } from "@trampo/contracts";

import type {
  AttemptControl,
  Clock,
  JobFactsExtractor,
  LlmJobPayload,
  ProviderCallOutcome,
} from "../../../src/application/index.js";

export type Step =
  | { readonly kind: "ok"; readonly raw: string; readonly latencyMs?: number }
  | { readonly kind: "limite_de_taxa"; readonly retryAfterMs: number | null; readonly latencyMs?: number }
  | { readonly kind: "erro_transitorio" | "erro_permanente"; readonly latencyMs?: number }
  /** Nunca responde, nem ao abort. */
  | { readonly kind: "trava" }
  /** Lança de forma síncrona, antes de qualquer promessa. */
  | { readonly kind: "lanca" }
  | { readonly kind: "rejeita"; readonly latencyMs?: number }
  /** Resolve com algo fora do contrato do adapter. */
  | { readonly kind: "lixo"; readonly value: unknown; readonly latencyMs?: number };

export interface RecordedCall {
  readonly payload: LlmJobPayload;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly atMs: number;
}

export const USAGE = { inputTokens: 1_200, outputTokens: 300 } as const;

export class ScriptedExtractor implements JobFactsExtractor {
  readonly calls: RecordedCall[] = [];
  readonly #steps: Step[];

  constructor(
    readonly provider: LlmProviderId,
    readonly clock: Clock,
    steps: readonly Step[],
    readonly model = "openai/gpt-oss-20b",
  ) {
    this.#steps = [...steps];
  }

  call(payload: LlmJobPayload, attempt: AttemptControl): Promise<ProviderCallOutcome> {
    this.calls.push({ payload, timeoutMs: attempt.timeoutMs, signal: attempt.signal, atMs: this.clock.nowMs() });
    const step = this.#steps.shift() ?? { kind: "erro_permanente" };
    if (step.kind === "lanca") throw new Error("adapter quebrado: segredo-que-nao-pode-vazar");
    if (step.kind === "trava") return new Promise<ProviderCallOutcome>(() => undefined);
    return this.clock.sleep(step.latencyMs ?? 0, attempt.signal).then(() => respond(step));
  }
}

function respond(step: Exclude<Step, { kind: "lanca" | "trava" }>): ProviderCallOutcome {
  switch (step.kind) {
    case "ok":
      return { ok: true, raw: step.raw, usage: USAGE };
    case "limite_de_taxa":
      return { ok: false, failure: "limite_de_taxa", retryAfterMs: step.retryAfterMs };
    case "rejeita":
      throw new Error("falha de rede com corpo: segredo-que-nao-pode-vazar");
    case "lixo":
      return step.value as ProviderCallOutcome;
    default:
      return { ok: false, failure: step.kind };
  }
}
