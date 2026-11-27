// F1-API-06 fatia 4 (ADR-031 D4 e §1.1, M3 e M4): o SupabaseAnalysisFeedbackStore grava pelo upsert classificado do
// cliente de usuário, contra o PostgREST simulado em socket real, que imita as respostas medidas na pilha local:
// 201 na inserção e 200 na atualização; 409 `23503` na análise inexistente ou de outro dono sem avaliação; 403
// `42501` na de outro dono com avaliação. Os dois últimos viram o mesmo `negada`, sem oráculo, e nada muda.
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ANALYSIS_FEEDBACK_COLUMNS, createSupabaseAnalysisFeedbackStore } from "../../src/infrastructure/persistence/supabase-analysis-feedback.js";
import { createPostgrestUserClient } from "../../src/infrastructure/supabase/postgrest-user-client.js";
import { HAPPY_PATH_TIMEOUT_MS } from "../support/socket-deadlines.js";
import { startFakePostgrest, type FakePostgrest } from "./fakes/fake-postgrest.js";

const PUBLISHABLE = "sb_publishable_AbC123-teste_xyz";
const OWNER = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const OTHER = "0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a";
// Montados em tempo de execução: não são JWTs reais e não devem parecer segredo para a varredura (cuidados 14 e 38).
const token = (subject: string): string => ["eyJhbGciOiJFUzI1NiJ9", Buffer.from(`{"sub":"${subject}"}`).toString("base64url"), "c2lnbmF0dXJh"].join(".");
const OWNER_TOKEN = token("a");
const OTHER_TOKEN = token("b");
const MINE = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const THEIRS = "2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e";
const MISSING = "3d4e5f60-7182-4c9d-8e1f-2a3b4c5d6e7f";

let postgrest: FakePostgrest;
beforeEach(async () => {
  postgrest = await startFakePostgrest(PUBLISHABLE);
  postgrest.sessions.set(OWNER_TOKEN, OWNER);
  postgrest.sessions.set(OTHER_TOKEN, OTHER);
  postgrest.analyses.push({ id: MINE, user_id: OWNER }, { id: THEIRS, user_id: OTHER });
});
afterEach(async () => {
  await postgrest.close();
});

const store = () =>
  createSupabaseAnalysisFeedbackStore({ client: createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: HAPPY_PATH_TIMEOUT_MS }) });
const mine = { userId: OWNER, accessToken: OWNER_TOKEN } as const;

describe("SupabaseAnalysisFeedbackStore (ADR-031 D4)", () => {
  test("as colunas são as 4 do upsert, congeladas (o updated_at é do banco)", () => {
    expect(ANALYSIS_FEEDBACK_COLUMNS).toEqual(["analysis_id", "user_id", "agreement", "reason"]);
    expect(Object.isFrozen(ANALYSIS_FEEDBACK_COLUMNS)).toBe(true);
  });

  test("1ª avaliação (201) e a troca dela (200): `gravada`, uma linha só, do dono do token", async () => {
    await expect(store().save(mine, { analysisId: MINE, agreement: "concordo", reason: null })).resolves.toBe("gravada");
    await expect(store().save(mine, { analysisId: MINE, agreement: "discordo", reason: "outro" })).resolves.toBe("gravada");
    expect(postgrest.feedback).toEqual([expect.objectContaining({ analysis_id: MINE, user_id: OWNER, agreement: "discordo", reason: "outro" })]);
    const [first] = postgrest.requests;
    const url = new URL(first?.url ?? "", "http://x");
    expect(url.pathname).toBe("/rest/v1/analysis_feedback");
    expect(Object.fromEntries(url.searchParams)).toEqual({ on_conflict: "analysis_id", columns: "analysis_id,user_id,agreement,reason" });
    expect(JSON.parse(first?.body ?? "{}")).toStrictEqual({ analysis_id: MINE, user_id: OWNER, agreement: "concordo", reason: null });
    expect(first?.prefer).toBe("resolution=merge-duplicates,return=minimal");
  });

  test("a análise de outro dono SEM avaliação (409 23503) e o id inexistente (409 23503): `negada`", async () => {
    await expect(store().save(mine, { analysisId: THEIRS, agreement: "concordo", reason: null })).resolves.toBe("negada");
    await expect(store().save(mine, { analysisId: MISSING, agreement: "concordo", reason: null })).resolves.toBe("negada");
    expect(postgrest.feedback).toEqual([]);
  });

  test("a análise de outro dono COM avaliação (403 42501): o mesmo `negada`, e a avaliação dele não muda", async () => {
    const theirs = { userId: OTHER, accessToken: OTHER_TOKEN } as const;
    await expect(store().save(theirs, { analysisId: THEIRS, agreement: "concordo", reason: null })).resolves.toBe("gravada");
    await expect(store().save(mine, { analysisId: THEIRS, agreement: "discordo", reason: "outro" })).resolves.toBe("negada");
    expect(postgrest.feedback).toEqual([expect.objectContaining({ analysis_id: THEIRS, user_id: OTHER, agreement: "concordo" })]);
  });

  test.each([
    ["400 do banco", 400],
    ["401", 401],
    ["500", 500],
    ["503", 503],
  ])("%s: `indisponivel`", async (_name, status) => {
    postgrest.mode = { kind: "status", status };
    await expect(store().save(mine, { analysisId: MINE, agreement: "concordo", reason: null })).resolves.toBe("indisponivel");
  });

  test("a entrada com chave a mais não leva nada além das 4 colunas (o dono é só o do sujeito)", async () => {
    const entry = { analysisId: MINE, agreement: "concordo", reason: null, user_id: OTHER, updated_at: "2099-01-01T00:00:00Z" } as const;
    await store().save(mine, entry);
    const body = postgrest.requests[0]?.body ?? "";
    expect(body).not.toContain(OTHER);
    expect(body).not.toContain("2099");
  });
});
