// Cliente REST de usuário do PostgREST (ADR-018 D5 e D7) contra um PostgREST simulado em socket real
// (127.0.0.1): cabeçalhos exatos, publishable só no `apikey` e token só no `Authorization`, recusa de chave
// secret e legada no construtor, e falha fechado (`{ ok: false }`, nunca rejeição) em status, `content-type`,
// tamanho, UTF-8, JSON, `__proto__`, prazo, travamento, aborto, redirecionamento e servidor fora do ar.
// O upsert (ADR-021 D5): URL, cabeçalhos e corpo exatos (só as colunas declaradas), teto de 32 KiB em bytes no
// corpo enviado, sucesso só no 201 e o corpo da resposta nunca lido (nem o eco da linha recusada).
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  POSTGREST_CLIENT_POLICY,
  PostgrestClientConfigError,
  createPostgrestUserClient,
  type PostgrestUserClient,
} from "../../src/infrastructure/supabase/postgrest-user-client.js";
import { startFakePostgrest, type FakePostgrest } from "./fakes/fake-postgrest.js";

const PUBLISHABLE = "sb_publishable_AbC123-teste_xyz";
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJh";
const USER = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const QUERY = { select: "schema_version,criteria,salary_ciphertext", user_id: `eq.${USER}` } as const;
const ROW = { user_id: USER, schema_version: 1, criteria: { a: 1 }, salary_ciphertext: "s1.k1.x.y.z" };

let postgrest: FakePostgrest;
let other: FakePostgrest | undefined;
let client: PostgrestUserClient;
beforeEach(async () => {
  postgrest = await startFakePostgrest(PUBLISHABLE);
  postgrest.sessions.set(TOKEN, USER);
  postgrest.rows.push(ROW);
  client = createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: 300 });
});
afterEach(async () => {
  await postgrest.close();
  await other?.close();
  other = undefined;
});

const select = (token = TOKEN, signal?: AbortSignal) => client.select("user_criteria", QUERY, token, signal);
const FAILURE = { ok: false };

describe("construtor: só a chave publishable", () => {
  test.each([
    ["secret", "sb_secret_AbC123-teste_xyz"],
    ["legada (JWT de anon ou service_role)", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.assinatura"],
    ["vazia", ""],
    ["prefixo sem corpo", "sb_publishable_"],
    ["com espaço", "sb_publishable_abc def"],
    ["com quebra de linha", "sb_publishable_abc\nx-injetado: 1"],
    ["prefixo em maiúsculas", "SB_PUBLISHABLE_abc"],
    ["publishable precedida de outra coisa", "xsb_publishable_abc"],
    ["longa demais", `sb_publishable_${"a".repeat(257)}`],
  ])("recusa %s, com mensagem fixa que não repete a chave", (_name, key) => {
    let error: unknown;
    try {
      createPostgrestUserClient({ url: postgrest.url, publishableKey: key });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PostgrestClientConfigError);
    const message = (error as Error).message;
    expect(message).toContain("SUPABASE_PUBLISHABLE_KEY");
    // A mensagem cita o prefixo esperado; tudo além dele seria eco da chave.
    if (key.length > "sb_publishable_".length) expect(message).not.toContain(key);
    expect((error as Error).name).toBe("PostgrestClientConfigError");
  });

  test("aceita a publishable no teto de 256 caracteres depois do prefixo", () => {
    expect(() => createPostgrestUserClient({ url: postgrest.url, publishableKey: `sb_publishable_${"a".repeat(256)}` })).not.toThrow();
  });

  test("política fixada no ADR-018 D5 e no ADR-021 D3 e D5", () => {
    expect(POSTGREST_CLIENT_POLICY).toEqual({
      timeoutMs: 900,
      maxResponseBytes: 32_768,
      maxRequestBytes: 32_768,
      upsertSuccessStatus: 201,
      accessTokenMaxChars: 8_192,
    });
  });
});

describe("protocolo", () => {
  test("GET /rest/v1/user_criteria com o select e o filtro; devolve o array como veio", async () => {
    await expect(select()).resolves.toEqual({
      ok: true,
      value: [{ schema_version: 1, criteria: { a: 1 }, salary_ciphertext: "s1.k1.x.y.z" }],
    });
    const [sent] = postgrest.requests;
    expect(sent?.method).toBe("GET");
    const url = new URL(sent?.url ?? "", "http://x");
    expect(url.pathname).toBe("/rest/v1/user_criteria");
    expect([...url.searchParams]).toEqual([
      ["select", "schema_version,criteria,salary_ciphertext"],
      ["user_id", `eq.${USER}`],
    ]);
  });

  test("cabeçalhos exatos: publishable no apikey, token do usuário no Bearer, accept JSON", async () => {
    await select();
    expect(postgrest.requests[0]).toMatchObject({
      apikey: PUBLISHABLE,
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json",
    });
  });

  test("nenhum sb_secret_ e nenhum token na URL", async () => {
    await select();
    const sent = JSON.stringify(postgrest.requests);
    expect(sent).not.toContain("sb_secret_");
    expect(postgrest.requests[0]?.url).not.toContain(TOKEN);
    expect(postgrest.requests[0]?.url).not.toContain(PUBLISHABLE);
  });

  test("um token por chamada: nada fica guardado entre chamadas", async () => {
    const second = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJiIn0.b3V0cmE";
    await select();
    await select(second);
    expect(postgrest.requests.map((request) => request.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${second}`]);
  });

  test("a URL base com caminho ou barra final dá no mesmo endpoint", async () => {
    const withPath = createPostgrestUserClient({ url: new URL(`${postgrest.url.origin}/outro/caminho/`), publishableKey: PUBLISHABLE });
    await expect(withPath.select("user_criteria", QUERY, TOKEN)).resolves.toMatchObject({ ok: true });
    expect(new URL(postgrest.requests.at(-1)?.url ?? "", "http://x").pathname).toBe("/rest/v1/user_criteria");
  });

  test("valor de filtro com & e = não injeta outro parâmetro", async () => {
    await client.select("user_criteria", { user_id: `eq.${USER}&select=*&role=service_role` }, TOKEN);
    const url = new URL(postgrest.requests[0]?.url ?? "", "http://x");
    expect([...url.searchParams.keys()]).toEqual(["user_id"]);
    expect(url.searchParams.get("user_id")).toBe(`eq.${USER}&select=*&role=service_role`);
  });

  test("content-type com caixa e parâmetros diferentes ainda é JSON", async () => {
    postgrest.mode = { kind: "corpo", body: "[]", contentType: " Application/JSON ; charset=utf-8" };
    await expect(select()).resolves.toEqual({ ok: true, value: [] });
  });

  test("sem signal do chamador, o prazo próprio ainda vale", async () => {
    postgrest.mode = { kind: "trava" };
    const start = performance.now();
    await expect(client.select("user_criteria", QUERY, TOKEN)).resolves.toEqual(FAILURE);
    expect(performance.now() - start).toBeLessThan(900);
  });
});

describe("token fora da forma: falha sem requisição", () => {
  test.each([
    ["vazio", ""],
    ["duas partes", "abc.def"],
    ["quatro partes", "a.b.c.d"],
    ["com espaço", "a.b c.d"],
    ["com quebra de linha", "a.b.c\nx-injetado: 1"],
    ["com padding", "a.b.c="],
    ["parte vazia", "a..c"],
  ])("%s", async (_name, token) => {
    await expect(select(token)).resolves.toEqual(FAILURE);
    expect(postgrest.requests).toHaveLength(0);
  });

  test("teto de 8.192 caracteres: 8.192 sai, 8.193 não", async () => {
    const atLimit = `a.b.${"c".repeat(POSTGREST_CLIENT_POLICY.accessTokenMaxChars - 4)}`;
    expect(atLimit).toHaveLength(8_192);
    // Sai e o servidor recusa (401: sessão desconhecida).
    await expect(select(atLimit)).resolves.toEqual(FAILURE);
    expect(postgrest.requests).toHaveLength(1);
    await expect(select(`${atLimit}c`)).resolves.toEqual(FAILURE);
    expect(postgrest.requests).toHaveLength(1);
  });
});

describe("falha fechado: nunca rejeita, devolve { ok: false }", () => {
  test("publishable errada (401)", async () => {
    const wrong = createPostgrestUserClient({ url: postgrest.url, publishableKey: "sb_publishable_outra" });
    await expect(wrong.select("user_criteria", QUERY, TOKEN)).resolves.toEqual(FAILURE);
  });

  test("token de outra sessão (401)", async () => {
    await expect(select("x.y.z")).resolves.toEqual(FAILURE);
  });

  test.each([[400], [401], [403], [404], [406], [429], [500], [503]])("status %d", async (status) => {
    postgrest.mode = { kind: "status", status };
    await expect(select()).resolves.toEqual(FAILURE);
  });

  test.each([[201], [203], [206], [300], [400], [500]])("status %d com um corpo que seria válido", async (status) => {
    postgrest.mode = { kind: "status", status, body: "[]" };
    await expect(select()).resolves.toEqual(FAILURE);
  });

  test("204 sem corpo", async () => {
    postgrest.mode = { kind: "status", status: 204, body: "" };
    await expect(select()).resolves.toEqual(FAILURE);
  });

  test.each([
    ["sem content-type", null],
    ["texto", "text/plain"],
    ["html", "text/html; charset=utf-8"],
    ["json com sufixo", "application/jsonx"],
    ["vnd do PostgREST", "application/vnd.pgrst.object+json"],
    ["csv", "text/csv"],
  ])("content-type %s com um JSON válido", async (_name, contentType) => {
    postgrest.mode = { kind: "corpo", body: "[]", contentType };
    await expect(select()).resolves.toEqual(FAILURE);
  });

  test("teto exato de 32 KiB: 32.768 bytes passam, 32.769 não", async () => {
    const valid = "[]";
    postgrest.mode = { kind: "corpo", body: valid + " ".repeat(POSTGREST_CLIENT_POLICY.maxResponseBytes - valid.length) };
    await expect(select()).resolves.toEqual({ ok: true, value: [] });
    postgrest.mode = { kind: "corpo", body: valid + " ".repeat(POSTGREST_CLIENT_POLICY.maxResponseBytes - valid.length + 1) };
    await expect(select()).resolves.toEqual(FAILURE);
  });

  test("corpo muito acima do teto (o stream é cortado)", async () => {
    postgrest.mode = { kind: "grande", bytes: 1024 * 1024 };
    await expect(select()).resolves.toEqual(FAILURE);
  });

  test("UTF-8 inválido dentro de uma string de um JSON que seria válido", async () => {
    const body = Buffer.concat([Buffer.from('[{"a":"'), Buffer.from([0xff]), Buffer.from('"}]')]);
    postgrest.mode = { kind: "corpo", body };
    await expect(select()).resolves.toEqual(FAILURE);
  });

  test.each([
    ["JSON inválido", "[{"],
    ["corpo vazio", ""],
    ["__proto__", '[{"criteria":{"__proto__":{"admin":true}}}]'],
    ["__proto__ escapado", '[{"criteria":{"\\u005f_proto__":{"admin":true}}}]'],
    ["constructor", '[{"constructor":{"prototype":{"admin":true}}}]'],
  ])("%s", async (_name, body) => {
    postgrest.mode = { kind: "corpo", body };
    await expect(select()).resolves.toEqual(FAILURE);
  });

  test("lento além do prazo: falha dentro do prazo", async () => {
    postgrest.mode = { kind: "lento", delayMs: 1_000 };
    const start = performance.now();
    await expect(select()).resolves.toEqual(FAILURE);
    expect(performance.now() - start).toBeLessThan(900);
  });

  test("o signal do chamador aborta a requisição", async () => {
    postgrest.mode = { kind: "trava" };
    const slow = createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = slow.select("user_criteria", QUERY, TOKEN, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const start = performance.now();
    await expect(pending).resolves.toEqual(FAILURE);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  test("com o signal do chamador que nunca aborta, o prazo próprio ainda vale", async () => {
    postgrest.mode = { kind: "trava" };
    const start = performance.now();
    await expect(select(TOKEN, new AbortController().signal)).resolves.toEqual(FAILURE);
    expect(performance.now() - start).toBeLessThan(900);
  });

  test("signal já abortado: falha sem esperar", async () => {
    const slow = createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: 10_000 });
    await expect(slow.select("user_criteria", QUERY, TOKEN, AbortSignal.abort())).resolves.toEqual(FAILURE);
  });

  test("redirecionamento não é seguido: o token não vai para outro host", async () => {
    other = await startFakePostgrest(PUBLISHABLE);
    other.sessions.set(TOKEN, USER);
    postgrest.mode = { kind: "redireciona", location: `${other.url.origin}/rest/v1/user_criteria` };
    await expect(select()).resolves.toEqual(FAILURE);
    expect(other.requests).toHaveLength(0);
  });

  test("servidor fora do ar (porta fechada)", async () => {
    const url = postgrest.url;
    await postgrest.close();
    postgrest = await startFakePostgrest(PUBLISHABLE);
    const closed = createPostgrestUserClient({ url, publishableKey: PUBLISHABLE, timeoutMs: 300 });
    await expect(closed.select("user_criteria", QUERY, TOKEN)).resolves.toEqual(FAILURE);
  });
});

// ---------- upsert (ADR-021 D5) ----------

const COLUMNS = ["user_id", "schema_version", "criteria", "salary_ciphertext", "updated_at"] as const;
const WRITE_ROW = {
  user_id: USER,
  schema_version: 1,
  criteria: { a: 2 },
  salary_ciphertext: "s1.k1.novo.y.z",
  updated_at: "2026-10-23T12:00:00.000Z",
};
const UPSERT = { columns: COLUMNS, onConflict: "user_id", row: WRITE_ROW } as const;
const WRITTEN = { ok: true };

const upsert = (token = TOKEN, signal?: AbortSignal, write: Parameters<PostgrestUserClient["upsert"]>[1] = UPSERT) =>
  client.upsert("user_criteria", write, token, signal);

/** O corpo que o cliente monta: só as colunas, na ordem delas. */
const bodyBytes = (row: Readonly<Record<string, unknown>>): number =>
  Buffer.byteLength(JSON.stringify(Object.fromEntries(COLUMNS.map((column) => [column, row[column]]))), "utf8");

describe("upsert: protocolo", () => {
  test("POST /rest/v1/user_criteria com on_conflict e columns; 201 é sucesso e a linha do dono é substituída", async () => {
    await expect(upsert()).resolves.toEqual(WRITTEN);
    const url = new URL(postgrest.requests[0]?.url ?? "", "http://x");
    expect(postgrest.requests[0]?.method).toBe("POST");
    expect(url.pathname).toBe("/rest/v1/user_criteria");
    expect(Object.fromEntries(url.searchParams)).toEqual({ on_conflict: "user_id", columns: COLUMNS.join(",") });
    expect(postgrest.rows).toEqual([WRITE_ROW]);
  });

  test("cabeçalhos exatos: publishable, Bearer do dono, JSON e o Prefer do D5", async () => {
    await upsert();
    expect(postgrest.requests[0]).toMatchObject({
      apikey: PUBLISHABLE,
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  });

  test("o corpo leva exatamente as colunas declaradas, na ordem delas, mesmo com chave a mais no row", async () => {
    const row = { ...WRITE_ROW, salary: "CANARIO-PRETENSAO", role: "service_role" };
    await upsert(TOKEN, undefined, { ...UPSERT, row });
    const body = postgrest.requests[0]?.body ?? "";
    expect(Object.keys(JSON.parse(body) as object)).toEqual([...COLUMNS]);
    expect(body).not.toContain("CANARIO-PRETENSAO");
    expect(body).not.toContain("service_role");
  });

  test("nenhum token na URL", async () => {
    await upsert();
    expect(postgrest.requests[0]?.url).not.toContain(TOKEN);
  });

  test("um token por chamada: nada fica guardado entre chamadas", async () => {
    const second = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJiIn0.c2lnbmF0dXJh";
    postgrest.sessions.set(second, USER);
    await upsert();
    await upsert(second);
    expect(postgrest.requests.map((r) => r.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${second}`]);
  });

  test("sem signal do chamador, o prazo próprio ainda vale", async () => {
    postgrest.mode = { kind: "trava" };
    const start = performance.now();
    await expect(upsert()).resolves.toEqual(FAILURE);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});

describe("upsert: nada é enviado fora da forma", () => {
  test.each([
    ["vazio", ""],
    ["sem três partes", "a.b"],
    ["com quebra de linha", `${TOKEN}\r\nx-injetado: 1`],
    ["acima do teto", `${"a".repeat(POSTGREST_CLIENT_POLICY.accessTokenMaxChars - 3)}.b.c`],
  ])("token %s", async (_name, token) => {
    await expect(upsert(token)).resolves.toEqual(FAILURE);
    expect(postgrest.requests).toHaveLength(0);
  });

  test("teto exato de 32 KiB no corpo enviado: 32.768 bytes saem, 32.769 não", async () => {
    const padded = (bytes: number) => {
      const base = { ...WRITE_ROW, criteria: "" };
      return { ...base, criteria: "a".repeat(bytes - bodyBytes(base)) };
    };
    const atLimit = padded(POSTGREST_CLIENT_POLICY.maxRequestBytes);
    expect(bodyBytes(atLimit)).toBe(32_768);
    await expect(upsert(TOKEN, undefined, { ...UPSERT, row: atLimit })).resolves.toEqual(WRITTEN);
    expect(postgrest.requests).toHaveLength(1);
    const over = padded(POSTGREST_CLIENT_POLICY.maxRequestBytes + 1);
    await expect(upsert(TOKEN, undefined, { ...UPSERT, row: over })).resolves.toEqual(FAILURE);
    expect(postgrest.requests).toHaveLength(1);
  });

  test("o teto conta bytes UTF-8, não caracteres", async () => {
    const base = { ...WRITE_ROW, criteria: "" };
    // 4 bytes por code point: em code units caberia, em bytes não.
    const row = { ...base, criteria: "😀".repeat(Math.ceil((POSTGREST_CLIENT_POLICY.maxRequestBytes - bodyBytes(base)) / 4) + 1) };
    expect(JSON.stringify(row).length).toBeLessThan(POSTGREST_CLIENT_POLICY.maxRequestBytes);
    await expect(upsert(TOKEN, undefined, { ...UPSERT, row })).resolves.toEqual(FAILURE);
    expect(postgrest.requests).toHaveLength(0);
  });

  test.each<[string, unknown]>([
    ["BigInt", 1n],
    ["cíclico", (() => { const cycle: Record<string, unknown> = {}; cycle["self"] = cycle; return cycle; })()],
  ])("valor que não serializa (%s)", async (_name, criteria) => {
    await expect(upsert(TOKEN, undefined, { ...UPSERT, row: { ...WRITE_ROW, criteria } })).resolves.toEqual(FAILURE);
    expect(postgrest.requests).toHaveLength(0);
  });
});

describe("upsert: falha fechado, sem ler o corpo da resposta", () => {
  test.each([
    ["200 (não é o status fixado)", 200],
    ["204", 204],
    ["400", 400],
    ["409 de constraint", 409],
    ["413", 413],
    ["500", 500],
    ["503", 503],
  ])("%s → { ok: false }", async (_name, status) => {
    postgrest.mode = { kind: "status", status };
    await expect(upsert()).resolves.toStrictEqual(FAILURE);
  });

  test("409 cujo corpo ecoa a linha recusada: nada do corpo volta", async () => {
    const echo = '{"code":"23514","details":"Failing row contains (CANARIO-LINHA)","message":"check"}';
    postgrest.mode = { kind: "status", status: 409, body: echo };
    const result = await upsert();
    expect(result).toStrictEqual(FAILURE);
    expect(JSON.stringify(result)).not.toContain("CANARIO");
  });

  test.each([
    ["erro", 409],
    ["sucesso", 201],
  ])("resposta de %s com corpo que nunca termina: o cliente não espera o corpo", async (_name, status) => {
    postgrest.mode = { kind: "sem_fim", status, chunk: '{"details":"Failing row contains (' };
    const slow = createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: 10_000 });
    const start = performance.now();
    await expect(slow.upsert("user_criteria", UPSERT, TOKEN)).resolves.toEqual(status === 201 ? WRITTEN : FAILURE);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  test("publishable errada (401)", async () => {
    const wrong = createPostgrestUserClient({ url: postgrest.url, publishableKey: "sb_publishable_outra", timeoutMs: 300 });
    await expect(wrong.upsert("user_criteria", UPSERT, TOKEN)).resolves.toEqual(FAILURE);
  });

  test("token de outra sessão (401)", async () => {
    await expect(upsert("eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.eA")).resolves.toEqual(FAILURE);
    expect(postgrest.rows).toEqual([ROW]);
  });

  test("linha de outro dono (403 da RLS): nada muda", async () => {
    const intruder = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJpIn0.aQ";
    postgrest.sessions.set(intruder, "0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a");
    await expect(upsert(intruder)).resolves.toEqual(FAILURE);
    expect(postgrest.rows).toEqual([ROW]);
  });

  test("lento além do prazo", async () => {
    postgrest.mode = { kind: "lento", delayMs: 1_000 };
    const start = performance.now();
    await expect(upsert()).resolves.toEqual(FAILURE);
    expect(performance.now() - start).toBeLessThan(900);
  });

  test("socket cortado", async () => {
    postgrest.mode = { kind: "corta" };
    await expect(upsert()).resolves.toEqual(FAILURE);
  });

  test("o signal do chamador aborta a requisição", async () => {
    postgrest.mode = { kind: "trava" };
    const slow = createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = slow.upsert("user_criteria", UPSERT, TOKEN, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const start = performance.now();
    await expect(pending).resolves.toEqual(FAILURE);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  test("com o signal do chamador que nunca aborta, o prazo próprio ainda vale", async () => {
    postgrest.mode = { kind: "trava" };
    const start = performance.now();
    await expect(upsert(TOKEN, new AbortController().signal)).resolves.toEqual(FAILURE);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  test("redirecionamento não é seguido: nem o token nem os critérios vão para outro host", async () => {
    other = await startFakePostgrest(PUBLISHABLE);
    other.sessions.set(TOKEN, USER);
    postgrest.mode = { kind: "redireciona", location: `${other.url.origin}/rest/v1/user_criteria` };
    await expect(upsert()).resolves.toEqual(FAILURE);
    expect(other.requests).toHaveLength(0);
  });

  test("servidor fora do ar (porta fechada)", async () => {
    const url = postgrest.url;
    await postgrest.close();
    postgrest = await startFakePostgrest(PUBLISHABLE);
    const closed = createPostgrestUserClient({ url, publishableKey: PUBLISHABLE, timeoutMs: 300 });
    await expect(closed.upsert("user_criteria", UPSERT, TOKEN)).resolves.toEqual(FAILURE);
  });
});
