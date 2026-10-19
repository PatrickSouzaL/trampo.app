// Aleatoriedade injetada (ADR-009 D1): o jitter do retry fica determinístico nos testes.
export interface Random {
  /** Número em [0, 1). */
  next(): number;
}
