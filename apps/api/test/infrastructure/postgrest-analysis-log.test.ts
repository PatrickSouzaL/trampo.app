// F1-API-06 fatia 3 (ADR-031 D1): o SupabaseAnalysisLog grava a linha mínima pelo `insert` do cliente de usuário,
// contra o PostgREST simulado em socket real. O dono vem só do sujeito, o id é o da análise, e as colunas são as 5
// da lista fechada; o resultado do cliente volta sem mudança.
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AnalysisLogEntry } from "../../src/application/index.js";
import { ANALYSES_INSERT_COLUMNS, createSupabaseAnalysisLog } from "../../src/infrastructure/persistence/supabase-analysis-log.js";
import { createPostgrestUserClient } from "../../src/infrastructure/supabase/postgrest-user-client.js";
import { HAPPY_PATH_TIMEOUT_MS } from "../support/socket-deadlines.js";
import { startFakePostgrest, type FakePostgrest } from "./fakes/fake-postgrest.js";

const PUBLISHABLE = "sb_publishable_AbC123-teste_xyz";
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJh";
const USER = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const SUBJECT = { userId: USER, accessToken: TOKEN } as const;
const ENTRY: AnalysisLogEntry = {
  analysisId: "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
  decisionPath: "fallback_deterministico",
  verdict: "neutro",
  score: 55,
};

let postgrest: FakePostgrest;
beforeEach(async () => {
  postgrest = await startFakePostgrest(PUBLISHABLE);
  postgrest.sessions.set(TOKEN, USER);
});
afterEach(async () => {
  await postgrest.close();
});

const log = () =>
  createSupabaseAnalysisLog({ client: createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: HAPPY_PATH_TIMEOUT_MS }) });

describe("SupabaseAnalysisLog (ADR-031 D1)", () => {
  test("as colunas são as 5 da linha mínima, congeladas", () => {
    expect(ANALYSES_INSERT_COLUMNS).toEqual(["id", "user_id", "decision_path", "verdict", "score"]);
    expect(Object.isFrozen(ANALYSES_INSERT_COLUMNS)).toBe(true);
  });

  test("grava a linha com o id da análise e o dono do sujeito, pelo Bearer dele", async () => {
    await expect(log().append(SUBJECT, ENTRY)).resolves.toBe("gravada");
    expect(postgrest.analyses).toEqual([
      expect.objectContaining({ id: ENTRY.analysisId, user_id: USER, decision_path: "fallback_deterministico", verdict: "neutro", score: 55 }),
    ]);
    const [sent] = postgrest.requests;
    expect(sent?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(sent?.body ?? "{}")).toStrictEqual({
      id: ENTRY.analysisId,
      user_id: USER,
      decision_path: "fallback_deterministico",
      verdict: "neutro",
      score: 55,
    });
  });

  test("a entrada com chave a mais não leva nada além das 5 colunas", async () => {
    const entry = { ...ENTRY, requestId: "CANARIO-REQUEST", text: "CANARIO-TEXTO" } as AnalysisLogEntry;
    await log().append(SUBJECT, entry);
    expect(postgrest.requests[0]?.body).not.toContain("CANARIO");
  });

  test("o mesmo id outra vez: `recusada`, e a 1ª linha fica", async () => {
    await log().append(SUBJECT, ENTRY);
    await expect(log().append(SUBJECT, { ...ENTRY, verdict: "foge", score: 1 })).resolves.toBe("recusada");
    expect(postgrest.analyses).toEqual([expect.objectContaining({ verdict: "neutro", score: 55 })]);
  });

  test("o teto do banco: `limite`", async () => {
    postgrest.analysesCap = 0;
    await expect(log().append(SUBJECT, ENTRY)).resolves.toBe("limite");
  });

  test("banco fora do ar: `indisponivel`", async () => {
    postgrest.mode = { kind: "status", status: 503 };
    await expect(log().append(SUBJECT, ENTRY)).resolves.toBe("indisponivel");
  });

  test("o signal do chamador chega ao cliente", async () => {
    postgrest.mode = { kind: "trava" };
    const controller = new AbortController();
    const pending = log().append(SUBJECT, ENTRY, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).resolves.toBe("indisponivel");
  });
});
