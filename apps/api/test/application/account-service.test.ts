// AccountService (ADR-029 D3 e D4): a porta que lança, rejeita, trava, demora ou devolve lixo dá `indisponivel`,
// nunca uma exclusão confirmada nem um arquivo pela metade. A entrada é conferida antes de tocar na porta, a resposta
// é revalidada, `ja_excluida` conta como `excluida`, e a exportação só sai inteira e reparseada pelo contrato.
import { AccountExportSchema } from "@trampo/contracts/account";
import { ACCOUNT_EXPORT_MAX_ROWS } from "@trampo/contracts/limits";
import { describe, expect, test } from "vitest";

import {
  ACCOUNT_SERVICE_POLICY,
  AccountService,
  type AccountStore,
  type AccountSubject,
  type CriteriaLookup,
  type CriteriaReader,
} from "../../src/application/index.js";
import { TEST_TOKEN } from "../auth-fakes.js";
import { criteria } from "../domain/fakes/scoring-fixtures.js";
import { FakeClock } from "./fakes/fake-clock.js";

const USER = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const SUBJECT: AccountSubject = { userId: USER, accessToken: TEST_TOKEN };
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const ID = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const analysis = { id: ID, createdAt: "2026-11-15T11:00:00.000Z", decisionPath: "extracao_llm", verdict: "neutro", score: 50 } as const;
const feedback = { analysisId: ID, agreement: "concordo", reason: null, updatedAt: "2026-11-15T11:30:00.000Z" } as const;
const RECORDS = { found: true, analyses: [analysis], analysesTruncated: false, feedback: [feedback], feedbackTruncated: true } as const;
const EXPORT_UNAVAILABLE = { ok: false };

type Behavior =
  | { readonly kind: "valor"; readonly value: unknown; readonly latencyMs?: number }
  | { readonly kind: "lanca" | "rejeita" | "trava" }
  | { readonly kind: "rejeita_tarde"; readonly latencyMs: number };

interface HarnessOptions {
  readonly deletion?: Behavior;
  readonly records?: Behavior;
  readonly lookup?: CriteriaLookup | "rejeita" | "lanca";
  readonly now?: () => number;
}

function harness(options: HarnessOptions = {}) {
  const clock = new FakeClock();
  const calls: { readonly op: string; readonly subject: AccountSubject; readonly signal: AbortSignal | undefined }[] = [];
  const respond = (behavior: Behavior, signal: AbortSignal | undefined): Promise<never> => {
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
  const store: AccountStore = {
    deleteOwn: (subject, signal) => {
      calls.push({ op: "deleteOwn", subject, signal });
      return respond(options.deletion ?? { kind: "valor", value: { done: true, result: "excluida" } }, signal);
    },
    records: (subject, signal) => {
      calls.push({ op: "records", subject, signal });
      return respond(options.records ?? { kind: "valor", value: RECORDS }, signal);
    },
  };
  const lookups: AccountSubject[] = [];
  const lookup = options.lookup ?? { found: true, criteria: criteria() };
  const reader: CriteriaReader = {
    load: (subject) => {
      lookups.push(subject);
      if (lookup === "lanca") throw new Error("critérios fora do ar");
      return lookup === "rejeita" ? Promise.reject(new Error("critérios fora do ar")) : Promise.resolve(lookup);
    },
  };
  const service = new AccountService({ store, criteria: reader, clock, now: options.now ?? (() => NOW) });
  return { clock, calls, lookups, service };
}

const BAD_SUBJECTS: ReadonlyArray<readonly [string, unknown]> = [
  ["userId que não é UUID", { userId: "x", accessToken: TEST_TOKEN }],
  ["token sem as três partes", { userId: USER, accessToken: "a.b" }],
  ["token acima do teto", { userId: USER, accessToken: `a.b.${"c".repeat(ACCOUNT_SERVICE_POLICY.accessTokenMaxChars)}` }],
  ["chave a mais", { ...SUBJECT, alvo: "outro" }],
  ["sem token", { userId: USER }],
  ["nulo", null],
];

describe("política (ADR-029 D3)", () => {
  test("prazos de 2 s e o teto do token do contrato", () => {
    expect(ACCOUNT_SERVICE_POLICY).toEqual({ deleteTimeoutMs: 2_000, recordsTimeoutMs: 2_000, accessTokenMaxChars: 8_192 });
  });
});

describe("delete", () => {
  test.each([
    ["excluida", "excluida"],
    ["ja_excluida", "excluida"],
    ["login_antigo", "login_antigo"],
  ] as const)("a palavra %s do banco vira %s", async (result, outcome) => {
    const { clock, service, calls } = harness({ deletion: { kind: "valor", value: { done: true, result } } });
    expect(await clock.run(service.delete(SUBJECT))).toBe(outcome);
    expect(calls.map((call) => call.op)).toEqual(["deleteOwn"]);
    expect(calls[0]?.subject).toEqual(SUBJECT);
    // A porta recebe o valor reparseado, nunca o objeto de quem chama, e sempre um signal do próprio serviço.
    expect(calls[0]?.subject).not.toBe(SUBJECT);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test.each(BAD_SUBJECTS)("entrada inválida (%s): indisponível sem tocar na porta", async (_caso, subject) => {
    const { clock, service, calls } = harness();
    expect(await clock.run(service.delete(subject as AccountSubject))).toBe("indisponivel");
    expect(calls).toHaveLength(0);
  });

  test.each<[string, Behavior]>([
    ["a porta lança", { kind: "lanca" }],
    ["a porta rejeita", { kind: "rejeita" }],
    ["a porta trava", { kind: "trava" }],
    ["a porta rejeita depois do prazo", { kind: "rejeita_tarde", latencyMs: 5_000 }],
    ["a falha declarada", { kind: "valor", value: { done: false, unavailable: true } }],
    ["palavra fora da lista", { kind: "valor", value: { done: true, result: "ok" } }],
    ["sem o resultado", { kind: "valor", value: { done: true } }],
    ["chave a mais", { kind: "valor", value: { done: true, result: "excluida", linhas: 3 } }],
    ["done que não é booleano", { kind: "valor", value: { done: "true", result: "excluida" } }],
    ["nulo", { kind: "valor", value: null }],
    ["a palavra solta", { kind: "valor", value: "excluida" }],
  ])("%s: indisponível, uma chamada só", async (_caso, deletion) => {
    const { clock, service, calls } = harness({ deletion });
    expect(await clock.run(service.delete(SUBJECT))).toBe("indisponivel");
    expect(calls).toHaveLength(1);
  });

  test("o prazo: 1 ms antes ainda vale; no prazo, indisponível, e a porta é abortada", async () => {
    const value = { done: true, result: "excluida" };
    const early = harness({ deletion: { kind: "valor", value, latencyMs: ACCOUNT_SERVICE_POLICY.deleteTimeoutMs - 1 } });
    expect(await early.clock.run(early.service.delete(SUBJECT))).toBe("excluida");
    const late = harness({ deletion: { kind: "valor", value, latencyMs: ACCOUNT_SERVICE_POLICY.deleteTimeoutMs } });
    expect(await late.clock.run(late.service.delete(SUBJECT))).toBe("indisponivel");
    expect(late.calls[0]?.signal?.aborted).toBe(true);
  });

  test("a exclusão não lê critérios nem listas", async () => {
    const { clock, service, calls, lookups } = harness();
    await clock.run(service.delete(SUBJECT));
    expect(calls.map((call) => call.op)).toEqual(["deleteOwn"]);
    expect(lookups).toHaveLength(0);
  });
});

describe("export", () => {
  test("o documento inteiro: critérios com a pretensão, as duas listas e as marcas de corte, reparseado pelo contrato", async () => {
    const value = criteria({ salary: { minimum: 9_000, currency: "BRL", period: "mes", importance: { level: "obrigatorio" } } });
    const { clock, service, calls, lookups } = harness({ lookup: { found: true, criteria: value } });
    const outcome = await clock.run(service.export(SUBJECT));
    expect(outcome).toEqual({
      ok: true,
      document: {
        schemaVersion: 1,
        exportedAt: "2026-11-15T12:00:00.000Z",
        criteria: value,
        analyses: [analysis],
        analysesTruncated: false,
        feedback: [feedback],
        feedbackTruncated: true,
      },
    });
    expect(outcome.ok && AccountExportSchema.safeParse(outcome.document).success).toBe(true);
    expect(calls.map((call) => call.op)).toEqual(["records"]);
    expect(lookups).toEqual([SUBJECT]);
    expect(calls[0]?.subject).not.toBe(SUBJECT);
  });

  test.each([
    ["found: false", { found: false }],
    ["found: false com unavailable: false", { found: false, unavailable: false }],
  ] as const)("quem nunca salvou critérios (%s): criteria null, e o resto sai", async (_caso, lookup) => {
    const { clock, service } = harness({ lookup });
    const outcome = await clock.run(service.export(SUBJECT));
    expect(outcome.ok && outcome.document.criteria).toBeNull();
    expect(outcome.ok && outcome.document.analyses).toEqual([analysis]);
  });

  test.each(BAD_SUBJECTS)("entrada inválida (%s): nada sai, sem tocar em porta nenhuma", async (_caso, subject) => {
    const { clock, service, calls, lookups } = harness();
    expect(await clock.run(service.export(subject as AccountSubject))).toEqual(EXPORT_UNAVAILABLE);
    expect(calls).toHaveLength(0);
    expect(lookups).toHaveLength(0);
  });

  test.each<[string, NonNullable<HarnessOptions["lookup"]>]>([
    ["os critérios indisponíveis", { found: false, unavailable: true }],
    ["a porta dos critérios rejeita", "rejeita"],
    ["a porta dos critérios lança", "lanca"],
  ])("%s: nada sai (nunca um arquivo sem os critérios parecendo completo)", async (_caso, lookup) => {
    const { clock, service } = harness({ lookup });
    expect(await clock.run(service.export(SUBJECT))).toEqual(EXPORT_UNAVAILABLE);
  });

  test.each<[string, Behavior]>([
    ["as listas lançam", { kind: "lanca" }],
    ["as listas rejeitam", { kind: "rejeita" }],
    ["as listas travam", { kind: "trava" }],
    ["as listas rejeitam depois do prazo", { kind: "rejeita_tarde", latencyMs: 5_000 }],
    ["a falha declarada", { kind: "valor", value: { found: false, unavailable: true } }],
    ["linha fora do contrato", { kind: "valor", value: { ...RECORDS, analyses: [{ ...analysis, score: 101 }] } }],
    ["o dono numa linha", { kind: "valor", value: { ...RECORDS, feedback: [{ ...feedback, userId: USER }] } }],
    ["sem a marca de corte", { kind: "valor", value: { found: true, analyses: [], feedback: [], feedbackTruncated: false } }],
    ["chave a mais", { kind: "valor", value: { ...RECORDS, email: "x@exemplo.invalid" } }],
    ["lista acima do teto", { kind: "valor", value: { ...RECORDS, analyses: Array.from({ length: ACCOUNT_EXPORT_MAX_ROWS + 1 }, () => analysis) } }],
    ["nulo", { kind: "valor", value: null }],
  ])("%s: nada sai", async (_caso, records) => {
    const { clock, service } = harness({ records });
    expect(await clock.run(service.export(SUBJECT))).toEqual(EXPORT_UNAVAILABLE);
  });

  test("o prazo das listas: 1 ms antes ainda vale; no prazo, nada sai, e a porta é abortada", async () => {
    const early = harness({ records: { kind: "valor", value: RECORDS, latencyMs: ACCOUNT_SERVICE_POLICY.recordsTimeoutMs - 1 } });
    expect((await early.clock.run(early.service.export(SUBJECT))).ok).toBe(true);
    const late = harness({ records: { kind: "valor", value: RECORDS, latencyMs: ACCOUNT_SERVICE_POLICY.recordsTimeoutMs } });
    expect(await late.clock.run(late.service.export(SUBJECT))).toEqual(EXPORT_UNAVAILABLE);
    expect(late.calls[0]?.signal?.aborted).toBe(true);
  });

  test("o teto exato de 500 linhas passa", async () => {
    const full = { ...RECORDS, analyses: Array.from({ length: ACCOUNT_EXPORT_MAX_ROWS }, () => analysis), analysesTruncated: true };
    const { clock, service } = harness({ records: { kind: "valor", value: full } });
    const outcome = await clock.run(service.export(SUBJECT));
    expect(outcome.ok && outcome.document.analyses).toHaveLength(ACCOUNT_EXPORT_MAX_ROWS);
    expect(outcome.ok && outcome.document.analysesTruncated).toBe(true);
  });

  test.each([
    ["relógio inválido", () => Number.NaN],
    ["relógio que lança", () => { throw new Error("relógio"); }],
  ])("%s: nada sai", async (_caso, now) => {
    const { clock, service } = harness({ now });
    expect(await clock.run(service.export(SUBJECT))).toEqual(EXPORT_UNAVAILABLE);
  });

  test("critérios fora do contrato vindos da porta: nada sai", async () => {
    const broken = { found: true, criteria: { ...criteria(), salary: { minimum: -1 } } } as unknown as CriteriaLookup;
    const { clock, service } = harness({ lookup: broken });
    expect(await clock.run(service.export(SUBJECT))).toEqual(EXPORT_UNAVAILABLE);
  });
});
