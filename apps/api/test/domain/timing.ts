// SR-09 mede o custo do algoritmo, não o agendador do sistema operacional. Uma execução de
// aquecimento (JIT) e depois o melhor de 3 execuções: isso
// ignora uma pausa passageira de CPU (turbo rodando build e lint em paralelo, cobertura ligada),
// mas um custo superlinear real (ReDoS, quadrático em 64 KiB) estoura o orçamento nas três.
export function bestOfThree<T>(run: () => T): { result: T; elapsedMs: number } {
  let best = Number.POSITIVE_INFINITY;
  let result = run();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    result = run();
    best = Math.min(best, performance.now() - started);
  }
  return { result, elapsedMs: best };
}
