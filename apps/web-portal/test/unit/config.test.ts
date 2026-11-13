import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PortalConfigError, parsePortalConfig, readPortalConfig, resetPortalConfigForTests } from "../../src/server/config";

const material = (): string => randomBytes(32).toString("base64url");
// A chave publishable é montada em tempo de execução (cuidado 14 do TRILHAS).
const PUBLISHABLE = ["sb", "publishable", "x".repeat(20)].join("_");

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PORTAL_ORIGIN: "https://portal.exemplo.invalid",
    SUPABASE_URL: "https://projeto.supabase.invalid",
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    PORTAL_SEAL_KEYS: `a1:${material()}`,
    PORTAL_SEAL_ACTIVE_KEY: "a1",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetPortalConfigForTests();
});

describe("parsePortalConfig (ADR-027 D9)", () => {
  it("deriva o issuer e o JWKS do SUPABASE_URL e marca o https do portal", () => {
    const config = parsePortalConfig(env());
    expect(config.portalOrigin).toBe("https://portal.exemplo.invalid");
    expect(config.https).toBe(true);
    expect(config.supabaseUrl).toBe("https://projeto.supabase.invalid");
    expect(config.issuer).toBe("https://projeto.supabase.invalid/auth/v1");
    expect(config.jwksUrl.href).toBe("https://projeto.supabase.invalid/auth/v1/.well-known/jwks.json");
    expect(config.publishableKey).toBe(PUBLISHABLE);
    expect(config.sealKeys.active.kid).toBe("a1");
  });

  it("aceita http só em loopback (portal e Supabase locais)", () => {
    const config = parsePortalConfig(env({ PORTAL_ORIGIN: "http://127.0.0.1:3100", SUPABASE_URL: "http://localhost:54321" }));
    expect(config.https).toBe(false);
    expect(config.portalOrigin).toBe("http://127.0.0.1:3100");
  });

  it.each([
    ["PORTAL_ORIGIN", undefined],
    ["PORTAL_ORIGIN", ""],
    ["PORTAL_ORIGIN", "http://portal.exemplo.invalid"],
    ["PORTAL_ORIGIN", "https://portal.exemplo.invalid/"],
    ["PORTAL_ORIGIN", "https://portal.exemplo.invalid/conta"],
    ["PORTAL_ORIGIN", "https://user:senha@portal.exemplo.invalid"],
    ["PORTAL_ORIGIN", "https://PORTAL.exemplo.invalid"],
    ["PORTAL_ORIGIN", "nada"],
    ["SUPABASE_URL", "http://projeto.supabase.invalid"],
    ["SUPABASE_URL", "https://projeto.supabase.invalid/auth/v1"],
    ["SUPABASE_PUBLISHABLE_KEY", undefined],
    ["SUPABASE_PUBLISHABLE_KEY", ["sb", "secret", "x".repeat(20)].join("_")],
    ["SUPABASE_PUBLISHABLE_KEY", ["ey", "J", "x".repeat(20)].join("")],
    ["SUPABASE_PUBLISHABLE_KEY", `${PUBLISHABLE}\n`],
    ["PORTAL_SEAL_KEYS", undefined],
    ["PORTAL_SEAL_KEYS", "a1:curta"],
    ["PORTAL_SEAL_ACTIVE_KEY", "b2"],
  ])("recusa %s = %j, com o nome do campo e sem o valor", (field, value) => {
    const input = env({ [field]: value });
    try {
      parsePortalConfig(input);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PortalConfigError);
      expect((error as PortalConfigError).field).toBe(field);
      if (value !== undefined && value.length > 0) expect((error as Error).message).not.toContain(value);
    }
  });
});

describe("readPortalConfig", () => {
  it("lê o process.env uma vez e guarda", () => {
    for (const [key, value] of Object.entries(env())) vi.stubEnv(key, value as string);
    const first = readPortalConfig();
    vi.stubEnv("PORTAL_ORIGIN", "https://outro.exemplo.invalid");
    expect(readPortalConfig()).toBe(first);
    resetPortalConfigForTests();
    expect(readPortalConfig().portalOrigin).toBe("https://outro.exemplo.invalid");
  });

  it("falha fechado sem ambiente", () => {
    expect(() => readPortalConfig()).toThrow(PortalConfigError);
  });
});
