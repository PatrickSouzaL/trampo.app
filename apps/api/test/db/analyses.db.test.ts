// F1-API-06 contra o Supabase local do runner (ADR-031 D2 e D3; condições 2 e 4 a 9 do §3; T38 e T55). Roda só
// no job db do CI, pelo `pnpm --filter @trampo/api test:db`. A migration entra pelo próprio `supabase start`. Prova,
// pelo PostgREST e pelo Postgres reais: o banco força o relógio das duas tabelas, o teto de análises por usuário em
// 24 horas é exato (também sob concorrência), a retenção apaga na borda exata de 90 dias com o limite por execução
// e o *cascade* do feedback, só o `postgres` executa a retenção, o job está agendado, e o feedback de um usuário
// nunca toca a análise de outro. Os testes de cada describe dependem da ordem (o arquivo roda em série).
import { randomUUID } from "node:crypto";

import { ANALYSES_DAILY_ROW_CAP, ANALYSES_RETENTION_DAYS } from "@trampo/contracts/limits";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

import {
  AGE_ANALYSIS_SQL,
  AGE_NEWEST_SQL,
  ANALYSES_ACL_SQL,
  ANALYSES_DEFINITIONS_SQL,
  ANALYSES_FUNCTIONS_SQL,
  ANALYSES_TRIGGERS_SQL,
  DELETE_ANALYSES_SQL,
  EXPECTED_ANALYSES_ACL,
  EXPECTED_ANALYSES_FUNCTIONS,
  FEEDBACK_ROW_SQL,
  PLANT_ANALYSES_SQL,
  PURGE_SQL,
  RETENTION_JOB_SQL,
  ROW_CLOCK_SQL,
  SURVIVORS_SQL,
} from "./support/analyses-sql.js";
import { sqlStateAsRoleSql } from "./support/catalog-sql.js";
import { parseLocalStackEnv, type LocalStack } from "./support/local-stack-env.js";
import { PostgrestErrorSchema, psqlJson, rest, signUp, upsert, type RestResponse, type StackUser } from "./support/local-stack.js";

const stack: LocalStack = parseLocalStackEnv(process.env);
const FEEDBACK_UPSERT = "analysis_feedback?on_conflict=analysis_id";

const analysisRow = (owner: StackUser, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  user_id: owner.userId,
  decision_path: "extracao_llm",
  verdict: "neutro",
  score: 50,
  ...extra,
});
const insertAnalysis = (owner: StackUser, row: Record<string, unknown> = analysisRow(owner)): Promise<RestResponse> =>
  rest(stack, "POST", "analyses", owner, row);
const plant = (owner: StackUser, n: number): unknown => psqlJson(stack, PLANT_ANALYSES_SQL, { uid: owner.userId, n: String(n) });
const ageAnalysis = (id: string, idade: string): void => {
  expect(psqlJson(stack, AGE_ANALYSIS_SQL, { id, idade })).toEqual({ linhas: 1 });
};
const survivors = (ids: readonly string[]): unknown => psqlJson(stack, SURVIVORS_SQL, { ids: ids.join(",") });

function expectPgError(response: RestResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  expect(PostgrestErrorSchema.parse(response.body).code).toBe(code);
}

describe("catálogo: as funções, os gatilhos, a ACL e o job (condições 7 e 8)", () => {
  test("três funções invoker, volatile, com search_path vazio e dono postgres", () => {
    expect(psqlJson(stack, ANALYSES_FUNCTIONS_SQL)).toEqual(EXPECTED_ANALYSES_FUNCTIONS);
  });

  test("um gatilho BEFORE por linha no insert das análises e no insert e update do feedback", () => {
    const triggers = z
      .array(z.object({ table: z.string(), name: z.string(), event: z.string(), timing: z.string(), orientation: z.string(), statement: z.string() }))
      .parse(psqlJson(stack, ANALYSES_TRIGGERS_SQL));
    expect(triggers.map(({ statement: _statement, ...rest }) => rest)).toEqual([
      { table: "analyses", name: "analyses_before_insert", event: "INSERT", timing: "BEFORE", orientation: "ROW" },
      { table: "analysis_feedback", name: "analysis_feedback_touch", event: "INSERT", timing: "BEFORE", orientation: "ROW" },
      { table: "analysis_feedback", name: "analysis_feedback_touch", event: "UPDATE", timing: "BEFORE", orientation: "ROW" },
    ]);
    expect(triggers[0]?.statement).toMatch(/^EXECUTE FUNCTION (public\.)?analyses_before_insert\(\)$/);
    expect(triggers[1]?.statement).toMatch(/^EXECUTE FUNCTION (public\.)?analysis_feedback_touch\(\)$/);
  });

  test("ninguém além do dono executa as funções; a retenção, nem o service_role", () => {
    expect(psqlJson(stack, ANALYSES_ACL_SQL)).toEqual(EXPECTED_ANALYSES_ACL);
    for (const papel of ["anon", "authenticated", "service_role"]) {
      expect(psqlJson(stack, sqlStateAsRoleSql("select public.purge_expired_analyses(1);"), { papel })).toEqual({ sqlstate: "42501", papel });
    }
  });

  test("as constantes da migration são as do contrato", () => {
    const definitions = z.object({ cap: z.string(), purge: z.string() }).parse(psqlJson(stack, ANALYSES_DEFINITIONS_SQL));
    expect(ANALYSES_DAILY_ROW_CAP).toBe(100);
    expect(ANALYSES_RETENTION_DAYS).toBe(90);
    expect(definitions.cap).toContain(`v_cap constant integer := ${String(ANALYSES_DAILY_ROW_CAP)};`);
    expect(definitions.purge).toContain(`make_interval(days => ${String(ANALYSES_RETENTION_DAYS)})`);
  });

  test("o job da retenção: de hora em hora, como postgres, com o limite de 5.000", () => {
    expect(psqlJson(stack, RETENTION_JOB_SQL)).toEqual([
      { schedule: "17 * * * *", command: "select public.purge_expired_analyses(5000)", active: true, username: "postgres" },
    ]);
  });
});

describe("o relógio é do banco (condição 4)", () => {
  let owner: StackUser;

  beforeAll(async () => {
    owner = await signUp(stack);
  });

  test("um created_at futuro mandado direto no PostgREST vira o now() do banco", async () => {
    const row = analysisRow(owner, { created_at: "2099-01-01T00:00:00Z" });
    expect((await insertAnalysis(owner, row)).status).toBe(201);
    expect(psqlJson(stack, ROW_CLOCK_SQL, { id: String(row["id"]) })).toEqual({ analise: true, feedback: null });
  });

  test("o updated_at do feedback também, na inserção e na atualização", async () => {
    const row = analysisRow(owner);
    expect((await insertAnalysis(owner, row)).status).toBe(201);
    const feedback = { analysis_id: row["id"], user_id: owner.userId, agreement: "concordo", reason: null, updated_at: "2099-01-01T00:00:00Z" };
    expect((await upsert(stack, FEEDBACK_UPSERT, owner, feedback)).status).toBe(201);
    expect(psqlJson(stack, ROW_CLOCK_SQL, { id: String(row["id"]) })).toEqual({ analise: true, feedback: true });
    const again = { ...feedback, agreement: "discordo", reason: "outro", updated_at: "2000-01-01T00:00:00Z" };
    expect((await upsert(stack, FEEDBACK_UPSERT, owner, again)).status).toBe(200);
    expect(psqlJson(stack, ROW_CLOCK_SQL, { id: String(row["id"]) })).toEqual({ analise: true, feedback: true });
    expect(psqlJson(stack, FEEDBACK_ROW_SQL, { id: String(row["id"]) })).toEqual({ user_id: owner.userId, agreement: "discordo", reason: "outro" });
  });
});

describe("o teto por usuário em 24 horas (condição 5)", () => {
  let owner: StackUser;
  let other: StackUser;

  beforeAll(async () => {
    owner = await signUp(stack);
    other = await signUp(stack);
    expect(plant(owner, ANALYSES_DAILY_ROW_CAP - 1)).toEqual({ linhas: ANALYSES_DAILY_ROW_CAP - 1 });
  });

  test("a 100ª passa e a 101ª dá 429 PT429, sem gravar", async () => {
    expect((await insertAnalysis(owner)).status).toBe(201);
    const refused = analysisRow(owner);
    const response = await insertAnalysis(owner, refused);
    expectPgError(response, 429, "PT429");
    expect(PostgrestErrorSchema.parse(response.body).message).toBe("analises_limite_diario");
    expect(survivors([String(refused["id"])])).toEqual({ analises: 0, feedback: 0 });
  });

  test("o teto é de cada usuário: o outro grava", async () => {
    expect((await insertAnalysis(other)).status).toBe(201);
  });

  test("a linha de 24 h e 1 s sai da janela; a de 23 h 59 min 59 s continua contando", async () => {
    expect(psqlJson(stack, AGE_NEWEST_SQL, { uid: owner.userId, n: "1", idade: "24 hours 1 second" })).toEqual({ linhas: 1 });
    expect((await insertAnalysis(owner)).status).toBe(201);
    expectPgError(await insertAnalysis(owner), 429, "PT429");
    expect(psqlJson(stack, AGE_NEWEST_SQL, { uid: owner.userId, n: "1", idade: "23 hours 59 minutes 59 seconds" })).toEqual({ linhas: 1 });
    expectPgError(await insertAnalysis(owner), 429, "PT429");
  });

  test("sob concorrência, o teto é exato: com 90 na janela, 20 pedidos juntos gravam 10", async () => {
    const racer = await signUp(stack);
    expect(plant(racer, ANALYSES_DAILY_ROW_CAP - 10)).toEqual({ linhas: ANALYSES_DAILY_ROW_CAP - 10 });
    const statuses = (await Promise.all(Array.from({ length: 20 }, () => insertAnalysis(racer)))).map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
    expect(plant(racer, 0)).toEqual({ linhas: ANALYSES_DAILY_ROW_CAP });
  });
});

describe("a retenção de 90 dias (condição 6)", () => {
  let owner: StackUser;
  const old: string[] = [];
  let edge = "";
  let fresh = "";

  beforeAll(async () => {
    // A retenção é global: o que uma rodada anterior deixou vencer sai antes, para a contagem ser só destas linhas.
    psqlJson(stack, PURGE_SQL, { limite: "50000" });
    owner = await signUp(stack);
    for (let i = 0; i < 3; i += 1) {
      const row = analysisRow(owner);
      expect((await insertAnalysis(owner, row)).status).toBe(201);
      old.push(String(row["id"]));
    }
    const feedback = { analysis_id: old[0], user_id: owner.userId, agreement: "discordo", reason: "nota_alta_demais" };
    expect((await upsert(stack, FEEDBACK_UPSERT, owner, feedback)).status).toBe(201);
    const edgeRow = analysisRow(owner);
    const freshRow = analysisRow(owner);
    expect((await insertAnalysis(owner, edgeRow)).status).toBe(201);
    expect((await insertAnalysis(owner, freshRow)).status).toBe(201);
    edge = String(edgeRow["id"]);
    fresh = String(freshRow["id"]);
    // A mais velha (com o feedback) tem 1 dia a mais: o limite por execução tira as mais velhas primeiro.
    ageAnalysis(old[0] ?? "", `${String(ANALYSES_RETENTION_DAYS + 1)} days`);
    for (const id of old.slice(1)) ageAnalysis(id, `${String(ANALYSES_RETENTION_DAYS)} days 1 second`);
    ageAnalysis(edge, `${String(ANALYSES_RETENTION_DAYS)} days -2 seconds`);
  });

  test("o limite por execução: com 1, apaga uma só (a mais velha primeiro)", () => {
    expect(psqlJson(stack, PURGE_SQL, { limite: "1" })).toEqual({ apagadas: 1 });
    expect(survivors(old.slice(0, 1))).toEqual({ analises: 0, feedback: 0 });
    expect(survivors(old.slice(1))).toEqual({ analises: 2, feedback: 0 });
  });

  test("a borda exata: mais de 90 dias sai, com o feedback; menos de 90 dias e a nova ficam", () => {
    expect(psqlJson(stack, PURGE_SQL, { limite: "5000" })).toEqual({ apagadas: 2 });
    expect(survivors(old)).toEqual({ analises: 0, feedback: 0 });
    expect(survivors([edge, fresh])).toEqual({ analises: 2, feedback: 0 });
    expect(psqlJson(stack, PURGE_SQL, { limite: "5000" })).toEqual({ apagadas: 0 });
  });

  test("o limite fora da faixa é recusado (22023), sem apagar nada", () => {
    for (const limite of ["0", "-1", "50001", "null"]) {
      expect(psqlJson(stack, sqlStateAsRoleSql(`select public.purge_expired_analyses(${limite});`), { papel: "postgres" })).toEqual({
        sqlstate: "22023",
        papel: "postgres",
      });
    }
    expect(survivors([edge, fresh])).toEqual({ analises: 2, feedback: 0 });
  });

  afterAll(() => {
    expect(psqlJson(stack, DELETE_ANALYSES_SQL, { ids: [edge, fresh].join(",") })).toEqual({ linhas: 2 });
  });
});

describe("o feedback só na própria análise (condições 2 e 9; T38)", () => {
  let owner: StackUser;
  let intruder: StackUser;
  let withFeedback = "";
  let withoutFeedback = "";

  beforeAll(async () => {
    owner = await signUp(stack);
    intruder = await signUp(stack);
    const a = analysisRow(owner);
    const b = analysisRow(owner);
    expect((await insertAnalysis(owner, a)).status).toBe(201);
    expect((await insertAnalysis(owner, b)).status).toBe(201);
    withFeedback = String(a["id"]);
    withoutFeedback = String(b["id"]);
    const feedback = { analysis_id: withFeedback, user_id: owner.userId, agreement: "concordo", reason: null };
    expect((await upsert(stack, FEEDBACK_UPSERT, owner, feedback)).status).toBe(201);
  });

  test("o id de uma análise de outro dono não é regravado: 409 23505", async () => {
    expectPgError(await insertAnalysis(intruder, analysisRow(intruder, { id: withFeedback })), 409, "23505");
  });

  test("na análise de outro com feedback, 403 42501, e a linha do dono não muda", async () => {
    const hostile = { analysis_id: withFeedback, user_id: intruder.userId, agreement: "discordo", reason: "outro" };
    expectPgError(await upsert(stack, FEEDBACK_UPSERT, intruder, hostile), 403, "42501");
    expect(psqlJson(stack, FEEDBACK_ROW_SQL, { id: withFeedback })).toEqual({ user_id: owner.userId, agreement: "concordo", reason: null });
  });

  test("na análise de outro sem feedback, ou num id inexistente, 409 23503 (a FK composta), sem linha nova", async () => {
    for (const analysisId of [withoutFeedback, randomUUID()]) {
      const hostile = { analysis_id: analysisId, user_id: intruder.userId, agreement: "discordo", reason: null };
      expectPgError(await upsert(stack, FEEDBACK_UPSERT, intruder, hostile), 409, "23503");
    }
    expect(psqlJson(stack, FEEDBACK_ROW_SQL, { id: withoutFeedback })).toBeNull();
  });
});
