// Corrida de uma operação de rede contra um prazo no Clock injetado (ADR-014 D1; ADR-015 D6). O vencedor
// decide: a operação, ou o `fallback` quando ela rejeita, lança ou estoura o prazo. O perdedor é abortado pelo
// signal, e uma rejeição tardia é absorvida. Nunca rejeita.
import type { Clock } from "../ports/clock.js";

export async function withDeadline<T>(
  clock: Clock,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  fallback: T,
): Promise<T> {
  const controller = new AbortController();
  const result = Promise.resolve()
    .then(() => operation(controller.signal))
    .catch(() => fallback);
  const timer = clock.sleep(timeoutMs, controller.signal).then(() => fallback);
  try {
    return await Promise.race([result, timer]);
  } finally {
    controller.abort();
  }
}
