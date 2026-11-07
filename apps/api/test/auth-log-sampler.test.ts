// F1-API-07 07g (ADR-004 D8 item 7 e §4.2 "Logs amostrados"): no máximo 1 linha por motivo a cada 60 s, por
// instância, com o contador das suprimidas. Relógio controlado: a conta exata da janela não depende de carga.
import { describe, expect, test } from "vitest";

import { AUTH_LOG_MESSAGES, AUTH_LOG_SAMPLING, createAuthLogSampler } from "../src/presentation/logging/auth-log-sampler.js";
import type { Clock } from "../src/application/ports/clock.js";
import { LOG_MESSAGES } from "../src/presentation/logging/log-policy.js";

/** Relógio que só anda quando o teste manda. */
class ManualClock implements Clock {
  #now = 10 * 60_000;
  nowMs(): number {
    return this.#now;
  }
  sleep(): Promise<void> {
    return Promise.resolve();
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}

describe("catálogo (ADR-004 D8 item 7; ADR-010 D2)", () => {
  test("as 10 mensagens do D8 item 7, todas no catálogo fechado do log", () => {
    expect(AUTH_LOG_MESSAGES).toEqual([
      "auth_troca_recusada",
      "auth_renovacao_recusada",
      "auth_envelope_invalido",
      "auth_sessao_idade_maxima",
      "auth_sessao_inativa",
      "auth_provedor_indisponivel",
      "auth_chaves_indisponiveis",
      "auth_token_fora_da_politica",
      "auth_renovacao_perdida",
      "auth_limite_local",
    ]);
    for (const message of AUTH_LOG_MESSAGES) expect(LOG_MESSAGES).toContain(message);
  });

  test("janela de 60 s fixada contra o ADR", () => {
    expect(AUTH_LOG_SAMPLING).toEqual({ windowMs: 60_000 });
  });
});

describe("amostragem", () => {
  test("1.000 recusas em 1 min geram 1 linha por motivo; a seguinte leva as 999 suprimidas", () => {
    const clock = new ManualClock();
    const sampler = createAuthLogSampler(clock);
    const emitted: { message: string; suppressed: number }[] = [];
    for (let i = 0; i < 1_000; i += 1) {
      for (const message of ["auth_troca_recusada", "auth_limite_local"] as const) {
        const decision = sampler.sample(message);
        if (decision.emit) emitted.push({ message, suppressed: decision.suppressed });
      }
      clock.advance(59);
    }
    // 1.000 × 59 ms = 59 s: tudo dentro da primeira janela.
    expect(emitted).toEqual([
      { message: "auth_troca_recusada", suppressed: 0 },
      { message: "auth_limite_local", suppressed: 0 },
    ]);
    clock.advance(1_000);
    expect(sampler.sample("auth_troca_recusada")).toEqual({ emit: true, suppressed: 999 });
    expect(sampler.sample("auth_troca_recusada")).toEqual({ emit: false });
  });

  test("o limite exato: 59.999 ms depois ainda cala; 60.000 ms depois escreve e zera o contador", () => {
    const clock = new ManualClock();
    const sampler = createAuthLogSampler(clock);
    expect(sampler.sample("auth_envelope_invalido")).toEqual({ emit: true, suppressed: 0 });
    clock.advance(59_999);
    expect(sampler.sample("auth_envelope_invalido")).toEqual({ emit: false });
    clock.advance(1);
    expect(sampler.sample("auth_envelope_invalido")).toEqual({ emit: true, suppressed: 1 });
    // A janela recomeça na escrita, e o contador volta a zero.
    clock.advance(60_000);
    expect(sampler.sample("auth_envelope_invalido")).toEqual({ emit: true, suppressed: 0 });
  });

  test("cada motivo tem a própria janela", () => {
    const clock = new ManualClock();
    const sampler = createAuthLogSampler(clock);
    expect(sampler.sample("auth_sessao_inativa").emit).toBe(true);
    clock.advance(30_000);
    expect(sampler.sample("auth_sessao_idade_maxima").emit).toBe(true);
    clock.advance(30_000);
    expect(sampler.sample("auth_sessao_inativa").emit).toBe(true);
    expect(sampler.sample("auth_sessao_idade_maxima").emit).toBe(false);
  });

  test("instâncias não dividem estado (a amostragem é por processo)", () => {
    const clock = new ManualClock();
    const first = createAuthLogSampler(clock);
    const second = createAuthLogSampler(clock);
    expect(first.sample("auth_renovacao_perdida").emit).toBe(true);
    expect(second.sample("auth_renovacao_perdida").emit).toBe(true);
  });
});
