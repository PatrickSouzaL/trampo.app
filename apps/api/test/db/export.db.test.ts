// F1-API-06 fatia 5 (ADR-031 D5; condição 13 do [APPSEC]) contra o Supabase local do runner: a exportação paginada lê
// as 2.500 análises e as 2.500 avaliações de um usuário pelo PostgREST real, que corta cada resposta no `max_rows` de
// 1.000, e devolve todas, na ordem do banco, sem repetição nem buraco entre as páginas.
//
// As análises são plantadas como `postgres` em lotes (o gatilho do teto vale também para ele: no máximo 100 em 24 h),
// e cada lote é envelhecido antes do seguinte (sempre menos de 90 dias, longe da retenção). Dentro de um lote, o
// `created_at` é o mesmo (o `now()` da transação), e os lotes de 50 nas pontas deixam as fronteiras das páginas no meio
// de um lote: o desempate é pelo id. As avaliações nascem todas num comando só, com o mesmo `updated_at`: as 2.500
// empatam, e as três páginas andam só pelo `analysis_id`.
import { ACCOUNT_EXPORT_MAX_ROWS } from "@trampo/contracts/limits";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

import { AccountService } from "../../src/application/index.js";
import { ACCOUNT_POSTGREST_CLIENT } from "../../src/composition/compose-app.js";
import { ACCOUNT_EXPORT_PAGE_ROWS, createSupabaseAccountStore } from "../../src/infrastructure/persistence/supabase-account-store.js";
import { createPostgrestUserClient } from "../../src/infrastructure/supabase/postgrest-user-client.js";
import { systemClock } from "../../src/infrastructure/time/system-clock.js";
import {
  AGE_PLANTED_BATCH_SQL,
  DELETE_USER_ANALYSES_SQL,
  EXPORT_ORDER_SQL,
  PLANT_ANALYSES_SQL,
  PLANT_FEEDBACK_FOR_ALL_SQL,
} from "./support/analyses-sql.js";
import { parseLocalStackEnv, type LocalStack } from "./support/local-stack-env.js";
import { psqlJson, signUp, type StackUser } from "./support/local-stack.js";

const stack: LocalStack = parseLocalStackEnv(process.env);
const TOTAL = 2_500;
/** 50 + 24 × 100 + 50: as fronteiras das páginas (1.000 e 2.000) caem no meio de um lote de datas iguais. */
const BATCHES = [50, ...Array.from({ length: 24 }, () => 100), 50];

let user: StackUser;
let expected: { readonly analyses: readonly string[]; readonly feedback: readonly string[] };

beforeAll(async () => {
  user = await signUp(stack);
  for (const [index, size] of BATCHES.entries()) {
    expect(psqlJson(stack, PLANT_ANALYSES_SQL, { uid: user.userId, n: String(size) })).toMatchObject({ linhas: expect.any(Number) });
    // Envelhece o lote recém-plantado: ele sai da janela de 24 h do teto, e o lote k fica k + 1 dias no passado.
    expect(psqlJson(stack, AGE_PLANTED_BATCH_SQL, { uid: user.userId, idade: `${index + 1} days` })).toEqual({ linhas: size });
  }
  expect(psqlJson(stack, PLANT_FEEDBACK_FOR_ALL_SQL, { uid: user.userId })).toEqual({ linhas: TOTAL });
  expected = z.object({ analyses: z.array(z.uuid()), feedback: z.array(z.uuid()) }).parse(psqlJson(stack, EXPORT_ORDER_SQL, { uid: user.userId }));
}, 120_000);

afterAll(() => {
  psqlJson(stack, DELETE_USER_ANALYSES_SQL, { uid: user.userId });
});

const store = () =>
  createSupabaseAccountStore({
    client: createPostgrestUserClient({ url: new URL("/", stack.apiUrl), publishableKey: stack.publishableKey, ...ACCOUNT_POSTGREST_CLIENT }),
  });

describe("exportação paginada contra o PostgREST real (ADR-031 D5)", () => {
  test("o plantio: 2.500 análises em 26 lotes, as datas iguais dentro de cada lote, e 2.500 avaliações", () => {
    expect(BATCHES.reduce((sum, size) => sum + size, 0)).toBe(TOTAL);
    expect(expected.analyses).toHaveLength(TOTAL);
    expect(expected.feedback).toHaveLength(TOTAL);
    expect(TOTAL).toBeGreaterThan(2 * ACCOUNT_EXPORT_PAGE_ROWS);
    expect(TOTAL).toBeLessThan(ACCOUNT_EXPORT_MAX_ROWS);
  });

  test("as 2.500 análises e as 2.500 avaliações saem inteiras, na ordem do banco, sem repetição nem buraco", async () => {
    const records = await store().records({ userId: user.userId, accessToken: user.accessToken });
    if (!records.found) throw new Error("a exportação falhou");
    expect(records.analyses.map((row) => row.id)).toEqual(expected.analyses);
    expect(records.feedback.map((row) => row.analysisId)).toEqual(expected.feedback);
    expect(new Set(records.analyses.map((row) => row.id)).size).toBe(TOTAL);
    expect(new Set(records.feedback.map((row) => row.analysisId)).size).toBe(TOTAL);
    expect(records.analysesTruncated).toBe(false);
    expect(records.feedbackTruncated).toBe(false);
  });

  test("pelo AccountService (o prazo de 10 s e o schema do contrato): o documento inteiro", async () => {
    const service = new AccountService({
      store: store(),
      criteria: { load: async () => ({ found: false }) },
      clock: systemClock,
      now: () => Date.now(),
    });
    const outcome = await service.export({ userId: user.userId, accessToken: user.accessToken });
    if (!outcome.ok) throw new Error("a exportação falhou");
    expect(outcome.document.analyses).toHaveLength(TOTAL);
    expect(outcome.document.feedback).toHaveLength(TOTAL);
    expect(outcome.document.criteria).toBeNull();
  });
});
