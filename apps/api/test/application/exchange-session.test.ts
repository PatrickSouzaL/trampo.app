// F1-API-07 07f (ADR-004 D4, `ExchangeSession`; D6; D7; §4.2 "Envelope", "GoTrue", "Verificação antes de repassar",
// "JWKS" e "Resposta"; §4.7 M-10 e M-11). Portas falsas, com o selador AEAD e o orçamento de saída reais.
import { AuthSessionResponseSchema, SealedRefreshSchema } from "@trampo/contracts/auth";
import { describe, expect, test } from "vitest";

import { ACCESS_TOKEN_LIFETIME_MAX_SECONDS, type AuthSessionOutcome } from "../../src/application/auth/auth-session.js";
import { ExchangeSession } from "../../src/application/auth/exchange-session.js";
import { GOTRUE_EGRESS_POLICY } from "../../src/application/auth/gotrue-egress.js";

import {
  AUTH_CODE,
  AuthHarness,
  CODE_VERIFIER,
  EXTENSION_ORIGIN,
  NAO_RECEBIDO,
  OTHER_ORIGIN,
  PODE_TER_ROTACIONADO,
  RECUSADO,
  SID,
  START_SECONDS,
  type MintOptions,
} from "./fakes/auth-session-harness.js";

const request = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  authCode: AUTH_CODE,
  codeVerifier: CODE_VERIFIER,
  ...overrides,
});

function setup() {
  const h = new AuthHarness();
  const exchange = new ExchangeSession({ gateway: h.gateway, sealer: h.sealer, verifier: h.verifier, egress: h.egress, now: h.now });
  const run = (body: unknown = request(), origin = EXTENSION_ORIGIN): Promise<AuthSessionOutcome> =>
    h.clock.run(exchange.execute({ request: body, origin }));
  return { h, run };
}

const OUT_OF_POLICY = { kind: "indisponivel", reason: "auth_token_fora_da_politica", retryAfterSeconds: null } as const;
const PROVIDER_DOWN = { kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: null } as const;
const NO_KEYS = { kind: "indisponivel", reason: "auth_chaves_indisponiveis", retryAfterSeconds: null } as const;

function session(outcome: AuthSessionOutcome) {
  if (outcome.kind !== "sessao") throw new Error(`esperava sessão, veio ${JSON.stringify(outcome)}`);
  return outcome.session;
}

describe("caminho feliz", () => {
  test("200 com exatamente as 4 chaves, 1 chamada ao GoTrue e a ordem do D4", async () => {
    const { h, run } = setup();
    const outcome = await run();
    const body = session(outcome);
    expect(Object.keys(body).sort()).toEqual(["accessToken", "expiresIn", "refreshToken", "schemaVersion"]);
    expect(AuthSessionResponseSchema.parse(body)).toEqual(body);
    expect(body.schemaVersion).toBe(1);
    expect(body.expiresIn).toBe(900);
    expect(h.calls).toEqual([{ method: "exchangePkce", args: [AUTH_CODE, CODE_VERIFIER], signal: undefined }]);
    expect(h.egressRuns).toEqual(["troca"]);
    // M-10: as chaves antes do orçamento e do GoTrue; a verificação e a selagem depois.
    expect(h.events).toEqual(["keysReady", "egress:troca", "gotrue:exchangePkce", "verify", "seal"]);
  });

  test("o envelope sela o refresh cru com sid do token, sst e iat = agora; só a mesma origem o abre", async () => {
    const { h, run } = setup();
    h.steps.push(h.issues({ refreshToken: "rt-da-troca" }));
    const body = session(await run());
    expect(SealedRefreshSchema.safeParse(body.refreshToken).success).toBe(true);
    expect(body.refreshToken).not.toContain("rt-da-troca");
    expect(h.openEnvelope(body.refreshToken)).toEqual({ rt: "rt-da-troca", sid: SID, sst: START_SECONDS, iat: START_SECONDS });
    expect(h.realSealer.open(body.refreshToken, OTHER_ORIGIN)).toEqual({ ok: false });
    expect(h.sealCalls.map((c) => c.origin)).toEqual([EXTENSION_ORIGIN]);
  });

  test("relógio com milissegundos: sst e iat em segundos inteiros, para baixo", async () => {
    const { h, run } = setup();
    h.steps.push(h.issues());
    h.nowMs = START_SECONDS * 1_000 + 999;
    const body = session(await run());
    expect(h.openEnvelope(body.refreshToken)).toMatchObject({ sst: START_SECONDS, iat: START_SECONDS });
  });

  test("M-11, projeção: o que o gateway trouxer além dos 4 campos não chega à resposta", async () => {
    const { h, run } = setup();
    h.steps.push(() => {
      const tokens = h.mint();
      return { ok: true, tokens: { ...tokens, user: { email: "canario@exemplo.invalid" }, provider_token: "CANARIO-PROVIDER" } as typeof tokens };
    });
    const body = session(await run());
    expect(Object.keys(body)).toHaveLength(4);
    expect(JSON.stringify(body)).not.toContain("CANARIO");
    expect(JSON.stringify(body)).not.toContain("canario");
  });
});

describe("formato antes da rede (D4 passo 1)", () => {
  test.each<[string, unknown]>([
    ["chave extra", request({ state: "x" })],
    ["versão errada", request({ schemaVersion: 2 })],
    ["código curto", request({ authCode: "abc" })],
    ["código com caractere fora do alfabeto", request({ authCode: "abc_defgh" })],
    ["verifier curto", request({ codeVerifier: "x".repeat(42) })],
    ["verifier longo", request({ codeVerifier: "x".repeat(129) })],
    ["sem verifier", { schemaVersion: 1, authCode: AUTH_CODE }],
    ["nulo", null],
    ["string", "{}"],
  ])("%s: entrada inválida, nenhum evento (nem chaves, nem orçamento, nem GoTrue)", async (_name, body) => {
    const { h, run } = setup();
    expect(await run(body)).toEqual({ kind: "entrada_invalida" });
    expect(h.events).toEqual([]);
  });
});

describe("M-10: chaves do JWKS antes do orçamento e do GoTrue (D6)", () => {
  test.each<[string, () => Promise<boolean>]>([
    ["false", async () => false],
    ["exceção", async () => Promise.reject(new Error("jwks"))],
    ["valor truthy que não é true", async () => "sim" as unknown as boolean],
  ])("keysReady %s: 503 auth_chaves_indisponiveis, 0 chamadas e 0 orçamento", async (_name, keysReady) => {
    const { h, run } = setup();
    h.keysReadyResult = keysReady;
    expect(await run()).toEqual(NO_KEYS);
    expect(h.calls).toEqual([]);
    expect(h.egressRuns).toEqual([]);
    expect(h.events).toEqual(["keysReady"]);
    // O orçamento ficou intacto: as 14 trocas da janela continuam livres.
    await h.spend("troca", GOTRUE_EGRESS_POLICY.trocaMax);
  });

  test("keysReady que lança de forma síncrona também é 503", async () => {
    const { h, run } = setup();
    h.keysReadyResult = () => {
      throw new Error("sincrono");
    };
    expect(await run()).toEqual(NO_KEYS);
    expect(h.calls).toEqual([]);
  });
});

describe("orçamento de saída e bulkhead (D8 item 5)", () => {
  test("partição troca esgotada: 503 com o retryAfterSeconds do orçamento e 0 chamadas", async () => {
    const { h, run } = setup();
    await h.spend("troca", GOTRUE_EGRESS_POLICY.trocaMax);
    const outcome = await run();
    expect(outcome).toEqual({ kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: 300 });
    expect(h.calls).toEqual([]);
  });

  test("bulkhead cheio: 503 com retryAfterSeconds 5 e 0 chamadas", async () => {
    const { h, run } = setup();
    const release: (() => void)[] = [];
    const hold = Array.from({ length: GOTRUE_EGRESS_POLICY.maxConcurrent }, () =>
      h.realEgress.run("logout", () => new Promise<void>((resolve) => release.push(resolve))),
    );
    expect(await run()).toEqual({ kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: 5 });
    expect(h.calls).toEqual([]);
    for (const done of release) done();
    await Promise.all(hold);
  });
});

describe("respostas do GoTrue (D7): sempre exatamente 1 chamada na troca", () => {
  test("recusado: 401 auth_troca_recusada, sem verificação nem selagem", async () => {
    const { h, run } = setup();
    h.steps.push(() => RECUSADO);
    expect(await run()).toEqual({ kind: "nao_autenticado", reason: "auth_troca_recusada" });
    expect(h.calls).toHaveLength(1);
    expect(h.events).not.toContain("verify");
    expect(h.sealCalls).toEqual([]);
  });

  test.each([
    ["não recebeu", NAO_RECEBIDO],
    ["pode ter rotacionado (sem nova tentativa: o código PKCE é de uso único)", PODE_TER_ROTACIONADO],
  ])("%s: 503 auth_provedor_indisponivel com 1 chamada", async (_name, result) => {
    const { h, run } = setup();
    h.steps.push(() => result);
    expect(await run()).toEqual(PROVIDER_DOWN);
    expect(h.calls).toHaveLength(1);
    expect(h.egressRuns).toEqual(["troca"]);
  });

  test("gateway que rejeita (quebra a porta): 503, 1 chamada", async () => {
    const { h, run } = setup();
    h.steps.push(() => Promise.reject(new Error("quebrou")));
    expect(await run()).toEqual(PROVIDER_DOWN);
    expect(h.calls).toHaveLength(1);
  });
});

describe("verificação antes de repassar (D6): qualquer falha depois do GoTrue é 503 fora da política", () => {
  test.each([
    ["token_invalido (assinatura, amr, anônimo)", { ok: false, reason: "token_invalido" }],
    ["chaves_indisponiveis (JWKS caiu depois do GoTrue)", { ok: false, reason: "chaves_indisponiveis" }],
  ] as const)("verify %s: 503 auth_token_fora_da_politica, sem selar", async (_name, verification) => {
    const { h, run } = setup();
    h.verifyResult = async () => verification;
    expect(await run()).toEqual(OUT_OF_POLICY);
    expect(h.sealCalls).toEqual([]);
  });

  test("verify que rejeita: 503 fora da política", async () => {
    const { h, run } = setup();
    h.verifyResult = () => Promise.reject(new Error("quebrou"));
    expect(await run()).toEqual(OUT_OF_POLICY);
  });

  test("sessionId nulo: 503, sem selar", async () => {
    const { h, run } = setup();
    h.steps.push(h.issues({ sessionId: null }));
    expect(await run()).toEqual(OUT_OF_POLICY);
    expect(h.sealCalls).toEqual([]);
  });
});

describe("M-11: política dos 900 s sem clamp silencioso (D4 passos 6 e 8)", () => {
  test("o teto é 900 (HITL-004)", () => {
    expect(ACCESS_TOKEN_LIFETIME_MAX_SECONDS).toBe(900);
  });

  test.each<[string, MintOptions, number | null]>([
    ["expires_in 3600", { expiresIn: 3_600 }, null],
    ["expires_in 901", { expiresIn: 901 }, null],
    ["expires_in 900", { expiresIn: 900 }, 900],
    ["exp − iat 3600", { lifetimeSeconds: 3_600 }, null],
    ["exp − iat 901", { lifetimeSeconds: 901 }, null],
    ["exp − iat 900", { lifetimeSeconds: 900 }, 900],
    // O min() só desconta a idade: com expires_in menor, vale o expires_in.
    ["expires_in 600 com idade 0", { expiresIn: 600 }, 600],
    // M-11: o min() que vira expires_in devolveria 900 aqui.
    ["expires_in 900 com idade 300", { ageSeconds: 300 }, 600],
    ["expires_in 600 com idade 400", { expiresIn: 600, ageSeconds: 400 }, 500],
    // Fronteiras do §4.2 (emenda da revisão da F1-AUTH-00).
    ["idade 899", { ageSeconds: 899 }, 1],
    ["idade 900", { ageSeconds: 900 }, null],
    ["idade 909 (dentro da tolerância de 10 s do verificador)", { ageSeconds: 909 }, null],
    // `iat` 5 s no futuro (relógio do GoTrue adiantado, dentro da tolerância): o teto de 900 continua de pé.
    ["iat 5 s no futuro", { ageSeconds: -5 }, 900],
  ])("%s → %s", async (_name, mint, expected) => {
    const { h, run } = setup();
    h.steps.push(h.issues(mint));
    const outcome = await run();
    if (expected === null) {
      expect(outcome).toEqual(OUT_OF_POLICY);
      expect(h.sealCalls).toEqual([]);
    } else {
      expect(session(outcome).expiresIn).toBe(expected);
    }
  });

  test("idade com milissegundos: 899,5 s deixa 0,5 s, que arredonda para 0 e dá 503 (nunca promete vida a mais)", async () => {
    const { h, run } = setup();
    h.steps.push(() => {
      const tokens = h.mint({ ageSeconds: 899 });
      h.nowMs += 500;
      return { ok: true, tokens };
    });
    expect(await run()).toEqual(OUT_OF_POLICY);
  });

  test("idade com milissegundos: 600,9 s dá expiresIn 299 (para baixo, inteiro)", async () => {
    const { h, run } = setup();
    h.steps.push(() => {
      const tokens = h.mint({ ageSeconds: 600 });
      h.nowMs += 900;
      return { ok: true, tokens };
    });
    expect(session(await run()).expiresIn).toBe(299);
  });

  test("expires_in que não é número (porta quebrada): 503, nunca 200", async () => {
    const { h, run } = setup();
    h.steps.push(() => ({ ok: true, tokens: { ...h.mint(), expiresIn: Number.NaN } }));
    expect(await run()).toEqual(OUT_OF_POLICY);
  });
});

describe("selagem e resposta reparseada", () => {
  test("refresh que não cabe no envelope (texto claro acima de 768 bytes): 503, nunca 500", async () => {
    const { h, run } = setup();
    h.steps.push(h.issues({ refreshToken: "é".repeat(400) }));
    expect(await run()).toEqual(OUT_OF_POLICY);
    expect(h.sealCalls).toHaveLength(1);
  });

  test("selador que lança: 503", async () => {
    const { h, run } = setup();
    h.sealOverride = () => {
      throw new Error("quebrou");
    };
    expect(await run()).toEqual(OUT_OF_POLICY);
  });

  test("envelope fora do SealedRefreshSchema (selador quebrado): 503", async () => {
    const { h, run } = setup();
    h.sealOverride = () => ({ ok: true, envelope: "nao-e-envelope" });
    expect(await run()).toEqual(OUT_OF_POLICY);
  });

  test("access token fora do AccessTokenSchema, mesmo verificado: 503", async () => {
    const { h, run } = setup();
    h.steps.push(h.issues({ accessToken: `a.${"b".repeat(8_192)}.c` }));
    expect(await run()).toEqual(OUT_OF_POLICY);
  });
});
