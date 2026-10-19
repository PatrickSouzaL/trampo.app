// Relógio de eventos discretos (ADR-009 §4). O tempo só anda quando todo o trabalho pendente parou: o
// `run` drena as microtarefas e então dispara o próximo timer. Determinístico e sem espera real.
import { setImmediate } from "node:timers/promises";

import type { Clock } from "../../../src/application/index.js";

interface Timer {
  readonly atMs: number;
  readonly seq: number;
  readonly fire: () => void;
}

export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers = new Set<Timer>();

  constructor(startMs = 1_000_000) {
    this.#now = startMs;
  }

  nowMs(): number {
    return this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const timer: Timer = {
        atMs: this.#now + Math.max(0, ms),
        seq: this.#seq++,
        fire: () => {
          this.#timers.delete(timer);
          resolve();
        },
      };
      this.#timers.add(timer);
      signal?.addEventListener("abort", timer.fire, { once: true });
    });
  }

  /** Timers ainda pendentes (para provar que nada vaza). */
  get pendingTimers(): number {
    return this.#timers.size;
  }

  /** Roda `promise` até resolver, avançando o tempo de timer em timer. Falha em impasse. */
  async run<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    const tracked = promise.finally(() => {
      settled = true;
    });
    for (let steps = 0; steps < 10_000; steps += 1) {
      await setImmediate();
      if (settled) return tracked;
      const next = [...this.#timers].sort((a, b) => a.atMs - b.atMs || a.seq - b.seq)[0];
      if (next === undefined) throw new Error("impasse: a promessa não resolve e não há timer pendente");
      this.#now = next.atMs;
      next.fire();
    }
    throw new Error("passos demais no relógio falso");
  }
}
