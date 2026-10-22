// Relógio monotônico real (porta Clock, ADR-009 D1). Usado pelos guardas de limite (ADR-014 D1) e, no
// F1-API-04, pelo prazo da análise. `sleep` nunca rejeita e solta o timer assim que o `signal` aborta.
import type { Clock } from "../../application/ports/clock.js";

export const systemClock: Clock = {
  nowMs: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      signal?.addEventListener("abort", done, { once: true });
    }),
};
