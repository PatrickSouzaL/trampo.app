// Contrato do BFF de autenticação contra o GoTrue local do runner (ADR-004 §4.3, com a emenda do HITL-035; F1-API-07
// 07h; ADR-019 emenda do 07h). Roda só no job db, fora do `pnpm test`. As peças são as de produção: o
// JoseAccessTokenVerifier com o JWKS de verdade e o GotrueTokenClient falando com o GoTrue de verdade, não com o
// simulado (que só repete a nossa hipótese). Prova:
// - a chave ES256 gerada no job assina, o JWKS só expõe a parte pública, e o token dura 900 s (o mesmo do projeto real);
// - `password` só passa com `NODE_ENV=test`; com `AUTH_ALLOWED_AMR=oauth` (o padrão), o mesmo token dá 401;
// - renovação e logout pelo adapter real, inclusive o logout repetido (o GoTrue responde 403 `session_not_found`);
// - P10: o pai do refresh ativo devolve o ativo, também depois de 10 s; o ancestral mais velho, depois de 10 s, revoga
//   a cadeia;
// - P11: `logout?scope=global` invalida o refresh de todas as sessões do usuário;
// - o `grant_type=pkce` com código desconhecido é `recusado` (404 com o corpo do GoTrue, D7);
// - F1-API-08 (achados A-01 e A-02, D7): cada recusa real da troca (400, 404 e 422), da renovação (400) e do logout
//   (403) chega com o corpo JSON do GoTrue e um `error_code` string, que é o que o adapter exige para dizer
//   `recusado` (o refresh desconhecido precisa ter a forma legada de 12 caracteres para chegar à busca, e o fluxo PKCE
//   gravado à mão precisa dos tokens do provedor como texto vazio: correção do 1º run do job, no PR #21); e o limite deste job: o gateway local não confere a `apikey` em `/auth/v1/`, então o `Invalid API key`
//   do projeto real só existe no simulado (e no S-3).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

import type { AccessTokenVerifier } from "../../src/application/ports/access-token-verifier.js";
import { AllowedAmrConfigError, readAllowedAmr } from "../../src/infrastructure/auth/allowed-amr-env.js";
import { createJoseAccessTokenVerifier } from "../../src/infrastructure/auth/jose-access-token-verifier.js";
import { createGotrueTokenClient } from "../../src/infrastructure/supabase/gotrue-token-client.js";
import { buildApp } from "../../src/presentation/build-app.js";
import { openLimits } from "../limit-fakes.js";
import {
  fetchJwks,
  insertPkceFlow,
  jwsHeader,
  rawAuthPost,
  signInWithPassword,
  signUpWithPassword,
  type PasswordSession,
  type RawAuthResponse,
} from "./support/auth-stack.js";
import { parseLocalStackEnv, type LocalStack } from "./support/local-stack-env.js";

const stack: LocalStack = parseLocalStackEnv(process.env);
const client = createGotrueTokenClient({ url: stack.apiUrl, publishableKey: stack.publishableKey });
const SIGNING_KEYS = fileURLToPath(new URL("../../../../supabase/signing_keys.json", import.meta.url));
/**
 * Refresh que o GoTrue procura no banco e não acha: 12 caracteres `[a-z0-9]`, a forma legada. Fora dela (e da forma
 * nova, assinada), o GoTrue v2.197.0 recusa antes da busca, com `validation_failed` (`RefreshTokenGrantParams.Validate`).
 */
const UNKNOWN_REFRESH = "trampo0sonda";
/** Refresh fora das duas formas (a sonda do 1º run do job, que deu `validation_failed`): nem chega à busca. */
const MALFORMED_REFRESH = "trampo-sonda-inexistente";
/** O intervalo de reuso do `config.toml` (10 s) e uma folga. */
const AFTER_REUSE_INTERVAL_MS = 11_500;

function verifierFor(amr: string): AccessTokenVerifier {
  return createJoseAccessTokenVerifier({
    issuer: new URL("/auth/v1", stack.apiUrl).href,
    jwksUrl: new URL("/auth/v1/.well-known/jwks.json", stack.apiUrl),
    // Pelo mesmo leitor do boot: `password` só entra porque o ambiente é de teste.
    allowedAmr: readAllowedAmr({ NODE_ENV: "test", AUTH_ALLOWED_AMR: amr }),
  });
}

const passwordVerifier = verifierFor("password");
const oauthVerifier = verifierFor("oauth");

/** Refresh pelo adapter real, que já devolve só os 4 campos projetados. */
async function refreshed(refreshToken: string): Promise<string> {
  const result = await client.refresh(refreshToken);
  if (!result.ok) throw new Error(`renovação recusada pelo GoTrue local: ${result.reason}`);
  return result.tokens.refreshToken;
}

let user: PasswordSession;

beforeAll(async () => {
  user = await signUpWithPassword(stack);
});

describe("a chave ES256 do job e o prazo de 900 s (config.toml espelhando a produção)", () => {
  test("o token sai assinado com a chave gerada no job, e o JWKS público não tem material privado", async () => {
    const generated = z
      .array(z.object({ kid: z.uuid(), alg: z.literal("ES256"), crv: z.literal("P-256"), x: z.string(), y: z.string() }))
      .length(1)
      .parse(JSON.parse(readFileSync(SIGNING_KEYS, "utf8")))[0];
    expect(jwsHeader(user.accessToken)).toMatchObject({ alg: "ES256", kid: generated?.kid });

    const jwks = await fetchJwks(stack);
    expect(jwks.status).toBe(200);
    const keys = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1) }).parse(jwks.body).keys;
    expect(keys).toContainEqual(expect.objectContaining({ kid: generated?.kid, kty: "EC", crv: "P-256", x: generated?.x, y: generated?.y }));
    for (const key of keys) {
      expect(key).not.toHaveProperty("d");
      expect(key).not.toHaveProperty("k");
    }
  });

  test("o GoTrue local dá expires_in 900, e o token passa no verificador real com exp − iat = 900", async () => {
    expect(user.expiresIn).toBe(900);
    const result = await passwordVerifier.verify(user.accessToken);
    expect(result).toMatchObject({ ok: true, principal: { userId: user.userId } });
    if (!result.ok) return;
    expect(result.principal.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.lifetime.expiresAt - result.lifetime.issuedAt).toBe(900);
    await expect(passwordVerifier.keysReady()).resolves.toBe(true);
  });
});

describe("amr: senha só na pilha local (ADR-004 D6)", () => {
  test("o leitor do boot recusa `password` fora de NODE_ENV=test", () => {
    expect(() => readAllowedAmr({ NODE_ENV: "production", AUTH_ALLOWED_AMR: "password" })).toThrow(AllowedAmrConfigError);
    expect(() => readAllowedAmr({ AUTH_ALLOWED_AMR: "password" })).toThrow(AllowedAmrConfigError);
  });

  test("com AUTH_ALLOWED_AMR=oauth, o token de senha é token_invalido", async () => {
    await expect(oauthVerifier.verify(user.accessToken)).resolves.toEqual({ ok: false, reason: "token_invalido" });
  });

  test("pela borda real (buildApp e o hook do JWT): 401 com oauth, 200 com password", async () => {
    const responseWith = async (verifier: AccessTokenVerifier): Promise<{ status: number; body: unknown }> => {
      const app = buildApp({ limits: openLimits, logger: false, accessTokenVerifier: verifier, corsAllowedOrigins: [] });
      app.get("/probe/eu", (request) => ({ userId: request.principal?.userId ?? null }));
      try {
        const response = await app.inject({ method: "GET", url: "/probe/eu", headers: { authorization: `Bearer ${user.accessToken}` } });
        return { status: response.statusCode, body: response.json() };
      } finally {
        await app.close();
      }
    };
    const refused = await responseWith(oauthVerifier);
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ code: "NAO_AUTENTICADO" });
    await expect(responseWith(passwordVerifier)).resolves.toEqual({ status: 200, body: { userId: user.userId } });
  });
});

describe("GotrueTokenClient contra o GoTrue de verdade", () => {
  test("renova: 4 campos, 900 s, refresh novo e access do mesmo usuário e da mesma sessão", async () => {
    const session = await signInWithPassword(stack, user);
    const result = await client.refresh(session.refreshToken);
    expect(result).toMatchObject({ ok: true, tokens: { expiresIn: 900, tokenType: "bearer" } });
    if (!result.ok) return;
    expect(Object.keys(result.tokens).sort()).toEqual(["accessToken", "expiresIn", "refreshToken", "tokenType"]);
    expect(result.tokens.refreshToken).not.toBe(session.refreshToken);
    const before = await passwordVerifier.verify(session.accessToken);
    const after = await passwordVerifier.verify(result.tokens.accessToken);
    expect(after).toMatchObject({ ok: true, principal: { userId: user.userId } });
    if (!before.ok || !after.ok) return;
    expect(after.principal.sessionId).toBe(before.principal.sessionId);
  });

  test("refresh desconhecido: recusado (400 refresh_token_not_found)", async () => {
    await expect(client.refresh(UNKNOWN_REFRESH)).resolves.toEqual({ ok: false, reason: "recusado" });
  });

  test("troca com código desconhecido: recusado (404 com o corpo do GoTrue, D7)", async () => {
    const result = await client.exchangePkce(randomUUID(), "v".repeat(64));
    expect(result).toEqual({ ok: false, reason: "recusado" });
  });
});

describe("P10: rotação e reuso do refresh", { timeout: 90_000 }, () => {
  test("o pai do ativo devolve o ativo (antes e depois de 10 s); o ancestral, depois de 10 s, revoga a cadeia", async () => {
    const session = await signInWithPassword(stack, user);
    const r0 = session.refreshToken;
    const r1 = await refreshed(r0);
    expect(r1).not.toBe(r0);

    // Pai do ativo, logo em seguida: o GoTrue devolve o ativo, sem rotacionar de novo.
    await expect(refreshed(r0)).resolves.toBe(r1);
    await sleep(AFTER_REUSE_INTERVAL_MS);
    // Depois do intervalo de reuso, o pai do ativo continua devolvendo o ativo (cliente que perdeu a resposta).
    await expect(refreshed(r0)).resolves.toBe(r1);

    const r2 = await refreshed(r1);
    expect(r2).not.toBe(r1);
    await sleep(AFTER_REUSE_INTERVAL_MS);
    // r0 agora é avô do ativo: reuso fora do intervalo, a cadeia inteira cai.
    await expect(client.refresh(r0)).resolves.toEqual({ ok: false, reason: "recusado" });
    // No algoritmo v1 do GoTrue, um token revogado há menos de 10 s ainda troca: a prova da cadeia caída espera o
    // intervalo (no v2, a sessão já foi apagada e a recusa vale na hora).
    await sleep(AFTER_REUSE_INTERVAL_MS);
    await expect(client.refresh(r2)).resolves.toEqual({ ok: false, reason: "recusado" });
    await expect(client.refresh(r1)).resolves.toEqual({ ok: false, reason: "recusado" });
  });
});

describe("P11: logout global", () => {
  test("invalida o refresh de todas as sessões do usuário, e o logout repetido também é encerrado", async () => {
    const owner = await signUpWithPassword(stack);
    const other = await signInWithPassword(stack, owner);
    const bystander = await signUpWithPassword(stack);

    await expect(client.logout(owner.accessToken)).resolves.toEqual({ ok: true });
    await expect(client.refresh(owner.refreshToken)).resolves.toEqual({ ok: false, reason: "recusado" });
    await expect(client.refresh(other.refreshToken)).resolves.toEqual({ ok: false, reason: "recusado" });
    // A sessão já não existe: o GoTrue responde 403 session_not_found, e o adapter trata como encerrada (D7, idempotente).
    await expect(client.logout(owner.accessToken)).resolves.toEqual({ ok: true });
    // Outro usuário não é afetado.
    await expect(client.refresh(bystander.refreshToken)).resolves.toMatchObject({ ok: true });
  });
});

/** O corpo de erro do GoTrue sem o cabeçalho `X-Supabase-Api-Version` (o adapter não o manda). */
const GotrueErrorBodySchema = z.object({ code: z.int(), error_code: z.string().min(1), msg: z.string() });
const RECUSADO = { ok: false, reason: "recusado" };
const TOKEN_HEADERS = { apikey: stack.publishableKey, "content-type": "application/json", accept: "application/json" };
const PKCE_PATH = "/auth/v1/token?grant_type=pkce";
const REFRESH_PATH = "/auth/v1/token?grant_type=refresh_token";
const LOGOUT_PATH = "/auth/v1/logout?scope=global";
const VERIFIER = "v".repeat(64);
/** Acima do `flow_state_expiry_duration` padrão do GoTrue (300 s). */
const EXPIRED_FLOW_AGE_SECONDS = 3_600;

/** A recusa veio do GoTrue: o status, JSON e o `error_code` dado (ou qualquer um, sem `errorCode`). */
function expectGotrueRefusal(raw: RawAuthResponse, status: number, errorCode?: string): void {
  expect(raw.status).toBe(status);
  expect(raw.contentType).toMatch(/^application\/json/);
  const body = GotrueErrorBodySchema.parse(raw.body);
  expect(body.code).toBe(status);
  if (errorCode !== undefined) expect(body.error_code).toBe(errorCode);
}

describe("F1-API-08: as recusas reais trazem o corpo do GoTrue (A-01 e A-02; D7)", () => {
  test("troca sem verifier: 400 validation_failed (só pela chamada crua; o adapter nem deixa sair)", async () => {
    const raw = await rawAuthPost(stack, PKCE_PATH, TOKEN_HEADERS, JSON.stringify({ auth_code: randomUUID(), code_verifier: "" }));
    expectGotrueRefusal(raw, 400, "validation_failed");
  });

  test("troca com código desconhecido: 404 flow_state_not_found", async () => {
    const raw = await rawAuthPost(stack, PKCE_PATH, TOKEN_HEADERS, JSON.stringify({ auth_code: randomUUID(), code_verifier: VERIFIER }));
    expectGotrueRefusal(raw, 404, "flow_state_not_found");
  });

  test("troca com verifier errado: 400 bad_code_verifier, e o adapter diz recusado", async () => {
    const code = insertPkceFlow(stack, user.userId, VERIFIER, 0);
    const wrong = "w".repeat(64);
    expectGotrueRefusal(await rawAuthPost(stack, PKCE_PATH, TOKEN_HEADERS, JSON.stringify({ auth_code: code, code_verifier: wrong })), 400, "bad_code_verifier");
    // O verifier errado não consome o fluxo: a mesma recusa, agora pelo adapter.
    await expect(client.exchangePkce(code, wrong)).resolves.toEqual(RECUSADO);
  });

  test("troca com fluxo vencido: 422 flow_state_expired, e o adapter diz recusado", async () => {
    const code = insertPkceFlow(stack, user.userId, VERIFIER, EXPIRED_FLOW_AGE_SECONDS);
    expectGotrueRefusal(await rawAuthPost(stack, PKCE_PATH, TOKEN_HEADERS, JSON.stringify({ auth_code: code, code_verifier: VERIFIER })), 422, "flow_state_expired");
    await expect(client.exchangePkce(code, VERIFIER)).resolves.toEqual(RECUSADO);
  });

  test("renovação com refresh desconhecido e com o de uma sessão encerrada: 400 com error_code", async () => {
    const unknown = await rawAuthPost(stack, REFRESH_PATH, TOKEN_HEADERS, JSON.stringify({ refresh_token: UNKNOWN_REFRESH }));
    expectGotrueRefusal(unknown, 400, "refresh_token_not_found");
    const session = await signInWithPassword(stack, user);
    await expect(client.logout(session.accessToken)).resolves.toEqual({ ok: true });
    expectGotrueRefusal(await rawAuthPost(stack, REFRESH_PATH, TOKEN_HEADERS, JSON.stringify({ refresh_token: session.refreshToken })), 400);
  });

  test("renovação com refresh fora da forma: 400 validation_failed, antes da busca, e o adapter diz recusado", async () => {
    const malformed = await rawAuthPost(stack, REFRESH_PATH, TOKEN_HEADERS, JSON.stringify({ refresh_token: MALFORMED_REFRESH }));
    expectGotrueRefusal(malformed, 400, "validation_failed");
    await expect(client.refresh(MALFORMED_REFRESH)).resolves.toEqual(RECUSADO);
  });

  test("logout com JWT que não verifica: 403 bad_jwt, e o adapter diz recusado (503 no caso de uso), nunca encerrada", async () => {
    const headers = { apikey: stack.publishableKey, authorization: "Bearer aaa.bbb.ccc", accept: "application/json" };
    expectGotrueRefusal(await rawAuthPost(stack, LOGOUT_PATH, headers, null), 403, "bad_jwt");
    await expect(client.logout("aaa.bbb.ccc")).resolves.toEqual(RECUSADO);
  });

  test("logout de sessão já apagada: 403 session_not_found, o único que vale como encerrada", async () => {
    const session = await signInWithPassword(stack, user);
    await expect(client.logout(session.accessToken)).resolves.toEqual({ ok: true });
    const headers = { apikey: stack.publishableKey, authorization: `Bearer ${session.accessToken}`, accept: "application/json" };
    expectGotrueRefusal(await rawAuthPost(stack, LOGOUT_PATH, headers, null), 403, "session_not_found");
  });

  test("logout sem Bearer: recusa com o corpo do GoTrue (o gateway local põe o JWT anônimo, que não tem sub)", async () => {
    const raw = await rawAuthPost(stack, LOGOUT_PATH, { apikey: stack.publishableKey, accept: "application/json" }, null);
    expect([401, 403]).toContain(raw.status);
    expectGotrueRefusal(raw, raw.status);
  });

  test("limite do job: o gateway local não confere a apikey em /auth/v1/, e a publishable errada chega ao GoTrue", async () => {
    // No projeto real, o gateway responde 401 `Invalid API key`, sem o corpo do GoTrue (o caso do A-01 e do A-02):
    // essa prova fica no simulado (gotrue-token-client e auth-session-stack) e no S-3.
    const headers = { ...TOKEN_HEADERS, apikey: "sb_publishable_ChaveRevogada-0000" };
    expectGotrueRefusal(await rawAuthPost(stack, REFRESH_PATH, headers, JSON.stringify({ refresh_token: UNKNOWN_REFRESH })), 400, "refresh_token_not_found");
  });
});
