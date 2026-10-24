// CriteriaGuard (ADR-018 D6; risco residual do ADR-017 §3.2): a porta que lança, rejeita, trava, demora ou
// devolve lixo dá `unavailable` (503), nunca critérios. A entrada é conferida antes de tocar na porta, a
// resposta é reparseada pelo UserCriteriaSchema e o guarda nunca rejeita. Na escrita (ADR-021 D5 e D10, commit 2),
// critérios fora do contrato não chegam à porta, o adapter recebe o valor reparseado e só `saved: true` é sucesso.
import { USER_CRITERIA_MAX_JSON_BYTES, type UserCriteria, UserCriteriaSchema, userCriteriaJsonBytes } from "@trampo/contracts";
import { describe, expect, test } from "vitest";

import {
  CRITERIA_GUARD_POLICY,
  CriteriaGuard,
  type CriteriaReader,
  type CriteriaRepository,
  type CriteriaSubject,
  type CriteriaWriter,
} from "../../src/application/index.js";
import { REQUIRED, criteria } from "../domain/fakes/scoring-fixtures.js";
import { TEST_TOKEN } from "../auth-fakes.js";
import { FakeClock } from "./fakes/fake-clock.js";

const USER = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const SUBJECT: CriteriaSubject = { userId: USER, accessToken: TEST_TOKEN };
const UNAVAILABLE = { found: false, unavailable: true };
const SAVE_UNAVAILABLE = { saved: false, unavailable: true };

type Behavior =
  | { readonly kind: "valor"; readonly value: unknown; readonly latencyMs?: number }
  | { readonly kind: "lanca" | "rejeita" | "trava" }
  | { readonly kind: "rejeita_tarde"; readonly latencyMs: number };

function harness(behavior: Behavior, timeoutMs?: number) {
  const clock = new FakeClock();
  const calls: { subject: CriteriaSubject; signal: AbortSignal | undefined }[] = [];
  const saves: { subject: CriteriaSubject; criteria: UserCriteria; signal: AbortSignal | undefined }[] = [];
  const respond = (signal: AbortSignal | undefined): Promise<never> => {
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
  };
  const repository: CriteriaRepository = {
    load: (subject, signal) => {
      calls.push({ subject, signal });
      return respond(signal);
    },
    save: (subject, criteria, signal) => {
      saves.push({ subject, criteria, signal });
      return respond(signal);
    },
  };
  const guard = timeoutMs === undefined ? new CriteriaGuard(repository, clock) : new CriteriaGuard(repository, clock, timeoutMs);
  return { clock, calls, saves, guard };
}

// Tags e cidades de 4 bytes por code point: cada item vale pelo formato, e só o conjunto passa do teto.
const astral = (first: number, length: number): string => String.fromCodePoint(first) + String.fromCodePoint(0x1d400).repeat(length - 1);

/** Montado por fora do `criteria()`, que já passa pelo schema (e recusaria o teto). */
function oversized(): UserCriteria {
  const tags = Array.from({ length: 60 }, (_, i) => astral(0x20000 + i, 40));
  const base = criteria();
  return {
    ...base,
    stack: { ...base.stack, mustHave: tags.slice(0, 15), niceToHave: tags.slice(15, 45), dealBreakers: tags.slice(45) },
    location: { acceptedUfs: [], acceptedCities: Array.from({ length: 10 }, (_, i) => astral(0x20100 + i, 80)), importance: REQUIRED },
  };
}

function withoutNotes(): unknown {
  const { notes: _notes, ...rest } = criteria();
  return rest;
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

describe("CriteriaGuard.save: gravação dentro do contrato (ADR-021 D5)", () => {
  test("saved: true passa, na forma canônica, com o sujeito copiado", async () => {
    const { clock, guard, saves } = harness({ kind: "valor", value: { saved: true } });
    expect(await clock.run(guard.save(SUBJECT, criteria()))).toStrictEqual({ saved: true });
    expect(saves.map((s) => s.subject)).toEqual([SUBJECT]);
    expect(saves[0]?.subject).not.toBe(SUBJECT);
  });

  test("o adapter recebe o objeto reparseado, não o de quem chama", async () => {
    const location = { acceptedUfs: ["PE"], acceptedCities: ["Recife"], importance: REQUIRED } satisfies UserCriteria["location"];
    const expected = criteria({ notes: "remoto ou híbrido", location });
    // Com os espaços que o schema remove: só o valor reparseado chega à porta.
    const fromRoute: UserCriteria = {
      ...expected,
      notes: "  remoto ou híbrido  ",
      location: { ...location, acceptedCities: [" Recife "] },
    };
    const { clock, guard, saves } = harness({ kind: "valor", value: { saved: true } });
    expect(await clock.run(guard.save(SUBJECT, fromRoute))).toStrictEqual({ saved: true });
    const received = saves[0]?.criteria;
    expect(received).toStrictEqual(expected);
    expect(received).not.toBe(fromRoute);
    expect(received?.stack).not.toBe(fromRoute.stack);
  });

  test("gravação 1 ms antes do prazo ainda vale", async () => {
    const { clock, guard } = harness({ kind: "valor", value: { saved: true }, latencyMs: CRITERIA_GUARD_POLICY.timeoutMs - 1 });
    expect(await clock.run(guard.save(SUBJECT, criteria()))).toStrictEqual({ saved: true });
  });

  test("o guarda sobre uma porta que grava é um CriteriaWriter; sobre uma só de leitura, o save não compila e falha fechado (ADR-021 §5.2)", async () => {
    const writer: CriteriaWriter = harness({ kind: "trava" }).guard;
    expect(typeof writer.save).toBe("function");
    const clock = new FakeClock();
    const reader: CriteriaReader = { load: () => Promise.resolve({ found: false }) };
    const readOnly = new CriteriaGuard(reader, clock);
    // @ts-expect-error -- o save exige uma porta que também grava; furado o tipo, a porta sem save vira unavailable.
    const result: unknown = await clock.run(readOnly.save(SUBJECT, criteria()));
    expect(result).toStrictEqual(SAVE_UNAVAILABLE);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe("CriteriaGuard.save: falha fechado (unavailable, nunca rejeita)", () => {
  test.each<[string, Behavior]>([
    ["lança de forma síncrona", { kind: "lanca" }],
    ["rejeita", { kind: "rejeita" }],
    ["rejeita depois do prazo", { kind: "rejeita_tarde", latencyMs: CRITERIA_GUARD_POLICY.timeoutMs + 500 }],
  ])("porta que %s", async (_name, behavior) => {
    const { clock, guard } = harness(behavior);
    expect(await clock.run(guard.save(SUBJECT, criteria()))).toStrictEqual(SAVE_UNAVAILABLE);
  });

  test("porta travada: unavailable exatamente no prazo, com o signal abortado e nenhum timer vazando", async () => {
    const { clock, guard, saves } = harness({ kind: "trava" });
    const start = clock.nowMs();
    expect(await clock.run(guard.save(SUBJECT, criteria()))).toStrictEqual(SAVE_UNAVAILABLE);
    expect(clock.nowMs() - start).toBe(CRITERIA_GUARD_POLICY.timeoutMs);
    expect(saves[0]?.signal?.aborted).toBe(true);
    expect(clock.pendingTimers).toBe(0);
  });

  test("gravação que chega no prazo exato perde para o prazo", async () => {
    const { clock, guard } = harness({ kind: "valor", value: { saved: true }, latencyMs: CRITERIA_GUARD_POLICY.timeoutMs });
    expect(await clock.run(guard.save(SUBJECT, criteria()))).toStrictEqual(SAVE_UNAVAILABLE);
  });

  test("prazo injetado vale no lugar do padrão", async () => {
    const { clock, guard } = harness({ kind: "trava" }, 50);
    const start = clock.nowMs();
    await clock.run(guard.save(SUBJECT, criteria()));
    expect(clock.nowMs() - start).toBe(50);
  });

  test("gravação que chega primeiro aborta o timer do prazo", async () => {
    const { clock, guard } = harness({ kind: "valor", value: { saved: true } });
    await clock.run(guard.save(SUBJECT, criteria()));
    expect(clock.pendingTimers).toBe(0);
  });

  test.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["true", true],
    ["string", "ok"],
    ["array", [{ saved: true }]],
    ["objeto vazio", {}],
    ["saved como string", { saved: "true" }],
    ["saved: 1", { saved: 1 }],
    ["falha declarada", { saved: false, unavailable: true }],
    ["saved: false sem unavailable", { saved: false }],
    ["saved: true com chave a mais", { saved: true, unavailable: false }],
    ["saved: true com o dono", { saved: true, userId: USER }],
  ])("resposta fora do contrato ou falha (%s) → unavailable", async (_name, value) => {
    const { clock, guard } = harness({ kind: "valor", value });
    expect(await clock.run(guard.save(SUBJECT, criteria()))).toStrictEqual(SAVE_UNAVAILABLE);
  });
});

describe("CriteriaGuard.save: a entrada é conferida antes de tocar na porta", () => {
  test("o perfil acima do teto é recusado só pelo teto de bytes", () => {
    expect(userCriteriaJsonBytes(oversized())).toBeGreaterThan(USER_CRITERIA_MAX_JSON_BYTES);
    const parsed = UserCriteriaSchema.safeParse(oversized());
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual(["criterios_grandes_demais"]);
  });

  test.each<[string, () => unknown]>([
    ["schemaVersion 2", () => ({ ...criteria(), schemaVersion: 2 })],
    ["userId no corpo (mass assignment)", () => ({ ...criteria(), userId: USER })],
    ["user_id no corpo", () => ({ ...criteria(), user_id: USER })],
    ["chave a mais aninhada", () => ({ ...criteria(), stack: { ...criteria().stack, extra: true } })],
    ["modelo de trabalho fora do enum", () => ({ ...criteria(), workModel: { accepted: ["lua"], importance: REQUIRED } })],
    ["pretensão negativa", () => ({ ...criteria(), salary: { minimum: -1, currency: "BRL", period: "mes", importance: REQUIRED } })],
    ["nota com URL", () => ({ ...criteria(), notes: "veja https://exemplo.com" })],
    ["chave obrigatória ausente", withoutNotes],
    ["acima do teto de bytes", oversized],
    ["critérios nulos", () => null],
    ["critérios como texto JSON", () => JSON.stringify(criteria())],
  ])("critérios com %s → unavailable, sem chamar a porta", async (_name, build) => {
    const { guard, saves } = harness({ kind: "valor", value: { saved: true } });
    expect(await guard.save(SUBJECT, build() as UserCriteria)).toStrictEqual(SAVE_UNAVAILABLE);
    expect(saves).toEqual([]);
  });

  test.each<[string, unknown]>([
    ["userId que não é UUID", { userId: "u1", accessToken: TEST_TOKEN }],
    ["token sem três partes", { userId: USER, accessToken: "a.b" }],
    ["header inteiro no lugar do token", { userId: USER, accessToken: `Bearer ${TEST_TOKEN}` }],
    ["token acima do teto", { userId: USER, accessToken: `${"a".repeat(CRITERIA_GUARD_POLICY.accessTokenMaxChars - 3)}.b.c` }],
    ["campo a mais", { ...SUBJECT, role: "service_role" }],
    ["sujeito nulo", null],
  ])("sujeito com %s → unavailable, sem chamar a porta", async (_name, subject) => {
    const { guard, saves } = harness({ kind: "valor", value: { saved: true } });
    expect(await guard.save(subject as CriteriaSubject, criteria())).toStrictEqual(SAVE_UNAVAILABLE);
    expect(saves).toEqual([]);
  });

  test("token exatamente no teto passa", async () => {
    const accessToken = `${"a".repeat(CRITERIA_GUARD_POLICY.accessTokenMaxChars - 4)}.b.c`;
    const { clock, guard, saves } = harness({ kind: "valor", value: { saved: true } });
    expect(await clock.run(guard.save({ userId: USER, accessToken }, criteria()))).toStrictEqual({ saved: true });
    expect(saves).toHaveLength(1);
  });
});
