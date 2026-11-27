// O RPC do cliente de usuário e o AccountStore do Supabase (ADR-029 D2 a D4) contra o PostgREST simulado em socket
// real (127.0.0.1). RPC: endereço, cabeçalhos e corpo exatos (`{}`: nada de quem chama vira argumento), lista fechada
// de funções, só o 200 com JSON de até 64 bytes, e falha fechada em todo desvio. Store: a palavra da função em lista
// fechada, as duas listas com colunas explícitas, o filtro pelo dono e a ordem, as datas convertidas para UTC, e
// nenhuma linha fora da forma. Paginação (ADR-031 D5): páginas de 1.000 por cursor de chave composta, com o valor CRU
// do Postgres (microssegundos), até 10 páginas por lista e uma sonda de 1 linha para a marca de corte; qualquer página
// que falha derruba a lista inteira.
import { ACCOUNT_EXPORT_MAX_ROWS } from "@trampo/contracts/limits";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AccountStore } from "../../src/application/index.js";
import {
  ACCOUNT_DELETE_FUNCTION,
  ACCOUNT_EXPORT_PAGE_ROWS,
  ANALYSES_SELECT,
  FEEDBACK_SELECT,
  createSupabaseAccountStore,
} from "../../src/infrastructure/persistence/supabase-account-store.js";
import {
  POSTGREST_CLIENT_POLICY,
  POSTGREST_FUNCTIONS,
  createPostgrestUserClient,
  type PostgrestRead,
  type PostgrestUserClient,
} from "../../src/infrastructure/supabase/postgrest-user-client.js";
import { HAPPY_PATH_TIMEOUT_MS } from "../support/socket-deadlines.js";
import { startFakePostgrest, type FakePostgrest, type OwnedRow } from "./fakes/fake-postgrest.js";

const PUBLISHABLE = "sb_publishable_AbC123-teste_xyz";
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJh";
// Montado em tempo de execução: não é um JWT real e não deve parecer um segredo para a varredura (cuidado 14).
const OTHER_TOKEN = [TOKEN.split(".")[0], "eyJzdWIiOiJiIn0", "b3V0cmE"].join(".");
const USER = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const OTHER = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f";
const SUBJECT = { userId: USER, accessToken: TOKEN };
const FAILURE = { ok: false } as const;
const DELETE_UNAVAILABLE = { done: false, unavailable: true };
const RECORDS_UNAVAILABLE = { found: false, unavailable: true };
const RPC = "/rest/v1/rpc/delete_own_account";

const uuid = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const analysisRow = (index: number, owner = USER): OwnedRow => ({
  id: uuid(index),
  user_id: owner,
  created_at: "2026-11-15T09:00:00.123456-03:00",
  decision_path: "extracao_llm",
  verdict: "neutro",
  score: 50,
});
const feedbackRow = (index: number, owner = USER): OwnedRow => ({
  analysis_id: uuid(index),
  user_id: owner,
  agreement: "discordo",
  reason: "nota_alta_demais",
  updated_at: "2026-11-15T12:00:00+00:00",
});

let postgrest: FakePostgrest;
let other: FakePostgrest | undefined;
let client: PostgrestUserClient;
let short: PostgrestUserClient;
let store: AccountStore;
beforeEach(async () => {
  postgrest = await startFakePostgrest(PUBLISHABLE);
  postgrest.sessions.set(TOKEN, USER);
  postgrest.sessions.set(OTHER_TOKEN, OTHER);
  client = createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: HAPPY_PATH_TIMEOUT_MS, maxResponseBytes: 256 * 1024 });
  short = createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: 300 });
  store = createSupabaseAccountStore({ client });
});
afterEach(async () => {
  await postgrest.close();
  await other?.close();
  other = undefined;
});

const rpc = (token = TOKEN, signal?: AbortSignal): Promise<PostgrestRead> => client.rpc("delete_own_account", token, signal);

describe("rpc: protocolo (ADR-029 D3)", () => {
  test("POST /rest/v1/rpc/delete_own_account com o corpo fixo {} e os cabeçalhos exatos", async () => {
    await expect(rpc()).resolves.toEqual({ ok: true, value: "excluida" });
    expect(postgrest.requests).toHaveLength(1);
    const [sent] = postgrest.requests;
    expect(sent).toEqual({
      method: "POST",
      url: RPC,
      apikey: PUBLISHABLE,
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json",
      contentType: "application/json",
      prefer: undefined,
      body: "{}",
    });
    expect(postgrest.deletions).toEqual([USER]);
  });

  test("a lista de funções é fechada e congelada; a política fixa o teto de 64 bytes", () => {
    expect(POSTGREST_FUNCTIONS).toEqual(["delete_own_account"]);
    expect(Object.isFrozen(POSTGREST_FUNCTIONS)).toBe(true);
    expect(ACCOUNT_DELETE_FUNCTION).toBe("delete_own_account");
    expect(POSTGREST_CLIENT_POLICY.rpcMaxResponseBytes).toBe(64);
  });

  test.each([["outra_funcao"], ["delete_own_account?uid=x"], ["../user_criteria"], [""], ["toString"], ["__proto__"], ["DELETE_OWN_ACCOUNT"]])(
    "função fora da lista (%j): nada sai",
    async (name) => {
      await expect(client.rpc(name as never, TOKEN)).resolves.toEqual(FAILURE);
      expect(postgrest.requests).toHaveLength(0);
    },
  );

  test.each([["sem pontos", "abc"], ["duas partes", "a.b"], ["com espaço", "a.b c.d"], ["com quebra de linha", "a.b.c\r\nx-injetado: 1"], ["vazio", ""]])(
    "token fora da forma (%s): nada sai",
    async (_caso, token) => {
      await expect(rpc(token)).resolves.toEqual(FAILURE);
      expect(postgrest.requests).toHaveLength(0);
    },
  );

  test("teto do token: 8.192 caracteres saem, 8.193 não", async () => {
    const at = (length: number): string => `a.b.${"c".repeat(length - 4)}`;
    await rpc(at(POSTGREST_CLIENT_POLICY.accessTokenMaxChars));
    expect(postgrest.requests).toHaveLength(1);
    await expect(rpc(at(POSTGREST_CLIENT_POLICY.accessTokenMaxChars + 1))).resolves.toEqual(FAILURE);
    expect(postgrest.requests).toHaveLength(1);
  });

  test("um token por chamada: a 2ª chamada leva só o 2º token", async () => {
    await rpc(TOKEN);
    await rpc(OTHER_TOKEN);
    expect(postgrest.requests.map((request) => request.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${OTHER_TOKEN}`]);
    expect(postgrest.deletions).toEqual([USER, OTHER]);
  });

  test("qualquer JSON de até 64 bytes volta como veio (quem fecha as três palavras é o store)", async () => {
    postgrest.deleteResult = "login_antigo";
    await expect(rpc()).resolves.toEqual({ ok: true, value: "login_antigo" });
    postgrest.deleteResult = { inesperado: true };
    await expect(rpc()).resolves.toEqual({ ok: true, value: { inesperado: true } });
  });
});

describe("rpc: falha fechado, nunca rejeita", () => {
  test("publishable errada e token de outra sessão (401)", async () => {
    const wrong = createPostgrestUserClient({ url: postgrest.url, publishableKey: "sb_publishable_outra", timeoutMs: HAPPY_PATH_TIMEOUT_MS });
    await expect(wrong.rpc("delete_own_account", TOKEN)).resolves.toEqual(FAILURE);
    await expect(rpc("x.y.z")).resolves.toEqual(FAILURE);
    expect(postgrest.deletions).toEqual([]);
  });

  test.each([[400], [401], [403], [404], [405], [409], [429], [500], [503]])("status %d", async (status) => {
    postgrest.mode = { kind: "status", status };
    await expect(rpc()).resolves.toEqual(FAILURE);
  });

  test.each([[201], [202], [204], [206], [300]])("status %d com um corpo que seria válido", async (status) => {
    postgrest.mode = { kind: "status", status, body: '"excluida"' };
    await expect(rpc()).resolves.toEqual(FAILURE);
  });

  test.each([
    ["sem content-type", null],
    ["texto", "text/plain"],
    ["json com sufixo", "application/jsonx"],
  ])("content-type %s com um JSON válido", async (_caso, contentType) => {
    postgrest.mode = { kind: "corpo", body: '"excluida"', contentType };
    await expect(rpc()).resolves.toEqual(FAILURE);
  });

  test("teto exato de 64 bytes na resposta", async () => {
    const valid = '"excluida"';
    postgrest.mode = { kind: "corpo", body: valid + " ".repeat(64 - valid.length) };
    await expect(rpc()).resolves.toEqual({ ok: true, value: "excluida" });
    postgrest.mode = { kind: "corpo", body: valid + " ".repeat(64 - valid.length + 1) };
    await expect(rpc()).resolves.toEqual(FAILURE);
  });

  test("o teto do RPC não é o da leitura: o cliente com 128 KiB de leitura ainda corta o RPC em 64 bytes", async () => {
    postgrest.mode = { kind: "corpo", body: `"${"a".repeat(100)}"` };
    await expect(rpc()).resolves.toEqual(FAILURE);
  });

  test.each([
    ["JSON inválido", '"excl'],
    ["corpo vazio", ""],
    ["__proto__", '{"__proto__":{"a":1}}'],
  ])("%s", async (_caso, body) => {
    postgrest.mode = { kind: "corpo", body };
    await expect(rpc()).resolves.toEqual(FAILURE);
  });

  test("lento além do prazo, travado e socket cortado", async () => {
    postgrest.mode = { kind: "lento", delayMs: 1_000 };
    const start = performance.now();
    await expect(short.rpc("delete_own_account", TOKEN)).resolves.toEqual(FAILURE);
    expect(performance.now() - start).toBeLessThan(900);
    postgrest.mode = { kind: "trava" };
    await expect(short.rpc("delete_own_account", TOKEN, new AbortController().signal)).resolves.toEqual(FAILURE);
    postgrest.mode = { kind: "corta" };
    await expect(rpc()).resolves.toEqual(FAILURE);
  });

  test("o signal do chamador aborta, e o já abortado nem espera", async () => {
    postgrest.mode = { kind: "trava" };
    const slow = createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = slow.rpc("delete_own_account", TOKEN, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const start = performance.now();
    await expect(pending).resolves.toEqual(FAILURE);
    expect(performance.now() - start).toBeLessThan(2_000);
    await expect(slow.rpc("delete_own_account", TOKEN, AbortSignal.abort())).resolves.toEqual(FAILURE);
  });

  test("redirecionamento não é seguido: o token não vai para outro host, e nada é apagado lá", async () => {
    other = await startFakePostgrest(PUBLISHABLE);
    other.sessions.set(TOKEN, USER);
    postgrest.mode = { kind: "redireciona", location: `${other.url.origin}${RPC}` };
    await expect(rpc()).resolves.toEqual(FAILURE);
    expect(other.requests).toHaveLength(0);
  });

  test("servidor fora do ar (porta fechada)", async () => {
    const url = postgrest.url;
    await postgrest.close();
    postgrest = await startFakePostgrest(PUBLISHABLE);
    const closed = createPostgrestUserClient({ url, publishableKey: PUBLISHABLE, timeoutMs: 300 });
    await expect(closed.rpc("delete_own_account", TOKEN)).resolves.toEqual(FAILURE);
  });
});

describe("select com o teto de leitura da conta", () => {
  test("o teto configurado vale no lugar do padrão, na borda exata", async () => {
    const small = createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: HAPPY_PATH_TIMEOUT_MS, maxResponseBytes: 100 });
    postgrest.mode = { kind: "corpo", body: `[]${" ".repeat(98)}` };
    await expect(small.select("analyses", { select: "id" }, TOKEN)).resolves.toEqual({ ok: true, value: [] });
    postgrest.mode = { kind: "corpo", body: `[]${" ".repeat(99)}` };
    await expect(small.select("analyses", { select: "id" }, TOKEN)).resolves.toEqual(FAILURE);
    // Acima do padrão de 32 KiB e dentro dos 128 KiB da conta.
    postgrest.mode = { kind: "corpo", body: `[]${" ".repeat(100_000)}` };
    await expect(client.select("analyses", { select: "id" }, TOKEN)).resolves.toEqual({ ok: true, value: [] });
  });
});

describe("deleteOwn (ADR-029 D2 e D3)", () => {
  test.each([["excluida"], ["ja_excluida"], ["login_antigo"]] as const)("a palavra %s volta como o resultado", async (word) => {
    postgrest.deleteResult = word;
    await expect(store.deleteOwn(SUBJECT)).resolves.toEqual({ done: true, result: word });
    expect(postgrest.requests.map((request) => `${request.method} ${request.url} ${request.body}`)).toEqual([`POST ${RPC} {}`]);
  });

  test("apaga as linhas do dono, e só as dele", async () => {
    postgrest.rows.push({ user_id: USER, schema_version: 1, criteria: {}, salary_ciphertext: "s1.k.a.b.c" }, { user_id: OTHER, schema_version: 1, criteria: {}, salary_ciphertext: "s1.k.a.b.c" });
    postgrest.analyses.push(analysisRow(1), analysisRow(2, OTHER));
    postgrest.feedback.push(feedbackRow(1), feedbackRow(2, OTHER));
    await expect(store.deleteOwn(SUBJECT)).resolves.toEqual({ done: true, result: "excluida" });
    expect(postgrest.rows.map((row) => row.user_id)).toEqual([OTHER]);
    expect(postgrest.analyses.map((row) => row.user_id)).toEqual([OTHER]);
    expect(postgrest.feedback.map((row) => row.user_id)).toEqual([OTHER]);
  });

  test.each([
    ["outra palavra", "ok"],
    ["a palavra em maiúsculas", "EXCLUIDA"],
    ["a palavra com espaço", "excluida "],
    ["booleano", true],
    ["nulo", null],
    ["número", 1],
    ["lista", ["excluida"]],
    ["objeto", { result: "excluida" }],
  ])("resposta fora das três palavras (%s): indisponível", async (_caso, value) => {
    postgrest.deleteResult = value;
    await expect(store.deleteOwn(SUBJECT)).resolves.toEqual(DELETE_UNAVAILABLE);
  });

  test.each([[401], [403], [404], [500], [503]])("status %d: indisponível", async (status) => {
    postgrest.mode = { kind: "status", status };
    await expect(store.deleteOwn(SUBJECT)).resolves.toEqual(DELETE_UNAVAILABLE);
  });

  test("o signal chega ao cliente", async () => {
    postgrest.mode = { kind: "trava" };
    await expect(store.deleteOwn(SUBJECT, AbortSignal.abort())).resolves.toEqual(DELETE_UNAVAILABLE);
    expect(postgrest.requests).toHaveLength(0);
  });
});

describe("records (ADR-029 D4)", () => {
  test("sem linhas: duas listas vazias, sem corte", async () => {
    await expect(store.records(SUBJECT)).resolves.toEqual({ found: true, analyses: [], analysesTruncated: false, feedback: [], feedbackTruncated: false });
  });

  test("as duas leituras: colunas explícitas, filtro pelo dono, da mais nova para a mais velha e páginas de 1.000", async () => {
    await store.records(SUBJECT);
    const sent = postgrest.requests.map((request) => new URL(request.url, "http://x"));
    expect(sent.map((url) => url.pathname).sort()).toEqual(["/rest/v1/analyses", "/rest/v1/analysis_feedback"]);
    const analyses = sent.find((url) => url.pathname === "/rest/v1/analyses") as URL;
    expect(Object.fromEntries(analyses.searchParams)).toEqual({ select: "id,created_at,decision_path,verdict,score", user_id: `eq.${USER}`, order: "created_at.desc,id.desc", limit: "1000" });
    const feedback = sent.find((url) => url.pathname === "/rest/v1/analysis_feedback") as URL;
    expect(Object.fromEntries(feedback.searchParams)).toEqual({ select: "analysis_id,agreement,reason,updated_at", user_id: `eq.${USER}`, order: "updated_at.desc,analysis_id.desc", limit: "1000" });
    expect(ANALYSES_SELECT).toBe("id,created_at,decision_path,verdict,score");
    expect(FEEDBACK_SELECT).toBe("analysis_id,agreement,reason,updated_at");
    expect(ACCOUNT_EXPORT_PAGE_ROWS).toBe(1_000);
    expect(ACCOUNT_EXPORT_MAX_ROWS).toBe(10 * ACCOUNT_EXPORT_PAGE_ROWS);
    for (const request of postgrest.requests) {
      expect(request.method).toBe("GET");
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.apikey).toBe(PUBLISHABLE);
    }
  });

  test("as linhas do dono, sem o user_id, com as datas em UTC; as de outro dono não vêm", async () => {
    postgrest.analyses.push(analysisRow(1), analysisRow(2, OTHER));
    postgrest.feedback.push({ ...feedbackRow(1), reason: null }, feedbackRow(2, OTHER));
    await expect(store.records(SUBJECT)).resolves.toEqual({
      found: true,
      analyses: [{ id: uuid(1), createdAt: "2026-11-15T12:00:00.123Z", decisionPath: "extracao_llm", verdict: "neutro", score: 50 }],
      analysesTruncated: false,
      feedback: [{ analysisId: uuid(1), agreement: "discordo", reason: null, updatedAt: "2026-11-15T12:00:00.000Z" }],
      feedbackTruncated: false,
    });
  });

  /** `n` análises do dono com datas distintas em microssegundos, `step` segundos entre elas (a mais nova é a 1). */
  const plantAnalyses = (n: number, base = Date.UTC(2026, 10, 15, 12)): void => {
    for (let index = 1; index <= n; index += 1) {
      const at = new Date(base - index * 1_000).toISOString().replace("Z", "");
      postgrest.analyses.push({ ...analysisRow(index), created_at: `${at}456+00:00` });
    }
  };

  test("2.500 análises: 3 páginas, na ordem, sem repetição nem buraco; o cursor leva o valor cru do Postgres", async () => {
    plantAnalyses(2_500);
    const result = await store.records(SUBJECT);
    if (!result.found) throw new Error("esperava as listas");
    expect(result.analyses.map((row) => row.id)).toEqual(Array.from({ length: 2_500 }, (_, index) => uuid(index + 1)));
    expect(result.analysesTruncated).toBe(false);
    const pages = postgrest.requests.map((request) => new URL(request.url, "http://x")).filter((url) => url.pathname === "/rest/v1/analyses");
    expect(pages.map((url) => url.searchParams.get("or"))).toEqual([
      null,
      `(created_at.lt."${String(postgrest.analyses[999]?.["created_at"])}",and(created_at.eq."${String(postgrest.analyses[999]?.["created_at"])}",id.lt.${uuid(1_000)}))`,
      `(created_at.lt."${String(postgrest.analyses[1_999]?.["created_at"])}",and(created_at.eq."${String(postgrest.analyses[1_999]?.["created_at"])}",id.lt.${uuid(2_000)}))`,
    ]);
    expect(pages.every((url) => url.searchParams.get("limit") === "1000")).toBe(true);
  });

  test("duas linhas com a mesma data na fronteira da página: o desempate pelo id não perde nem repete nenhuma", async () => {
    plantAnalyses(1_002);
    // A 1.000ª e a 1.001ª ficam com o mesmo instante; na ordem do banco, o id maior vem antes.
    const tie = String(postgrest.analyses[999]?.["created_at"]);
    postgrest.analyses[1_000] = { ...analysisRow(1_001), created_at: tie };
    const result = await store.records(SUBJECT);
    if (!result.found) throw new Error("esperava as listas");
    expect(result.analyses).toHaveLength(1_002);
    expect(new Set(result.analyses.map((row) => row.id)).size).toBe(1_002);
    // Na mesma data, o id maior vem antes: a 1.001ª (id maior) abre a 2ª página sem repetir a 1.000ª.
    expect(result.analyses.slice(999, 1_001).map((row) => row.id)).toEqual([uuid(1_001), uuid(1_000)].sort().reverse());
  });

  test("o mesmo milissegundo com microssegundos diferentes na fronteira: o cursor cru não pula a linha", async () => {
    plantAnalyses(1_001);
    const base = String(postgrest.analyses[999]?.["created_at"]).replace("456+00:00", "");
    postgrest.analyses[999] = { ...postgrest.analyses[999], user_id: USER, created_at: `${base}457+00:00` };
    postgrest.analyses[1_000] = { ...postgrest.analyses[1_000], user_id: USER, created_at: `${base}456+00:00` };
    const result = await store.records(SUBJECT);
    if (!result.found) throw new Error("esperava as listas");
    expect(result.analyses).toHaveLength(1_001);
    expect(new Set(result.analyses.map((row) => row.id)).size).toBe(1_001);
  });

  test("10.000 linhas exatas: 10 páginas e a sonda vazia, sem marca; a 10.001ª liga a marca e nunca sai", async () => {
    plantAnalyses(ACCOUNT_EXPORT_MAX_ROWS);
    for (let index = 1; index <= 3; index += 1) postgrest.feedback.push(feedbackRow(index));
    const exact = await store.records(SUBJECT);
    if (!exact.found) throw new Error("esperava as listas");
    expect(exact.analyses).toHaveLength(ACCOUNT_EXPORT_MAX_ROWS);
    expect(exact.analysesTruncated).toBe(false);
    const probes = postgrest.requests.map((request) => new URL(request.url, "http://x")).filter((url) => url.pathname === "/rest/v1/analyses");
    expect(probes.map((url) => url.searchParams.get("limit"))).toEqual([...Array.from({ length: 10 }, () => "1000"), "1"]);
    postgrest.analyses.push({ ...analysisRow(ACCOUNT_EXPORT_MAX_ROWS + 1), created_at: "2025-12-31T23:00:00.000456+00:00" });
    const over = await store.records(SUBJECT);
    if (!over.found) throw new Error("esperava as listas");
    expect(over.analyses).toHaveLength(ACCOUNT_EXPORT_MAX_ROWS);
    expect(over.analysesTruncated).toBe(true);
    expect(over.analyses.some((row) => row.id === uuid(ACCOUNT_EXPORT_MAX_ROWS + 1))).toBe(false);
  });

  test("as avaliações também paginam pelo cursor (updated_at, analysis_id)", async () => {
    for (let index = 1; index <= 1_001; index += 1) {
      const at = new Date(Date.UTC(2026, 10, 15, 12) - index * 1_000).toISOString().replace("Z", "");
      postgrest.feedback.push({ ...feedbackRow(index), updated_at: `${at}123+00:00` });
    }
    const result = await store.records(SUBJECT);
    if (!result.found) throw new Error("esperava as listas");
    expect(result.feedback.map((row) => row.analysisId)).toEqual(Array.from({ length: 1_001 }, (_, index) => uuid(index + 1)));
    const second = postgrest.requests.map((request) => new URL(request.url, "http://x")).filter((url) => url.pathname === "/rest/v1/analysis_feedback")[1];
    const last = String(postgrest.feedback[999]?.["updated_at"]);
    expect(second?.searchParams.get("or")).toBe(`(updated_at.lt."${last}",and(updated_at.eq."${last}",analysis_id.lt.${uuid(1_000)}))`);
  });

  test.each([2, 3])("a %iª página falha: a lista inteira é indisponível, sem documento parcial", async (failing) => {
    plantAnalyses(2_500);
    let calls = 0;
    const stub: PostgrestUserClient = {
      ...client,
      select: (table, query, token, signal) => {
        if (table === "analyses") calls += 1;
        return table === "analyses" && calls === failing ? Promise.resolve(FAILURE) : client.select(table, query, token, signal);
      },
    };
    await expect(createSupabaseAccountStore({ client: stub }).records(SUBJECT)).resolves.toEqual(RECORDS_UNAVAILABLE);
  });

  test("a sonda de corte que falha: indisponível", async () => {
    plantAnalyses(ACCOUNT_EXPORT_MAX_ROWS);
    const stub: PostgrestUserClient = {
      ...client,
      select: (table, query, token, signal) => (query["limit"] === "1" ? Promise.resolve(FAILURE) : client.select(table, query, token, signal)),
    };
    await expect(createSupabaseAccountStore({ client: stub }).records(SUBJECT)).resolves.toEqual(RECORDS_UNAVAILABLE);
  });

  test.each<[string, OwnedRow]>([
    ["nota fora da faixa", { ...analysisRow(1), score: 101 }],
    ["nota fracionada", { ...analysisRow(1), score: 1.5 }],
    ["veredito fora da lista", { ...analysisRow(1), verdict: "otimo" }],
    ["caminho fora da lista", { ...analysisRow(1), decision_path: "outro" }],
    ["id que não é UUID", { ...analysisRow(1), id: "1" }],
    ["data sem fuso", { ...analysisRow(1), created_at: "2026-11-15T12:00:00" }],
    ["data que não é data", { ...analysisRow(1), created_at: "ontem" }],
    ["coluna nula", { ...analysisRow(1), verdict: null }],
  ])("linha de análise fora da forma (%s): indisponível, nunca uma lista parcial", async (_caso, row) => {
    postgrest.analyses.push(analysisRow(2), row);
    await expect(store.records(SUBJECT)).resolves.toEqual(RECORDS_UNAVAILABLE);
  });

  test.each<[string, OwnedRow]>([
    ["concordância fora da lista", { ...feedbackRow(1), agreement: "talvez" }],
    ["motivo em texto livre", { ...feedbackRow(1), reason: "porque sim" }],
    ["data inválida", { ...feedbackRow(1), updated_at: "" }],
    ["id que não é UUID", { ...feedbackRow(1), analysis_id: "x" }],
  ])("linha de avaliação fora da forma (%s): indisponível", async (_caso, row) => {
    postgrest.feedback.push(row);
    await expect(store.records(SUBJECT)).resolves.toEqual(RECORDS_UNAVAILABLE);
  });

  test.each([
    ["coluna a mais na análise", "/rest/v1/analyses", [{ ...analysisRow(1), job_text: "vaga" }]],
    ["o dono na avaliação", "/rest/v1/analysis_feedback", [feedbackRow(1)]],
    ["objeto no lugar da lista", "/rest/v1/analyses", {}],
    ["mais de 1.000 linhas numa página", "/rest/v1/analyses", Array.from({ length: 1_001 }, (_, index) => ({ id: uuid(index), created_at: "2026-11-15T12:00:00+00:00", decision_path: "extracao_llm", verdict: "neutro", score: 1 }))],
  ])("resposta fora do contrato (%s): indisponível", async (_caso, path, body) => {
    const stub: PostgrestUserClient = {
      ...client,
      select: (table) => Promise.resolve({ ok: true, value: `/rest/v1/${table}` === path ? body : [] }),
    };
    await expect(createSupabaseAccountStore({ client: stub }).records(SUBJECT)).resolves.toEqual(RECORDS_UNAVAILABLE);
  });

  test.each(["analyses", "analysis_feedback"])("uma das leituras falha (%s): indisponível", async (failing) => {
    const stub: PostgrestUserClient = { ...client, select: (table) => Promise.resolve(table === failing ? FAILURE : { ok: true, value: [] }) };
    await expect(createSupabaseAccountStore({ client: stub }).records(SUBJECT)).resolves.toEqual(RECORDS_UNAVAILABLE);
  });

  test("banco fora do ar e o signal de quem chama", async () => {
    postgrest.mode = { kind: "status", status: 503 };
    await expect(store.records(SUBJECT)).resolves.toEqual(RECORDS_UNAVAILABLE);
    postgrest.mode = { kind: "normal" };
    postgrest.requests.length = 0;
    await expect(store.records(SUBJECT, AbortSignal.abort())).resolves.toEqual(RECORDS_UNAVAILABLE);
    expect(postgrest.requests).toHaveLength(0);
  });
});
