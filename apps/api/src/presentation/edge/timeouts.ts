// Prazos do servidor HTTP (ADR-007 D4). Os padrões do Fastify são inseguros: requestTimeout 0
// sobrescreve os 300 s do Node e connectionTimeout 0 deixa o socket ocioso para sempre. Revisar
// keepAliveTimeout diante do balanceador no S-5 (ADR-003).

export interface EdgeTimeouts {
  /** Anti-slowloris: os headers precisam chegar inteiros neste prazo. */
  readonly headersTimeout: number;
  /** Recepção completa (headers + corpo de até 64 KiB). Não limita a resposta (SSE). */
  readonly requestTimeout: number;
  /** Ociosidade do socket. Acima do ANALYSIS_DEADLINE_MS (12 s) para não derrubar um SSE. */
  readonly connectionTimeout: number;
  /** Socket keep-alive ocioso entre requisições. */
  readonly keepAliveTimeout: number;
  /** De quanto em quanto tempo o Node confere os dois primeiros prazos (padrão do Node: 30 s). */
  readonly connectionsCheckingInterval: number;
}

export const EDGE_TIMEOUTS: EdgeTimeouts = Object.freeze({
  headersTimeout: 5_000,
  requestTimeout: 10_000,
  connectionTimeout: 30_000,
  keepAliveTimeout: 5_000,
  connectionsCheckingInterval: 1_000,
});
