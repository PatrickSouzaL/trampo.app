// CriteriaGuard (ADR-018 D6; risco residual do ADR-017 §3.2): a porta que lança, rejeita, trava, demora ou
// devolve lixo dá `unavailable` (503), nunca critérios. A entrada é conferida antes de tocar na porta, a
// resposta é reparseada pelo UserCriteriaSchema e o guarda nunca rejeita.
import { describe, expect, test } from "vitest";

import {
  CRITERIA_GUARD_POLICY,
  CriteriaGuard,
  type CriteriaRepository,
  type CriteriaSubject,
} from "../../src/application/index.js";
import { criteria } from "../domain/fakes/scoring-fixtures.js";
import { TEST_TOKEN } from "../auth-fakes.js";
import { FakeClock } from "./fakes/fake-clock.js";

const USER = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const SUBJECT: CriteriaSubject = { userId: USER, accessToken: TEST_TOKEN };
const UNAVAILABLE = { found: false, unavailable: true };

type Behavior =
  | { readonly kind: "valor"; readonly value: unknown; readonly latencyMs?: number }
  | { readonly kind: "lanca" | "rejeita" | "trava" }
  | { readonly kind: "rejeita_tarde"; readonly latencyMs: number };

function harness(behavior: Behavior, timeoutMs?: number) {
  const clock = new FakeClock();
  const calls: { subject: CriteriaSubject; signal: AbortSignal | undefined }[] = [];
  const repository: CriteriaRepository = {
    load: (subject, signal) => {
      calls.push({ subject, signal });
      switch (behavior.kind) {
        case "lanca":
          throw new Error("banco fora do ar");
        case "rejeita":
          return Promise.reject(new Error("banco fora do ar"));
        case "trava":
          return new Promise<never>(() => undefined);
        case "rejeita_tarde":
          // Ignora o signal de propósito: a rejeição chega depois do prazo e precisa ser absorvida.
          return clock.sleep(behavior.latencyMs).then(() => Promise.reject(new Error("tarde")));
        default:
          return clock.sleep(behavior.latencyMs ?? 0, signal).then(() => behavior.value as never);
      }
    },
  };
  const guard = timeoutMs === undefined ? new CriteriaGuard(repository, clock) : new CriteriaGuard(repository, clock, timeoutMs);
  return { clock, calls, guard };
}

describe("CriteriaGuard: respostas dentro do contrato passam reparseadas", () => {
  test("found: true devolve os critérios reparseados (outro objeto, mesmo valor)", async () => {
    const value = { found: true, criteria: criteria() };
    const { clock, guard, calls } = harness({ kind: "valor", value });
    const result = await clock.run(guard.load(SUBJECT));
    expect(result).toEqual(value);
    expect(result.found && result.criteria).not.toBe(value.criteria);
    expect(calls.map((c) => c.subject)).toEqual([SUBJECT]);
    expect(calls[0]?.subject).not.toBe(SUBJECT);
  });

  test.each([
    ["found: false", { found: false }],
    ["found: false com unavailable: false", { found: false, unavailable: false }],
  ])("%s → não configurado, na forma canônica", async (_name, value) => {
    const { clock, guard } = harness({ kind: "valor", value });
    expect(await clock.run(guard.load(SUBJECT))).toStrictEqual({ found: false });
  });

  test("found: false com unavailable: true → unavailable", async () => {
    const { clock, guard } = harness({ kind: "valor", value: { found: false, unavailable: true } });
    expect(await clock.run(guard.load(SUBJECT))).toStrictEqual(UNAVAILABLE);
  });

  test("resposta 1 ms antes do prazo ainda vale", async () => {
    const value = { found: true, criteria: criteria() };
    const { clock, guard } = harness({ kind: "valor", value, latencyMs: CRITERIA_GUARD_POLICY.timeoutMs - 1 });
    expect(await clock.run(guard.load(SUBJECT))).toEqual(value);
  });
});

describe("CriteriaGuard: falha fechado (unavailable, nunca rejeita)", () => {
  test.each<[string, Behavior]>([
    ["lança de forma síncrona", { kind: "lanca" }],
    ["rejeita", { kind: "rejeita" }],
    ["rejeita depois do prazo", { kind: "rejeita_tarde", latencyMs: CRITERIA_GUARD_POLICY.timeoutMs + 500 }],
  ])("porta que %s", async (_name, behavior) => {
    const { clock, guard } = harness(behavior);
    expect(await clock.run(guard.load(SUBJECT))).toStrictEqual(UNAVAILABLE);
  });

  test("porta travada: unavailable exatamente no prazo, com o signal abortado e nenhum timer vazando", async () => {
    const { clock, guard, calls } = harness({ kind: "trava" });
    const start = clock.nowMs();
    expect(await clock.run(guard.load(SUBJECT))).toStrictEqual(UNAVAILABLE);
    expect(clock.nowMs() - start).toBe(CRITERIA_GUARD_POLICY.timeoutMs);
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(clock.pendingTimers).toBe(0);
  });

  test("resposta válida que chega no prazo exato perde para o prazo", async () => {
    const value = { found: true, criteria: criteria() };
    const { clock, guard } = harness({ kind: "valor", value, latencyMs: CRITERIA_GUARD_POLICY.timeoutMs });
    expect(await clock.run(guard.load(SUBJECT))).toStrictEqual(UNAVAILABLE);
  });

  test("prazo injetado vale no lugar do padrão", async () => {
    const { clock, guard } = harness({ kind: "trava" }, 50);
    const start = clock.nowMs();
    await clock.run(guard.load(SUBJECT));
    expect(clock.nowMs() - start).toBe(50);
  });

  test("resposta que chega primeiro aborta o timer do prazo", async () => {
    const { clock, guard } = harness({ kind: "valor", value: { found: false } });
    await clock.run(guard.load(SUBJECT));
    expect(clock.pendingTimers).toBe(0);
  });

  test.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["string", "ok"],
    ["array", []],
    ["found sem critérios", { found: true }],
    ["found como string", { found: "true", criteria: criteria() }],
    ["critérios fora do schema", { found: true, criteria: { ...criteria(), schemaVersion: 2 } }],
    ["critérios com campo a mais (mass assignment)", { found: true, criteria: { ...criteria(), userId: USER } }],
    ["chave a mais na resposta", { found: true, criteria: criteria(), userId: USER }],
    ["unavailable como string", { found: false, unavailable: "true" }],
    ["found: false com chave a mais", { found: false, userId: USER }],
    ["found: true com unavailable", { found: true, criteria: criteria(), unavailable: true }],
  ])("resposta fora do contrato (%s) → unavailable", async (_name, value) => {
    const { clock, guard } = harness({ kind: "valor", value });
    expect(await clock.run(guard.load(SUBJECT))).toStrictEqual(UNAVAILABLE);
  });

  test("a pretensão fora do schema derruba os critérios inteiros (sem relatório com salário inválido)", async () => {
    const bad = { ...criteria(), salary: { minimum: -1, currency: "BRL", period: "mensal", importance: { level: "obrigatorio" } } };
    const { clock, guard } = harness({ kind: "valor", value: { found: true, criteria: bad } });
    expect(await clock.run(guard.load(SUBJECT))).toStrictEqual(UNAVAILABLE);
  });
});

describe("CriteriaGuard: a entrada é conferida antes de tocar na porta", () => {
  test.each<[string, unknown]>([
    ["userId que não é UUID", { userId: "u1", accessToken: TEST_TOKEN }],
    ["token vazio", { userId: USER, accessToken: "" }],
    ["token sem três partes", { userId: USER, accessToken: "a.b" }],
    ["token com espaço", { userId: USER, accessToken: "a.b .c" }],
    ["header inteiro no lugar do token", { userId: USER, accessToken: `Bearer ${TEST_TOKEN}` }],
    ["lixo antes do token", { userId: USER, accessToken: `x;${TEST_TOKEN}` }],
    ["token com caractere fora do base64url", { userId: USER, accessToken: "a.b.c=" }],
    ["token acima do teto", { userId: USER, accessToken: `${"a".repeat(CRITERIA_GUARD_POLICY.accessTokenMaxChars - 3)}.b.c` }],
    ["campo a mais", { ...SUBJECT, role: "service_role" }],
    ["sujeito nulo", null],
  ])("%s → unavailable, sem chamar a porta", async (_name, subject) => {
    const { guard, calls } = harness({ kind: "valor", value: { found: false } });
    expect(await guard.load(subject as CriteriaSubject)).toStrictEqual(UNAVAILABLE);
    expect(calls).toEqual([]);
  });

  test("token exatamente no teto passa", async () => {
    const accessToken = `${"a".repeat(CRITERIA_GUARD_POLICY.accessTokenMaxChars - 4)}.b.c`;
    const { clock, guard, calls } = harness({ kind: "valor", value: { found: false } });
    expect(await clock.run(guard.load({ userId: USER, accessToken }))).toStrictEqual({ found: false });
    expect(calls).toHaveLength(1);
  });

  test("política fixada contra o ADR-018 D6", () => {
    expect(CRITERIA_GUARD_POLICY).toEqual({ timeoutMs: 1_000, accessTokenMaxChars: 8_192 });
  });
});
