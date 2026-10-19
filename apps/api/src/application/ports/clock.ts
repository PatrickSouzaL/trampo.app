// Relógio monotônico injetado (ADR-009 D1). A aplicação não lê o relógio do sistema: o adapter real fica
// em infrastructure e os testes usam um relógio de eventos discretos.
export interface Clock {
  /** Milissegundos monotônicos. Só a diferença entre leituras tem significado. */
  nowMs(): number;
  /** Resolve depois de `ms`, ou assim que o `signal` abortar. Nunca rejeita. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Instante-limite da análise, no relógio do `Clock` (ADR-009 D4). */
export interface Deadline {
  readonly atMs: number;
}

export function deadlineAfter(clock: Clock, ms: number): Deadline {
  return { atMs: clock.nowMs() + ms };
}
