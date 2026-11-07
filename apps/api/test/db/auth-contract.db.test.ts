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
// - o `grant_type=pkce` com código desconhecido é `recusado` (404 com o corpo do GoTrue, D7).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

import type { AccessTokenVerifier } from "../../src/application/ports/access-token-verifier.js";
import { AllowedAmrConfigError, readAllowedAmr } from "../../src/infrastructure/auth/allowed-amr-env.js";
import { createJoseAccessTokenVerifier } from "../../src/infrastructure/auth/jose-access-token-verifier.js";
import { createGotrueTokenClient } from "../../src/infrastructure/supabase/gotrue-token-client.js";
import { createAuthHook } from "../../src/presentation/edge/auth.js";
import { fetchJwks, jwsHeader, signInWithPassword, signUpWithPassword, type PasswordSession } from "./support/auth-stack.js";
import { parseLocalStackEnv, type LocalStack } from "./support/local-stack-env.js";

const stack: LocalStack = parseLocalStackEnv(process.env);
const client = createGotrueTokenClient({ url: stack.apiUrl, publishableKey: stack.publishableKey });
const SIGNING_KEYS = fileURLToPath(new URL("../../../../supabase/signing_keys.json", import.meta.url));
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

  test("pela borda real (hook do JWT): 401 com oauth, 200 com password", async () => {
    const statusWith = async (verifier: AccessTokenVerifier): Promise<number> => {
      const app = Fastify();
      app.addHook("onRequest", createAuthHook(verifier));
      app.get("/v1/criteria", () => ({ ok: true }));
      const response = await app.inject({ method: "GET", url: "/v1/criteria", headers: { authorization: `Bearer ${user.accessToken}` } });
      await app.close();
      return response.statusCode;
    };
    expect(await statusWith(oauthVerifier)).toBe(401);
    expect(await statusWith(passwordVerifier)).toBe(200);
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
    await expect(client.refresh("trampo-sonda-inexistente")).resolves.toEqual({ ok: false, reason: "recusado" });
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
