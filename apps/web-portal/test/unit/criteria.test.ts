// DAL dos critérios (ADR-028 D4 a D8): a página e a gravação contra o GoTrue e a API simulados, em socket real, com a
// sessão de verdade do portal. Prova a tabela do D6, o 401 da API que só apaga a sessão depois da recusa do GoTrue,
// o rascunho selado de uso único e que a pretensão nunca vai a destino nem a aviso.
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApiClient } from "../../src/server/api-client";
import { parsePortalConfig, type PortalConfig } from "../../src/server/config";
import { COOKIE_NAMES, type CookieWrite } from "../../src/server/cookies";
import { DRAFT_POLICY, createCriteriaDal, type CriteriaDal } from "../../src/server/criteria";
import { criteriaToForm, defaultFormValues, formPairs, type FormValues } from "../../src/server/criteria-form";
import { createGotrueClient } from "../../src/server/gotrue";
import { SEAL_PURPOSES, createSealer } from "../../src/server/seal";
import { createPortalAuth, type PortalAuth, type Redirect } from "../../src/server/session";
import { createAccessTokenVerifier } from "../../src/server/verifier";
import { SALARY_CANARY_TEXT, fullCriteria } from "../support/criteria-fixtures";
import { startFakeApi, type FakeApi } from "../support/fake-api";
import { GOTRUE_CANARIES, startFakeGotrue, type FakeGotrue } from "../support/fake-gotrue";

const PUBLISHABLE = ["sb", "publishable", "c".repeat(24)].join("_");
const PORTAL = "http://127.0.0.1:3997";
const CRITERIOS = `${PORTAL}/conta/criterios`;
const URLENCODED = "application/x-www-form-urlencoded";
let fake: FakeGotrue;
let api: FakeApi;
let config: PortalConfig;
let clock = { ms: Date.now() };
let auth: PortalAuth;
let dal: CriteriaDal;

beforeAll(async () => {
  fake = await startFakeGotrue({ publishableKey: PUBLISHABLE, allowedRedirects: [`${PORTAL}/auth/retorno`] });
  // A API simulada aceita os access que o GoTrue simulado emitiu, como o verificador da API real.
  api = await startFakeApi({ owner: (token) => (fake.issued.some((pair) => pair.accessToken === token) ? GOTRUE_CANARIES.userId : null) });
  config = parsePortalConfig({
    PORTAL_ORIGIN: PORTAL,
    SUPABASE_URL: fake.url.origin,
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    API_ORIGIN: api.url.origin,
    PORTAL_SEAL_KEYS: `c1:${randomBytes(32).toString("base64url")}`,
    PORTAL_SEAL_ACTIVE_KEY: "c1",
  });
});
afterAll(async () => {
  await fake.close();
  await api.close();
});
beforeEach(() => {
  fake.mode = { kind: "normal" };
  fake.hookRefuses = false;
  fake.claims = {};
  fake.expiresIn = 900;
  api.mode = { kind: "normal" };
  api.rows.clear();
  api.requests.length = 0;
  fake.requests.length = 0;
  clock = { ms: Date.now() };
  auth = createPortalAuth({
    config,
    gotrue: createGotrueClient({ supabaseUrl: config.supabaseUrl, publishableKey: PUBLISHABLE, timeoutMs: 500 }),
    verifier: createAccessTokenVerifier({ issuer: config.issuer, jwksUrl: config.jwksUrl }),
    now: () => clock.ms,
    defer: () => undefined,
  });
  dal = createCriteriaDal({ config, auth, api: createApiClient({ apiOrigin: config.apiOrigin, timeoutMs: 400 }), now: () => clock.ms });
});

const sessaoSealer = () => createSealer(config.sealKeys, SEAL_PURPOSES.sessao, PORTAL);
const rascunhoSealer = () => createSealer(config.sealKeys, SEAL_PURPOSES.rascunho, PORTAL);
const nowS = (): number => Math.floor(clock.ms / 1_000);
const tokenCalls = () => fake.requests.filter((request) => request.url.startsWith("/auth/v1/token"));
const sidOf = (cookie: string) => (JSON.parse(sessaoSealer().open(cookie) as string) as { sid: string }).sid;
const cookieOf = (result: Redirect, name: string): CookieWrite | undefined => result.cookies.find((cookie) => cookie.name === name);

async function login(): Promise<string> {
  const start = await auth.startLogin({ provider: "github", secFetchSite: "same-origin" });
  const flow = start.cookies[0] as CookieWrite;
  const authorize = await fetch(start.location, { redirect: "manual" });
  const search = new URL(authorize.headers.get("location") as string).searchParams;
  const done = await auth.completeLogin({ search, flowCookie: flow.value });
  fake.requests.length = 0;
  api.requests.length = 0;
  return (done.cookies.find((cookie) => cookie.name === COOKIE_NAMES.sessao) as CookieWrite).value;
}

function bodyOf(values: FormValues | Array<readonly [string, string]>): ReadableStream<Uint8Array> {
  const pairs = Array.isArray(values) ? values : formPairs(values as FormValues);
  return new Response(new URLSearchParams(pairs.map(([key, value]) => [key, value])).toString()).body as ReadableStream<Uint8Array>;
}

const allowed: { readonly origin: string | null; readonly secFetchSite: string | null; readonly contentType: string | null } = {
  origin: PORTAL,
  secFetchSite: "same-origin",
  contentType: URLENCODED,
};
const save = (sessionCookie: string | undefined, values: FormValues | Array<readonly [string, string]>, over: Partial<typeof allowed> = {}) =>
  dal.save({ ...allowed, ...over, body: bodyOf(values), sessionCookie });

async function saveRedirect(sessionCookie: string | undefined, values: FormValues | Array<readonly [string, string]>, over: Partial<typeof allowed> = {}): Promise<Redirect> {
  const result = await save(sessionCookie, values, over);
  if (result.kind !== "redirect") throw new Error("esperava um redirecionamento");
  return result;
}

/** O rascunho aberto, para conferir o que foi selado. */
function openDraft(result: Redirect): { sid: string; iat: number; a: string; c: string[]; p: Array<[string, string]> } {
  const draft = cookieOf(result, COOKIE_NAMES.rascunho) as CookieWrite;
  return JSON.parse(rascunhoSealer().open(draft.value) as string) as { sid: string; iat: number; a: string; c: string[]; p: Array<[string, string]> };
}

describe("save: a gravação (ADR-028 D6)", () => {
  it.each([
    ["sem Origin", { origin: null }],
    ["outra origem", { origin: "https://evil.invalid" }],
    ["Origin null", { origin: "null" }],
    ["origem com barra", { origin: `${PORTAL}/` }],
    ["cross-site", { secFetchSite: "cross-site" }],
    ["same-site", { secFetchSite: "same-site" }],
    ["sem Sec-Fetch-Site", { secFetchSite: null }],
  ] as const)("%s: 403, sem rede e sem cookie", async (_caso, over) => {
    const session = await login();
    const result = await dal.save({ ...allowed, ...over, body: bodyOf(criteriaToForm(fullCriteria())), sessionCookie: session });
    expect(result).toEqual({ kind: "forbidden" });
    expect([fake.requests.length, api.requests.length]).toEqual([0, 0]);
  });

  it("formulário válido: um PUT com o contrato, 303 para criterios_salvos, sem rascunho", async () => {
    const session = await login();
    const result = await saveRedirect(session, criteriaToForm(fullCriteria()));
    expect(result).toEqual({ kind: "redirect", location: `${CRITERIOS}?aviso=criterios_salvos`, cookies: [] });
    expect(api.rows.get(GOTRUE_CANARIES.userId)).toEqual(fullCriteria());
    expect(api.requests.map((request) => request.method)).toEqual(["PUT"]);
  });

  it.each([
    ["Content-Type multipart", { contentType: "multipart/form-data; boundary=x" }],
    ["sem Content-Type", { contentType: null }],
  ] as const)("%s: formulario_recusado, sem rede e sem rascunho", async (_caso, over) => {
    const session = await login();
    expect(await saveRedirect(session, criteriaToForm(fullCriteria()), over)).toEqual({ kind: "redirect", location: `${CRITERIOS}?aviso=formulario_recusado`, cookies: [] });
    expect(api.requests).toHaveLength(0);
  });

  it("campo desconhecido (o dono, por exemplo): formulario_recusado, sem rede", async () => {
    const session = await login();
    const pairs = [...formPairs(criteriaToForm(fullCriteria())), ["userId", randomUUID()] as const];
    expect(await saveRedirect(session, pairs)).toEqual({ kind: "redirect", location: `${CRITERIOS}?aviso=formulario_recusado`, cookies: [] });
    expect(api.requests).toHaveLength(0);
  });

  it("sem sessão: página inicial, sem rede", async () => {
    expect(await saveRedirect(undefined, criteriaToForm(fullCriteria()))).toEqual({ kind: "redirect", location: `${PORTAL}/`, cookies: [] });
    expect(api.requests).toHaveLength(0);
  });

  it("sessão vencida: 'entre de novo', com o cookie apagado e sem rede", async () => {
    const session = await login();
    clock.ms += 86_401_000;
    const result = await saveRedirect(session, criteriaToForm(fullCriteria()));
    expect(result).toEqual({ kind: "redirect", location: `${PORTAL}/?aviso=sessao_expirada`, cookies: [{ name: COOKIE_NAMES.sessao, value: "", maxAge: 0 }] });
    expect([tokenCalls().length, api.requests.length]).toEqual([0, 0]);
  });

  it("validação antes da rede: criterios_invalidos com o rascunho selado, sem chamar a API", async () => {
    const session = await login();
    const values = { ...criteriaToForm(fullCriteria()), "salary.minimum": ["0"], notes: ["<b>CANARIO</b>"] };
    const result = await saveRedirect(session, values);
    expect(result.location).toBe(`${CRITERIOS}?aviso=criterios_invalidos`);
    expect(api.requests).toHaveLength(0);
    const draft = cookieOf(result, COOKIE_NAMES.rascunho) as CookieWrite;
    expect(draft.maxAge).toBe(DRAFT_POLICY.maxAgeSeconds);
    expect(draft.value).toMatch(/^r1\.c1\./);
    expect(draft.value).not.toContain(SALARY_CANARY_TEXT);
    expect(openDraft(result)).toEqual({ sid: sidOf(session), iat: nowS(), a: "criterios_invalidos", c: ["salary", "notes"], p: formPairs(values) });
  });

  it.each([
    ["400 PAYLOAD_INVALIDO", { kind: "responde", status: 400, code: "PAYLOAD_INVALIDO" }, "criterios_recusados"],
    ["429 LIMITE_DE_TAXA", { kind: "responde", status: 429, code: "LIMITE_DE_TAXA", retryAfter: 9 }, "criterios_indisponiveis"],
    ["redirecionamento", { kind: "redireciona", location: "https://outro.exemplo.invalid/" }, "criterios_indisponiveis"],
    ["503 SERVICO_INDISPONIVEL", { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" }, "criterios_nao_confirmados"],
    ["prazo depois do envio", { kind: "trava" }, "criterios_nao_confirmados"],
  ] as const)("API %s: %s com o rascunho, o cookie da sessão intacto e um PUT só", async (_caso, mode, notice) => {
    const session = await login();
    api.mode = mode;
    const result = await saveRedirect(session, criteriaToForm(fullCriteria()));
    expect(result.location).toBe(`${CRITERIOS}?aviso=${notice}`);
    expect(result.cookies.map((cookie) => cookie.name)).toEqual([COOKIE_NAMES.rascunho]);
    expect(openDraft(result)).toMatchObject({ sid: sidOf(session), a: notice, c: [] });
    expect(api.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    expect(tokenCalls()).toHaveLength(0);
  });

  it("access perto do fim: renova antes do PUT e grava o cookie novo", async () => {
    const session = await login();
    clock.ms += 850_000;
    const result = await saveRedirect(session, criteriaToForm(fullCriteria()));
    expect(result.location).toBe(`${CRITERIOS}?aviso=criterios_salvos`);
    expect(result.cookies.map((cookie) => cookie.name)).toEqual([COOKIE_NAMES.sessao]);
    expect(tokenCalls()).toHaveLength(1);
    const renewed = JSON.parse(sessaoSealer().open(cookieOf(result, COOKIE_NAMES.sessao)?.value as string) as string) as { at: string };
    expect(api.requests[0]?.headers["authorization"]).toBe(`Bearer ${renewed.at}`);
  });

  it("access perto do fim e o GoTrue recusando: 'entre de novo', cookie apagado, sem PUT", async () => {
    const session = await login();
    clock.ms += 850_000;
    fake.hookRefuses = true;
    const result = await saveRedirect(session, criteriaToForm(fullCriteria()));
    expect(result).toEqual({ kind: "redirect", location: `${PORTAL}/?aviso=sessao_expirada`, cookies: [{ name: COOKIE_NAMES.sessao, value: "", maxAge: 0 }] });
    expect(api.requests).toHaveLength(0);
  });

  it("access perto do fim e o GoTrue fora: indisponível com o rascunho, o cookie fica e não há PUT", async () => {
    const session = await login();
    clock.ms += 850_000;
    fake.mode = { kind: "responde", status: 503, body: "" };
    const result = await saveRedirect(session, criteriaToForm(fullCriteria()));
    expect(result.location).toBe(`${CRITERIOS}?aviso=criterios_indisponiveis`);
    expect(result.cookies.map((cookie) => cookie.name)).toEqual([COOKIE_NAMES.rascunho]);
    expect(openDraft(result).sid).toBe(sidOf(session));
    expect(api.requests).toHaveLength(0);
  });

  it("401 da API e o GoTrue recusando a renovação forçada: 'entre de novo', cookie apagado, um PUT só", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 401, code: "NAO_AUTENTICADO" };
    fake.hookRefuses = true;
    const result = await saveRedirect(session, criteriaToForm(fullCriteria()));
    expect(result).toEqual({ kind: "redirect", location: `${PORTAL}/?aviso=sessao_expirada`, cookies: [{ name: COOKIE_NAMES.sessao, value: "", maxAge: 0 }] });
    expect(api.requests).toHaveLength(1);
    expect(tokenCalls()).toHaveLength(1);
  });

  it("401 da API e o GoTrue aceitando: indisponível com o cookie novo e o rascunho, sem repetir o PUT (T30)", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 401, code: "NAO_AUTENTICADO" };
    const result = await saveRedirect(session, criteriaToForm(fullCriteria()));
    expect(result.location).toBe(`${CRITERIOS}?aviso=criterios_indisponiveis`);
    expect(result.cookies.map((cookie) => cookie.name)).toEqual([COOKIE_NAMES.sessao, COOKIE_NAMES.rascunho]);
    expect(cookieOf(result, COOKIE_NAMES.sessao)?.value).not.toBe(session);
    expect(openDraft(result).sid).toBe(sidOf(session));
    expect(api.requests).toHaveLength(1);
    expect(tokenCalls()).toHaveLength(1);
  });

  it("401 da API depois de renovar antes: a renovação forçada parte do cookie novo", async () => {
    const session = await login();
    clock.ms += 850_000;
    api.mode = { kind: "responde", status: 401, code: "NAO_AUTENTICADO" };
    const result = await saveRedirect(session, criteriaToForm(fullCriteria()));
    expect(result.location).toBe(`${CRITERIOS}?aviso=criterios_indisponiveis`);
    expect(tokenCalls()).toHaveLength(2);
    const bodies = tokenCalls().map((request) => (JSON.parse(request.body) as { refresh_token: string }).refresh_token);
    // A 2ª renovação usa o refresh que a 1ª devolveu, não o do cookie antigo.
    expect(bodies[1]).not.toBe(bodies[0]);
    expect(result.cookies.map((cookie) => cookie.name)).toEqual([COOKIE_NAMES.sessao, COOKIE_NAMES.rascunho]);
  });

  it("401 da API e o GoTrue fora na renovação forçada: indisponível com o rascunho, sem apagar a sessão", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 401, code: "NAO_AUTENTICADO" };
    fake.mode = { kind: "responde", status: 503, body: "" };
    const result = await saveRedirect(session, criteriaToForm(fullCriteria()));
    expect(result.location).toBe(`${CRITERIOS}?aviso=criterios_indisponiveis`);
    expect(result.cookies.map((cookie) => cookie.name)).toEqual([COOKIE_NAMES.rascunho]);
  });

  it("indisponível sem o sid (cookie que nem abriu): o aviso, sem rascunho", async () => {
    const stub = createCriteriaDal({
      config,
      auth: { ...auth, apiAccess: () => Promise.resolve({ ok: false, state: "indisponivel" }) },
      api: createApiClient({ apiOrigin: config.apiOrigin }),
      now: () => clock.ms,
    });
    const result = await stub.save({ ...allowed, body: bodyOf(criteriaToForm(fullCriteria())), sessionCookie: "qualquer" });
    expect(result).toEqual({ kind: "redirect", location: `${CRITERIOS}?aviso=criterios_indisponiveis`, cookies: [] });
  });

  it("rascunho acima do teto do selo: não é gravado, e o aviso continua", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" };
    const values = {
      ...criteriaToForm(fullCriteria()),
      "stack.niceToHave": [Array.from({ length: 30 }, (_, i) => `${"T".repeat(37)}${String(i).padStart(2, "0")}`).join("\n")],
      notes: ["é".repeat(500)],
    };
    const result = await saveRedirect(session, values);
    expect(result).toEqual({ kind: "redirect", location: `${CRITERIOS}?aviso=criterios_nao_confirmados`, cookies: [] });
  });

  it("o destino nunca leva a pretensão nem nada do pedido", async () => {
    const session = await login();
    for (const mode of [{ kind: "normal" }, { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" }] as const) {
      api.mode = mode;
      const result = await saveRedirect(session, criteriaToForm(fullCriteria()));
      expect(result.location.startsWith(`${CRITERIOS}?aviso=`)).toBe(true);
      expect(result.location).not.toContain(SALARY_CANARY_TEXT);
    }
  });
});

describe("page: a página (ADR-028 D5 e D8)", () => {
  it("sem sessão: sem_sessao, sem rede", async () => {
    expect(await dal.page({ sessionCookie: undefined, draftCookie: undefined, aviso: undefined })).toEqual({ kind: "sem_sessao" });
    expect(api.requests).toHaveLength(0);
  });

  it("nunca salvou: o formulário com os padrões", async () => {
    const session = await login();
    expect(await dal.page({ sessionCookie: session, draftCookie: undefined, aviso: undefined })).toEqual({
      kind: "formulario",
      values: defaultFormValues(),
      origin: "padroes",
      notice: null,
      fields: [],
      draftLost: false,
    });
  });

  it("salvos: o formulário com o valor da API, e o aviso do catálogo", async () => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    expect(await dal.page({ sessionCookie: session, draftCookie: undefined, aviso: "criterios_salvos" })).toEqual({
      kind: "formulario",
      values: criteriaToForm(fullCriteria()),
      origin: "salvos",
      notice: "criterios_salvos",
      fields: [],
      draftLost: false,
    });
    const request = api.requests[0];
    expect(request?.method).toBe("GET");
    for (const name of ["cookie", "origin", "referer", "x-forwarded-for"]) expect(request?.headers[name], name).toBeUndefined();
  });

  it("aviso fora do catálogo é ignorado", async () => {
    const session = await login();
    for (const aviso of ["<script>", "toString", ["criterios_salvos"], "saiu"]) {
      expect(await dal.page({ sessionCookie: session, draftCookie: undefined, aviso })).toMatchObject({ notice: null });
    }
  });

  it.each([
    ["503", { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" }],
    ["429", { kind: "responde", status: 429, code: "LIMITE_DE_TAXA", retryAfter: 3 }],
    ["401 (a página não grava cookie nem renova)", { kind: "responde", status: 401, code: "NAO_AUTENTICADO" }],
  ] as const)("API %s na leitura: indisponível, sem o formulário de padrões", async (_caso, mode) => {
    const session = await login();
    api.mode = mode;
    expect(await dal.page({ sessionCookie: session, draftCookie: undefined, aviso: undefined })).toEqual({ kind: "indisponivel", notice: null });
    expect(tokenCalls()).toHaveLength(0);
  });

  it("perto do fim do access: a página não renova (o proxy já renovou ou disse indisponível)", async () => {
    const session = await login();
    clock.ms += 850_000;
    expect((await dal.page({ sessionCookie: session, draftCookie: undefined, aviso: undefined })).kind).toBe("formulario");
    expect(tokenCalls()).toHaveLength(0);
  });

  it("rascunho da mesma sessão: o formulário com o rascunho e os campos marcados, sem ler a API", async () => {
    const session = await login();
    const values = { ...criteriaToForm(fullCriteria()), "salary.minimum": ["0"] };
    const failed = await saveRedirect(session, values);
    api.requests.length = 0;
    const draft = cookieOf(failed, COOKIE_NAMES.rascunho)?.value;
    expect(await dal.page({ sessionCookie: session, draftCookie: draft, aviso: "criterios_invalidos" })).toEqual({
      kind: "formulario",
      values,
      origin: "rascunho",
      notice: "criterios_invalidos",
      fields: ["salary"],
      draftLost: false,
    });
    expect(api.requests).toHaveLength(0);
  });

  it("rascunho com a API fora: mostra o rascunho assim mesmo", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" };
    const failed = await saveRedirect(session, criteriaToForm(fullCriteria()));
    const view = await dal.page({ sessionCookie: session, draftCookie: cookieOf(failed, COOKIE_NAMES.rascunho)?.value, aviso: "criterios_nao_confirmados" });
    expect(view).toMatchObject({ kind: "formulario", origin: "rascunho", values: criteriaToForm(fullCriteria()) });
  });

  it("rascunho de outra sessão, vencido, adulterado ou de outra finalidade: ignorado, e o aviso diz que se perdeu", async () => {
    const session = await login();
    api.rows.set(GOTRUE_CANARIES.userId, fullCriteria());
    const pairs = formPairs(criteriaToForm(fullCriteria()));
    const seal = (payload: unknown) => rascunhoSealer().seal(JSON.stringify(payload)) as string;
    const good = { sid: sidOf(session), iat: nowS(), a: "criterios_indisponiveis", c: [], p: pairs };
    const drafts = [
      seal({ ...good, sid: randomUUID() }),
      seal({ ...good, iat: nowS() - DRAFT_POLICY.maxAgeSeconds - 1 }),
      seal({ ...good, iat: nowS() + 60 }),
      seal({ ...good, p: [...pairs, ["userId", "x"]] }),
      seal({ ...good, c: ["inexistente"] }),
      seal({ ...good, a: "saiu" }),
      seal({ ...good, extra: 1 }),
      `${seal(good)}x`,
      sessaoSealer().seal(JSON.stringify(good)) as string,
      rascunhoSealer().seal("[") as string,
    ];
    for (const draftCookie of drafts) {
      expect(await dal.page({ sessionCookie: session, draftCookie, aviso: "criterios_indisponiveis" })).toEqual({
        kind: "formulario",
        values: criteriaToForm(fullCriteria()),
        origin: "salvos",
        notice: "criterios_indisponiveis",
        fields: [],
        draftLost: true,
      });
    }
    // Controle: o mesmo rascunho, bom, é aceito.
    expect(await dal.page({ sessionCookie: session, draftCookie: seal(good), aviso: "criterios_indisponiveis" })).toMatchObject({ origin: "rascunho", draftLost: false });
  });

  it("rascunho no limite exato de 120 s: aceito", async () => {
    const session = await login();
    const good = { sid: sidOf(session), iat: nowS() - DRAFT_POLICY.maxAgeSeconds, a: "criterios_invalidos", c: ["notes"], p: formPairs(criteriaToForm(fullCriteria())) };
    const view = await dal.page({ sessionCookie: session, draftCookie: rascunhoSealer().seal(JSON.stringify(good)) as string, aviso: "criterios_invalidos" });
    expect(view).toMatchObject({ origin: "rascunho", fields: ["notes"] });
  });

  it("aviso de falha sem rascunho e com a API fora: indisponível, com o aviso", async () => {
    const session = await login();
    api.mode = { kind: "responde", status: 503, code: "SERVICO_INDISPONIVEL" };
    expect(await dal.page({ sessionCookie: session, draftCookie: undefined, aviso: "criterios_indisponiveis" })).toEqual({ kind: "indisponivel", notice: "criterios_indisponiveis" });
  });
});
