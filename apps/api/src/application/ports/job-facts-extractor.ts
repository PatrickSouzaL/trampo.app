// Porta de um provedor de LLM (ADR-001 §5.5; ADR-009 D1 e D2). O adapter só faz a chamada e devolve a
// resposta BRUTA: quem roda a guarda de saída é o router, então nenhum provedor entrega fatos sem ela.
import type { LlmProviderId } from "@trampo/contracts";

/**
 * O que vai ao LLM: só o texto da vaga já normalizado e selecionado. Não há campo para perfil,
 * critérios, userId, token ou URL (ADR-001 D2; AGENTS §1.3).
 */
export interface LlmJobPayload {
  readonly text: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AttemptControl {
  /** Aborta quando a tentativa estoura o prazo. O adapter cancela o HTTP. */
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export type ProviderCallOutcome =
  | { readonly ok: true; readonly raw: string; readonly usage: TokenUsage }
  /** HTTP 429. `retryAfterMs` vem do cabeçalho `Retry-After`, ou null se ausente ou ilegível. */
  | { readonly ok: false; readonly failure: "limite_de_taxa"; readonly retryAfterMs: number | null }
  /** `erro_transitorio`: rede ou 5xx (admite um retry). `erro_permanente`: outro 4xx (nunca retry). */
  | { readonly ok: false; readonly failure: "erro_transitorio" | "erro_permanente" };

export interface JobFactsExtractor {
  readonly provider: LlmProviderId;
  readonly model: string;
  call(payload: LlmJobPayload, attempt: AttemptControl): Promise<ProviderCallOutcome>;
}
