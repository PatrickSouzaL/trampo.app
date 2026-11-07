// F1-API-07 07e (ADR-004 D8 item 5, §4.2 "Orçamento de saída" e "Bulkhead"; emenda ao ADR-014, D10): orçamento de
// saída ao GoTrue em janela deslizante exata de 300 s, particionado, com reserva da renovação, e *bulkhead* de 4.
// Relógio manual: o tempo só anda quando o teste manda.
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import {
  EgressPolicyError,
  GOTRUE_EGRESS_POLICY,
  SUPABASE_AUTH_IP_LIMITS,
  createGotrueEgress,
  type EgressCall,
  type GotrueEgressPolicy,
} from "../../src/application/auth/gotrue-egress.js";
import type { Clock } from "../../src/application/ports/clock.js";

class ManualClock implements Clock {
  constructor(public now = 1_000_000) {}
  nowMs(): number {
    return this.now;
  }
  sleep(): Promise<void> {
    return Promise.resolve();
  }
}

const WINDOW = GOTRUE_EGRESS_POLICY.windowMs;

function egressWith(policy?: GotrueEgressPolicy) {
  const clock = new ManualClock();
  const egress = createGotrueEgress(clock, policy);
  let calls = 0;
  const run = (kind: EgressCall) =>
    egress.run(kind, async () => {
      calls += 1;
      return "feito";
    });
  return { clock, egress, run, calls: () => calls };
}

async function spendN(run: (kind: EgressCall) => Promise<{ ok: boolean }>, kind: EgressCall, n: number): Promise<number> {
  let passed = 0;
  for (let i = 0; i < n; i += 1) if ((await run(kind)).ok) passed += 1;
  return passed;
}

describe("tetos do P19 (HITL-036) presos por teste", () => {
  test("os limites do Supabase Auth por IP são os anotados: 150 no token e 30 no sign-in por 5 min", () => {
    expect(SUPABASE_AUTH_IP_LIMITS).toEqual({ windowMs: 300_000, tokenRefresh: 150, signIn: 30 });
  });

  test("a política é exatamente a do ADR-004 §6.3 (07e)", () => {
    expect(GOTRUE_EGRESS_POLICY).toEqual({
      windowMs: 300_000,
      trocaMax: 14,
      tokenTotalMax: 74,
      renovacaoReserve: 37,
      maxConcurrent: 4,
      busyRetryAfterSeconds: 5,
    });
  });

  test("cada teto fica abaixo de 50% do limite real, na mesma janela", () => {
    expect(GOTRUE_EGRESS_POLICY.windowMs).toBe(SUPABASE_AUTH_IP_LIMITS.windowMs);
    // O pkce conta, no pior caso, no balde de sign-in e no de token (D8 item 5).
    expect(GOTRUE_EGRESS_POLICY.trocaMax * 2).toBeLessThan(SUPABASE_AUTH_IP_LIMITS.signIn);
    expect(GOTRUE_EGRESS_POLICY.tokenTotalMax * 2).toBeLessThan(SUPABASE_AUTH_IP_LIMITS.tokenRefresh);
  });

  test("a reserva da renovação é de pelo menos 50% do total, e a renovação fica com o resto da troca", () => {
    expect(GOTRUE_EGRESS_POLICY.renovacaoReserve * 2).toBeGreaterThanOrEqual(GOTRUE_EGRESS_POLICY.tokenTotalMax);
    expect(GOTRUE_EGRESS_POLICY.tokenTotalMax - GOTRUE_EGRESS_POLICY.trocaMax).toBeGreaterThanOrEqual(
      GOTRUE_EGRESS_POLICY.renovacaoReserve,
    );
  });
});

describe("orçamento por partição", () => {
  test("a 15ª troca na janela é negada, sem rodar a chamada e com Retry-After até a 1ª sair", async () => {
    const { clock, run, calls } = egressWith();
    for (let i = 0; i < 14; i += 1) {
      expect(await run("troca")).toEqual({ ok: true, value: "feito" });
      clock.now += 1_000;
    }
    // A 1ª troca foi em 1.000.000 e sai da janela em 1.300.000; agora = 1.014.000.
    expect(await run("troca")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 286 });
    expect(calls()).toBe(14);
  });

  test("uma inundação de trocas não impede a renovação: ela segue até o total de 74", async () => {
    const { run, calls } = egressWith();
    expect(await spendN(run, "troca", 1_000)).toBe(14);
    expect(await spendN(run, "renovacao", 100)).toBe(60);
    expect(calls()).toBe(74);
    expect(await run("renovacao")).toMatchObject({ ok: false, reason: "orcamento_esgotado" });
  });

  test("a renovação sozinha usa o total inteiro, e depois a troca também é negada", async () => {
    const { run } = egressWith();
    expect(await spendN(run, "renovacao", 100)).toBe(74);
    expect(await run("troca")).toMatchObject({ ok: false, reason: "orcamento_esgotado" });
  });

  test("com a renovação acima da reserva, a troca só usa o que sobra do total", async () => {
    const { run } = egressWith();
    expect(await spendN(run, "renovacao", 65)).toBe(65);
    expect(await spendN(run, "troca", 100)).toBe(9);
  });

  test("a reserva vale por si: com troca larga, a troca para quando só restam as vagas reservadas", async () => {
    // Dirigido "reserva da renovação ignorada": com a troca em 14 a reserva nunca morde, então a prova usa uma
    // política em que ela é o único freio.
    const { run } = egressWith({ ...GOTRUE_EGRESS_POLICY, trocaMax: 70 });
    expect(await spendN(run, "troca", 100)).toBe(37);
    expect(await spendN(run, "renovacao", 100)).toBe(37);
  });

  test("a reserva conta só as vagas da renovação ainda não usadas", async () => {
    const { run } = egressWith({ ...GOTRUE_EGRESS_POLICY, trocaMax: 70 });
    expect(await spendN(run, "renovacao", 10)).toBe(10);
    // 74 − max(10, 37) = 37 trocas: as 10 renovações já saíram da reserva.
    expect(await spendN(run, "troca", 100)).toBe(37);
    expect(await spendN(run, "renovacao", 100)).toBe(27);
  });

  test("o logout não gasta o orçamento do /token", async () => {
    const { run } = egressWith();
    expect(await spendN(run, "logout", 200)).toBe(200);
    expect(await spendN(run, "troca", 100)).toBe(14);
  });
});

describe("janela deslizante de 300 s (exata)", () => {
  test("a virada da janela fixa não devolve o orçamento: só a saída de cada chamada devolve", async () => {
    // Dirigido "janela fixa no lugar da deslizante": as 14 trocas ficam no fim de uma janela de 300 s alinhada.
    const { clock, run } = egressWith();
    clock.now = 2 * WINDOW - 1_000;
    expect(await spendN(run, "troca", 14)).toBe(14);
    clock.now = 2 * WINDOW + 1_000;
    expect(await run("troca")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 298 });
    clock.now = 3 * WINDOW - 1_001;
    expect(await run("troca")).toMatchObject({ ok: false });
    clock.now = 3 * WINDOW - 1_000;
    expect(await spendN(run, "troca", 15)).toBe(14);
  });

  test("a chamada de exatamente 300 s atrás já saiu; a de 300 s − 1 ms ainda conta", async () => {
    const { clock, run } = egressWith();
    expect(await spendN(run, "troca", 14)).toBe(14);
    clock.now += WINDOW - 1;
    expect(await run("troca")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 1 });
    clock.now += 1;
    expect(await spendN(run, "troca", 15)).toBe(14);
  });

  test("o Retry-After aponta a 1ª chamada que libera a partição, não só a mais antiga", async () => {
    const { clock, run } = egressWith();
    // A mais antiga é uma renovação: sair da janela não libera a troca, que está no teto de 14.
    expect(await run("renovacao")).toMatchObject({ ok: true });
    clock.now += 10_000;
    expect(await spendN(run, "troca", 14)).toBe(14);
    clock.now += 5_000;
    // A 1ª troca saiu em +10 s e sai da janela em +310 s; agora = +15 s.
    expect(await run("troca")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 295 });
  });

  test("o Retry-After nunca é menor que 1 nem maior que a janela", async () => {
    const { clock, run } = egressWith();
    expect(await spendN(run, "renovacao", 74)).toBe(74);
    expect(await run("renovacao")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 300 });
    clock.now += WINDOW - 400;
    expect(await run("renovacao")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 1 });
  });

  test("propriedade: em toda janela de 300 s passam no máximo 14 trocas e 74 chamadas ao /token", async () => {
    const step = fc.record({ gapMs: fc.integer({ min: 0, max: 30_000 }), kind: fc.constantFrom<EgressCall>("troca", "renovacao", "logout") });
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 400 }), async (steps) => {
        const { clock, egress } = egressWith();
        const passed: { atMs: number; kind: EgressCall }[] = [];
        for (const { gapMs, kind } of steps) {
          clock.now += gapMs;
          const outcome = await egress.run(kind, async () => undefined);
          if (outcome.ok) passed.push({ atMs: clock.now, kind });
          else expect(outcome.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        }
        for (const { atMs } of passed) {
          const inWindow = passed.filter((p) => p.atMs > atMs - WINDOW && p.atMs <= atMs);
          expect(inWindow.filter((p) => p.kind === "troca").length).toBeLessThanOrEqual(14);
          expect(inWindow.filter((p) => p.kind !== "logout").length).toBeLessThanOrEqual(74);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("bulkhead de 4 chamadas simultâneas", () => {
  function pending() {
    const releases: (() => void)[] = [];
    const call = () =>
      new Promise<string>((resolve) => {
        releases.push(() => resolve("feito"));
      });
    return { releases, call };
  }

  test("a 5ª chamada simultânea é negada com retryAfterSeconds 5, sem rodar e sem gastar orçamento", async () => {
    const { egress } = egressWith();
    const { releases, call } = pending();
    const running = [egress.run("renovacao", call), egress.run("troca", call), egress.run("logout", call), egress.run("renovacao", call)];
    let fifthRan = false;
    const fifth = await egress.run("troca", async () => {
      fifthRan = true;
      return "feito";
    });
    expect(fifth).toEqual({ ok: false, reason: "bulkhead_cheio", retryAfterSeconds: 5 });
    expect(fifthRan).toBe(false);
    expect(await egress.run("logout", async () => "feito")).toMatchObject({ ok: false, reason: "bulkhead_cheio" });
    for (const release of releases) release();
    expect(await Promise.all(running)).toEqual(Array(4).fill({ ok: true, value: "feito" }));
    // As negadas do bulkhead não gastaram vaga: restam 14 − 1 = 13 trocas.
    let trocas = 0;
    for (let i = 0; i < 20; i += 1) if ((await egress.run("troca", async () => "feito")).ok) trocas += 1;
    expect(trocas).toBe(13);
  });

  test("a vaga volta quando a chamada termina, inclusive se ela rejeitar", async () => {
    const { egress } = egressWith();
    const { releases, call } = pending();
    const running = [egress.run("logout", call), egress.run("logout", call), egress.run("logout", call)];
    await expect(egress.run("logout", () => Promise.reject(new Error("falhou")))).rejects.toThrow("falhou");
    const fourth = egress.run("logout", call);
    expect(await egress.run("logout", async () => "feito")).toMatchObject({ ok: false, reason: "bulkhead_cheio" });
    releases[0]?.();
    await running[0];
    expect(await egress.run("logout", async () => "feito")).toEqual({ ok: true, value: "feito" });
    for (const release of releases.slice(1)) release();
    // Se a rejeição prendesse a vaga, a 4ª teria sido negada de cara.
    expect(await fourth).toEqual({ ok: true, value: "feito" });
    await Promise.all(running);
  });

  test("o orçamento esgotado nega sem ocupar vaga do bulkhead", async () => {
    const { egress, run } = egressWith();
    expect(await spendN(run, "troca", 14)).toBe(14);
    const { releases, call } = pending();
    for (let i = 0; i < 10; i += 1) expect(await egress.run("troca", call)).toMatchObject({ ok: false, reason: "orcamento_esgotado" });
    const running = [1, 2, 3, 4].map(() => egress.run("renovacao", call));
    expect(await egress.run("renovacao", call)).toMatchObject({ ok: false, reason: "bulkhead_cheio" });
    for (const release of releases) release();
    await Promise.all(running);
  });
});

describe("política inválida derruba a criação", () => {
  test.each<[string, Partial<GotrueEgressPolicy>]>([
    ["janela zero", { windowMs: 0 }],
    ["janela fracionária", { windowMs: 1.5 }],
    ["troca zero", { trocaMax: 0 }],
    ["total zero", { tokenTotalMax: 0, renovacaoReserve: 0 }],
    ["reserva igual ao total (a troca nunca passaria)", { renovacaoReserve: 74 }],
    ["reserva negativa", { renovacaoReserve: -1 }],
    ["reserva fracionária", { renovacaoReserve: 1.5 }],
    ["bulkhead zero", { maxConcurrent: 0 }],
    ["Retry-After do bulkhead zero", { busyRetryAfterSeconds: 0 }],
    ["total NaN", { tokenTotalMax: Number.NaN }],
  ])("%s", (_name, patch) => {
    expect(() => createGotrueEgress(new ManualClock(), { ...GOTRUE_EGRESS_POLICY, ...patch })).toThrow(EgressPolicyError);
  });

  test("reserva zero é válida (a renovação só não tem vaga própria)", () => {
    expect(() => createGotrueEgress(new ManualClock(), { ...GOTRUE_EGRESS_POLICY, renovacaoReserve: 0 })).not.toThrow();
  });

  test("a mensagem não repete valor", () => {
    expect(() => createGotrueEgress(new ManualClock(), { ...GOTRUE_EGRESS_POLICY, trocaMax: 987_654 + 0.5 })).toThrow(
      /^política do orçamento de saída do GoTrue inválida$/,
    );
  });
});
