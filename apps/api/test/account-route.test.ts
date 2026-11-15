// ADR-029 D3 a D5 (condições 8 a 12): GET /v1/account/export e POST /v1/account/delete pelo buildApp, com o
// AccountService real em volta de um AccountStore falso. Cobre o registro pela opção `account`, a ordem de defesa (401
// sem ler o corpo, 413 sem parse, rate limit da classe `conta` antes do corpo, 400 sem tocar no banco), os desfechos
// de cada rota, o `Cache-Control: no-store` em toda resposta, o SR-12 com o log capturado e o CORS (a extensão não
// alcança nenhuma das duas). O fluxo com as peças reais (JWT, PostgREST simulado e cifra) está no teste de boot.
import { randomUUID } from "node:crypto";

import { ApiErrorSchema } from "@trampo/contracts";
import { ACCOUNT_ROUTES, AccountExportSchema } from "@trampo/contracts/account";
import { ACCOUNT_DELETE_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import Fastify from "fastify";
import { afterEach, describe, expect, test } from "vitest";

import { AccountService, CriteriaGuard, type AccountDeletion, type AccountRecords, type AccountStore } from "../src/application/index.js";
import { systemClock } from "../src/infrastructure/time/system-clock.js";
import { buildApp } from "../src/presentation/build-app.js";
import { LOG_ALLOWLIST, LOG_MESSAGES } from "../src/presentation/logging/log-policy.js";
import { createDeleteAccountHandler, createExportAccountHandler, type AccountRouteOptions } from "../src/presentation/routes/account.js";
import { FakeCriteriaRepository } from "./application/fakes/fake-criteria-repository.js";
import { TEST_AUTHORIZATION, TEST_PRINCIPAL, TEST_TOKEN, fakeVerifier } from "./auth-fakes.js";
import { criteria } from "./domain/fakes/scoring-fixtures.js";
import { type FakeBehavior, fakeLimits } from "./limit-fakes.js";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PORTAL = "https://portal.trampo.example";
const LIMITED = { kind: "valor", value: { ok: false, reason: "limite_excedido", retryAfterSeconds: 30 } } as const;
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const ID = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const SALARY_CANARY = 987_654;
const analysis = { id: ID, createdAt: "2026-11-15T11:00:00.000Z", decisionPath: "extracao_llm", verdict: "neutro", score: 50 } as const;
const feedback = { analysisId: ID, agreement: "concordo", reason: null, updatedAt: "2026-11-15T11:30:00.000Z" } as const;
const CONFIRMED = { schemaVersion: 1, confirmation: "excluir minha conta" };
// Os literais do contrato, não as constantes: renomear uma rota tem de quebrar o teste.
const EXPORT_PATH = "/v1/account/export";
const DELETE_PATH = "/v1/account/delete";

class FakeAccountStore implements AccountStore {
  readonly deletes: { readonly userId: string; readonly accessToken: string }[] = [];
  readonly reads: { readonly userId: string; readonly accessToken: string }[] = [];
  deletion: AccountDeletion = { done: true, result: "excluida" };
  records_: AccountRecords = { found: true, analyses: [analysis], analysesTruncated: false, feedback: [feedback], feedbackTruncated: false };

  deleteOwn(subject: { readonly userId: string; readonly accessToken: string }): Promise<AccountDeletion> {
    this.deletes.push(subject);
    return Promise.resolve(this.deletion);
  }

  records(subject: { readonly userId: string; readonly accessToken: string }): Promise<AccountRecords> {
    this.reads.push(subject);
    return Promise.resolve(this.records_);
  }
}

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface AppOptions {
  readonly store?: FakeAccountStore;
  readonly criteria?: FakeCriteriaRepository;
  readonly service?: AccountRouteOptions["service"];
  readonly rate?: FakeBehavior;
  readonly lines?: string[];
  readonly throwOn?: readonly string[];
}

function accountApp(options: AppOptions = {}) {
  const store = options.store ?? new FakeAccountStore();
  const repository = options.criteria ?? new FakeCriteriaRepository();
  const fakes = fakeLimits(options.rate === undefined ? {} : { rate: options.rate });
  const throwOn = options.throwOn ?? [];
  const stream = {
    write: (line: string) => {
      options.lines?.push(line);
      if (throwOn.some((msg) => line.includes(`"msg":"${msg}"`))) throw new Error("destino de log fora do ar");
    },
  };
  const counts = { parser: 0 };
  const service = options.service ?? new AccountService({ store, criteria: new CriteriaGuard(repository, systemClock), clock: systemClock, now: () => NOW });
  const instance = buildApp({
    accessTokenVerifier: fakeVerifier().verifier,
    limits: fakes.limits,
    corsAllowedOrigins: [EXTENSION, PORTAL],
    logger: options.lines === undefined && throwOn.length === 0 ? false : { level: "trace", stream },
    account: { service },
  });
  const defaultJson = instance.getDefaultJsonParser("error", "error");
  instance.removeContentTypeParser("application/json");
  instance.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    counts.parser += 1;
    defaultJson(request, typeof body === "string" ? body : body.toString("utf8"), done);
  });
  app = instance;
  return { app: instance, store, repository, rate: fakes.rate, quota: fakes.quota, counts };
}

function exportData(instance: ReturnType<typeof buildApp>, headers: Record<string, string> = {}, url = EXPORT_PATH) {
  return instance.inject({ method: "GET", url, headers: { authorization: TEST_AUTHORIZATION, ...headers } });
}

function remove(instance: ReturnType<typeof buildApp>, payload: unknown = CONFIRMED, headers: Record<string, string> = {}, url = DELETE_PATH) {
  return instance.inject({
    method: "POST",
    url,
    headers: { authorization: TEST_AUTHORIZATION, "content-type": "application/json", ...headers },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

const records = (lines: readonly string[]) => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const messages = (lines: readonly string[], level: number) => records(lines).filter((r) => r["level"] === level).map((r) => r["msg"]);

function expectApiError(res: { statusCode: number; json: () => unknown }, status: number, code: string) {
  expect(res.statusCode).toBe(status);
  const parsed = ApiErrorSchema.parse(res.json());
  expect(parsed.code).toBe(code);
  expect(Object.keys(res.json() as object).sort()).toEqual(["code", "message", "requestId", "retryAfterSeconds"]);
}

describe("registro (ADR-029 D3 e D5)", () => {
  test("sem a opção `account`, as duas rotas não existem: 404 com token, 401 sem", async () => {
    const bare = buildApp({ accessTokenVerifier: fakeVerifier().verifier, limits: fakeLimits().limits, logger: false });
    app = bare;
    expectApiError(await exportData(bare), 404, "PROIBIDO");
    expectApiError(await remove(bare), 404, "PROIBIDO");
    expect((await bare.inject({ method: "GET", url: EXPORT_PATH })).statusCode).toBe(401);
  });

  test("as constantes das rotas são os literais do contrato", () => {
    expect(ACCOUNT_ROUTES).toEqual({ export: EXPORT_PATH, delete: DELETE_PATH });
  });

  test("as duas na classe `conta`, e nenhuma gasta cota diária", async () => {
    const { app, rate, quota } = accountApp();
    await exportData(app);
    await remove(app);
    expect(rate.calls.map((call) => call.rateClass)).toEqual(["conta", "conta"]);
    expect(quota.calls).toHaveLength(0);
  });

  test.each([
    ["DELETE na rota de exclusão", "DELETE", DELETE_PATH],
    ["GET na rota de exclusão", "GET", DELETE_PATH],
    ["PUT na rota de exclusão", "PUT", DELETE_PATH],
    ["POST na rota de exportação", "POST", EXPORT_PATH],
    ["DELETE em /v1/account", "DELETE", "/v1/account"],
    ["barra final", "POST", `${DELETE_PATH}/`],
    ["caixa diferente", "POST", "/v1/Account/Delete"],
  ])("%s: 404, e nada chega ao banco", async (_caso, method, url) => {
    const { app, store } = accountApp();
    const res = await app.inject({ method: method as "GET", url, headers: { authorization: TEST_AUTHORIZATION, "content-type": "application/json" }, ...(method === "GET" ? {} : { payload: JSON.stringify(CONFIRMED) }) });
    expect(res.statusCode).toBe(404);
    expect(store.deletes).toHaveLength(0);
    expect(store.reads).toHaveLength(0);
  });
});

describe("POST /v1/account/delete", () => {
  test("204 sem corpo, com no-store; o dono é o do principal e o token é o Bearer verificado", async () => {
    const { app, store } = accountApp();
    const res = await remove(app);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(store.deletes).toEqual([{ userId: TEST_PRINCIPAL.userId, accessToken: TEST_TOKEN }]);
    expect(store.reads).toHaveLength(0);
  });

  test("repetir é seguro: ja_excluida também é 204", async () => {
    const store = new FakeAccountStore();
    store.deletion = { done: true, result: "ja_excluida" };
    const { app } = accountApp({ store });
    expect((await remove(app)).statusCode).toBe(204);
  });

  test("login antigo: 403 PROIBIDO, sem código novo no catálogo, e nada no log de aviso", async () => {
    const lines: string[] = [];
    const store = new FakeAccountStore();
    store.deletion = { done: true, result: "login_antigo" };
    const { app } = accountApp({ store, lines });
    const res = await remove(app);
    expectApiError(res, 403, "PROIBIDO");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(messages(lines, 40)).toEqual([]);
    expect(records(lines).map((r) => r["msg"])).not.toContain("conta_excluida");
  });

  test("banco fora do ar: 503 (não prova nada), no-store e só `conta_exclusao_indisponivel` no log", async () => {
    const lines: string[] = [];
    const store = new FakeAccountStore();
    store.deletion = { done: false, unavailable: true };
    const { app } = accountApp({ store, lines });
    const res = await remove(app);
    expectApiError(res, 503, "SERVICO_INDISPONIVEL");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(messages(lines, 40)).toEqual(["conta_exclusao_indisponivel"]);
    expect(store.deletes).toHaveLength(1);
  });

  test.each([
    ["vazio", {}],
    ["sem a frase", { schemaVersion: 1 }],
    ["frase errada", { schemaVersion: 1, confirmation: "excluir" }],
    ["frase em maiúsculas", { schemaVersion: 1, confirmation: "EXCLUIR MINHA CONTA" }],
    ["versão 2", { schemaVersion: 2, confirmation: "excluir minha conta" }],
    ["alvo no corpo", { ...CONFIRMED, userId: "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f" }],
    ["lista", [CONFIRMED]],
    ["JSON inválido", "{"],
    ["nulo", "null"],
  ])("corpo sem a confirmação exata (%s): 400, e nada chega ao banco", async (_caso, payload) => {
    const { app, store } = accountApp();
    const res = await remove(app, payload);
    expectApiError(res, 400, "PAYLOAD_INVALIDO");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(res.json())).not.toMatch(/confirmation|schemaVersion|Invalid|expected/);
    expect(store.deletes).toHaveLength(0);
  });

  test("sem corpo e sem content-type: recusado antes do banco", async () => {
    const { app, store } = accountApp();
    const res = await app.inject({ method: "POST", url: DELETE_PATH, headers: { authorization: TEST_AUTHORIZATION } });
    expect([400, 415]).toContain(res.statusCode);
    expect(store.deletes).toHaveLength(0);
  });

  test("corpo acima de 256 bytes: 413 sem parse; no teto exato ele é lido (e recusado pelo schema)", async () => {
    const { app, store, counts } = accountApp();
    const pad = (bytes: number): string => {
      const base = JSON.stringify({ ...CONFIRMED, x: "" });
      return JSON.stringify({ ...CONFIRMED, x: "a".repeat(bytes - base.length) });
    };
    expect(pad(ACCOUNT_DELETE_BODY_MAX_BYTES + 1)).toHaveLength(257);
    expectApiError(await remove(app, pad(ACCOUNT_DELETE_BODY_MAX_BYTES + 1)), 413, "PAYLOAD_GRANDE_DEMAIS");
    expect(counts.parser).toBe(0);
    expectApiError(await remove(app, pad(ACCOUNT_DELETE_BODY_MAX_BYTES)), 400, "PAYLOAD_INVALIDO");
    expect(counts.parser).toBe(1);
    expect(store.deletes).toHaveLength(0);
  });

  test("sem token: 401 sem ler o corpo; token recusado: 401; nada chega ao banco", async () => {
    const { app, store, counts } = accountApp();
    const res = await app.inject({ method: "POST", url: DELETE_PATH, headers: { "content-type": "application/json" }, payload: JSON.stringify(CONFIRMED) });
    expectApiError(res, 401, "NAO_AUTENTICADO");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(counts.parser).toBe(0);
    expect(store.deletes).toHaveLength(0);
  });

  test("rate limit: 429 antes de ler o corpo, com no-store", async () => {
    const { app, store, counts } = accountApp({ rate: LIMITED });
    const res = await remove(app);
    expectApiError(res, 429, "LIMITE_DE_TAXA");
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(counts.parser).toBe(0);
    expect(store.deletes).toHaveLength(0);
  });

  test("nada do pedido escolhe o alvo: query e cabeçalhos hostis não mudam o dono", async () => {
    const { app, store } = accountApp();
    const other = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f";
    const res = await remove(app, CONFIRMED, { "x-user-id": other, "x-forwarded-user": other }, `${DELETE_PATH}?user_id=${other}&uid=${other}`);
    expect(res.statusCode).toBe(204);
    expect(store.deletes).toEqual([{ userId: TEST_PRINCIPAL.userId, accessToken: TEST_TOKEN }]);
  });

  test("o serviço que rejeita ou devolve lixo: 503, nunca 204", async () => {
    for (const service of [
      { delete: () => Promise.reject(new Error("x")), export: () => Promise.reject(new Error("x")) },
      { delete: () => Promise.resolve("ok" as never), export: () => Promise.resolve({ ok: false } as const) },
    ]) {
      const { app } = accountApp({ service });
      expectApiError(await remove(app), 503, "SERVICO_INDISPONIVEL");
      await app.close();
    }
  });

  test("log que lança em `conta_excluida` ou no aviso: a resposta não muda", async () => {
    const ok = accountApp({ throwOn: ["conta_excluida"] });
    expect((await remove(ok.app)).statusCode).toBe(204);
    await ok.app.close();
    const store = new FakeAccountStore();
    store.deletion = { done: false, unavailable: true };
    const failing = accountApp({ store, throwOn: ["conta_exclusao_indisponivel"] });
    expectApiError(await remove(failing.app), 503, "SERVICO_INDISPONIVEL");
  });
});

describe("GET /v1/account/export", () => {
  test("200 com o documento do contrato (a pretensão em claro só aqui), no-store", async () => {
    const repository = new FakeCriteriaRepository().set(TEST_PRINCIPAL.userId, criteria({ salary: { minimum: SALARY_CANARY, currency: "BRL", period: "mes", importance: { level: "obrigatorio" } } }));
    const { app, store } = accountApp({ criteria: repository });
    const res = await exportData(app);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    const document = AccountExportSchema.parse(res.json());
    expect(document.exportedAt).toBe("2026-11-15T12:00:00.000Z");
    expect(document.criteria?.salary?.minimum).toBe(SALARY_CANARY);
    expect(document.analyses).toEqual([analysis]);
    expect(document.feedback).toEqual([feedback]);
    expect(Object.keys(res.json() as object).sort()).toEqual(["analyses", "analysesTruncated", "criteria", "exportedAt", "feedback", "feedbackTruncated", "schemaVersion"]);
    expect(store.reads).toEqual([{ userId: TEST_PRINCIPAL.userId, accessToken: TEST_TOKEN }]);
    expect(repository.loads).toEqual([TEST_PRINCIPAL.userId]);
    expect(repository.tokens).toEqual([TEST_TOKEN]);
    expect(store.deletes).toHaveLength(0);
  });

  test("quem nunca salvou critérios: criteria null", async () => {
    const { app } = accountApp();
    const res = await exportData(app);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { criteria: unknown }).criteria).toBeNull();
  });

  test.each(["listas", "criterios"])("falha fechada (%s indisponíveis): 503, no-store e só `conta_exportacao_indisponivel` no log", async (which) => {
    const lines: string[] = [];
    const store = new FakeAccountStore();
    const repository = new FakeCriteriaRepository();
    if (which === "listas") store.records_ = { found: false, unavailable: true };
    else repository.unavailable = true;
    const { app } = accountApp({ store, criteria: repository, lines });
    const res = await exportData(app);
    expectApiError(res, 503, "SERVICO_INDISPONIVEL");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(messages(lines, 40)).toEqual(["conta_exportacao_indisponivel"]);
  });

  test("o serviço que rejeita: 503; documento fora do contrato não sai (o serializador barra)", async () => {
    const rejecting = accountApp({ service: { delete: () => Promise.resolve("indisponivel"), export: () => Promise.reject(new Error("x")) } });
    expectApiError(await exportData(rejecting.app), 503, "SERVICO_INDISPONIVEL");
    await rejecting.app.close();
    const leaking = accountApp({
      service: { delete: () => Promise.resolve("indisponivel"), export: () => Promise.resolve({ ok: true, document: { schemaVersion: 1, userId: TEST_PRINCIPAL.userId } as never }) },
    });
    const res = await exportData(leaking.app);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(TEST_PRINCIPAL.userId);
  });

  test("sem token: 401; rate limit: 429; os dois com no-store e sem tocar no banco", async () => {
    const open = accountApp();
    const unauthenticated = await open.app.inject({ method: "GET", url: EXPORT_PATH });
    expectApiError(unauthenticated, 401, "NAO_AUTENTICADO");
    expect(unauthenticated.headers["cache-control"]).toBe("no-store");
    expect(open.store.reads).toHaveLength(0);
    await open.app.close();
    const limited = accountApp({ rate: LIMITED });
    const res = await exportData(limited.app);
    expectApiError(res, 429, "LIMITE_DE_TAXA");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(limited.store.reads).toHaveLength(0);
  });

  test("log que lança no aviso: ainda 503", async () => {
    const store = new FakeAccountStore();
    store.records_ = { found: false, unavailable: true };
    const { app } = accountApp({ store, throwOn: ["conta_exportacao_indisponivel"] });
    expectApiError(await exportData(app), 503, "SERVICO_INDISPONIVEL");
  });
});

describe("handlers sem principal (quebra de invariante): 401, sem tocar no serviço", () => {
  test.each([
    ["exportação", createExportAccountHandler],
    ["exclusão", createDeleteAccountHandler],
  ])("%s", async (_caso, create) => {
    let touched = 0;
    const service: AccountRouteOptions["service"] = {
      delete: () => {
        touched += 1;
        return Promise.resolve("excluida");
      },
      export: () => {
        touched += 1;
        return Promise.resolve({ ok: false });
      },
    };
    const bare = Fastify({ logger: false, genReqId: () => randomUUID() });
    bare.decorateRequest("principal", null);
    bare.all("/x", async (request, reply) => create(service)(request, reply));
    const without = await bare.inject({ method: "POST", url: "/x", headers: { authorization: TEST_AUTHORIZATION } });
    expect(without.statusCode).toBe(401);
    const noBearer = Fastify({ logger: false, genReqId: () => randomUUID() });
    noBearer.decorateRequest("principal", null);
    noBearer.addHook("onRequest", async (request) => {
      request.principal = TEST_PRINCIPAL;
    });
    noBearer.all("/x", async (request, reply) => create(service)(request, reply));
    expect((await noBearer.inject({ method: "POST", url: "/x" })).statusCode).toBe(401);
    expect(touched).toBe(0);
    await bare.close();
    await noBearer.close();
  });
});

describe("SR-12 e o registro mínimo (ADR-029 D3)", () => {
  test("`conta_excluida`: uma linha de info sem campo nenhum além dos do catálogo, e nada do sub, do token ou dos dados em linha nenhuma", async () => {
    const lines: string[] = [];
    const repository = new FakeCriteriaRepository().set(TEST_PRINCIPAL.userId, criteria({ salary: { minimum: SALARY_CANARY, currency: "BRL", period: "mes", importance: { level: "obrigatorio" } } }));
    const { app } = accountApp({ lines, criteria: repository });
    expect((await exportData(app)).statusCode).toBe(200);
    expect((await remove(app)).statusCode).toBe(204);
    expect(messages(lines, 30).filter((msg) => msg === "conta_excluida")).toHaveLength(1);
    const line = records(lines).find((r) => r["msg"] === "conta_excluida") as Record<string, unknown>;
    expect(Object.keys(line).every((key) => (LOG_ALLOWLIST.top as readonly string[]).includes(key))).toBe(true);
    // Só o nível, a hora, a mensagem e o id do pedido: nenhum campo de usuário.
    expect(Object.keys(line).sort()).toEqual(["level", "msg", "reqId", "time"]);
    const all = lines.join("\n");
    for (const secret of [TEST_PRINCIPAL.userId, TEST_PRINCIPAL.sessionId, TEST_TOKEN, String(SALARY_CANARY), ID, "excluir minha conta"]) expect(all).not.toContain(secret);
    for (const message of ["conta_excluida", "conta_exclusao_indisponivel", "conta_exportacao_indisponivel"]) expect(LOG_MESSAGES).toContain(message);
  });
});

describe("CORS (ADR-029 D5): a extensão não alcança nenhuma das duas", () => {
  test("origem da extensão: 403 na borda, antes do JWT e do banco; o preflight também", async () => {
    const { app, store, rate } = accountApp();
    expectApiError(await exportData(app, { origin: EXTENSION }), 403, "PROIBIDO");
    expectApiError(await remove(app, CONFIRMED, { origin: EXTENSION }), 403, "PROIBIDO");
    for (const [method, url] of [["GET", EXPORT_PATH], ["POST", DELETE_PATH]] as const) {
      const preflight = await app.inject({ method: "OPTIONS", url, headers: { origin: EXTENSION, "access-control-request-method": method } });
      expect(preflight.statusCode).toBe(403);
    }
    expectApiError(await remove(app, CONFIRMED, { origin: EXTENSION }, "/v1/%61ccount/delete"), 403, "PROIBIDO");
    expect(store.deletes).toHaveLength(0);
    expect(store.reads).toHaveLength(0);
    expect(rate.calls).toHaveLength(0);
  });

  test("origem fora da lista: 403; sem Origin (o portal, servidor a servidor) e com a origem do portal: passa", async () => {
    const { app, store } = accountApp();
    expectApiError(await remove(app, CONFIRMED, { origin: "https://evil.invalid" }), 403, "PROIBIDO");
    expect(store.deletes).toHaveLength(0);
    expect((await exportData(app)).statusCode).toBe(200);
    const withOrigin = await exportData(app, { origin: PORTAL });
    expect(withOrigin.statusCode).toBe(200);
    expect(withOrigin.headers["access-control-allow-origin"]).toBe(PORTAL);
  });
});
