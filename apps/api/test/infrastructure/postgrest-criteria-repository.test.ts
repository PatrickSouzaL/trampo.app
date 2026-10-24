// SupabaseCriteriaRepository (ADR-018 D4, D5 e §3) sobre o cliente REST real e um PostgREST simulado em socket
// real, com o SalaryCipher real e chaves geradas no teste. Prova: a leitura do dono com o filtro e a RLS, a
// pretensão aberta (inclusive `null`), e que toda falha de decifragem, `salary` em claro, linha fora da forma ou
// banco fora do ar é `unavailable` (503), NUNCA `found: false` (409) — também pela rota, de ponta a ponta.
// Na escrita (ADR-021 D5, D6 e D10, commit 3): um upsert com as 5 colunas explícitas, a pretensão só dentro do
// envelope com o AAD do dono (canário ausente do corpo cru), a RLS recusando o `user_id` de outro dono, a ida e
// volta com `load` e falha fechado em todo desvio, sem nada do corpo de erro voltar.
import { randomBytes } from "node:crypto";

import {
  ApiErrorSchema,
  USER_CRITERIA_MAX_JSON_BYTES,
  UserCriteriaSchema,
  userCriteriaJsonBytes,
  type UserCriteria,
} from "@trampo/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CriteriaGuard, type CriteriaRepository } from "../../src/application/index.js";
import { createSalaryCipher, parseSalaryKeyring, type SalaryCipher } from "../../src/infrastructure/crypto/salary-cipher.js";
import {
  USER_CRITERIA_COLUMNS,
  USER_CRITERIA_SELECT,
  createSupabaseCriteriaRepository,
} from "../../src/infrastructure/persistence/supabase-criteria-repository.js";
import { createPostgrestUserClient } from "../../src/infrastructure/supabase/postgrest-user-client.js";
import { systemClock } from "../../src/infrastructure/time/system-clock.js";
import { buildApp } from "../../src/presentation/build-app.js";
import { CLEAN_TEXT, JobHarness, REQUEST_ID } from "../application/fakes/analyze-job-harness.js";
import { TEST_AUTHORIZATION, TEST_PRINCIPAL, TEST_TOKEN, fakeVerifier } from "../auth-fakes.js";
import { REQUIRED, criteria, weighted } from "../domain/fakes/scoring-fixtures.js";
import { fakeLimits } from "../limit-fakes.js";
import { startFakePostgrest, type FakePostgrest, type PostgrestMode } from "./fakes/fake-postgrest.js";

const PUBLISHABLE = "sb_publishable_teste-repositorio";
const OWNER = TEST_PRINCIPAL.userId;
const OTHER = "0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a";
const OTHER_TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJvdXRyYSJ9.b3V0cmE";
const SALARY: UserCriteria["salary"] = { minimum: 9_000, currency: "BRL", period: "mes", importance: weighted(3) };

const NOW_MS = Date.parse("2026-10-23T12:00:00.000Z");
const now = (): number => NOW_MS;

const key = (): string => randomBytes(32).toString("base64url");
const KEY_A = key();
const KEY_B = key();

let postgrest: FakePostgrest;
let cipher: SalaryCipher;
let repository: CriteriaRepository;
let app: ReturnType<typeof buildApp> | undefined;

beforeEach(async () => {
  postgrest = await startFakePostgrest(PUBLISHABLE);
  postgrest.sessions.set(TEST_TOKEN, OWNER);
  postgrest.sessions.set(OTHER_TOKEN, OTHER);
  cipher = createSalaryCipher(parseSalaryKeyring(`k1:${KEY_A}`, "k1"));
  repository = createSupabaseCriteriaRepository({
    now,
    client: createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: 300 }),
    cipher,
  });
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await postgrest.close();
});

/** Uma linha gravada direto no PostgREST simulado, no formato que o `save` grava: tudo menos `salary` e `schemaVersion` na coluna `criteria`. */
function store(userId: string, value: UserCriteria, over: Partial<{ criteria: unknown; salary_ciphertext: string; schema_version: number }> = {}): void {
  const { salary, schemaVersion, ...rest } = value;
  postgrest.rows.push({
    user_id: userId,
    schema_version: schemaVersion,
    criteria: rest,
    salary_ciphertext: cipher.seal(userId, salary),
    ...over,
  });
}

const load = (userId = OWNER, accessToken = TEST_TOKEN, signal?: AbortSignal) => repository.load({ userId, accessToken }, signal);
const UNAVAILABLE = { found: false, unavailable: true };

describe("leitura do dono", () => {
  test("abre a pretensão e monta o UserCriteria igual ao gravado", async () => {
    const value = criteria({ salary: SALARY, stack: { ...criteria().stack, mustHave: ["TypeScript"] } });
    store(OWNER, value);
    await expect(load()).resolves.toEqual({ found: true, criteria: value });
  });

  test("pretensão `null` também é cifrada e volta `null`", async () => {
    const value = criteria({ salary: null });
    store(OWNER, value);
    expect(postgrest.rows[0]?.salary_ciphertext).toMatch(/^s1\.k1\./);
    await expect(load()).resolves.toEqual({ found: true, criteria: value });
  });

  test("a consulta é exatamente o select do D5 com o filtro pelo dono", async () => {
    await load();
    const url = new URL(postgrest.requests[0]?.url ?? "", "http://x");
    expect(url.pathname).toBe("/rest/v1/user_criteria");
    expect(Object.fromEntries(url.searchParams)).toEqual({ select: USER_CRITERIA_SELECT, user_id: `eq.${OWNER}` });
    expect(USER_CRITERIA_SELECT).toBe("schema_version,criteria,salary_ciphertext");
    expect(postgrest.requests[0]).toMatchObject({ apikey: PUBLISHABLE, authorization: `Bearer ${TEST_TOKEN}` });
  });

  test("sem linha: não configurado (o único caminho do 409)", async () => {
    await expect(load()).resolves.toEqual({ found: false });
  });

  test("a linha de outro usuário não aparece (filtro e RLS): não configurado", async () => {
    store(OTHER, criteria({ salary: SALARY }));
    await expect(load()).resolves.toEqual({ found: false });
  });

  test("a rotação vale: a linha cifrada com a chave antiga abre com o anel novo", async () => {
    const value = criteria({ salary: SALARY });
    store(OWNER, value);
    const rotated = createSupabaseCriteriaRepository({
      now,
      client: createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE }),
      cipher: createSalaryCipher(parseSalaryKeyring(`k2:${KEY_B},k1:${KEY_A}`, "k2")),
    });
    await expect(rotated.load({ userId: OWNER, accessToken: TEST_TOKEN })).resolves.toEqual({ found: true, criteria: value });
  });

  test("o signal do chamador chega ao cliente (aborto vira unavailable)", async () => {
    postgrest.mode = { kind: "trava" };
    // Prazo do cliente longo: só o signal do chamador explica a resposta rápida.
    const slow = createSupabaseCriteriaRepository({
      now,
      client: createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: 10_000 }),
      cipher,
    });
    const controller = new AbortController();
    const pending = slow.load({ userId: OWNER, accessToken: TEST_TOKEN }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const start = performance.now();
    await expect(pending).resolves.toEqual(UNAVAILABLE);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});

describe("decifragem que falha: unavailable (503), nunca found: false (409)", () => {
  test("chave perdida: o anel não tem mais o kid da linha", async () => {
    store(OWNER, criteria({ salary: SALARY }));
    const lost = createSupabaseCriteriaRepository({
      now,
      client: createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE }),
      cipher: createSalaryCipher(parseSalaryKeyring(`k2:${KEY_B}`, "k2")),
    });
    await expect(lost.load({ userId: OWNER, accessToken: TEST_TOKEN })).resolves.toEqual(UNAVAILABLE);
  });

  test("chave trocada com o mesmo kid", async () => {
    store(OWNER, criteria({ salary: SALARY }));
    const swapped = createSupabaseCriteriaRepository({
      now,
      client: createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE }),
      cipher: createSalaryCipher(parseSalaryKeyring(`k1:${KEY_B}`, "k1")),
    });
    await expect(swapped.load({ userId: OWNER, accessToken: TEST_TOKEN })).resolves.toEqual(UNAVAILABLE);
  });

  test("cifrado de B colado na linha de A (AAD por dono)", async () => {
    store(OWNER, criteria({ salary: null }), { salary_ciphertext: cipher.seal(OTHER, SALARY) });
    await expect(load()).resolves.toEqual(UNAVAILABLE);
  });

  test("tag adulterada", async () => {
    const sealed = cipher.seal(OWNER, SALARY);
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "AQ" : "AA"}`;
    store(OWNER, criteria({ salary: SALARY }), { salary_ciphertext: tampered });
    await expect(load()).resolves.toEqual(UNAVAILABLE);
  });

  test.each([
    ["envelope vazio", ""],
    ["envelope de outra versão", "s2.k1.AAAAAAAAAAAAAAAA.AA.AAAAAAAAAAAAAAAAAAAAAA"],
    ["texto qualquer", "pretensao-em-claro"],
  ])("%s", async (_name, salaryCiphertext) => {
    store(OWNER, criteria({ salary: SALARY }), { salary_ciphertext: salaryCiphertext });
    await expect(load()).resolves.toEqual(UNAVAILABLE);
  });
});

describe("linha fora do contrato: unavailable", () => {
  test("`salary` em claro na coluna `criteria` (mesmo com o cifrado válido)", async () => {
    const value = criteria({ salary: SALARY });
    const { schemaVersion: _version, ...withSalary } = value;
    store(OWNER, value, { criteria: withSalary });
    await expect(load()).resolves.toEqual(UNAVAILABLE);
  });

  test("`salary: null` em claro também é recusado", async () => {
    const { salary: _salary, schemaVersion: _version, ...rest } = criteria();
    store(OWNER, criteria(), { criteria: { ...rest, salary: null } });
    await expect(load()).resolves.toEqual(UNAVAILABLE);
  });

  test("`schemaVersion` dentro da coluna `criteria` não é sobrescrito em silêncio", async () => {
    const { salary: _salary, schemaVersion: _version, ...rest } = criteria();
    store(OWNER, criteria(), { criteria: { ...rest, schemaVersion: 2 } });
    await expect(load()).resolves.toEqual(UNAVAILABLE);
  });

  test("critérios que não passam no UserCriteriaSchema (gravados direto pelo PostgREST)", async () => {
    const { salary: _salary, schemaVersion: _version, ...rest } = criteria();
    store(OWNER, criteria(), { criteria: { ...rest, workModel: { accepted: ["lua"], importance: REQUIRED } } });
    await expect(load()).resolves.toEqual(UNAVAILABLE);
  });

  test("linha acima do teto de bytes do contrato (ADR-021 D3), gravada direto pelo PostgREST", async () => {
    // Tags e cidades de 4 bytes por code point: cada item vale pelo formato, e só o conjunto passa de 12 KiB.
    const astral = (first: number, length: number): string => String.fromCodePoint(first) + String.fromCodePoint(0x1d400).repeat(length - 1);
    const tags = Array.from({ length: 60 }, (_, i) => astral(0x20000 + i, 40));
    // Montado por fora do `criteria()`, que já passa pelo schema (e recusaria o teto).
    const base = criteria();
    const value: UserCriteria = {
      ...base,
      stack: { ...base.stack, mustHave: tags.slice(0, 15), niceToHave: tags.slice(15, 45), dealBreakers: tags.slice(45) },
      location: { acceptedUfs: [], acceptedCities: Array.from({ length: 10 }, (_, i) => astral(0x20100 + i, 80)), importance: REQUIRED },
    };
    expect(userCriteriaJsonBytes(value)).toBeGreaterThan(USER_CRITERIA_MAX_JSON_BYTES);
    const parsed = UserCriteriaSchema.safeParse(value);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual(["criterios_grandes_demais"]);
    store(OWNER, value);
    await expect(load()).resolves.toEqual(UNAVAILABLE);
  });

  test("chave a mais nos critérios", async () => {
    const { salary: _salary, schemaVersion: _version, ...rest } = criteria();
    store(OWNER, criteria(), { criteria: { ...rest, extra: true } });
    await expect(load()).resolves.toEqual(UNAVAILABLE);
  });

  test.each([
    ["schema_version 2", { schema_version: 2 }],
    ["criteria array", { criteria: [] }],
    ["criteria null", { criteria: null }],
    ["criteria texto", { criteria: "{}" }],
  ])("%s", async (_name, over) => {
    store(OWNER, criteria(), over);
    await expect(load()).resolves.toEqual(UNAVAILABLE);
  });

  test.each([
    ["duas linhas", (row: object) => `[${JSON.stringify(row)},${JSON.stringify(row)}]`],
    ["objeto em vez de array", (row: object) => JSON.stringify(row)],
    ["coluna a mais", (row: object) => JSON.stringify([{ ...row, user_id: OWNER }])],
    ["sem o cifrado", (row: object) => JSON.stringify([{ ...row, salary_ciphertext: undefined }])],
    ["cifrado nulo", (row: object) => JSON.stringify([{ ...row, salary_ciphertext: null }])],
    ["null", () => "null"],
  ])("resposta com %s", async (_name, render) => {
    const { salary, schemaVersion, ...rest } = criteria({ salary: SALARY });
    const row = { schema_version: schemaVersion, criteria: rest, salary_ciphertext: cipher.seal(OWNER, salary) };
    postgrest.mode = { kind: "corpo", body: render(row) };
    await expect(load()).resolves.toEqual(UNAVAILABLE);
  });

  test.each([[401], [500], [503]])("banco respondendo %d", async (status) => {
    postgrest.mode = { kind: "status", status };
    await expect(load()).resolves.toEqual(UNAVAILABLE);
  });

  test("token que o banco não reconhece (401 do PostgREST) é unavailable, não 409", async () => {
    store(OWNER, criteria());
    await expect(load(OWNER, "x.y.z")).resolves.toEqual(UNAVAILABLE);
  });
});

describe("de ponta a ponta pela rota (critério 3 do [APPSEC])", () => {
  function routeApp(lines?: string[]) {
    const fakes = fakeLimits();
    app = buildApp({
      accessTokenVerifier: fakeVerifier().verifier,
      limits: fakes.limits,
      logger: lines === undefined ? false : { level: "trace", stream: { write: (line: string) => lines.push(line) } },
      analysis: { job: new JobHarness({ groq: null }).job, criteria: new CriteriaGuard(repository, systemClock) },
    });
    return { app, quota: fakes.quota };
  }

  const post = (instance: ReturnType<typeof buildApp>) =>
    instance.inject({
      method: "POST",
      url: "/v1/analyze",
      headers: { authorization: TEST_AUTHORIZATION, "content-type": "application/json" },
      payload: JSON.stringify({
        schemaVersion: 1,
        requestId: REQUEST_ID,
        source: { platform: "gupy", extractorVersion: "gupy-1" },
        job: { titleHint: "Desenvolvedor Backend Pleno", text: CLEAN_TEXT, clientTruncated: false },
        mode: "auto",
      }),
    });

  test("pretensão que não abre: 503 SERVICO_INDISPONIVEL, nunca 409, e a cota fica intacta", async () => {
    const foreign = cipher.seal(OTHER, SALARY);
    store(OWNER, criteria({ salary: SALARY }), { salary_ciphertext: foreign });
    const lines: string[] = [];
    const { app: instance, quota } = routeApp(lines);
    const res = await post(instance);
    expect(res.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("SERVICO_INDISPONIVEL");
    expect(quota.calls).toEqual([]);
    // Critério 4 e SR-12: nem token, nem chave, nem cifrado, nem dono no log ou na resposta.
    expect(lines.join("")).toContain("criterios_indisponiveis");
    for (const leak of [TEST_TOKEN, PUBLISHABLE, foreign, OWNER, "9000"]) {
      expect(lines.join("")).not.toContain(leak);
      expect(res.body).not.toContain(leak);
    }
  });

  test("controle: sem linha é 409 CRITERIOS_NAO_CONFIGURADOS", async () => {
    const res = await post(routeApp().app);
    expect(res.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("CRITERIOS_NAO_CONFIGURADOS");
  });

  test("controle: linha válida libera a análise (200 em SSE) com o token do dono no PostgREST", async () => {
    store(OWNER, criteria({ salary: SALARY }));
    const res = await post(routeApp().app);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(postgrest.requests.map((request) => request.authorization)).toEqual([`Bearer ${TEST_TOKEN}`]);
  });
});

// ---------- escrita (ADR-021 D5, D6 e D10, commit 3) ----------

/** Valor de pretensão que não aparece em nenhum outro lugar: se surgir no corpo cru, a cifra vazou. */
const CANARY_SALARY: UserCriteria["salary"] = { minimum: 31_415.92, currency: "BRL", period: "mes", importance: weighted(4) };
const SAVE_UNAVAILABLE = { saved: false, unavailable: true };

const save = (value: UserCriteria, userId = OWNER, accessToken = TEST_TOKEN, signal?: AbortSignal) =>
  repository.save({ userId, accessToken }, value, signal);
const sentBody = (index = 0): Record<string, unknown> => JSON.parse(postgrest.requests[index]?.body ?? "null") as Record<string, unknown>;

describe("escrita do dono", () => {
  test("um upsert com on_conflict, columns e os cabeçalhos do D5", async () => {
    await expect(save(criteria({ salary: SALARY }))).resolves.toEqual({ saved: true });
    expect(postgrest.requests).toHaveLength(1);
    const request = postgrest.requests[0];
    const url = new URL(request?.url ?? "", "http://x");
    expect(request?.method).toBe("POST");
    expect(url.pathname).toBe("/rest/v1/user_criteria");
    expect(Object.fromEntries(url.searchParams)).toEqual({ on_conflict: "user_id", columns: USER_CRITERIA_COLUMNS.join(",") });
    expect(USER_CRITERIA_COLUMNS).toEqual(["user_id", "schema_version", "criteria", "salary_ciphertext", "updated_at"]);
    expect(request).toMatchObject({
      apikey: PUBLISHABLE,
      authorization: `Bearer ${TEST_TOKEN}`,
      contentType: "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  });

  test("o corpo tem exatamente as 5 colunas: dono do sujeito, versão, critérios sem salary e schemaVersion, cifrado e o now()", async () => {
    const value = criteria({ salary: SALARY, notes: "remoto" });
    await save(value);
    const body = sentBody();
    const { salary: _salary, schemaVersion: _version, ...column } = value;
    expect(Object.keys(body)).toEqual([...USER_CRITERIA_COLUMNS]);
    expect(body).toMatchObject({ user_id: OWNER, schema_version: 1, criteria: column, updated_at: new Date(NOW_MS).toISOString() });
    expect(Object.keys(body["criteria"] as object)).not.toContain("salary");
    expect(Object.keys(body["criteria"] as object)).not.toContain("schemaVersion");
    expect(body["salary_ciphertext"]).toMatch(/^s1\.k1\./);
  });

  test("canário: o valor da pretensão não aparece no corpo cru, e o cifrado abre só com o AAD do dono", async () => {
    await save(criteria({ salary: CANARY_SALARY }));
    const raw = postgrest.requests[0]?.body ?? "";
    expect(raw).not.toContain("31415.92");
    expect(raw).not.toContain('"salary"');
    expect(raw).not.toContain('"minimum"');
    const sealed = sentBody()["salary_ciphertext"] as string;
    expect(cipher.open(OWNER, sealed)).toEqual({ ok: true, salary: CANARY_SALARY });
    expect(cipher.open(OTHER, sealed)).toEqual({ ok: false });
  });

  test("pretensão null também é cifrada (o envelope existe e abre null)", async () => {
    await save(criteria({ salary: null }));
    const sealed = sentBody()["salary_ciphertext"] as string;
    expect(sealed).toMatch(/^s1\.k1\./);
    expect(cipher.open(OWNER, sealed)).toEqual({ ok: true, salary: null });
  });

  test("ida e volta: save e depois load devolvem os mesmos critérios", async () => {
    const value = criteria({ salary: SALARY, stack: { ...criteria().stack, mustHave: ["TypeScript"] } });
    await expect(save(value)).resolves.toEqual({ saved: true });
    await expect(load()).resolves.toEqual({ found: true, criteria: value });
  });

  test("ida e volta com salary: null", async () => {
    const value = criteria({ salary: null });
    await save(value);
    await expect(load()).resolves.toEqual({ found: true, criteria: value });
  });

  test("a segunda gravação substitui a primeira (uma linha só, última gravação vence)", async () => {
    await save(criteria({ salary: SALARY }));
    const updated = criteria({ salary: null, notes: "nova" });
    await save(updated);
    expect(postgrest.rows).toHaveLength(1);
    await expect(load()).resolves.toEqual({ found: true, criteria: updated });
  });

  test("a gravação sobrescreve uma linha que não abria (chave perdida): o caminho de recuperação do D2", async () => {
    store(OWNER, criteria({ salary: SALARY }), { salary_ciphertext: "s1.k9.lixo.lixo.lixo" });
    await expect(load()).resolves.toEqual(UNAVAILABLE);
    const value = criteria({ salary: SALARY });
    await expect(save(value)).resolves.toEqual({ saved: true });
    await expect(load()).resolves.toEqual({ found: true, criteria: value });
  });

  test("o signal do chamador chega ao cliente", async () => {
    postgrest.mode = { kind: "trava" };
    const slow = createSupabaseCriteriaRepository({
      now,
      client: createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: 10_000 }),
      cipher,
    });
    const controller = new AbortController();
    const pending = slow.save({ userId: OWNER, accessToken: TEST_TOKEN }, criteria(), controller.signal);
    setTimeout(() => controller.abort(), 20);
    const start = performance.now();
    await expect(pending).resolves.toEqual(SAVE_UNAVAILABLE);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  test("pelo CriteriaGuard: o mesmo guarda grava e lê", async () => {
    const guard = new CriteriaGuard(repository, systemClock);
    const value = criteria({ salary: SALARY });
    await expect(guard.save({ userId: OWNER, accessToken: TEST_TOKEN }, value)).resolves.toEqual({ saved: true });
    await expect(guard.load({ userId: OWNER, accessToken: TEST_TOKEN })).resolves.toEqual({ found: true, criteria: value });
  });
});

describe("escrita: falha fechado (unavailable, nunca rejeita)", () => {
  test("dono fora do contrato do envelope (SalarySealError): nada é enviado", async () => {
    await expect(save(criteria({ salary: SALARY }), "nao-e-uuid")).resolves.toEqual(SAVE_UNAVAILABLE);
    expect(postgrest.requests).toHaveLength(0);
  });

  test("pretensão fora do contrato (SalarySealError): nada é enviado", async () => {
    const bad = { ...criteria(), salary: { ...SALARY, minimum: -1 } } as UserCriteria;
    await expect(save(bad)).resolves.toEqual(SAVE_UNAVAILABLE);
    expect(postgrest.requests).toHaveLength(0);
  });

  test("relógio inválido: nada é enviado", async () => {
    const broken = createSupabaseCriteriaRepository({
      now: () => Number.NaN,
      client: createPostgrestUserClient({ url: postgrest.url, publishableKey: PUBLISHABLE, timeoutMs: 300 }),
      cipher,
    });
    await expect(broken.save({ userId: OWNER, accessToken: TEST_TOKEN }, criteria())).resolves.toEqual(SAVE_UNAVAILABLE);
    expect(postgrest.requests).toHaveLength(0);
  });

  test("token sem sessão (401)", async () => {
    await expect(save(criteria(), OWNER, "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.eA")).resolves.toEqual(SAVE_UNAVAILABLE);
    expect(postgrest.rows).toEqual([]);
  });

  test("primeira barreira furada de propósito (user_id de B com o token de A): a RLS recusa e a linha de B fica intacta", async () => {
    const otherValue = criteria({ salary: SALARY, notes: "de B" });
    store(OTHER, otherValue);
    const before = structuredClone(postgrest.rows);
    await expect(save(criteria({ salary: null }), OTHER, TEST_TOKEN)).resolves.toEqual(SAVE_UNAVAILABLE);
    expect(postgrest.rows).toEqual(before);
    await expect(load(OTHER, OTHER_TOKEN)).resolves.toEqual({ found: true, criteria: otherValue });
  });

  test("409 cujo corpo ecoa um canário da linha: o canário não aparece em lugar nenhum", async () => {
    postgrest.mode = { kind: "status", status: 409, body: '{"code":"23514","details":"Failing row contains (CANARIO-31415)"}' };
    const result = await save(criteria({ salary: CANARY_SALARY }));
    expect(result).toStrictEqual(SAVE_UNAVAILABLE);
    expect(JSON.stringify(result)).not.toContain("CANARIO");
  });

  test.each([401, 403, 413, 500, 200, 204])("status %i", async (status) => {
    postgrest.mode = { kind: "status", status };
    await expect(save(criteria())).resolves.toStrictEqual(SAVE_UNAVAILABLE);
  });

  test.each<[string, PostgrestMode]>([
    ["lento além do prazo", { kind: "lento", delayMs: 1_000 }],
    ["travado", { kind: "trava" }],
    ["socket cortado", { kind: "corta" }],
  ])("%s", async (_name, mode) => {
    postgrest.mode = mode;
    await expect(save(criteria())).resolves.toEqual(SAVE_UNAVAILABLE);
  });

  test("redirecionamento: zero requisições ao 2º host", async () => {
    const second = await startFakePostgrest(PUBLISHABLE);
    second.sessions.set(TEST_TOKEN, OWNER);
    try {
      postgrest.mode = { kind: "redireciona", location: `${second.url.origin}/rest/v1/user_criteria` };
      await expect(save(criteria({ salary: SALARY }))).resolves.toEqual(SAVE_UNAVAILABLE);
      expect(second.requests).toHaveLength(0);
    } finally {
      await second.close();
    }
  });
});
