// F1-API-07 07f (ADR-004 D4, `RefreshSession`; D5; D6; D7; D8 itens 3 e 5; §4.2 "Envelope", "Orçamento de saída",
// "GoTrue" e "JWKS"; §4.7 M-09, M-10 e o operador "orçamento antes do `open`" do M-16). Portas falsas, com o selador
// AEAD e o orçamento de saída reais; o FakeClock dá o prazo da nova tentativa sem espera real.
import { randomBytes } from "node:crypto";

import { SealedRefreshSchema } from "@trampo/contracts/auth";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import type { AuthSessionOutcome } from "../../src/application/auth/auth-session.js";
import { GOTRUE_EGRESS_POLICY } from "../../src/application/auth/gotrue-egress.js";
import {
  REFRESH_SESSION_POLICY,
  RefreshSession,
  RefreshSessionConfigError,
  type SessionAges,
} from "../../src/application/auth/refresh-session.js";
import type { AuthTokenResult } from "../../src/application/ports/auth-token-gateway.js";
import { createAeadRefreshSealer, parseRefreshKeyring } from "../../src/infrastructure/crypto/aead-refresh-sealer.js";

import {
  AGES,
  AuthHarness,
  EXTENSION_ORIGIN,
  NAO_RECEBIDO,
  OTHER_ORIGIN,
  OTHER_SID,
  PODE_TER_ROTACIONADO,
  RECUSADO,
  SID,
  START_SECONDS,
  newSealKey,
} from "./fakes/auth-session-harness.js";

function setup(ages: SessionAges = AGES) {
  const h = new AuthHarness();
  const refresh = new RefreshSession({
    gateway: h.gateway,
    sealer: h.sealer,
    verifier: h.verifier,
    egress: h.egress,
    clock: h.clock,
    now: h.now,
    ages,
  });
  const run = (refreshToken: unknown = h.envelope(), origin = EXTENSION_ORIGIN, extra: Record<string, unknown> = {}): Promise<AuthSessionOutcome> =>
    h.clock.run(refresh.execute({ request: { schemaVersion: 1, refreshToken, ...extra }, origin }));
  return { h, refresh, run };
}

const OUT_OF_POLICY = { kind: "indisponivel", reason: "auth_token_fora_da_politica", retryAfterSeconds: null } as const;
const PROVIDER_DOWN = { kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: null } as const;
const NO_KEYS = { kind: "indisponivel", reason: "auth_chaves_indisponiveis", retryAfterSeconds: null } as const;
const rejected = (reason: string) => ({ kind: "nao_autenticado", reason });

function session(outcome: AuthSessionOutcome) {
  if (outcome.kind !== "sessao") throw new Error(`esperava sessão, veio ${JSON.stringify(outcome)}`);
  return outcome.session;
}

/** Envelope com a forma do contrato e bytes aleatórios: o AEAD não abre. */
function forgedEnvelope(): string {
  return ["r1", "k1", randomBytes(12), randomBytes(48), randomBytes(16)]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

describe("caminho feliz (D4 passos 1 a 8)", () => {
  test("200, 1 chamada com o rt do envelope, a ordem sem rede antes da rede, mesmo sst e iat novo", async () => {
    const { h, run } = setup();
    h.steps.push(h.issues({ refreshToken: "rt-novo" }));
    const envelope = h.envelope({ rt: "rt-original", sst: START_SECONDS - 3_600, iat: START_SECONDS - 120 });
    const body = session(await run(envelope));
    expect(body.expiresIn).toBe(900);
    expect(h.calls).toEqual([{ method: "refresh", args: ["rt-original"], signal: undefined }]);
    expect(h.egressRuns).toEqual(["renovacao"]);
    // open, idades (sem evento) → chaves → orçamento → GoTrue → verificação → selagem.
    expect(h.events).toEqual(["open", "keysReady", "egress:renovacao", "gotrue:refresh", "verify", "seal"]);
    expect(h.openEnvelope(body.refreshToken)).toEqual({ rt: "rt-novo", sid: SID, sst: START_SECONDS - 3_600, iat: START_SECONDS });
    expect(body.refreshToken).not.toBe(envelope);
    expect(SealedRefreshSchema.safeParse(body.refreshToken).success).toBe(true);
  });

  test("a resposta tem as 4 chaves e o access novo", async () => {
    const { h, run } = setup();
    const tokens = h.mint();
    h.steps.push(() => ({ ok: true, tokens }));
    const body = session(await run());
    expect(Object.keys(body).sort()).toEqual(["accessToken", "expiresIn", "refreshToken", "schemaVersion"]);
    expect(body.accessToken).toBe(tokens.accessToken);
  });
});

describe("formato antes do open", () => {
  test.each<[string, unknown, Record<string, unknown>]>([
    ["fora do SealedRefreshSchema", "r1.k1.curto", {}],
    ["chave extra", undefined, { extra: 1 }],
    ["não string", 42, {}],
  ])("%s: entrada inválida, nenhum evento", async (_name, refreshToken, extra) => {
    const { h, run } = setup();
    expect(await run(refreshToken ?? h.envelope(), EXTENSION_ORIGIN, extra)).toEqual({ kind: "entrada_invalida" });
    expect(h.events).toEqual([]);
  });
});

describe("envelope (D5; §4.2): 401 auth_envelope_invalido com 0 chamadas e 0 orçamento", () => {
  const cases: [string, (h: AuthHarness) => string, string][] = [
    ["blob aleatório com a forma do contrato", () => forgedEnvelope(), EXTENSION_ORIGIN],
    ["tag adulterada", (h) => {
      const parts = h.envelope().split(".");
      const tag = Buffer.from(parts[4] ?? "", "base64url");
      tag[0] = (tag[0] ?? 0) ^ 1;
      parts[4] = tag.toString("base64url");
      return parts.join(".");
    }, EXTENSION_ORIGIN],
    ["kid desconhecido", (h) => h.envelope().replace(/^r1\.k1\./, "r1.k9."), EXTENSION_ORIGIN],
    ["AAD de outra origem", (h) => h.envelope(), OTHER_ORIGIN],
    ["outra chave de selagem", () => {
      const other = createAeadRefreshSealer(parseRefreshKeyring(`k1:${newSealKey()}`, "k1"));
      const sealed = other.seal({ rt: "rt", sid: SID, sst: START_SECONDS, iat: START_SECONDS }, EXTENSION_ORIGIN);
      return sealed.ok ? sealed.envelope : "";
    }, EXTENSION_ORIGIN],
    ["tag em base64url não canônica", (h) => {
      const parts = h.envelope().split(".");
      const tag = parts[4] ?? "";
      // O 22º caractere carrega só 2 bits da tag (canônicos: A, Q, g, w): o seguinte no alfabeto só liga um bit de
      // sobra, e os bytes decodificados não mudam.
      const last = tag.at(-1) ?? "A";
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      parts[4] = tag.slice(0, -1) + alphabet.charAt(alphabet.indexOf(last) + 1);
      return parts.join(".");
    }, EXTENSION_ORIGIN],
  ];

  test.each(cases)("%s", async (_name, make, origin) => {
    const { h, run } = setup();
    const envelope = make(h);
    expect(SealedRefreshSchema.safeParse(envelope).success).toBe(true);
    expect(await run(envelope, origin)).toEqual(rejected("auth_envelope_invalido"));
    expect(h.events).toEqual(["open"]);
    expect(h.calls).toEqual([]);
    expect(h.egressRuns).toEqual([]);
  });

  test("selador que lança no open: 401, 0 chamadas", async () => {
    const { h, run } = setup();
    h.openOverride = () => {
      throw new Error("quebrou");
    };
    expect(await run()).toEqual(rejected("auth_envelope_invalido"));
    expect(h.calls).toEqual([]);
  });
});

describe("M-16, orçamento antes do open: forjado nunca consome, genuíno é barrado pelo orçamento", () => {
  test("10.000 envelopes forjados consomem 0 do orçamento; depois, 74 renovações genuínas passam e a 75ª é barrada", async () => {
    const { h, run } = setup();
    for (let i = 0; i < 10_000; i += 1) {
      const outcome = await run(forgedEnvelope());
      expect(outcome.kind).toBe("nao_autenticado");
    }
    expect(h.egressRuns).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.events.every((event) => event === "open")).toBe(true);

    // O *replay* do mesmo envelope genuíno fica limitado pelo orçamento (D8 item 3): o total do /token inteiro.
    const envelope = h.envelope();
    for (let i = 0; i < GOTRUE_EGRESS_POLICY.tokenTotalMax; i += 1) expect((await run(envelope)).kind).toBe("sessao");
    expect(h.calls).toHaveLength(GOTRUE_EGRESS_POLICY.tokenTotalMax);
    expect(await run(envelope)).toEqual({ kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: 300 });
    expect(h.calls).toHaveLength(GOTRUE_EGRESS_POLICY.tokenTotalMax);
  });

  test("idade máxima e inatividade vencidas também não consomem orçamento", async () => {
    const { h, run } = setup();
    for (let i = 0; i < 200; i += 1) {
      await run(h.envelope({ sst: START_SECONDS - AGES.maxAgeSeconds - 1 }));
      await run(h.envelope({ iat: START_SECONDS - AGES.idleSeconds - 1 }));
    }
    expect(h.egressRuns).toEqual([]);
    await h.spend("renovacao", GOTRUE_EGRESS_POLICY.tokenTotalMax);
  });

  test("propriedade: nenhum envelope forjado chega ao orçamento", async () => {
    const { h, run } = setup();
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 15, maxLength: 200 }), fc.uint8Array({ minLength: 16, maxLength: 16 }), async (ct, tag) => {
        const envelope = `r1.k1.${randomBytes(12).toString("base64url")}.${Buffer.from(ct).toString("base64url")}.${Buffer.from(tag).toString("base64url")}`;
        const outcome = await run(envelope);
        return outcome.kind === "nao_autenticado" || outcome.kind === "entrada_invalida";
      }),
      { numRuns: 300 },
    );
    expect(h.egressRuns).toEqual([]);
  });
});

describe("M-09: idade máxima e inatividade sem rede, limites exatos (D5)", () => {
  test("idade = máxima exata: passa (1 chamada); 1 ms além: 401 auth_sessao_idade_maxima com 0 chamadas", async () => {
    const envelopeAt = (h: AuthHarness) =>
      h.envelope({ sst: START_SECONDS - 600, iat: START_SECONDS - 600 + AGES.maxAgeSeconds - 60 });
    const atLimit = setup();
    atLimit.h.nowMs = (START_SECONDS - 600 + AGES.maxAgeSeconds) * 1_000;
    expect((await atLimit.run(envelopeAt(atLimit.h))).kind).toBe("sessao");
    expect(atLimit.h.calls).toHaveLength(1);

    const over = setup();
    over.h.nowMs = (START_SECONDS - 600 + AGES.maxAgeSeconds) * 1_000 + 1;
    expect(await over.run(envelopeAt(over.h))).toEqual(rejected("auth_sessao_idade_maxima"));
    expect(over.h.events).toEqual(["open"]);
    expect(over.h.calls).toEqual([]);
  });

  test("inatividade = limite exato: passa; 1 ms além: 401 auth_sessao_inativa com 0 chamadas", async () => {
    const envelopeAt = (h: AuthHarness) => h.envelope({ sst: START_SECONDS - 600, iat: START_SECONDS - AGES.idleSeconds });
    const atLimit = setup();
    expect((await atLimit.run(envelopeAt(atLimit.h))).kind).toBe("sessao");
    expect(atLimit.h.calls).toHaveLength(1);

    const over = setup();
    over.h.nowMs += 1;
    expect(await over.run(envelopeAt(over.h))).toEqual(rejected("auth_sessao_inativa"));
    expect(over.h.events).toEqual(["open"]);
    expect(over.h.calls).toEqual([]);
  });

  test("as duas vencidas: a idade máxima decide primeiro", async () => {
    const { h, run } = setup();
    const envelope = h.envelope({ sst: START_SECONDS - AGES.maxAgeSeconds - 10, iat: START_SECONDS - AGES.idleSeconds - 10 });
    expect(await run(envelope)).toEqual(rejected("auth_sessao_idade_maxima"));
  });

  test("as idades vêm da configuração, não de constantes", async () => {
    const { h, run } = setup({ maxAgeSeconds: 3_600, idleSeconds: 900 });
    expect(await run(h.envelope({ sst: START_SECONDS - 3_601, iat: START_SECONDS }))).toEqual(rejected("auth_sessao_idade_maxima"));
    expect(await run(h.envelope({ sst: START_SECONDS - 100, iat: START_SECONDS - 901 }))).toEqual(rejected("auth_sessao_inativa"));
    expect((await run(h.envelope({ sst: START_SECONDS - 3_600, iat: START_SECONDS - 900 }))).kind).toBe("sessao");
  });
});

describe("M-10: chaves do JWKS depois das idades e antes do orçamento (D6)", () => {
  test("sem chaves: 503 auth_chaves_indisponiveis, 0 chamadas, 0 orçamento (o refresh não é consumido)", async () => {
    const { h, run } = setup();
    h.keysReadyResult = async () => false;
    expect(await run()).toEqual(NO_KEYS);
    expect(h.events).toEqual(["open", "keysReady"]);
    expect(h.calls).toEqual([]);
    expect(h.egressRuns).toEqual([]);
  });

  test("keysReady que rejeita: 503, 0 chamadas", async () => {
    const { h, run } = setup();
    h.keysReadyResult = () => Promise.reject(new Error("jwks"));
    expect(await run()).toEqual(NO_KEYS);
    expect(h.calls).toEqual([]);
  });
});

describe("respostas do GoTrue na 1ª chamada (D4 passo 6; D7)", () => {
  test("recusado: 401 auth_renovacao_recusada, exatamente 1 chamada, sem selar", async () => {
    const { h, run } = setup();
    h.steps.push(() => RECUSADO);
    expect(await run()).toEqual(rejected("auth_renovacao_recusada"));
    expect(h.calls).toHaveLength(1);
    expect(h.sealCalls).toEqual([]);
  });

  test("não recebeu: 503, exatamente 1 chamada, sem nova tentativa", async () => {
    const { h, run } = setup();
    h.steps.push(() => NAO_RECEBIDO);
    expect(await run()).toEqual(PROVIDER_DOWN);
    expect(h.calls).toHaveLength(1);
    expect(h.egressRuns).toEqual(["renovacao"]);
  });

  test("gateway que rejeita: 503, exatamente 1 chamada, sem nova tentativa", async () => {
    const { h, run } = setup();
    h.steps.push(() => Promise.reject(new Error("quebrou")));
    expect(await run()).toEqual(PROVIDER_DOWN);
    expect(h.calls).toHaveLength(1);
  });

  test("orçamento esgotado: 503 com o retryAfterSeconds dele e 0 chamadas", async () => {
    const { h, run } = setup();
    await h.spend("renovacao", GOTRUE_EGRESS_POLICY.tokenTotalMax);
    expect(await run()).toEqual({ kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: 300 });
    expect(h.calls).toEqual([]);
  });
});

describe("nova tentativa quando o GoTrue pode ter rotacionado (D4 passo 6; §4.2: exatamente 2 chamadas, mesmo rt, até 2 s)", () => {
  test("o prazo é de 2 s", () => {
    expect(REFRESH_SESSION_POLICY).toEqual({ retryTimeoutMs: 2_000 });
  });

  test("pode ter rotacionado → sucesso: 200 com exatamente 2 chamadas e o mesmo rt; a 2ª com signal e orçamento próprio", async () => {
    const { h, run } = setup();
    h.steps.push(() => PODE_TER_ROTACIONADO);
    const body = session(await run(h.envelope({ rt: "rt-original" })));
    expect(h.calls.map((c) => [c.method, c.args])).toEqual([["refresh", ["rt-original"]], ["refresh", ["rt-original"]]]);
    expect(h.calls[0]?.signal).toBeUndefined();
    expect(h.calls[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(h.calls[1]?.signal?.aborted).toBe(true); // o withDeadline solta o prazo ao terminar
    expect(h.egressRuns).toEqual(["renovacao", "renovacao"]);
    expect(h.events).toEqual(["open", "keysReady", "egress:renovacao", "gotrue:refresh", "egress:renovacao", "gotrue:refresh", "verify", "seal"]);
    expect(h.openEnvelope(body.refreshToken).sst).toBe(START_SECONDS - 600);
    expect(h.clock.pendingTimers).toBe(0);
  });

  test.each<[string, AuthTokenResult]>([
    ["pode ter rotacionado de novo", PODE_TER_ROTACIONADO],
    ["recusado (o 1º pode ter rotacionado: 503, não 401)", RECUSADO],
    ["não recebeu", NAO_RECEBIDO],
  ])("2ª chamada %s: 503 com exatamente 2 chamadas", async (_name, second) => {
    const { h, run } = setup();
    h.steps.push(() => PODE_TER_ROTACIONADO, () => second);
    expect(await run()).toEqual(PROVIDER_DOWN);
    expect(h.calls).toHaveLength(2);
    expect(h.sealCalls).toEqual([]);
  });

  test("2ª chamada que rejeita: 503 com 2 chamadas", async () => {
    const { h, run } = setup();
    h.steps.push(() => PODE_TER_ROTACIONADO, () => Promise.reject(new Error("quebrou")));
    expect(await run()).toEqual(PROVIDER_DOWN);
    expect(h.calls).toHaveLength(2);
  });

  test("2ª chamada lenta que respeita o signal: abortada em exatamente 2 s, 503", async () => {
    const { h, run } = setup();
    const startMs = h.clock.nowMs();
    h.steps.push(
      () => PODE_TER_ROTACIONADO,
      (signal) =>
        new Promise<AuthTokenResult>((resolve) => {
          signal?.addEventListener("abort", () => resolve(PODE_TER_ROTACIONADO), { once: true });
        }),
    );
    expect(await run()).toEqual(PROVIDER_DOWN);
    expect(h.clock.nowMs() - startMs).toBe(REFRESH_SESSION_POLICY.retryTimeoutMs);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.signal?.aborted).toBe(true);
  });

  test("2ª chamada que ignora o signal: o caso de uso desiste em 2 s mesmo assim, 503", async () => {
    const { h, run } = setup();
    const startMs = h.clock.nowMs();
    let late: ((value: AuthTokenResult) => void) | undefined;
    h.steps.push(
      () => PODE_TER_ROTACIONADO,
      () => new Promise<AuthTokenResult>((resolve) => {
        late = resolve;
      }),
    );
    expect(await run()).toEqual(PROVIDER_DOWN);
    expect(h.clock.nowMs() - startMs).toBe(REFRESH_SESSION_POLICY.retryTimeoutMs);
    // A resposta tardia não sela nada: o resultado já foi decidido.
    late?.({ ok: true, tokens: h.mint() });
    await Promise.resolve();
    expect(h.sealCalls).toEqual([]);
  });

  test("2ª chamada barrada pelo orçamento: 503 com o retryAfterSeconds dele e só 1 chamada", async () => {
    const { h, run } = setup();
    await h.spend("renovacao", GOTRUE_EGRESS_POLICY.tokenTotalMax - 1);
    h.steps.push(() => PODE_TER_ROTACIONADO);
    expect(await run()).toEqual({ kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: 300 });
    expect(h.calls).toHaveLength(1);
    expect(h.egressRuns).toEqual(["renovacao", "renovacao"]);
  });

  test("nunca uma 3ª chamada", async () => {
    const { h, run } = setup();
    h.steps.push(() => PODE_TER_ROTACIONADO, () => PODE_TER_ROTACIONADO, () => PODE_TER_ROTACIONADO);
    await run();
    expect(h.calls).toHaveLength(2);
  });
});

describe("M-09, sid: o token novo precisa ser da mesma sessão (D4 passo 7)", () => {
  test("sid divergente: 401 depois de 1 chamada, sem selar o refresh novo", async () => {
    const { h, run } = setup();
    h.steps.push(h.issues({ sessionId: OTHER_SID }));
    expect(await run(h.envelope({ sid: SID }))).toEqual(rejected("auth_renovacao_recusada"));
    expect(h.calls).toHaveLength(1);
    expect(h.sealCalls).toEqual([]);
    expect(h.events).toEqual(["open", "keysReady", "egress:renovacao", "gotrue:refresh", "verify"]);
  });

  test("sid divergente depois da nova tentativa: 401 com 2 chamadas, sem selar", async () => {
    const { h, run } = setup();
    h.steps.push(() => PODE_TER_ROTACIONADO, h.issues({ sessionId: OTHER_SID }));
    expect(await run()).toEqual(rejected("auth_renovacao_recusada"));
    expect(h.calls).toHaveLength(2);
    expect(h.sealCalls).toEqual([]);
  });

  test("sessionId nulo: 503 fora da política, sem selar", async () => {
    const { h, run } = setup();
    h.steps.push(h.issues({ sessionId: null }));
    expect(await run()).toEqual(OUT_OF_POLICY);
    expect(h.sealCalls).toEqual([]);
  });
});

describe("verificação antes de repassar na renovação (D6): 503 fora da política", () => {
  test.each([
    ["verify token_invalido", (h: AuthHarness) => {
      h.verifyResult = async () => ({ ok: false, reason: "token_invalido" });
    }],
    ["verify chaves_indisponiveis depois do GoTrue (renovação perdida)", (h: AuthHarness) => {
      h.verifyResult = async () => ({ ok: false, reason: "chaves_indisponiveis" });
    }],
    ["expires_in 3600", (h: AuthHarness) => void h.steps.push(h.issues({ expiresIn: 3_600 }))],
    ["exp − iat 3600", (h: AuthHarness) => void h.steps.push(h.issues({ lifetimeSeconds: 3_600 }))],
    ["idade 900", (h: AuthHarness) => void h.steps.push(h.issues({ ageSeconds: 900 }))],
    ["rt novo que não cabe no envelope", (h: AuthHarness) => void h.steps.push(h.issues({ refreshToken: "é".repeat(400) }))],
  ])("%s", async (_name, arrange) => {
    const { h, run } = setup();
    arrange(h);
    expect(await run()).toEqual(OUT_OF_POLICY);
  });

  test("idade 899: expiresIn 1", async () => {
    const { h, run } = setup();
    h.steps.push(h.issues({ ageSeconds: 899 }));
    expect(session(await run()).expiresIn).toBe(1);
  });
});

describe("configuração das idades em falha fechada", () => {
  const deps = (ages: SessionAges) => {
    const h = new AuthHarness();
    return { gateway: h.gateway, sealer: h.sealer, verifier: h.verifier, egress: h.egress, clock: h.clock, now: h.now, ages };
  };

  test.each<[string, SessionAges]>([
    ["idade máxima zero", { maxAgeSeconds: 0, idleSeconds: 900 }],
    ["inatividade zero", { maxAgeSeconds: 3_600, idleSeconds: 0 }],
    ["inatividade acima da idade máxima", { maxAgeSeconds: 3_600, idleSeconds: 3_601 }],
    ["não inteiro", { maxAgeSeconds: 3_600.5, idleSeconds: 900 }],
    ["NaN", { maxAgeSeconds: Number.NaN, idleSeconds: 900 }],
    ["inatividade não inteira", { maxAgeSeconds: 3_600, idleSeconds: 900.5 }],
  ])("%s: recusa na montagem", (_name, ages) => {
    expect(() => new RefreshSession(deps(ages))).toThrow(RefreshSessionConfigError);
    expect(() => new RefreshSession(deps(ages))).toThrow("idades da sessão do BFF inválidas");
  });

  test("inatividade igual à idade máxima é aceita", () => {
    expect(() => new RefreshSession(deps({ maxAgeSeconds: 3_600, idleSeconds: 3_600 }))).not.toThrow();
  });
});
