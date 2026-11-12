// Custom Access Token Hook contra a pilha local do runner (F1-DB-02; ADR-026; ADR-004 D5, §4.3 e CA-15). Roda só no
// job db, fora do `pnpm test`. O `supabase/config.toml` liga o hook, então toda emissão do GoTrue local passa pela
// função `trampo_hooks.custom_access_token`. Prova:
// - catálogo: invoker, stable, search_path vazio, ACL exata (só o supabase_auth_admin) e a constante igual à da API;
// - a função chamada direto, pela mesma conexão do GoTrue (supabase_auth_admin): o limite exato de 86.400 s numa
//   transação só, cada evento fora da forma (500, falha fechada) e cada recusa (403), sempre pelo objeto `error`;
// - fora do alcance de anon, authenticated e service_role, por RPC e por SQL;
// - GoTrue de verdade: a emissão normal não muda o token; a sessão envelhecida leva 403 com `error_code`, que o adapter
//   lê como `recusado` e a borda real do BFF como 401, nunca 503; a recusa não consome o refresh;
// - falha fechada: com a função trocada por uma que lança, ninguém recebe token, e o adapter diz `nao_recebido` (503),
//   nunca `recusado`, inclusive quando a exceção pede 403 (`PT403`).
// A recusa por idade na emissão inicial não é alcançável: a sessão nasce na mesma transação do hook (ADR-026 F8).
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ApiErrorSchema } from "@trampo/contracts";
import { AuthSessionResponseSchema } from "@trampo/contracts/auth";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

import { composeApp, type ComposedApp } from "../../src/composition/compose-app.js";
import { readAllowedAmr } from "../../src/infrastructure/auth/allowed-amr-env.js";
import { AUTH_SESSION_LIMITS } from "../../src/infrastructure/auth/auth-session-env.js";
import { createJoseAccessTokenVerifier } from "../../src/infrastructure/auth/jose-access-token-verifier.js";
import { createGotrueTokenClient } from "../../src/infrastructure/supabase/gotrue-token-client.js";
import {
  insertPkceFlow,
  jwsHeader,
  rawAuthPost,
  signInWithPassword,
  signUpWithPassword,
  type PasswordSession,
} from "./support/auth-stack.js";
import {
  AGE_SESSION_SQL,
  BREAK_HOOK_SQL,
  EXPECTED_HOOK_ACL,
  EXPECTED_HOOK_FUNCTIONS,
  EXPECTED_HOOK_PRIVILEGES,
  HOOK_ACL_SQL,
  HOOK_CALL_AT_AGE_SQL,
  HOOK_CALL_NULL_SQL,
  HOOK_CALL_SQL,
  HOOK_CALL_WITHOUT_DATE_SQL,
  HOOK_DEFINITION_SQL,
  HOOK_FUNCTION,
  HOOK_FUNCTIONS_SQL,
  HOOK_OWNERSHIP_SQL,
  HOOK_PRIVILEGES_SQL,
  HOOK_RELATIONS_SQL,
  HOOK_SCHEMA,
  sqlStateAsRoleSql,
} from "./support/catalog-sql.js";
import { parseLocalStackEnv, type LocalStack } from "./support/local-stack-env.js";
import { PostgrestErrorSchema, psqlJson, rest, rpcInSchema, stackAs, type RestResponse } from "./support/local-stack.js";

const stack: LocalStack = parseLocalStackEnv(process.env);
/** A conexão do GoTrue local (ADR-026 F11): dona de `auth.sessions`, e a única com `execute` na função. */
const authAdmin: LocalStack = stackAs(stack, "supabase_auth_admin");
const client = createGotrueTokenClient({ url: stack.apiUrl, publishableKey: stack.publishableKey });
const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../../supabase/migrations/20261112210000_custom_access_token_hook.sql", import.meta.url)),
  "utf8",
);

/** A idade máxima padrão da API (ADR-004 D5): a função do banco tem de usar o mesmo número. */
const MAX_AGE_SECONDS = AUTH_SESSION_LIMITS.maxAgeSeconds.fallback;
const REFUSED = { error: { http_code: 403, message: "sessao acima da idade maxima" } };
const MALFORMED = { error: { http_code: 500, message: "evento do hook fora do formato esperado" } };
const REFRESH_PATH = "/auth/v1/token?grant_type=refresh_token";
const TOKEN_HEADERS = { apikey: stack.publishableKey, "content-type": "application/json", accept: "application/json" };
/** As claims do `AccessTokenClaims` do GoTrue v2.197.0 numa sessão sem cliente OAuth nem escopo, com ou sem hook. */
const GOTRUE_CLAIMS = [
  "aal",
  "amr",
  "app_metadata",
  "aud",
  "email",
  "exp",
  "iat",
  "is_anonymous",
  "iss",
  "phone",
  "role",
  "session_id",
  "sub",
  "user_metadata",
];

function verifierFor(amr: string) {
  return createJoseAccessTokenVerifier({
    issuer: new URL("/auth/v1", stack.apiUrl).href,
    jwksUrl: new URL("/auth/v1/.well-known/jwks.json", stack.apiUrl),
    allowedAmr: readAllowedAmr({ NODE_ENV: "test", AUTH_ALLOWED_AMR: amr }),
  });
}
const passwordVerifier = verifierFor("password");
const oauthVerifier = verifierFor("oauth");

const ClaimsSchema = z.record(z.string(), z.unknown());
/** As claims do token, decodificadas sem verificar (a verificação é do verificador real, nos testes que a pedem). */
function claimsOf(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] ?? "";
  return ClaimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
}
const sessionIdOf = (token: string): string => z.uuid().parse(claimsOf(token)["session_id"]);

const HookOutputSchema = z.object({ saida: z.unknown() });
/** O evento como o GoTrue o monta (ADR-026 F1), com as claims dadas. */
function eventFor(claims: unknown, method: unknown = "token_refresh"): string {
  return asciiJson({
    metadata: { uuid: randomUUID(), time: new Date().toISOString(), name: "custom-access-token" },
    user_id: randomUUID(),
    claims,
    authentication_method: method,
  });
}
/** JSON só com ASCII (`\uXXXX` no resto): o evento vai ao psql como argumento, e assim não depende do locale do runner. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
/** A função chamada direto, como `supabase_auth_admin`, com o evento já em texto. */
function callHook(event: string): unknown {
  return HookOutputSchema.parse(psqlJson(authAdmin, HOOK_CALL_SQL, { event })).saida;
}
/** A função chamada com a sessão das claims com exatamente `age` segundos (numa transação desfeita no fim). */
function callHookAtAge(claims: Record<string, unknown>, age: string, method: unknown = "token_refresh"): unknown {
  const sid = z.uuid().parse(claims["session_id"]);
  return HookOutputSchema.parse(psqlJson(authAdmin, HOOK_CALL_AT_AGE_SQL, { event: eventFor(claims, method), sid, age })).saida;
}
/** Envelhece de verdade a sessão: `created_at` passa a ser `age` segundos atrás. */
function ageSession(sessionId: string, age: number): void {
  z.object({ linhas: z.literal(1) }).parse(psqlJson(authAdmin, AGE_SESSION_SQL, { sid: sessionId, age: String(age) }));
}

let user: PasswordSession;
let userClaims: Record<string, unknown>;

beforeAll(async () => {
  user = await signUpWithPassword(stack);
  userClaims = claimsOf(user.accessToken);
});

describe("catálogo: a função, os grants e a constante (ADR-026 D1, D4 e D5)", () => {
  test("uma função só no schema, invoker, stable, search_path vazio, plpgsql, (jsonb) → jsonb, e nenhuma relação", () => {
    expect(psqlJson(stack, HOOK_FUNCTIONS_SQL)).toEqual(EXPECTED_HOOK_FUNCTIONS);
    expect(psqlJson(stack, HOOK_RELATIONS_SQL)).toEqual({ relacoes: 0 });
  });

  test("ACL exata: só o supabase_auth_admin, com usage no schema e execute na função; PUBLIC sem nada", () => {
    expect(psqlJson(stack, HOOK_ACL_SQL)).toEqual(EXPECTED_HOOK_ACL);
  });

  test("privilégio efetivo: anon, authenticated e service_role sem usage nem execute; o supabase_auth_admin com os dois", () => {
    expect(psqlJson(stack, HOOK_PRIVILEGES_SQL)).toEqual(EXPECTED_HOOK_PRIVILEGES);
  });

  test("o supabase_auth_admin é o dono de auth.sessions e a lê sem grant novo; a RLS dela está ligada e não forçada", () => {
    const ownership = z
      .object({
        functionOwner: z.enum(["postgres", "supabase_admin"]),
        sessionsOwner: z.string(),
        sessionsSelect: z.boolean(),
        sessionsRls: z.boolean(),
        sessionsForcedRls: z.boolean(),
      })
      .parse(psqlJson(stack, HOOK_OWNERSHIP_SQL));
    expect(ownership).toMatchObject({ sessionsOwner: "supabase_auth_admin", sessionsSelect: true, sessionsRls: true, sessionsForcedRls: false });
  });

  test("a idade máxima lida do banco é o padrão do AUTH_SESSION_MAX_AGE_SECONDS da API (86.400)", () => {
    const { definition } = z.object({ definition: z.string() }).parse(psqlJson(stack, HOOK_DEFINITION_SQL));
    const seconds = [...definition.matchAll(/make_interval\(secs => (\d+)\)/g)].map((match) => Number(match[1]));
    expect(seconds).toEqual([MAX_AGE_SECONDS]);
    expect(MAX_AGE_SECONDS).toBe(86_400);
    // Nenhum outro número de idade no corpo: nem em horas, nem em dias.
    expect(definition).not.toMatch(/interval\s+'/);
  });
});

describe("a função chamada direto, como supabase_auth_admin (ADR-026 D2 e D3)", () => {
  test("sessão nova: devolve exatamente as claims do evento, e nada do resto do evento", () => {
    expect(callHook(eventFor(userClaims))).toEqual({ claims: userClaims });
  });

  test("claim desconhecida, aninhada e com unicode volta igual: a função não tira nem acrescenta", () => {
    const claims = { ...userClaims, extra: { lista: [1, "dois", null, { três: "ação" }], vazio: {} }, outra: "" };
    expect(callHook(eventFor(claims))).toEqual({ claims });
  });

  test("limite exato, com o relógio do banco parado: 86.400 s passa; 86.401 s e 86.400 s mais 1 microssegundo recusam", () => {
    expect(callHookAtAge(userClaims, String(MAX_AGE_SECONDS))).toEqual({ claims: userClaims });
    expect(callHookAtAge(userClaims, String(MAX_AGE_SECONDS - 1))).toEqual({ claims: userClaims });
    expect(callHookAtAge(userClaims, String(MAX_AGE_SECONDS + 1))).toEqual(REFUSED);
    expect(callHookAtAge(userClaims, `${String(MAX_AGE_SECONDS)}.000001`)).toEqual(REFUSED);
    expect(callHookAtAge(userClaims, String(7 * MAX_AGE_SECONDS))).toEqual(REFUSED);
  });

  test("created_at no futuro (relógio do GoTrue adiantado): passa", () => {
    expect(callHookAtAge(userClaims, "-30")).toEqual({ claims: userClaims });
  });

  test.each([["token_refresh"], ["password"], ["oauth"], ["metodo-que-nao-existe"], [null], [42], [{ objeto: true }]])(
    "authentication_method %j: a idade decide, igual para todo método",
    (method) => {
      expect(callHookAtAge(userClaims, "60", method)).toEqual({ claims: userClaims });
      expect(callHookAtAge(userClaims, String(MAX_AGE_SECONDS + 1), method)).toEqual(REFUSED);
    },
  );

  test("sem authentication_method no evento: a idade decide", () => {
    const event = asciiJson({ claims: userClaims });
    expect(callHook(event)).toEqual({ claims: userClaims });
  });

  test("sessão que não existe: recusa 403", () => {
    expect(callHook(eventFor({ ...userClaims, session_id: randomUUID() }))).toEqual(REFUSED);
  });

  test("sessão sem created_at: recusa 403 (idade impossível de provar)", () => {
    const sid = sessionIdOf(user.accessToken);
    const output = HookOutputSchema.parse(psqlJson(authAdmin, HOOK_CALL_WITHOUT_DATE_SQL, { event: eventFor(userClaims), sid })).saida;
    expect(output).toEqual(REFUSED);
    // A transação foi desfeita: a sessão segue com data e passa.
    expect(callHook(eventFor(userClaims))).toEqual({ claims: userClaims });
  });

  test.each([
    ["evento vazio", {}],
    ["claims nulo", { claims: null }],
    ["claims texto", { claims: "texto" }],
    ["claims lista", { claims: [{ session_id: "x" }] }],
    ["claims número", { claims: 7 }],
    ["evento que é uma lista", []],
    ["evento que é um texto", "evento"],
    ["sem session_id", { claims: { sub: "a" } }],
    ["session_id nulo", { claims: { session_id: null } }],
    ["session_id número", { claims: { session_id: 123 } }],
    ["session_id objeto", { claims: { session_id: { id: "x" } } }],
    ["session_id vazio", { claims: { session_id: "" } }],
    ["session_id que não é uuid", { claims: { session_id: "nao-e-uuid" } }],
    ["session_id com SQL", { claims: { session_id: "' or 1=1 --" } }],
    ["session_id uuid com lixo depois", { claims: { session_id: `${randomUUID()}x` } }],
    ["session_id uuid com lixo antes", { claims: { session_id: `x${randomUUID()}` } }],
    ["session_id uuid com quebra de linha", { claims: { session_id: `${randomUUID()}\n` } }],
    ["session_id uuid entre chaves", { claims: { session_id: `{${randomUUID()}}` } }],
    ["session_id uuid sem hífens", { claims: { session_id: randomUUID().replaceAll("-", "") } }],
  ])("%s: falha fechada 500, sem exceção", (_name, event) => {
    expect(callHook(asciiJson(event))).toEqual(MALFORMED);
  });

  test("session_id da sessão real em maiúsculas: falha fechada 500 (o GoTrue só emite minúsculas)", () => {
    const upper = sessionIdOf(user.accessToken).toUpperCase();
    expect(callHook(eventFor({ ...userClaims, session_id: upper }))).toEqual(MALFORMED);
  });

  test("evento nulo do SQL: falha fechada 500, sem exceção", () => {
    expect(HookOutputSchema.parse(psqlJson(authAdmin, HOOK_CALL_NULL_SQL)).saida).toEqual(MALFORMED);
  });

  test("nenhuma recusa traz dado da sessão, do usuário ou do evento", () => {
    const refused = JSON.stringify(callHookAtAge(userClaims, String(MAX_AGE_SECONDS + 1)));
    const malformed = JSON.stringify(callHook(asciiJson({ claims: { session_id: "nao-e-uuid", email: user.email } })));
    for (const text of [refused, malformed]) {
      for (const secret of [sessionIdOf(user.accessToken), user.userId, user.email, "nao-e-uuid"]) expect(text).not.toContain(secret);
    }
  });
});

describe("fora do alcance de anon, authenticated e service_role (ADR-026 condição 1)", () => {
  const CALL = `select ${HOOK_SCHEMA}.${HOOK_FUNCTION}('{}'::jsonb);`;
  const SqlStateSchema = z.object({ sqlstate: z.string(), papel: z.string() });
  const asRole = (role: string, statement: string): unknown => SqlStateSchema.parse(psqlJson(stack, sqlStateAsRoleSql(statement), { papel: role }));

  test.each([["anon"], ["authenticated"], ["service_role"]])("por SQL, como %s: permissão negada (42501)", (role) => {
    expect(asRole(role, CALL)).toEqual({ sqlstate: "42501", papel: role });
  });

  test("controle: o mesmo roteiro, com uma instrução permitida, não acusa erro", () => {
    // O `\gset` guarda o resultado numa variável do psql: nada é impresso além do JSON do roteiro.
    expect(asRole("authenticated", "select 1 as controle \\gset")).toEqual({ sqlstate: "00000", papel: "authenticated" });
  });

  function expectPostgrestError(response: RestResponse, status: number, code: string): void {
    expect(response.status).toBe(status);
    expect(PostgrestErrorSchema.parse(response.body).code).toBe(code);
  }

  test("por RPC, como anon e como usuário: a função não existe para o PostgREST (404 PGRST202)", async () => {
    const stackUser = { userId: user.userId, accessToken: user.accessToken };
    expectPostgrestError(await rest(stack, "POST", `rpc/${HOOK_FUNCTION}`, null, { event: {} }), 404, "PGRST202");
    expectPostgrestError(await rest(stack, "POST", `rpc/${HOOK_FUNCTION}`, stackUser, { event: {} }), 404, "PGRST202");
  });

  test("por RPC pedindo o schema do hook: o schema não é servido a papel nenhum (406 PGRST106)", async () => {
    const stackUser = { userId: user.userId, accessToken: user.accessToken };
    expectPostgrestError(await rpcInSchema(stack, HOOK_SCHEMA, HOOK_FUNCTION, null, { event: {} }), 406, "PGRST106");
    expectPostgrestError(await rpcInSchema(stack, HOOK_SCHEMA, HOOK_FUNCTION, stackUser, { event: {} }), 406, "PGRST106");
  });
});

describe("GoTrue de verdade com o hook ligado", () => {
  /** O corpo de erro do GoTrue sem o cabeçalho `X-Supabase-Api-Version`. */
  const GotrueErrorBodySchema = z.strictObject({ code: z.int(), error_code: z.string(), msg: z.string() });
  const rawRefresh = (refreshToken: string) => rawAuthPost(stack, REFRESH_PATH, TOKEN_HEADERS, JSON.stringify({ refresh_token: refreshToken }));

  test("emissão normal: ES256, amr, exp − iat = 900 no verificador real e exatamente as claims do GoTrue", async () => {
    expect(jwsHeader(user.accessToken)).toMatchObject({ alg: "ES256" });
    const verified = await passwordVerifier.verify(user.accessToken);
    expect(verified).toMatchObject({ ok: true, principal: { userId: user.userId, sessionId: sessionIdOf(user.accessToken) } });
    if (!verified.ok) return;
    expect(verified.lifetime.expiresAt - verified.lifetime.issuedAt).toBe(900);
    expect(Object.keys(userClaims).sort()).toEqual(GOTRUE_CLAIMS);
    expect(userClaims).toMatchObject({ sub: user.userId, role: "authenticated", aal: "aal1", is_anonymous: false });
    expect(z.array(z.object({ method: z.string() })).parse(userClaims["amr"]).map((entry) => entry.method)).toEqual(["password"]);
  });

  test("renovação normal: o token novo tem as mesmas claims, da mesma sessão", async () => {
    const session = await signInWithPassword(stack, user);
    const result = await client.refresh(session.refreshToken);
    expect(result).toMatchObject({ ok: true, tokens: { expiresIn: 900 } });
    if (!result.ok) return;
    const before = claimsOf(session.accessToken);
    const after = claimsOf(result.tokens.accessToken);
    expect(Object.keys(after).sort()).toEqual(GOTRUE_CLAIMS);
    // Só o relógio muda entre os dois tokens.
    expect({ ...after, iat: 0, exp: 0 }).toEqual({ ...before, iat: 0, exp: 0 });
    await expect(passwordVerifier.verify(result.tokens.accessToken)).resolves.toMatchObject({ ok: true });
  });

  test("sessão com menos de 24 h renova; com mais, 403 com error_code e a mensagem fixa, e o adapter diz recusado", async () => {
    const session = await signInWithPassword(stack, user);
    const sid = sessionIdOf(session.accessToken);
    // Folga de 10 minutos para o relógio real: a conta exata está na função chamada direto.
    ageSession(sid, MAX_AGE_SECONDS - 600);
    const renewed = await client.refresh(session.refreshToken);
    expect(renewed).toMatchObject({ ok: true });
    if (!renewed.ok) return;

    ageSession(sid, MAX_AGE_SECONDS + 5);
    const raw = await rawRefresh(renewed.tokens.refreshToken);
    expect(raw.status).toBe(403);
    expect(raw.contentType).toMatch(/^application\/json/);
    expect(GotrueErrorBodySchema.parse(raw.body)).toEqual({ code: 403, error_code: "unknown", msg: REFUSED.error.message });
    await expect(client.refresh(renewed.tokens.refreshToken)).resolves.toEqual({ ok: false, reason: "recusado" });

    // A recusa desfaz a transação: o refresh não foi consumido. Com a data devolvida, o mesmo refresh renova.
    ageSession(sid, 60);
    await expect(client.refresh(renewed.tokens.refreshToken)).resolves.toMatchObject({ ok: true });
  });

  test("a recusa vale para a sessão, não para o usuário: outra sessão do mesmo usuário renova", async () => {
    const old = await signInWithPassword(stack, user);
    const fresh = await signInWithPassword(stack, user);
    ageSession(sessionIdOf(old.accessToken), 2 * MAX_AGE_SECONDS);
    await expect(client.refresh(old.refreshToken)).resolves.toEqual({ ok: false, reason: "recusado" });
    await expect(client.refresh(fresh.refreshToken)).resolves.toMatchObject({ ok: true });
    // E o login novo do mesmo usuário passa: a sessão nasce na transação do hook, com a data de agora.
    await expect(signInWithPassword(stack, user)).resolves.toMatchObject({ userId: user.userId });
  });
});

describe("borda real do BFF e falha fechada (ADR-026 condições 3 e 4)", () => {
  const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const VERIFIER = "v".repeat(64);
  const random = (): string => randomBytes(32).toString("base64url");
  let composed: ComposedApp;
  let definitionMd5: string;
  let hookOwner: LocalStack;

  const definition = (): string => z.object({ md5: z.string().length(32) }).parse(psqlJson(stack, HOOK_DEFINITION_SQL)).md5;
  /** A migration é idempotente (ADR-026 D6): rodá-la de novo devolve a função certa. */
  const restoreHook = (): void => {
    const script = `set client_min_messages to warning;\n${MIGRATION}\nselect json_build_object('restaurada', true);`;
    expect(psqlJson(hookOwner, script)).toEqual({ restaurada: true });
  };
  const breakHook = (sqlState: string): void => {
    expect(psqlJson(hookOwner, BREAK_HOOK_SQL, { estado: sqlState })).toEqual({ trocada: true });
  };

  const post = (route: "exchange" | "refresh", payload: unknown) =>
    composed.app.inject({
      method: "POST",
      url: `/v1/auth/${route}`,
      headers: { "content-type": "application/json", origin: EXTENSION },
      payload: JSON.stringify(payload),
    });
  const refreshBody = (refreshToken: string) => ({ schemaVersion: 1, refreshToken });
  /** Uma sessão do BFF pela troca PKCE de verdade: o fluxo gravado como `postgres`, com `amr` oauth. */
  async function exchange(): Promise<{ accessToken: string; refreshToken: string }> {
    const code = insertPkceFlow(stack, user.userId, VERIFIER, 0);
    const response = await post("exchange", { schemaVersion: 1, authCode: code, codeVerifier: VERIFIER });
    expect(response.statusCode).toBe(200);
    return AuthSessionResponseSchema.parse(response.json());
  }
  function expectApiError(response: { statusCode: number; json: () => unknown }, status: number, code: string): void {
    expect(response.statusCode).toBe(status);
    expect(ApiErrorSchema.parse(response.json()).code).toBe(code);
  }

  beforeAll(() => {
    const origin = stack.apiUrl.origin;
    // O BFF de produção inteiro contra a pilha local. O Redis nunca é chamado nas rotas públicas de auth (ADR-004
    // CA-08): a origem abaixo não tem ninguém escutando, e uma chamada a ela derrubaria o teste.
    composed = composeApp(
      {
        SUPABASE_URL: origin,
        SUPABASE_JWKS_URL: `${origin}/auth/v1/.well-known/jwks.json`,
        SUPABASE_PUBLISHABLE_KEY: stack.publishableKey,
        UPSTASH_REDIS_REST_URL: "http://127.0.0.1:9",
        UPSTASH_REDIS_REST_TOKEN: "token-que-nunca-sai",
        RATE_KEY_PEPPER: random(),
        CRITERIA_SALARY_KEYS: `k1:${random()}`,
        CRITERIA_SALARY_ACTIVE_KEY: "k1",
        CORS_ALLOWED_ORIGINS: EXTENSION,
        TRUST_PROXY: "false",
        API_BEHIND_PROXY: "false",
        AUTH_REFRESH_SEAL_KEYS: `r1k1:${random()}`,
        AUTH_REFRESH_SEAL_ACTIVE_KEY: "r1k1",
      },
      { logger: false },
    );
    definitionMd5 = definition();
    const { functionOwner } = z.object({ functionOwner: z.enum(["postgres", "supabase_admin"]) }).parse(psqlJson(stack, HOOK_OWNERSHIP_SQL));
    hookOwner = stackAs(stack, functionOwner);
  });

  afterAll(async () => {
    // Mesmo que um teste caia no meio, a função certa volta antes dos outros arquivos do job.
    restoreHook();
    await composed.app.close();
  });

  test("troca PKCE pelo BFF: 200, token de sessão oauth, e a renovação da sessão nova dá 200", async () => {
    const session = await exchange();
    const verified = await oauthVerifier.verify(session.accessToken);
    expect(verified).toMatchObject({ ok: true, principal: { userId: user.userId } });
    expect(Object.keys(claimsOf(session.accessToken)).sort()).toEqual(GOTRUE_CLAIMS);
    const renewed = await post("refresh", refreshBody(session.refreshToken));
    expect(renewed.statusCode).toBe(200);
    expect(AuthSessionResponseSchema.parse(renewed.json()).refreshToken).not.toBe(session.refreshToken);
  });

  test("sessão com mais de 24 h no banco: POST /v1/auth/refresh dá 401 NAO_AUTENTICADO, nunca 503", async () => {
    const session = await exchange();
    ageSession(sessionIdOf(session.accessToken), MAX_AGE_SECONDS + 5);
    // O envelope é novo (a idade da API não venceu): quem recusa é o hook, no GoTrue.
    const refused = await post("refresh", refreshBody(session.refreshToken));
    expectApiError(refused, 401, "NAO_AUTENTICADO");
    expect(refused.headers["retry-after"]).toBeUndefined();
    // E segue recusando: a sessão não volta sozinha.
    expectApiError(await post("refresh", refreshBody(session.refreshToken)), 401, "NAO_AUTENTICADO");
  });

  test("falha fechada: com a função lançando, ninguém recebe token, e o adapter e o BFF dizem indisponível, nunca recusado", async () => {
    const direct = await signInWithPassword(stack, user);
    const viaBff = await exchange();
    try {
      breakHook("P0001");
      expect(definition()).not.toBe(definitionMd5);

      // Login novo: 500 com o corpo de erro do Postgres, sem `error_code` (ADR-026 F5).
      const email = `trampo-auth-${randomUUID()}@example.com`;
      const signup = await rawAuthPost(stack, "/auth/v1/signup", TOKEN_HEADERS, JSON.stringify({ email, password: randomUUID() }));
      expect(signup.status).toBe(500);
      expect(signup.body).not.toHaveProperty("error_code");
      expect(signup.body).not.toHaveProperty("access_token");

      // Renovação: o adapter não vê recusa, e o BFF responde 503 (a sessão do cliente fica).
      const raw = await rawAuthPost(stack, REFRESH_PATH, TOKEN_HEADERS, JSON.stringify({ refresh_token: direct.refreshToken }));
      expect(raw.status).toBe(500);
      expect(raw.body).not.toHaveProperty("error_code");
      await expect(client.refresh(direct.refreshToken)).resolves.toEqual({ ok: false, reason: "nao_recebido" });
      expectApiError(await post("refresh", refreshBody(viaBff.refreshToken)), 503, "SERVICO_INDISPONIVEL");

      // Troca: o fluxo é válido, e ainda assim nada sai.
      const code = insertPkceFlow(stack, user.userId, VERIFIER, 0);
      expectApiError(await post("exchange", { schemaVersion: 1, authCode: code, codeVerifier: VERIFIER }), 503, "SERVICO_INDISPONIVEL");

      // A exceção que pede 403 (`PT403`) também não é recusa: o corpo não tem `error_code`.
      breakHook("PT403");
      const forbidden = await rawAuthPost(stack, REFRESH_PATH, TOKEN_HEADERS, JSON.stringify({ refresh_token: direct.refreshToken }));
      expect(forbidden.status).toBe(403);
      expect(forbidden.body).not.toHaveProperty("error_code");
      await expect(client.refresh(direct.refreshToken)).resolves.toEqual({ ok: false, reason: "nao_recebido" });
      expectApiError(await post("refresh", refreshBody(viaBff.refreshToken)), 503, "SERVICO_INDISPONIVEL");
    } finally {
      restoreHook();
    }

    // A função certa voltou, byte a byte, e nenhum refresh foi consumido pelas falhas.
    expect(definition()).toBe(definitionMd5);
    expect(psqlJson(stack, HOOK_ACL_SQL)).toEqual(EXPECTED_HOOK_ACL);
    await expect(client.refresh(direct.refreshToken)).resolves.toMatchObject({ ok: true });
    expect((await post("refresh", refreshBody(viaBff.refreshToken))).statusCode).toBe(200);
    await expect(signUpWithPassword(stack)).resolves.toMatchObject({ expiresIn: 900 });
  });
});
