// Rate limit por usuário e por IP (ADR-001 §5.1; ADR-014 D1 e D4). A aplicação só conhece esta porta: o
// adapter em Redis fica em infrastructure/limits e o hook que lê o principal e o IP fica na presentation.

/** Classe de limite que a rota declara. Rota sem classe usa `padrao`; valor desconhecido usa a mais estrita. */
export type RateLimitClass = "padrao" | "analise";

export interface RateLimitSubject {
  /** `sub` do token já verificado (UUID). Só entra no Redis dentro de um HMAC (SR-17). */
  readonly userId: string;
  /** Balde do endereço do cliente (IPv4, prefixo /64 do IPv6 ou balde único de inválidos). Também só via HMAC. */
  readonly clientAddress: string;
}

/**
 * - `limite_excedido`: usuário ou IP acima do limite da janela → 429 com `Retry-After`.
 * - `indisponivel`: Redis com erro, lento ou fora do contrato → 503. Nunca libera (SR-06, T39).
 */
export type RateLimitDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "limite_excedido"; readonly retryAfterSeconds: number }
  | { readonly ok: false; readonly reason: "indisponivel" };

export interface RateLimiter {
  /** Conta a requisição e decide. Nunca deveria rejeitar; o guarda trata a rejeição como `indisponivel`. */
  check(rateClass: RateLimitClass, subject: RateLimitSubject, signal: AbortSignal): Promise<RateLimitDecision>;
}
