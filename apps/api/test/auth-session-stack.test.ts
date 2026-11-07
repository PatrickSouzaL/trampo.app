// F1-API-07 07f (ADR-004 §4.2 "GoTrue", "Envelope", "JWKS", "Verificação antes de repassar" e "Logout"): os casos de
// uso com as peças reais, sem rota (a rota é do 07g). GoTrue simulado em socket real (QA-02, fake-gotrue.ts), adapter
// real do 07c, verificador `jose` real contra um JWKS local, selador AEAD real e orçamento de saída real no relógio
// do sistema. Nenhum teste toca o Supabase real. Os casos de 2 chamadas usam os modos `lento` e `corta`, que
// processam (rotacionam) antes de perder a resposta.
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { EndSession } from "../src/application/auth/end-session.js";
import { ExchangeSession } from "../src/application/auth/exchange-session.js";
import { createGotrueEgress } from "../src/application/auth/gotrue-egress.js";
import { REFRESH_SESSION_POLICY, RefreshSession } from "../src/application/auth/refresh-session.js";
import type { AuthTokenGateway } from "../src/application/ports/auth-token-gateway.js";
import type { RefreshSealer } from "../src/application/ports/refresh-sealer.js";
import { createJoseAccessTokenVerifier } from "../src/infrastructure/auth/jose-access-token-verifier.js";
import { createAeadRefreshSealer, parseRefreshKeyring } from "../src/infrastructure/crypto/aead-refresh-sealer.js";
import { createGotrueTokenClient } from "../src/infrastructure/supabase/gotrue-token-client.js";
import { systemClock } from "../src/infrastructure/time/system-clock.js";
import {
  nowSeconds,
  signToken,
  signingKey,
  startJwksServer,
  supabaseClaims,
  type Claims,
  type JwksServer,
  type SigningKey,
} from "./infrastructure/jwks-fixture.js";
import { HAPPY_PATH_TIMEOUT_MS } from "./support/socket-deadlines.js";
import { GOTRUE_CANARIES, startFakeGotrue, type FakeGotrue } from "./support/fake-gotrue.js";

const PUBLISHABLE = "sb_publishable_AbC123-teste_xyz";
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const CODE = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const SID = "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3";
const OTHER_SID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
/** Prazo curto do adapter nos casos de resposta perdida; o simulado lento responde depois dele. */
const SHORT_TIMEOUT_MS = 300;
const SLOW_MS = 900;

let jwks: JwksServer;
let key: SigningKey;
let gotrue: FakeGotrue;
/** Access tokens assinados que o GoTrue simulado vai emitir, em ordem; vazio, emite um com as claims padrão. */
const tokenQueue: string[] = [];
let defaultToken: string;

beforeAll(async () => {
  key = await signingKey();
  jwks = await startJwksServer([key.jwk]);
  defaultToken = await signToken(key, supabaseClaims(jwks.issuer));
  gotrue = await startFakeGotrue(PUBLISHABLE, { accessToken: () => tokenQueue.shift() ?? defaultToken });
});
afterAll(async () => {
  await gotrue.close();
  await jwks.close();
});
beforeEach(async () => {
  tokenQueue.length = 0;
  defaultToken = await signToken(key, supabaseClaims(jwks.issuer));
  gotrue.mode = { kind: "normal" };
  gotrue.expiresIn = 900;
  gotrue.requests.length = 0;
  jwks.behavior = { status: 200, delayMs: 0 };
});

/** Enfileira um access token assinado com as claims padrão e as trocas pedidas. */
async function nextToken(overrides: Claims = {}): Promise<void> {
  tokenQueue.push(await signToken(key, supabaseClaims(jwks.issuer, overrides)));
}

function stack(timeoutMs = HAPPY_PATH_TIMEOUT_MS) {
  const gateway: AuthTokenGateway = createGotrueTokenClient({ url: gotrue.url, publishableKey: PUBLISHABLE, timeoutMs });
  const sealer: RefreshSealer = createAeadRefreshSealer(parseRefreshKeyring(`k1:${randomBytes(32).toString("base64url")}`, "k1"));
  // Verificador novo por pilha: cache do JWKS vazio, como no boot.
  const verifier = createJoseAccessTokenVerifier({ issuer: jwks.issuer, jwksUrl: jwks.jwksUrl, allowedAmr: ["oauth"] });
  const egress = createGotrueEgress(systemClock);
  const now = (): number => Date.now();
  const ages = { maxAgeSeconds: 86_400, idleSeconds: 14_400 };
  return {
    sealer,
    exchange: new ExchangeSession({ gateway, sealer, verifier, egress, now }),
    refresh: new RefreshSession({ gateway, sealer, verifier, egress, clock: systemClock, now, ages }),
    end: new EndSession({ gateway, egress }),
    envelopeFor(rt: string): string {
      const sealed = sealer.seal({ rt, sid: SID, sst: nowSeconds() - 600, iat: nowSeconds() - 60 }, ORIGIN);
      if (!sealed.ok) throw new Error("envelope de teste fora da política");
      return sealed.envelope;
    },
  };
}

const exchangeBody = { schemaVersion: 1, authCode: CODE, codeVerifier: VERIFIER };
const tokenRequests = () => gotrue.requests.filter((r) => r.url.startsWith("/auth/v1/token"));

describe("ExchangeSession com as peças reais", () => {
  test("200: 1 chamada ao /token, token verificado pelo jose, envelope do refresh do GoTrue e nenhum canário", async () => {
    const s = stack();
    gotrue.addFlow(CODE, VERIFIER);
    const outcome = await s.exchange.execute({ request: exchangeBody, origin: ORIGIN });
    if (outcome.kind !== "sessao") throw new Error(JSON.stringify(outcome));
    expect(tokenRequests()).toHaveLength(1);
    expect(tokenRequests()[0]?.url).toBe("/auth/v1/token?grant_type=pkce");
    // Relógio real: o token foi assinado há alguns instantes e o desconto da idade é para baixo. A conta exata (899,
    // 900 e 909 s) está provada com o relógio controlado em test/application/exchange-session.test.ts.
    expect(outcome.session.expiresIn).toBeGreaterThanOrEqual(880);
    expect(outcome.session.expiresIn).toBeLessThanOrEqual(900);
    const opened = s.sealer.open(outcome.session.refreshToken, ORIGIN);
    if (!opened.ok) throw new Error("envelope não abre");
    expect(gotrue.activeRefreshTokens.has(opened.session.rt)).toBe(true);
    expect(opened.session.sid).toBe(SID);
    const text = JSON.stringify(outcome);
    for (const canary of Object.values(GOTRUE_CANARIES)) expect(text).not.toContain(canary);
  });

  test("código já usado (404 flow_state_not_found): 401, 1 chamada", async () => {
    const s = stack();
    const outcome = await s.exchange.execute({ request: exchangeBody, origin: ORIGIN });
    expect(outcome).toEqual({ kind: "nao_autenticado", reason: "auth_troca_recusada" });
    expect(tokenRequests()).toHaveLength(1);
  });

  test.each([
    ["lento (processa e responde depois do prazo)", { kind: "lento", delayMs: SLOW_MS }],
    ["corta (processa e derruba o socket)", { kind: "corta" }],
    ["404 sem o corpo do GoTrue", { kind: "responde", status: 404, body: "<html>404</html>", contentType: "text/html" }],
  ] as const)("%s: 503 com exatamente 1 chamada (sem nova tentativa na troca)", async (_name, mode) => {
    const s = stack(SHORT_TIMEOUT_MS);
    gotrue.addFlow(CODE, VERIFIER);
    gotrue.mode = mode;
    const outcome = await s.exchange.execute({ request: exchangeBody, origin: ORIGIN });
    expect(outcome).toEqual({ kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: null });
    expect(tokenRequests()).toHaveLength(1);
  });

  test("JWKS fora do ar: 503 auth_chaves_indisponiveis com 0 chamadas ao GoTrue (o código não é gasto)", async () => {
    const s = stack();
    gotrue.addFlow(CODE, VERIFIER);
    jwks.behavior = { status: 500, delayMs: 0 };
    expect(await s.exchange.execute({ request: exchangeBody, origin: ORIGIN })).toEqual({
      kind: "indisponivel",
      reason: "auth_chaves_indisponiveis",
      retryAfterSeconds: null,
    });
    expect(gotrue.requests).toHaveLength(0);
  });

  test.each<[string, () => Promise<void>]>([
    ["expires_in 3600", async () => {
      gotrue.expiresIn = 3_600;
    }],
    ["exp − iat 3600", async () => nextToken({ exp: nowSeconds() + 3_600 })],
    ["idade 909 (dentro da tolerância do jose)", async () => nextToken({ iat: nowSeconds() - 909, exp: nowSeconds() - 9 })],
    ["sem session_id", async () => nextToken({ session_id: undefined })],
    ["amr password", async () => nextToken({ amr: [{ method: "password", timestamp: nowSeconds() }] })],
    ["anônimo", async () => nextToken({ is_anonymous: true })],
  ])("token do GoTrue fora da política (%s): 503 auth_token_fora_da_politica, nunca repassado", async (_name, arrange) => {
    const s = stack();
    gotrue.addFlow(CODE, VERIFIER);
    await arrange();
    expect(await s.exchange.execute({ request: exchangeBody, origin: ORIGIN })).toEqual({
      kind: "indisponivel",
      reason: "auth_token_fora_da_politica",
      retryAfterSeconds: null,
    });
    expect(tokenRequests()).toHaveLength(1);
  });
});

describe("RefreshSession com as peças reais", () => {
  test("200: 1 chamada, o refresh rotaciona no GoTrue e o envelope novo leva o refresh novo", async () => {
    const s = stack();
    const { refreshToken } = gotrue.addSession();
    gotrue.requests.length = 0;
    const outcome = await s.refresh.execute({ request: { schemaVersion: 1, refreshToken: s.envelopeFor(refreshToken) }, origin: ORIGIN });
    if (outcome.kind !== "sessao") throw new Error(JSON.stringify(outcome));
    expect(tokenRequests().map((r) => r.body)).toEqual([JSON.stringify({ refresh_token: refreshToken })]);
    const opened = s.sealer.open(outcome.session.refreshToken, ORIGIN);
    if (!opened.ok) throw new Error("envelope não abre");
    expect(opened.session.rt).not.toBe(refreshToken);
    expect(gotrue.activeRefreshTokens.has(opened.session.rt)).toBe(true);
    expect(gotrue.activeRefreshTokens.has(refreshToken)).toBe(false);
  });

  test.each([
    ["lento", { kind: "lento", delayMs: SLOW_MS }],
    ["corta", { kind: "corta" }],
  ] as const)(
    "%s: o GoTrue rotaciona e a resposta se perde → exatamente 2 chamadas com o mesmo rt, dentro de 2 s, e 503",
    async (_name, mode) => {
      const s = stack(SHORT_TIMEOUT_MS);
      const { refreshToken } = gotrue.addSession();
      gotrue.requests.length = 0;
      gotrue.mode = mode;
      const started = performance.now();
      const outcome = await s.refresh.execute({ request: { schemaVersion: 1, refreshToken: s.envelopeFor(refreshToken) }, origin: ORIGIN });
      const elapsedMs = performance.now() - started;
      expect(outcome).toEqual({ kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: null });
      const body = JSON.stringify({ refresh_token: refreshToken });
      expect(tokenRequests().map((r) => r.body)).toEqual([body, body]);
      // O 1º pedido foi processado: o refresh original já rotacionou no simulado.
      expect(gotrue.activeRefreshTokens.has(refreshToken)).toBe(false);
      // Duas chamadas de no máximo 300 ms cada, muito abaixo do teto de 2 s da nova tentativa + o 1º prazo.
      expect(elapsedMs).toBeLessThan(SHORT_TIMEOUT_MS + REFRESH_SESSION_POLICY.retryTimeoutMs + 1_000);
    },
  );

  test("404 sem o corpo do GoTrue: 503 com 1 chamada, sem apagar nada", async () => {
    const s = stack();
    const { refreshToken } = gotrue.addSession();
    gotrue.requests.length = 0;
    gotrue.mode = { kind: "responde", status: 404, body: "", contentType: null };
    const outcome = await s.refresh.execute({ request: { schemaVersion: 1, refreshToken: s.envelopeFor(refreshToken) }, origin: ORIGIN });
    expect(outcome).toEqual({ kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: null });
    expect(tokenRequests()).toHaveLength(1);
    expect(gotrue.activeRefreshTokens.has(refreshToken)).toBe(true);
  });

  test("sid divergente: 401 depois de 1 chamada, e o refresh novo não sai da API", async () => {
    const s = stack();
    const { refreshToken } = gotrue.addSession();
    gotrue.requests.length = 0;
    await nextToken({ session_id: OTHER_SID });
    const outcome = await s.refresh.execute({ request: { schemaVersion: 1, refreshToken: s.envelopeFor(refreshToken) }, origin: ORIGIN });
    expect(outcome).toEqual({ kind: "nao_autenticado", reason: "auth_renovacao_recusada" });
    expect(tokenRequests()).toHaveLength(1);
  });

  test("JWKS fora do ar: 503 com 0 chamadas, e o refresh continua valendo no GoTrue", async () => {
    const s = stack();
    const { refreshToken } = gotrue.addSession();
    gotrue.requests.length = 0;
    jwks.behavior = { status: 500, delayMs: 0 };
    const outcome = await s.refresh.execute({ request: { schemaVersion: 1, refreshToken: s.envelopeFor(refreshToken) }, origin: ORIGIN });
    expect(outcome).toEqual({ kind: "indisponivel", reason: "auth_chaves_indisponiveis", retryAfterSeconds: null });
    expect(gotrue.requests).toHaveLength(0);
    expect(gotrue.activeRefreshTokens.has(refreshToken)).toBe(true);
  });

  test("envelope forjado: 401 com 0 chamadas", async () => {
    const s = stack();
    const forged = ["r1", "k1", randomBytes(12), randomBytes(48), randomBytes(16)]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
    expect(await s.refresh.execute({ request: { schemaVersion: 1, refreshToken: forged }, origin: ORIGIN })).toEqual({
      kind: "nao_autenticado",
      reason: "auth_envelope_invalido",
    });
    expect(gotrue.requests).toHaveLength(0);
  });
});

describe("EndSession com as peças reais", () => {
  test("sessão viva: encerrada, logout?scope=global com o Bearer, e o refresh da sessão deixa de valer", async () => {
    const s = stack();
    const { accessToken, refreshToken } = gotrue.addSession();
    gotrue.requests.length = 0;
    expect(await s.end.execute({ accessToken })).toEqual({ kind: "encerrada" });
    expect(gotrue.requests.map((r) => [r.url, r.headers.authorization])).toEqual([["/auth/v1/logout?scope=global", `Bearer ${accessToken}`]]);
    expect(gotrue.activeRefreshTokens.has(refreshToken)).toBe(false);
  });

  test("sessão já revogada (401): encerrada, idempotente", async () => {
    const s = stack();
    const { accessToken } = gotrue.addSession();
    await s.end.execute({ accessToken });
    expect(await s.end.execute({ accessToken })).toEqual({ kind: "encerrada" });
  });

  test("GoTrue 500: 503", async () => {
    const s = stack();
    const { accessToken } = gotrue.addSession();
    gotrue.mode = { kind: "responde", status: 500, body: "{}" };
    expect(await s.end.execute({ accessToken })).toEqual({
      kind: "indisponivel",
      reason: "auth_provedor_indisponivel",
      retryAfterSeconds: null,
    });
  });
});
