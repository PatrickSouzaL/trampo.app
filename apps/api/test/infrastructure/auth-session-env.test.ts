// F1-API-07, commit 07b (ADR-004 D5): ambiente da sessão do BFF, lido em falha fechada. O anel do refresh
// (`AUTH_REFRESH_SEAL_KEYS` e `AUTH_REFRESH_SEAL_ACTIVE_KEY`) é obrigatório; a idade máxima e a inatividade têm
// padrão (24 h e 4 h, HITL-034 Q2 e Q3) e faixas fixadas contra o ADR. Nenhuma mensagem repete valor recebido.
import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  AUTH_SESSION_LIMITS,
  AuthSessionConfigError,
  readAuthSessionEnv,
} from "../../src/infrastructure/auth/auth-session-env.js";
import { RefreshKeyringConfigError } from "../../src/infrastructure/crypto/aead-refresh-sealer.js";

const KEY = randomBytes(32).toString("base64url");
const RING = { AUTH_REFRESH_SEAL_KEYS: `k1:${KEY}`, AUTH_REFRESH_SEAL_ACTIVE_KEY: "k1" };

function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("não lançou");
}

describe("readAuthSessionEnv", () => {
  test("faixas fixadas contra o ADR-004 D5", () => {
    expect(AUTH_SESSION_LIMITS).toEqual({
      maxAgeSeconds: { fallback: 86_400, min: 3_600, max: 86_400 },
      idleSeconds: { fallback: 14_400, min: 900 },
    });
  });

  // F1-API-09 (emenda do ADR-004 D5, sessão 29): o hook do banco recusa a renovação depois de 86.400 s, então um teto
  // acima disso seria uma configuração que o hook anula sem aviso. O teto é o padrão, e o test:db prende os dois à
  // constante da migration.
  test("o teto da idade máxima é o padrão (o 86.400 do hook)", () => {
    expect(AUTH_SESSION_LIMITS.maxAgeSeconds.max).toBe(AUTH_SESSION_LIMITS.maxAgeSeconds.fallback);
    expect(readAuthSessionEnv({ ...RING, AUTH_SESSION_MAX_AGE_SECONDS: "86400" }).maxAgeSeconds).toBe(86_400);
  });

  test("só o anel: idade máxima de 24 h e inatividade de 4 h", () => {
    const config = readAuthSessionEnv(RING);
    expect(config.maxAgeSeconds).toBe(86_400);
    expect(config.idleSeconds).toBe(14_400);
    expect(config.keyring.activeKid).toBe("k1");
    expect(config.keyring.keys.get("k1")).toEqual(Buffer.from(KEY, "base64url"));
  });

  test("variáveis vazias valem como ausentes (padrão)", () => {
    const config = readAuthSessionEnv({ ...RING, AUTH_SESSION_MAX_AGE_SECONDS: "", AUTH_SESSION_IDLE_SECONDS: "" });
    expect([config.maxAgeSeconds, config.idleSeconds]).toEqual([86_400, 14_400]);
  });

  test("valores nas bordas das faixas", () => {
    expect(readAuthSessionEnv({ ...RING, AUTH_SESSION_MAX_AGE_SECONDS: "3600", AUTH_SESSION_IDLE_SECONDS: "900" })).toMatchObject({
      maxAgeSeconds: 3_600,
      idleSeconds: 900,
    });
    expect(readAuthSessionEnv({ ...RING, AUTH_SESSION_MAX_AGE_SECONDS: "86400", AUTH_SESSION_IDLE_SECONDS: "86400" })).toMatchObject({
      maxAgeSeconds: 86_400,
      idleSeconds: 86_400,
    });
    // A inatividade pode ser igual à idade máxima, nunca maior.
    expect(readAuthSessionEnv({ ...RING, AUTH_SESSION_MAX_AGE_SECONDS: "7200", AUTH_SESSION_IDLE_SECONDS: "7200" }).idleSeconds).toBe(7_200);
  });

  test.each([
    ["AUTH_SESSION_MAX_AGE_SECONDS", "3599"],
    // F1-API-09: um acima do teto novo, o teto antigo e um acima dele.
    ["AUTH_SESSION_MAX_AGE_SECONDS", "86401"],
    ["AUTH_SESSION_MAX_AGE_SECONDS", "604800"],
    ["AUTH_SESSION_MAX_AGE_SECONDS", "604801"],
    ["AUTH_SESSION_MAX_AGE_SECONDS", "86400.5"],
    ["AUTH_SESSION_MAX_AGE_SECONDS", "8.64e4"],
    ["AUTH_SESSION_MAX_AGE_SECONDS", "0x15180"],
    ["AUTH_SESSION_MAX_AGE_SECONDS", " 86400"],
    ["AUTH_SESSION_MAX_AGE_SECONDS", "086400"],
    ["AUTH_SESSION_MAX_AGE_SECONDS", "-86400"],
    ["AUTH_SESSION_MAX_AGE_SECONDS", "86400s"],
    ["AUTH_SESSION_IDLE_SECONDS", "899"],
    ["AUTH_SESSION_IDLE_SECONDS", "86401"],
    ["AUTH_SESSION_IDLE_SECONDS", "4h"],
    ["AUTH_SESSION_IDLE_SECONDS", "99999999999999999999"],
  ])("%s=%s → AuthSessionConfigError com o nome, sem o valor", (variable, value) => {
    const error = thrownBy(() => readAuthSessionEnv({ ...RING, [variable]: value }));
    expect(error).toBeInstanceOf(AuthSessionConfigError);
    expect(error.name).toBe("AuthSessionConfigError");
    expect(error.message).toContain(variable);
    expect(error.message).not.toContain(value.trim());
  });

  test("inatividade maior que uma idade máxima configurada é recusada", () => {
    const error = thrownBy(() =>
      readAuthSessionEnv({ ...RING, AUTH_SESSION_MAX_AGE_SECONDS: "7200", AUTH_SESSION_IDLE_SECONDS: "7201" }),
    );
    expect(error).toBeInstanceOf(AuthSessionConfigError);
    expect(error.message).toContain("AUTH_SESSION_IDLE_SECONDS");
    // Com a idade no teto, a inatividade um segundo acima dele também cai, e a mensagem não repete o valor.
    const atCeiling = thrownBy(() =>
      readAuthSessionEnv({ ...RING, AUTH_SESSION_MAX_AGE_SECONDS: "86400", AUTH_SESSION_IDLE_SECONDS: "86401" }),
    );
    expect(atCeiling).toBeInstanceOf(AuthSessionConfigError);
    expect(atCeiling.message).toContain("AUTH_SESSION_IDLE_SECONDS");
    expect(atCeiling.message).not.toContain("86401");
  });

  test.each([
    ["sem anel", {}],
    ["anel vazio", { AUTH_REFRESH_SEAL_KEYS: "", AUTH_REFRESH_SEAL_ACTIVE_KEY: "" }],
    ["sem a ativa", { AUTH_REFRESH_SEAL_KEYS: `k1:${KEY}` }],
    ["ativa fora do anel", { AUTH_REFRESH_SEAL_KEYS: `k1:${KEY}`, AUTH_REFRESH_SEAL_ACTIVE_KEY: "k2" }],
    ["kid fora do contrato", { AUTH_REFRESH_SEAL_KEYS: `K1:${KEY}`, AUTH_REFRESH_SEAL_ACTIVE_KEY: "K1" }],
  ])("%s → RefreshKeyringConfigError sem a chave na mensagem", (_label, env) => {
    const error = thrownBy(() => readAuthSessionEnv(env));
    expect(error).toBeInstanceOf(RefreshKeyringConfigError);
    expect(error.message).not.toContain(KEY);
  });
});
