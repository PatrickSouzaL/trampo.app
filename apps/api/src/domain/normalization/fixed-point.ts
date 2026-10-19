// Repetição até o ponto fixo com teto de passadas (ADR-001 §5.2, item 2; ADR-005 D4).

export interface StepResult<S> {
  readonly value: string;
  readonly stats: S;
}

export interface FixedPointResult<S> {
  readonly value: string;
  /** Quantas vezes o passo rodou (inclui a passada que confirmou a estabilidade). */
  readonly passes: number;
  /** true se a última passada não mudou nada: `value` é um ponto fixo do passo. */
  readonly stable: boolean;
  /** Estatísticas de cada passada, na ordem. A primeira sempre existe. */
  readonly history: readonly [S, ...S[]];
}

/**
 * Aplica `step` até a saída parar de mudar, rodando no máximo `maxPasses` vezes (mínimo 1).
 * Se não estabilizar, devolve a última saída com `stable: false`; quem chama decide o que isso significa.
 */
export function iterateToFixedPoint<S>(
  input: string,
  step: (value: string) => StepResult<S>,
  maxPasses: number,
): FixedPointResult<S> {
  const first = step(input);
  const history: [S, ...S[]] = [first.stats];
  let previous = input;
  let current = first.value;
  while (current !== previous && history.length < maxPasses) {
    const next = step(current);
    history.push(next.stats);
    previous = current;
    current = next.value;
  }
  return { value: current, passes: history.length, stable: current === previous, history };
}
