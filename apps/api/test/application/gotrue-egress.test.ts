// F1-API-07 07e (ADR-004 D8 item 5, §4.2 "Orçamento de saída" e "Bulkhead"; emenda ao ADR-014, D10): orçamento de
// saída ao GoTrue em janela deslizante exata de 300 s, particionado, com reserva da renovação, e *bulkhead* de 4, com
// uma vaga que a troca nunca ocupa (F1-API-08, achado A-03). Relógio manual: o tempo só anda quando o teste manda.
// F1-API-07 07j (ADR-004 D8 item 5, "Emenda do 07h"): teto de rajada no `/token`, um balde de 15 fichas com reposição
// de 1 a cada 4 s, somado à janela. Os testes da janela usam a rajada do tamanho do total, para a janela decidir sozinha.
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
const REFILL = GOTRUE_EGRESS_POLICY.burstRefillIntervalMs;
/** A política real com a rajada do tamanho do total da janela: só a janela e o *bulkhead* decidem. */
const WINDOW_ONLY: GotrueEgressPolicy = { ...GOTRUE_EGRESS_POLICY, burstCapacity: GOTRUE_EGRESS_POLICY.tokenTotalMax };

function egressWith(policy: GotrueEgressPolicy = WINDOW_ONLY) {
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
    expect(SUPABASE_AUTH_IP_LIMITS).toEqual({ windowMs: 300_000, tokenRefresh: 150, signIn: 30, tokenBurst: 30 });
  });

  test("a política é exatamente a do ADR-004 §6.3 (07e)", () => {
    expect(GOTRUE_EGRESS_POLICY).toEqual({
      windowMs: 300_000,
      trocaMax: 14,
      tokenTotalMax: 74,
      renovacaoReserve: 37,
      maxConcurrent: 4,
      trocaMaxConcurrent: 3,
      busyRetryAfterSeconds: 5,
      burstCapacity: 15,
      burstRefillIntervalMs: 4_000,
    });
  });

  test("07j: a rajada fica em 50% da rajada fixa do balde Token do GoTrue, e a reposição, em 50% da dele", () => {
    expect(GOTRUE_EGRESS_POLICY.burstCapacity * 2).toBeLessThanOrEqual(SUPABASE_AUTH_IP_LIMITS.tokenBurst);
    // O GoTrue repõe 150 fichas em 300 s (uma a cada 2 s); o orçamento, uma a cada 4 s (0,25 por segundo).
    const gotrueRefillIntervalMs = SUPABASE_AUTH_IP_LIMITS.windowMs / SUPABASE_AUTH_IP_LIMITS.tokenRefresh;
    expect(GOTRUE_EGRESS_POLICY.burstRefillIntervalMs).toBeGreaterThanOrEqual(2 * gotrueRefillIntervalMs);
    expect(1_000 / GOTRUE_EGRESS_POLICY.burstRefillIntervalMs).toBe(0.25);
  });

  test("a troca deixa pelo menos uma vaga do bulkhead para quem já está logado (A-03)", () => {
    expect(GOTRUE_EGRESS_POLICY.trocaMaxConcurrent).toBeLessThan(GOTRUE_EGRESS_POLICY.maxConcurrent);
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
    const { run } = egressWith({ ...WINDOW_ONLY, trocaMax: 70 });
    expect(await spendN(run, "troca", 100)).toBe(37);
    expect(await spendN(run, "renovacao", 100)).toBe(37);
  });

  test("a reserva conta só as vagas da renovação ainda não usadas", async () => {
    const { run } = egressWith({ ...WINDOW_ONLY, trocaMax: 70 });
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
        const { clock, egress } = egressWith(GOTRUE_EGRESS_POLICY);
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
    ["troca simultânea zero (a troca nunca passaria)", { trocaMaxConcurrent: 0 }],
    ["troca simultânea igual ao bulkhead (nenhuma vaga para quem está logado)", { trocaMaxConcurrent: 4 }],
    ["troca simultânea acima do bulkhead", { trocaMaxConcurrent: 5 }],
    ["troca simultânea fracionária", { trocaMaxConcurrent: 1.5 }],
    ["troca simultânea NaN", { trocaMaxConcurrent: Number.NaN }],
    ["rajada zero (nada passaria)", { burstCapacity: 0 }],
    ["rajada negativa", { burstCapacity: -1 }],
    ["rajada fracionária", { burstCapacity: 1.5 }],
    ["rajada NaN", { burstCapacity: Number.NaN }],
    ["reposição da rajada zero", { burstRefillIntervalMs: 0 }],
    ["reposição da rajada fracionária", { burstRefillIntervalMs: 0.5 }],
    ["reposição da rajada infinita", { burstRefillIntervalMs: Number.POSITIVE_INFINITY }],
  ])("%s", (_name, patch) => {
    expect(() => createGotrueEgress(new ManualClock(), { ...GOTRUE_EGRESS_POLICY, ...patch })).toThrow(EgressPolicyError);
  });

  test("o menor bulkhead com a vaga reservada é válido: 2 vagas, 1 para a troca", () => {
    expect(() => createGotrueEgress(new ManualClock(), { ...GOTRUE_EGRESS_POLICY, maxConcurrent: 2, trocaMaxConcurrent: 1 })).not.toThrow();
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

// F1-SEC-01, achado A-03 da revisão adversarial de auth; decisão da F1-API-08 (ADR-004 D8 item 5, "Emenda da
// F1-API-08"): a troca é a única chamada que um anônimo leva ao GoTrue (código de formato válido basta), e ela ocupa no
// máximo 3 das 4 vagas. A renovação (envelope que abre) e o logout (Bearer verificado) usam as 4.
describe("vaga do bulkhead que a troca nunca ocupa (A-03)", () => {
  function hanging() {
    const releases: (() => void)[] = [];
    const hang = () =>
      new Promise<string>((resolve) => {
        releases.push(() => resolve("feito"));
      });
    return { releases, hang };
  }

  test("3 trocas penduradas: a 4ª troca leva bulkhead_cheio sem rodar nem gastar orçamento, e a renovação passa", async () => {
    const { egress, run, calls } = egressWith();
    const { releases, hang } = hanging();
    const trocas = [1, 2, 3].map(() => egress.run("troca", hang));
    expect(await run("troca")).toEqual({ ok: false, reason: "bulkhead_cheio", retryAfterSeconds: 5 });
    expect(calls()).toBe(0);
    expect(await run("renovacao")).toEqual({ ok: true, value: "feito" });
    for (const release of releases) release();
    await Promise.all(trocas);
    // A troca negada não gastou orçamento: 14 − 3 penduradas = 11.
    expect(await spendN(run, "troca", 20)).toBe(11);
  });

  test("3 trocas penduradas: o logout também usa a 4ª vaga", async () => {
    const { egress, run } = egressWith();
    const { releases, hang } = hanging();
    const trocas = [1, 2, 3].map(() => egress.run("troca", hang));
    expect(await run("logout")).toEqual({ ok: true, value: "feito" });
    for (const release of releases) release();
    await Promise.all(trocas);
  });

  test("com a 4ª vaga ocupada por quem está logado, nada mais entra até uma vaga voltar", async () => {
    const { egress, run } = egressWith();
    const { releases, hang } = hanging();
    const running = [egress.run("troca", hang), egress.run("troca", hang), egress.run("troca", hang), egress.run("renovacao", hang)];
    for (const kind of ["troca", "renovacao", "logout"] as const) {
      expect(await run(kind)).toEqual({ ok: false, reason: "bulkhead_cheio", retryAfterSeconds: 5 });
    }
    // Volta a vaga da renovação: a troca continua no teto dela, e a renovação entra.
    releases[3]?.();
    await running[3];
    expect(await run("troca")).toMatchObject({ ok: false, reason: "bulkhead_cheio" });
    expect(await run("renovacao")).toEqual({ ok: true, value: "feito" });
    for (const release of releases.slice(0, 3)) release();
    await Promise.all(running);
  });

  test("4 renovações ocupam o bulkhead inteiro; a troca volta a entrar quando uma vaga volta", async () => {
    const { egress, run } = egressWith();
    const { releases, hang } = hanging();
    const running = [1, 2, 3, 4].map(() => egress.run("renovacao", hang));
    expect(await run("troca")).toMatchObject({ ok: false, reason: "bulkhead_cheio" });
    releases[0]?.();
    await running[0];
    expect(await run("troca")).toEqual({ ok: true, value: "feito" });
    for (const release of releases.slice(1)) release();
    await Promise.all(running);
  });

  test("2 trocas e 1 renovação: cabe uma 3ª troca, e só então o bulkhead enche", async () => {
    const { egress, run } = egressWith();
    const { releases, hang } = hanging();
    const running = [egress.run("troca", hang), egress.run("renovacao", hang), egress.run("troca", hang)];
    const third = egress.run("troca", hang);
    expect(await run("logout")).toMatchObject({ ok: false, reason: "bulkhead_cheio" });
    for (const release of releases) release();
    expect(await third).toEqual({ ok: true, value: "feito" });
    await Promise.all(running);
  });

  test("a vaga da troca volta quando ela termina, inclusive se rejeitar", async () => {
    const { egress, run } = egressWith();
    const { releases, hang } = hanging();
    const running = [egress.run("troca", hang), egress.run("troca", hang)];
    await expect(egress.run("troca", () => Promise.reject(new Error("falhou")))).rejects.toThrow("falhou");
    // Se a rejeição prendesse a vaga da troca, esta 3ª seria negada.
    const third = egress.run("troca", hang);
    expect(await run("troca")).toMatchObject({ ok: false, reason: "bulkhead_cheio" });
    for (const release of releases) release();
    expect(await third).toEqual({ ok: true, value: "feito" });
    await Promise.all(running);
  });

  test("com 1 vaga de troca em 2: a 2ª troca simultânea é negada, e a renovação entra", async () => {
    const { egress, run } = egressWith({ ...GOTRUE_EGRESS_POLICY, maxConcurrent: 2, trocaMaxConcurrent: 1 });
    const { releases, hang } = hanging();
    const first = egress.run("troca", hang);
    expect(await run("troca")).toMatchObject({ ok: false, reason: "bulkhead_cheio" });
    expect(await run("renovacao")).toEqual({ ok: true, value: "feito" });
    for (const release of releases) release();
    await first;
  });
});

// F1-API-07 07j (ADR-004 D8 item 5, "Emenda do 07h"): o balde `Token` do GoTrue tem rajada fixa de 30, e a janela de
// 300 s deixava passar 74 chamadas seguidas. O orçamento ganha um balde de 15 fichas, com 1 ficha a cada 4 s, somado às
// janelas: a chamada ao `/token` precisa passar nos dois, e a negada não gasta nenhum.
describe("teto de rajada no /token (07j)", () => {
  const real = () => egressWith(GOTRUE_EGRESS_POLICY);
  const BURST = GOTRUE_EGRESS_POLICY.burstCapacity;

  test("15 chamadas seguidas passam; a 16ª é negada sem rodar, com Retry-After de 4 s", async () => {
    const { run, calls } = real();
    expect(await spendN(run, "renovacao", BURST)).toBe(15);
    expect(await run("renovacao")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 4 });
    expect(calls()).toBe(15);
  });

  test("a ficha volta em exatamente 4 s: 1 ms antes ainda nega, com Retry-After de 1 s", async () => {
    const { clock, run } = real();
    expect(await spendN(run, "renovacao", 20)).toBe(15);
    clock.now += REFILL - 1;
    expect(await run("renovacao")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 1 });
    clock.now += 1;
    expect(await run("renovacao")).toEqual({ ok: true, value: "feito" });
    expect(await run("renovacao")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 4 });
  });

  test("a reposição é de 1 ficha a cada 4 s, sem perder a fração: 10 s dão 2 fichas, e a 3ª sai aos 12 s", async () => {
    const { clock, run } = real();
    expect(await spendN(run, "renovacao", BURST)).toBe(15);
    clock.now += 10_000;
    expect(await spendN(run, "renovacao", 5)).toBe(2);
    expect(await run("renovacao")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 2 });
    clock.now += 2_000;
    expect(await spendN(run, "renovacao", 5)).toBe(1);
  });

  test("o balde não acumula além de 15: depois de 1 h parado, a 16ª seguida é negada", async () => {
    const { clock, run } = real();
    expect(await spendN(run, "renovacao", 3)).toBe(3);
    clock.now += 3_600_000;
    expect(await spendN(run, "renovacao", 40)).toBe(15);
  });

  test("troca e renovação dividem o mesmo balde (as duas vão ao /token)", async () => {
    const { run } = real();
    expect(await spendN(run, "troca", 10)).toBe(10);
    expect(await spendN(run, "renovacao", 10)).toBe(5);
    expect(await run("troca")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 4 });
    expect(await run("renovacao")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 4 });
  });

  test("as 14 trocas da janela nunca esvaziam o balde: sobra uma ficha para quem já está logado", async () => {
    const { run } = real();
    expect(await spendN(run, "troca", 1_000)).toBe(14);
    expect(await run("renovacao")).toEqual({ ok: true, value: "feito" });
  });

  test("o logout não gasta ficha (o /logout do GoTrue não passa pelo balde Token)", async () => {
    const { run } = real();
    expect(await spendN(run, "logout", 100)).toBe(100);
    expect(await spendN(run, "renovacao", 20)).toBe(15);
    expect(await spendN(run, "logout", 100)).toBe(100);
  });

  test("a negada pela rajada não gasta ficha: depois de 100 negadas, 4 s devolvem exatamente 1", async () => {
    const { clock, run } = real();
    expect(await spendN(run, "renovacao", 115)).toBe(15);
    clock.now += REFILL;
    expect(await spendN(run, "renovacao", 10)).toBe(1);
  });

  test("a negada pela rajada não gasta a janela: paradas as rajadas, passam as 74 da janela, nem uma a menos", async () => {
    const { clock, run } = real();
    let passed = await spendN(run, "renovacao", 500);
    expect(passed).toBe(15);
    // Uma ficha a cada 4 s, com 5 negadas no meio de cada uma: as outras 59 saem em 236 s, dentro da janela.
    while (passed < GOTRUE_EGRESS_POLICY.tokenTotalMax) {
      clock.now += REFILL;
      expect(await spendN(run, "renovacao", 6)).toBe(1);
      passed += 1;
    }
    expect(clock.now).toBe(1_000_000 + 59 * REFILL);
    clock.now += REFILL;
    // Com a ficha de volta, quem nega agora é a janela: a 1ª chamada sai aos 300 s, e faltam 60.
    expect(await run("renovacao")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 60 });
  });

  test("a negada pela janela não gasta ficha: com a troca no teto da janela, a ficha que sobra é da renovação", async () => {
    const { run } = real();
    expect(await spendN(run, "troca", 14)).toBe(14);
    for (let i = 0; i < 50; i += 1) expect(await run("troca")).toMatchObject({ ok: false, reason: "orcamento_esgotado" });
    expect(await run("renovacao")).toEqual({ ok: true, value: "feito" });
    expect(await run("renovacao")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 4 });
  });

  test("com a janela e a rajada negando juntas, o Retry-After é o maior dos dois", async () => {
    // Janela de 10 s com 2 chamadas e balde de 1 ficha a cada 8 s: aos 9,5 s a janela libera em 0,5 s, e a ficha, em 6,5 s.
    const policy: GotrueEgressPolicy = { ...GOTRUE_EGRESS_POLICY, windowMs: 10_000, trocaMax: 2, tokenTotalMax: 2, renovacaoReserve: 0, burstCapacity: 1, burstRefillIntervalMs: 8_000 };
    const { clock, run } = egressWith(policy);
    expect(await run("renovacao")).toMatchObject({ ok: true });
    clock.now += 8_000;
    expect(await run("renovacao")).toMatchObject({ ok: true });
    clock.now += 1_500;
    expect(await run("renovacao")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 7 });
    // E o contrário: a ficha volta antes de a janela liberar.
    const slow: GotrueEgressPolicy = { ...policy, burstCapacity: 2, burstRefillIntervalMs: 1_000 };
    const other = egressWith(slow);
    expect(await spendN(other.run, "renovacao", 2)).toBe(2);
    other.clock.now += 500;
    expect(await other.run("renovacao")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 10 });
  });

  test("a rajada negada não ocupa vaga do bulkhead nem roda a chamada", async () => {
    const { egress, run, calls } = real();
    expect(await spendN(run, "renovacao", 15)).toBe(15);
    for (let i = 0; i < 10; i += 1) expect(await run("renovacao")).toMatchObject({ ok: false, reason: "orcamento_esgotado" });
    expect(calls()).toBe(15);
    // As 4 vagas seguem livres para o logout, que não gasta ficha.
    const releases: (() => void)[] = [];
    const hang = () => new Promise<string>((resolve) => void releases.push(() => resolve("feito")));
    const running = [1, 2, 3, 4].map(() => egress.run("logout", hang));
    expect(await run("logout")).toMatchObject({ ok: false, reason: "bulkhead_cheio" });
    for (const release of releases) release();
    await Promise.all(running);
  });

  test("o bulkhead cheio não gasta ficha", async () => {
    const { egress, run } = real();
    const releases: (() => void)[] = [];
    const hang = () => new Promise<string>((resolve) => void releases.push(() => resolve("feito")));
    const running = [1, 2, 3, 4].map(() => egress.run("renovacao", hang));
    for (let i = 0; i < 30; i += 1) expect(await run("renovacao")).toMatchObject({ ok: false, reason: "bulkhead_cheio" });
    for (const release of releases) release();
    await Promise.all(running);
    // 4 fichas gastas pelas que rodaram; as 30 negadas pelo bulkhead não gastaram nenhuma.
    expect(await spendN(run, "renovacao", 20)).toBe(11);
  });

  test("a chamada que rejeita gasta a ficha (o pedido saiu)", async () => {
    const { egress, run } = real();
    for (let i = 0; i < 15; i += 1) await expect(egress.run("renovacao", () => Promise.reject(new Error("falhou")))).rejects.toThrow("falhou");
    expect(await run("renovacao")).toEqual({ ok: false, reason: "orcamento_esgotado", retryAfterSeconds: 4 });
  });

  const steps = (maxGapMs: number) =>
    fc.array(fc.record({ gapMs: fc.integer({ min: 0, max: maxGapMs }), kind: fc.constantFrom<EgressCall>("troca", "renovacao", "renovacao", "logout") }), { minLength: 1, maxLength: 400 });

  test.each([
    ["rajadas (intervalos de até 1,5 s)", 1_500],
    ["tráfego espaçado (intervalos de até 30 s)", 30_000],
  ])("propriedade, %s: nenhuma rajada passa de 15, nenhum intervalo passa de 15 mais 1 a cada 4 s, e nenhuma janela de 300 s passa de 74 nem de 14 trocas", async (_caso, maxGapMs) => {
    await fc.assert(
      fc.asyncProperty(steps(maxGapMs), async (sequence) => {
        const { clock, egress } = real();
        const token: number[] = [];
        const trocas: number[] = [];
        for (const { gapMs, kind } of sequence) {
          clock.now += gapMs;
          const outcome = await egress.run(kind, async () => undefined);
          if (!outcome.ok) {
            expect(outcome.reason).toBe("orcamento_esgotado");
            expect(outcome.retryAfterSeconds).toBeGreaterThanOrEqual(1);
            expect(outcome.retryAfterSeconds).toBeLessThanOrEqual(300);
          } else if (kind !== "logout") {
            token.push(clock.now);
            if (kind === "troca") trocas.push(clock.now);
          }
        }
        // Conta sem `expect` no laço (são até 80 mil pares por sequência) e confere o pior caso de cada regra.
        let sameInstant = 0;
        let overBurst = 0;
        let inWindow = 0;
        for (let i = 0; i < token.length; i += 1) {
          const start = token[i] as number;
          let atStart = 0;
          let windowed = 0;
          for (let j = 0; j < token.length; j += 1) {
            const at = token[j] as number;
            if (at === start) atStart += 1;
            if (at > start - WINDOW && at <= start) windowed += 1;
            // De i a j (em ordem de chamada) passaram j − i + 1 chamadas em `at − start` ms.
            if (j >= i) overBurst = Math.max(overBurst, j - i + 1 - Math.floor((at - start) / REFILL));
          }
          sameInstant = Math.max(sameInstant, atStart);
          inWindow = Math.max(inWindow, windowed);
        }
        expect(sameInstant).toBeLessThanOrEqual(BURST);
        expect(overBurst).toBeLessThanOrEqual(BURST);
        expect(inWindow).toBeLessThanOrEqual(GOTRUE_EGRESS_POLICY.tokenTotalMax);
        const trocasInWindow = Math.max(0, ...trocas.map((at) => trocas.filter((other) => other > at - WINDOW && other <= at).length));
        expect(trocasInWindow).toBeLessThanOrEqual(GOTRUE_EGRESS_POLICY.trocaMax);
      }),
      { numRuns: 150 },
    );
  });

  test("propriedade: o Retry-After cumpre o que promete (depois dele, a mesma chamada passa) e não manda esperar à toa", async () => {
    await fc.assert(
      fc.asyncProperty(steps(3_000), async (sequence) => {
        const { clock, egress } = real();
        for (const { gapMs, kind } of sequence) {
          clock.now += gapMs;
          const outcome = await egress.run(kind, async () => undefined);
          if (outcome.ok) continue;
          const deniedAt = clock.now;
          // Um segundo antes do prometido, ainda nega (o Retry-After é o menor inteiro de segundos que serve).
          if (outcome.retryAfterSeconds > 1) {
            clock.now = deniedAt + (outcome.retryAfterSeconds - 1) * 1_000;
            expect((await egress.run(kind, async () => undefined)).ok).toBe(false);
          }
          clock.now = deniedAt + outcome.retryAfterSeconds * 1_000;
          expect((await egress.run(kind, async () => undefined)).ok).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  test("a rajada do tamanho do total da janela nunca morde antes dela (a política dos testes da janela)", async () => {
    const { run } = egressWith(WINDOW_ONLY);
    expect(await spendN(run, "renovacao", 100)).toBe(74);
  });
});
