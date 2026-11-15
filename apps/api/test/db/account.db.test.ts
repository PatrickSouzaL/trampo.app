// SR-16 contra o Supabase local do runner (ADR-029 D2, D6 e D7, condições 1 a 7). Roda só no job db do CI, pelo
// `pnpm --filter @trampo/api test:db`. A migration da função entra pelo próprio `supabase start`. Prova, pelo
// PostgREST e pelo Auth reais: a função só apaga a conta de quem chama, anon e service_role não a executam, nada do
// usuário sobra (nem nos dois lugares do auth que o cascade não pega), o login recente é conferido no banco, o
// usuário apagado não regrava com o access que ainda vale, e a definição está presa pelo catálogo.
// Os testes de cada describe dependem da ordem (o arquivo roda em série).
import { randomBytes, randomUUID } from "node:crypto";

import { AccountDeleteResultSchema } from "@trampo/contracts/account";
import { ACCOUNT_RECENT_LOGIN_SECONDS } from "@trampo/contracts/limits";
import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

import { insertPkceFlow, signInWithPassword, signUpWithPassword, type PasswordSession } from "./support/auth-stack.js";
import {
  ACCOUNT_ACL_SQL,
  ACCOUNT_CALL_AT_AGE_SQL,
  ACCOUNT_CALL_SQL,
  ACCOUNT_DEFINITION_SQL,
  ACCOUNT_FUNCTION,
  ACCOUNT_FUNCTIONS_SQL,
  ACCOUNT_ROWS_SQL,
  AGE_SESSION_SQL,
  EXPECTED_ACCOUNT_ACL,
  EXPECTED_ACCOUNT_FUNCTIONS,
  NO_ACCOUNT_ROWS,
  UNDATE_SESSION_SQL,
  sqlStateAsRoleSql,
} from "./support/catalog-sql.js";
import { parseLocalStackEnv, type LocalStack } from "./support/local-stack-env.js";
import { PostgrestErrorSchema, psqlJson, rest, upsert, type RestResponse } from "./support/local-stack.js";

const stack: LocalStack = parseLocalStackEnv(process.env);
const RPC = `rpc/${ACCOUNT_FUNCTION}`;

const claimsOf = (token: string): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString("utf8")));
const sessionIdOf = (token: string): string => z.uuid().parse(claimsOf(token)["session_id"]);
const rowsOf = (user: PasswordSession): unknown => psqlJson(stack, ACCOUNT_ROWS_SQL, { uid: user.userId });
const callRpc = (user: PasswordSession | null, body: unknown = {}): Promise<RestResponse> => rest(stack, "POST", RPC, user, body);
const ageSession = (user: PasswordSession, seconds: number): void => {
  z.object({ linhas: z.literal(1) }).parse(psqlJson(stack, AGE_SESSION_SQL, { sid: sessionIdOf(user.accessToken), age: String(seconds) }));
};

/** Uma linha válida de `user_criteria` (o envelope só precisa da forma do check). */
function criteriaRow(owner: PasswordSession): Record<string, unknown> {
  return {
    user_id: owner.userId,
    schema_version: 1,
    criteria: {},
    salary_ciphertext: `s1.k1.${randomBytes(12).toString("base64url")}.${randomBytes(24).toString("base64url")}.${randomBytes(16).toString("base64url")}`,
    updated_at: new Date().toISOString(),
  };
}

/** Planta uma linha do usuário em cada lugar: critérios, análise, avaliação e um fluxo PKCE (o signup já deixou a auditoria). */
async function plant(owner: PasswordSession): Promise<void> {
  const analysisId = randomUUID();
  expect((await rest(stack, "POST", "user_criteria", owner, criteriaRow(owner))).status).toBe(201);
  const analysis = { id: analysisId, user_id: owner.userId, decision_path: "extracao_llm", verdict: "neutro", score: 50 };
  expect((await rest(stack, "POST", "analyses", owner, analysis)).status).toBe(201);
  const feedback = { analysis_id: analysisId, user_id: owner.userId, agreement: "concordo", reason: null };
  expect((await rest(stack, "POST", "analysis_feedback", owner, feedback)).status).toBe(201);
  insertPkceFlow(stack, owner.userId, randomBytes(32).toString("base64url"), 10);
}

function expectPgError(response: RestResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  expect(PostgrestErrorSchema.parse(response.body).code).toBe(code);
}

describe("catálogo: a definição presa (condições 2 e 7)", () => {
  test("uma função só, sem parâmetro, definer, volatile, search_path vazio e dono postgres", () => {
    expect(psqlJson(stack, ACCOUNT_FUNCTIONS_SQL)).toEqual(EXPECTED_ACCOUNT_FUNCTIONS);
  });

  test("só authenticated executa; sem a função, ele não apaga nada do auth", () => {
    expect(psqlJson(stack, ACCOUNT_ACL_SQL)).toEqual(EXPECTED_ACCOUNT_ACL);
  });

  test("a janela do login recente é a do contrato, em segundos", () => {
    const { definition } = z.object({ definition: z.string() }).parse(psqlJson(stack, ACCOUNT_DEFINITION_SQL));
    expect(ACCOUNT_RECENT_LOGIN_SECONDS).toBe(600);
    expect(definition).toContain(`make_interval(secs => ${String(ACCOUNT_RECENT_LOGIN_SECONDS)})`);
    // Uma janela só, e nenhum outro intervalo escrito na função.
    expect(definition.match(/make_interval\(/g)).toHaveLength(1);
    expect(definition).not.toMatch(/interval '/i);
  });

  test.each(["anon", "service_role"])("%s não executa a função (42501)", (papel) => {
    expect(psqlJson(stack, sqlStateAsRoleSql("select public.delete_own_account();"), { papel })).toEqual({ sqlstate: "42501", papel });
  });

  test("authenticated sem usuário no JWT: 28000, nunca uma exclusão", () => {
    expect(psqlJson(stack, sqlStateAsRoleSql("select public.delete_own_account();"), { papel: "authenticated" })).toEqual({ sqlstate: "28000", papel: "authenticated" });
  });
});

describe("pelo PostgREST: só a própria conta, sem resíduo (condições 1, 3, 5 e 6)", () => {
  let a: PasswordSession;
  let b: PasswordSession;

  beforeAll(async () => {
    a = await signUpWithPassword(stack);
    b = await signUpWithPassword(stack);
    await plant(a);
    await plant(b);
  });

  test("o cenário tem linha em todo lugar, para os dois usuários", () => {
    for (const user of [a, b]) {
      const rows = z.record(z.string(), z.int()).parse(rowsOf(user));
      expect(Object.keys(rows).sort()).toEqual(Object.keys(NO_ACCOUNT_ROWS).sort());
      for (const [place, count] of Object.entries(rows)) expect(count, place).toBeGreaterThan(0);
    }
  });

  test("anon (só a publishable) não chama: 401 com 42501", async () => {
    expectPgError(await callRpc(null), 401, "42501");
  });

  test("por GET a função não roda (transação só de leitura): 405 com 25006", async () => {
    expectPgError(await rest(stack, "GET", RPC, a), 405, "25006");
    expect(z.record(z.string(), z.int()).parse(rowsOf(a))["users"]).toBe(1);
  });

  test.each([
    ["o id de outro usuário", (): unknown => ({ uid: b.userId })],
    ["user_id", (): unknown => ({ user_id: b.userId })],
    ["um argumento posicional", (): unknown => ({ "": b.userId })],
  ])("nenhum parâmetro escolhe o alvo (%s): 404 PGRST202, e ninguém some", async (_caso, body) => {
    expectPgError(await callRpc(a, body()), 404, "PGRST202");
    for (const user of [a, b]) expect(z.record(z.string(), z.int()).parse(rowsOf(user))["users"]).toBe(1);
  });

  test("A apaga a própria conta: nada dele sobra em lugar nenhum, e B fica intacto", async () => {
    const before = rowsOf(b);
    const response = await callRpc(a);
    expect(response).toEqual({ status: 200, body: "excluida" });
    expect(AccountDeleteResultSchema.parse(response.body)).toBe("excluida");
    expect(rowsOf(a)).toEqual(NO_ACCOUNT_ROWS);
    expect(rowsOf(b)).toEqual(before);
  });

  test("de novo, com o access que ainda vale: ja_excluida (idempotente)", async () => {
    expect(await callRpc(a)).toEqual({ status: 200, body: "ja_excluida" });
    expect(rowsOf(a)).toEqual(NO_ACCOUNT_ROWS);
  });

  test("o usuário apagado não regrava os critérios: a FK recusa (409 com 23503), e a linha não existe", async () => {
    const path = "user_criteria?on_conflict=user_id&columns=user_id,schema_version,criteria,salary_ciphertext,updated_at";
    expectPgError(await upsert(stack, path, a, criteriaRow(a)), 409, "23503");
    expectPgError(await rest(stack, "POST", "analyses", a, { id: randomUUID(), user_id: a.userId, decision_path: "extracao_llm", verdict: "neutro", score: 1 }), 409, "23503");
    expect(rowsOf(a)).toEqual(NO_ACCOUNT_ROWS);
  });

  test("o usuário apagado lê lista vazia, nunca a linha de outro", async () => {
    expect(await rest(stack, "GET", "user_criteria?select=user_id", a)).toEqual({ status: 200, body: [] });
  });
});

describe("login recente, conferido no banco (condição 4)", () => {
  let user: PasswordSession;
  let other: PasswordSession;

  beforeAll(async () => {
    user = await signUpWithPassword(stack);
    other = await signUpWithPassword(stack);
    await plant(user);
  });

  const at = (age: number, claims: Record<string, unknown>, sid = sessionIdOf(user.accessToken)): unknown =>
    psqlJson(stack, ACCOUNT_CALL_AT_AGE_SQL, { sid, uid: user.userId, age: String(age), claims: JSON.stringify(claims) });

  test("a borda exata: 600 s ainda apaga, 601 s não (na mesma transação, com rollback)", () => {
    const claims = claimsOf(user.accessToken);
    expect(at(ACCOUNT_RECENT_LOGIN_SECONDS, claims)).toEqual({ saida: "excluida", sobrou: 0 });
    expect(at(ACCOUNT_RECENT_LOGIN_SECONDS - 1, claims)).toEqual({ saida: "excluida", sobrou: 0 });
    expect(at(ACCOUNT_RECENT_LOGIN_SECONDS + 1, claims)).toEqual({ saida: "login_antigo", sobrou: 1 });
    expect(at(86_400, claims)).toEqual({ saida: "login_antigo", sobrou: 1 });
    // O rollback desfez as exclusões: o cenário segue inteiro.
    expect(z.record(z.string(), z.int()).parse(rowsOf(user))["user_criteria"]).toBe(1);
  });

  test.each([
    ["sem session_id", (claims: Record<string, unknown>): Record<string, unknown> => (({ session_id: _omit, ...rest }) => rest)(claims)],
    ["session_id nulo", (claims: Record<string, unknown>) => ({ ...claims, session_id: null })],
    ["session_id número", (claims: Record<string, unknown>) => ({ ...claims, session_id: 123 })],
    ["session_id vazio", (claims: Record<string, unknown>) => ({ ...claims, session_id: "" })],
    ["session_id que não é uuid", (claims: Record<string, unknown>) => ({ ...claims, session_id: "nao-e-uuid" })],
    ["session_id com SQL", (claims: Record<string, unknown>) => ({ ...claims, session_id: "' or 1=1 --" })],
    ["session_id uuid com lixo depois", (claims: Record<string, unknown>) => ({ ...claims, session_id: `${randomUUID()}x` })],
    ["session_id em maiúsculas", (claims: Record<string, unknown>) => ({ ...claims, session_id: String(claims["session_id"]).toUpperCase() })],
    ["sessão que não existe", (claims: Record<string, unknown>) => ({ ...claims, session_id: randomUUID() })],
  ])("%s: login_antigo, sem lançar e sem apagar", (_caso, change) => {
    const claims = change(claimsOf(user.accessToken));
    expect(psqlJson(stack, ACCOUNT_CALL_SQL, { claims: JSON.stringify(claims) })).toEqual({ saida: "login_antigo" });
  });

  test("a sessão recente de OUTRO usuário não serve: login_antigo", () => {
    const claims = { ...claimsOf(user.accessToken), session_id: sessionIdOf(other.accessToken) };
    expect(psqlJson(stack, ACCOUNT_CALL_SQL, { claims: JSON.stringify(claims) })).toEqual({ saida: "login_antigo" });
  });

  test("pelo PostgREST, com a sessão de 601 s: login_antigo, e nada some", async () => {
    const before = rowsOf(user);
    ageSession(user, ACCOUNT_RECENT_LOGIN_SECONDS + 1);
    expect(await callRpc(user)).toEqual({ status: 200, body: "login_antigo" });
    expect(rowsOf(user)).toEqual(before);
  });

  test("a renovação não rejuvenesce a sessão: só um login novo libera", async () => {
    const again = await signInWithPassword(stack, user);
    // A sessão velha continua velha, mesmo com outra sessão nova do mesmo usuário.
    expect(await callRpc(user)).toEqual({ status: 200, body: "login_antigo" });
    expect(await callRpc(again)).toEqual({ status: 200, body: "excluida" });
    expect(rowsOf(user)).toEqual(NO_ACCOUNT_ROWS);
  });

  test("sessão sem data: login_antigo", async () => {
    z.object({ linhas: z.literal(1) }).parse(psqlJson(stack, UNDATE_SESSION_SQL, { sid: sessionIdOf(other.accessToken) }));
    expect(await callRpc(other)).toEqual({ status: 200, body: "login_antigo" });
    expect(z.record(z.string(), z.int()).parse(rowsOf(other))["users"]).toBe(1);
  });
});
