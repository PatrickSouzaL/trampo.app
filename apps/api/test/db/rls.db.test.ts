// SR-15 contra o Supabase local do runner (ADR-018 D7; F1-OPS-01 parte 2, ADR-019 D8). Roda só no job db do CI,
// pelo `pnpm --filter @trampo/api test:db`, fora do `pnpm test`: o portão padrão não exige Docker. A migration
// é aplicada pelo próprio `supabase start`. Prova, pelo PostgREST e pelo Auth reais e pelo adapter da API:
// A e B isolados (leitura, alteração e inserção), anon sem acesso, FK composta do feedback, checks, nenhum
// delete pela API, o catálogo (RLS forçada, privilégios e policies) e o cascade da exclusão de conta.
// Os testes de cada describe dependem da ordem (o arquivo roda em série).
import { randomBytes, randomUUID } from "node:crypto";

import { AnalysisFeedbackRequestSchema, DecisionPathSchema, VerdictSchema, type UserCriteria } from "@trampo/contracts";
import { beforeAll, describe, expect, test } from "vitest";

import { createSalaryCipher, parseSalaryKeyring } from "../../src/infrastructure/crypto/salary-cipher.js";
import { createSupabaseCriteriaRepository } from "../../src/infrastructure/persistence/supabase-criteria-repository.js";
import { createPostgrestUserClient } from "../../src/infrastructure/supabase/postgrest-user-client.js";
import { criteria, weighted } from "../domain/fakes/scoring-fixtures.js";
import {
  DELETE_AUTH_USER_SQL,
  EXPECTED_POLICIES,
  EXPECTED_PRIVILEGES,
  POLICIES_SQL,
  PRIVILEGES_SQL,
  PUBLIC_TABLES,
  RLS_CATALOG_SQL,
  ROWS_OF_USER_SQL,
} from "./support/catalog-sql.js";
import { parseLocalStackEnv, type LocalStack } from "./support/local-stack-env.js";
import { PostgrestErrorSchema, psqlJson, rest, signUp, type RestResponse, type StackUser } from "./support/local-stack.js";

const stack: LocalStack = parseLocalStackEnv(process.env);
// Chave gerada no teste: nenhum anel real entra no runner.
const cipher = createSalaryCipher(parseSalaryKeyring(`k1:${randomBytes(32).toString("base64url")}`, "k1"));
const repository = createSupabaseCriteriaRepository({
  client: createPostgrestUserClient({ url: stack.apiUrl, publishableKey: stack.publishableKey }),
  cipher,
});

const VALUE: UserCriteria = criteria({
  salary: { minimum: 9_000, currency: "BRL", period: "mes", importance: weighted(3) },
  stack: { ...criteria().stack, mustHave: ["TypeScript"] },
});

/** A linha que o UpdateCriteria (F1-API-05) gravará: a pretensão só no cifrado, a versão só na coluna. */
function criteriaRow(owner: StackUser, value: UserCriteria = VALUE): Record<string, unknown> {
  const { salary, schemaVersion, ...rest } = value;
  return {
    user_id: owner.userId,
    schema_version: schemaVersion,
    criteria: rest,
    salary_ciphertext: cipher.seal(owner.userId, salary),
  };
}

function analysisRow(owner: StackUser, id: string = randomUUID()): Record<string, unknown> {
  return { id, user_id: owner.userId, decision_path: "extracao_llm", verdict: "recomendado", score: 72 };
}

/** Erro do Postgres repassado pelo PostgREST, com o status HTTP que ele escolhe para o código. */
function expectPgError(response: RestResponse, status: number, code: string, constraint?: string): void {
  expect(response.status).toBe(status);
  const error = PostgrestErrorSchema.parse(response.body);
  expect(error.code).toBe(code);
  if (constraint !== undefined) expect(error.message).toContain(constraint);
}

let a: StackUser;
let b: StackUser;

beforeAll(async () => {
  a = await signUp(stack);
  b = await signUp(stack);
});

describe("user_criteria: A e B isolados", () => {
  test("B não insere com o user_id de A (with check da RLS)", async () => {
    expectPgError(await rest(stack, "POST", "user_criteria", b, criteriaRow(a)), 403, "42501");
  });

  test("A grava os próprios critérios", async () => {
    const response = await rest(stack, "POST", "user_criteria", a, criteriaRow(a));
    expect(response.status).toBe(201);
    expect(response.body).toEqual([expect.objectContaining({ user_id: a.userId, schema_version: 1 })]);
  });

  test("o adapter da API lê a linha do dono e abre a pretensão", async () => {
    await expect(repository.load({ userId: a.userId, accessToken: a.accessToken })).resolves.toEqual({
      found: true,
      criteria: VALUE,
    });
  });

  test("B não lê a linha de A: nem pelo filtro, nem sem filtro, nem pelo adapter com o userId de A", async () => {
    expect(await rest(stack, "GET", `user_criteria?user_id=eq.${a.userId}`, b)).toEqual({ status: 200, body: [] });
    expect(await rest(stack, "GET", "user_criteria", b)).toEqual({ status: 200, body: [] });
    // A segunda barreira sozinha: mesmo que a primeira (o `sub` verificado) errasse o dono, a RLS esconde a linha.
    await expect(repository.load({ userId: a.userId, accessToken: b.accessToken })).resolves.toEqual({ found: false });
  });

  test("B não altera a linha de A (0 linhas), e a linha continua igual", async () => {
    const response = await rest(stack, "PATCH", `user_criteria?user_id=eq.${a.userId}`, b, { schema_version: 1, criteria: {} });
    expect(response).toEqual({ status: 200, body: [] });
    await expect(repository.load({ userId: a.userId, accessToken: a.accessToken })).resolves.toEqual({
      found: true,
      criteria: VALUE,
    });
  });

  test("A não passa a própria linha para B (with check do update)", async () => {
    expectPgError(await rest(stack, "PATCH", `user_criteria?user_id=eq.${a.userId}`, a, { user_id: b.userId }), 403, "42501");
  });

  test("ninguém apaga pela API: delete só existe por cascade", async () => {
    expectPgError(await rest(stack, "DELETE", `user_criteria?user_id=eq.${a.userId}`, a), 403, "42501");
  });
});

describe("user_criteria: checks do D2", () => {
  const patch = (body: Record<string, unknown>): Promise<RestResponse> =>
    rest(stack, "PATCH", `user_criteria?user_id=eq.${a.userId}`, a, body);

  test("salary em claro na coluna criteria é recusado", async () => {
    expectPgError(await patch({ criteria: { ...criteriaRow(a)["criteria"] as object, salary: null } }), 400, "23514", "user_criteria_sem_salary");
  });

  test("schemaVersion na coluna criteria é recusado", async () => {
    expectPgError(await patch({ criteria: { schemaVersion: 1 } }), 400, "23514", "user_criteria_sem_schema_version");
  });

  test("criteria que não é objeto é recusado", async () => {
    expectPgError(await patch({ criteria: [] }), 400, "23514", "user_criteria_criteria_objeto");
  });

  test("criteria acima de 16 KiB é recusado", async () => {
    expectPgError(await patch({ criteria: { notes: randomBytes(24_000).toString("base64") } }), 400, "23514", "user_criteria_criteria_tamanho");
  });

  test("schema_version diferente de 1 é recusado", async () => {
    expectPgError(await patch({ schema_version: 2 }), 400, "23514", "user_criteria_schema_version");
  });

  /** Envelope montado à mão nas bordas do padrão (iv de 16, tag de 22). Não abre: a tag é falsa. */
  const envelope = (cipherText = "b".repeat(40), kid = "k1", tag = "c".repeat(22), iv = "a".repeat(16)): string =>
    `s1.${kid}.${iv}.${cipherText}.${tag}`;

  test("criteria de 16 KB passa (o teto é 16.384 bytes)", async () => {
    expect((await patch({ criteria: { notes: "y".repeat(16_000) } })).status).toBe(200);
    expect((await patch({ criteria: criteriaRow(a)["criteria"] })).status).toBe(200);
  });

  test.each([
    ["texto qualquer", "nao-e-envelope"],
    ["versão errada", cipher.seal(randomUUID(), null).replace(/^s1\./, "s2.")],
    ["kid maiúsculo", envelope(undefined, "K1")],
    ["kid de 17 caracteres", envelope(undefined, "k".repeat(17))],
    ["iv de 15 caracteres", envelope(undefined, undefined, undefined, "a".repeat(15))],
    ["tag de 21 caracteres", envelope(undefined, undefined, "c".repeat(21))],
    ["tag de 23 caracteres", envelope(undefined, undefined, "c".repeat(23))],
    ["cifrado vazio", envelope("")],
    ["cifrado de 343 caracteres", envelope("b".repeat(343))],
    ["caractere fora do base64url", envelope(`${"b".repeat(39)}+`)],
    ["texto antes do envelope", `x${envelope()}`],
    ["texto depois do envelope", `${envelope()}x`],
    ["acima de 1.024 caracteres", envelope("a".repeat(1_100))],
  ])("envelope inválido é recusado: %s", async (_label, value) => {
    expectPgError(await patch({ salary_ciphertext: value }), 400, "23514", "user_criteria_salary_envelope");
  });

  test.each([
    ["o maior que o SalaryCipher produz (cifrado de 342)", envelope("b".repeat(342))],
    ["cifrado de 1 caractere", envelope("b")],
    ["kid de 16 caracteres", envelope(undefined, "k".repeat(16))],
  ])("envelope na borda do padrão passa: %s", async (_label, value) => {
    expect((await patch({ salary_ciphertext: value })).status).toBe(200);
    // Volta a linha boa: o envelope acima não abre (tag falsa), e o adapter responderia 503.
    expect((await patch({ salary_ciphertext: criteriaRow(a)["salary_ciphertext"] })).status).toBe(200);
  });
});

describe("anon não acessa nenhuma tabela", () => {
  test.each(PUBLIC_TABLES.map((table) => [table]))("%s: nem leitura, nem escrita", async (table) => {
    const row = { user_id: a.userId };
    expectPgError(await rest(stack, "GET", table, null), 401, "42501");
    expectPgError(await rest(stack, "POST", table, null, row), 401, "42501");
    expectPgError(await rest(stack, "PATCH", `${table}?user_id=eq.${a.userId}`, null, row), 401, "42501");
    expectPgError(await rest(stack, "DELETE", `${table}?user_id=eq.${a.userId}`, null), 401, "42501");
  });
});

describe("analyses e analysis_feedback: o mesmo dono", () => {
  const analysisOfA = randomUUID();
  const analysisOfB = randomUUID();

  test("cada um grava a própria análise e só lê a própria", async () => {
    expect((await rest(stack, "POST", "analyses", a, analysisRow(a, analysisOfA))).status).toBe(201);
    expect((await rest(stack, "POST", "analyses", b, analysisRow(b, analysisOfB))).status).toBe(201);
    const ofA = await rest(stack, "GET", "analyses?select=id", a);
    expect(ofA).toEqual({ status: 200, body: [{ id: analysisOfA }] });
  });

  test("A não grava análise em nome de B", async () => {
    expectPgError(await rest(stack, "POST", "analyses", a, analysisRow(b)), 403, "42501");
  });

  test("checks da análise: veredito, caminho e nota fora da lista fechada", async () => {
    expectPgError(await rest(stack, "POST", "analyses", a, { ...analysisRow(a), verdict: "otimo" }), 400, "23514", "analyses_verdict");
    expectPgError(await rest(stack, "POST", "analyses", a, { ...analysisRow(a), decision_path: "llm" }), 400, "23514", "analyses_decision_path");
    expectPgError(await rest(stack, "POST", "analyses", a, { ...analysisRow(a), score: 101 }), 400, "23514", "analyses_score");
    expectPgError(await rest(stack, "POST", "analyses", a, { ...analysisRow(a), score: -1 }), 400, "23514", "analyses_score");
  });

  test("o banco aceita todo valor dos enums do contrato e os extremos da nota", async () => {
    const rows = [
      ...VerdictSchema.options.map((verdict) => ({ ...analysisRow(a), verdict })),
      ...DecisionPathSchema.options.map((decision_path) => ({ ...analysisRow(a), decision_path })),
      { ...analysisRow(a), score: 0 },
      { ...analysisRow(a), score: 100 },
    ];
    // Um insert em lote: o PostgREST grava o array inteiro numa instrução.
    const response = await rest(stack, "POST", "analyses?select=id", a, rows);
    expect(response.status).toBe(201);
    expect(response.body).toHaveLength(rows.length);
  });

  test("análise não se altera nem se apaga pela API", async () => {
    expectPgError(await rest(stack, "PATCH", `analyses?id=eq.${analysisOfA}`, a, { score: 10 }), 403, "42501");
    expectPgError(await rest(stack, "DELETE", `analyses?id=eq.${analysisOfA}`, a), 403, "42501");
  });

  test("A não cria feedback para a análise de B: a FK composta recusa com o próprio user_id", async () => {
    const response = await rest(stack, "POST", "analysis_feedback", a, { analysis_id: analysisOfB, user_id: a.userId, agreement: "discordo", reason: null });
    expectPgError(response, 409, "23503", "analysis_feedback_mesmo_dono");
  });

  test("A não cria feedback para a análise de B: a RLS recusa com o user_id de B", async () => {
    const response = await rest(stack, "POST", "analysis_feedback", a, { analysis_id: analysisOfB, user_id: b.userId, agreement: "discordo", reason: null });
    expectPgError(response, 403, "42501");
  });

  test("A dá e troca o próprio feedback; B não o lê nem o altera", async () => {
    const created = await rest(stack, "POST", "analysis_feedback", a, { analysis_id: analysisOfA, user_id: a.userId, agreement: "concordo", reason: null });
    expect(created.status).toBe(201);
    const updated = await rest(stack, "PATCH", `analysis_feedback?analysis_id=eq.${analysisOfA}`, a, { agreement: "discordo", reason: "nota_alta_demais" });
    expect(updated).toEqual({ status: 200, body: [expect.objectContaining({ agreement: "discordo", reason: "nota_alta_demais" })] });
    expect(await rest(stack, "GET", "analysis_feedback", b)).toEqual({ status: 200, body: [] });
    expect(await rest(stack, "PATCH", `analysis_feedback?analysis_id=eq.${analysisOfA}`, b, { agreement: "concordo" })).toEqual({ status: 200, body: [] });
  });

  test("checks do feedback: concordância e motivo fora da lista fechada", async () => {
    const patch = (body: Record<string, unknown>): Promise<RestResponse> =>
      rest(stack, "PATCH", `analysis_feedback?analysis_id=eq.${analysisOfA}`, a, body);
    expectPgError(await patch({ agreement: "talvez" }), 400, "23514", "analysis_feedback_agreement");
    expectPgError(await patch({ reason: "nao_gostei" }), 400, "23514", "analysis_feedback_reason");
  });

  test("o banco aceita toda concordância e todo motivo do contrato, inclusive o motivo nulo", async () => {
    const { agreement, reason } = AnalysisFeedbackRequestSchema.shape;
    const values = [
      ...agreement.options.map((value) => ({ agreement: value, reason: null })),
      ...reason.unwrap().options.map((value) => ({ agreement: "discordo", reason: value })),
    ];
    for (const body of values) {
      const response = await rest(stack, "PATCH", `analysis_feedback?analysis_id=eq.${analysisOfA}`, a, body);
      expect(response).toEqual({ status: 200, body: [expect.objectContaining(body)] });
    }
  });

  test("feedback não se apaga pela API", async () => {
    expectPgError(await rest(stack, "DELETE", `analysis_feedback?analysis_id=eq.${analysisOfA}`, a), 403, "42501");
  });
});

describe("catálogo (D3)", () => {
  test("toda tabela do public tem RLS ligada e forçada", () => {
    const tables = psqlJson(stack, RLS_CATALOG_SQL);
    expect(tables).toEqual(expect.arrayContaining(PUBLIC_TABLES.map((table) => ({ table, rls: true, force: true }))));
    expect(tables).toEqual((tables as readonly unknown[]).map(() => expect.objectContaining({ rls: true, force: true })));
  });

  test("anon, authenticated e service_role têm só os privilégios do D3", () => {
    expect(psqlJson(stack, PRIVILEGES_SQL)).toEqual(EXPECTED_PRIVILEGES);
  });

  test("uma policy por comando, só para authenticated e sempre pelo dono", () => {
    expect(psqlJson(stack, POLICIES_SQL)).toEqual(EXPECTED_POLICIES);
  });
});

describe("exclusão da conta leva as linhas junto (cascade)", () => {
  test("critérios, análise e feedback somem com o usuário do Auth", async () => {
    const c = await signUp(stack);
    const analysisId = randomUUID();
    expect((await rest(stack, "POST", "user_criteria", c, criteriaRow(c))).status).toBe(201);
    expect((await rest(stack, "POST", "analyses", c, analysisRow(c, analysisId))).status).toBe(201);
    const feedback = { analysis_id: analysisId, user_id: c.userId, agreement: "concordo", reason: null };
    expect((await rest(stack, "POST", "analysis_feedback", c, feedback)).status).toBe(201);
    const vars = { uid: c.userId };
    expect(psqlJson(stack, ROWS_OF_USER_SQL, vars)).toEqual([{ user_criteria: 1, analyses: 1, analysis_feedback: 1 }]);
    expect(psqlJson(stack, DELETE_AUTH_USER_SQL + ROWS_OF_USER_SQL, vars)).toEqual([
      { user_criteria: 0, analyses: 0, analysis_feedback: 0 },
    ]);
  });
});
