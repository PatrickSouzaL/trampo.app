// Peças de base do ADR-014: HMAC das chaves (D7), ambiente obrigatório (D8) e relógio real.
import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  PSEUDONYM_HEX_CHARS,
  PepperConfigError,
  createHmacKeyPseudonymizer,
} from "../../src/infrastructure/crypto/hmac-key-pseudonymizer.js";
import { LimitsEnvSchema, isUpstashOrigin } from "../../src/infrastructure/limits/limits-env.js";
import { asInteger, asStoredCount, bestEffort, isOne } from "../../src/infrastructure/limits/redis-replies.js";
import { systemClock } from "../../src/infrastructure/time/system-clock.js";

// Pepper de teste (gerado só para este arquivo; não é segredo de nenhum ambiente).
const PEPPER = "q3Jx7W0sY1n2b4V6c8D0e2F4g6H8i0K2m4N6p8R0t2U";
const SUB = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";

describe("HMAC das chaves (ADR-014 D7; SR-17)", () => {
  const pseudonymizer = createHmacKeyPseudonymizer(PEPPER);

  test("é o HMAC-SHA256 do pepper decodificado sobre 'domínio:valor', truncado em 32 hex", () => {
    const expected = createHmac("sha256", Buffer.from(PEPPER, "base64url")).update(`sub:${SUB}`).digest("hex").slice(0, 32);
    expect(pseudonymizer.pseudonym("sub", SUB)).toBe(expected);
    expect(pseudonymizer.pseudonym("sub", SUB)).toMatch(/^[0-9a-f]{32}$/);
    expect(PSEUDONYM_HEX_CHARS).toBe(32);
  });

  test("determinístico, com domínios separados e sem o valor em claro", () => {
    const a = pseudonymizer.pseudonym("ip", "v4:203.0.113.7");
    expect(pseudonymizer.pseudonym("ip", "v4:203.0.113.7")).toBe(a);
    expect(pseudonymizer.pseudonym("sub", "v4:203.0.113.7")).not.toBe(a);
    expect(pseudonymizer.pseudonym("ip", "v4:203.0.113.8")).not.toBe(a);
    expect(a).not.toContain("203");
  });

  test("outro pepper, outro pseudônimo (a rotação troca todas as chaves)", () => {
    // O 1º caractere (o último de 43 tem 2 bits de enchimento que o base64url descarta).
    const other = createHmacKeyPseudonymizer(`Z${PEPPER.slice(1)}`);
    expect(other.pseudonym("sub", SUB)).not.toBe(pseudonymizer.pseudonym("sub", SUB));
  });

  test.each([
    ["curto demais (42)", PEPPER.slice(0, 42)],
    ["vazio", ""],
    ["com espaço", `${PEPPER.slice(0, 40)} abc`],
    ["base64 com + e /", `${PEPPER.slice(0, 41)}+/`],
    ["com padding", `${PEPPER}=`],
    ["longo demais (513)", "a".repeat(513)],
    ["frase digitada", "minha senha secreta do pepper que eu inventei agora"],
  ])("pepper %s derruba o boot, sem repetir o valor na mensagem", (_name, pepper) => {
    let error: unknown;
    try {
      createHmacKeyPseudonymizer(pepper);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(PepperConfigError);
    expect(String((error as Error).message)).not.toContain(pepper === "" ? "\u0000" : pepper);
  });

  test("43 e 512 caracteres são aceitos", () => {
    expect(() => createHmacKeyPseudonymizer(PEPPER)).not.toThrow();
    expect(() => createHmacKeyPseudonymizer("A".repeat(512))).not.toThrow();
  });
});

describe("ambiente dos limites (ADR-014 D8)", () => {
  const valid = {
    UPSTASH_REDIS_REST_URL: "https://exemplo-123.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "AXyzToken_de-teste.123",
    RATE_KEY_PEPPER: PEPPER,
  };

  test("válido: devolve URL, token e pepper", () => {
    const env = LimitsEnvSchema.parse(valid);
    expect(env.restUrl.href).toBe("https://exemplo-123.upstash.io/");
    expect(env.restToken).toBe(valid.UPSTASH_REDIS_REST_TOKEN);
    expect(env.pepper).toBe(PEPPER);
  });

  test.each([
    ["sem URL", { UPSTASH_REDIS_REST_URL: undefined }],
    ["sem token", { UPSTASH_REDIS_REST_TOKEN: undefined }],
    ["sem pepper", { RATE_KEY_PEPPER: undefined }],
    ["token vazio", { UPSTASH_REDIS_REST_TOKEN: "" }],
    ["token com espaço", { UPSTASH_REDIS_REST_TOKEN: "abc def" }],
    ["token longo demais", { UPSTASH_REDIS_REST_TOKEN: "a".repeat(513) }],
    ["pepper curto", { RATE_KEY_PEPPER: "curto" }],
    ["URL http fora de loopback", { UPSTASH_REDIS_REST_URL: "http://exemplo.upstash.io" }],
    ["URL com caminho", { UPSTASH_REDIS_REST_URL: "https://exemplo.upstash.io/x" }],
  ])("%s derruba a subida, sem ecoar o valor", (_name, patch) => {
    const result = LimitsEnvSchema.safeParse({ ...valid, ...patch });
    expect(result.success).toBe(false);
    const text = JSON.stringify(result.error?.issues);
    expect(text).not.toContain(PEPPER);
    expect(text).not.toContain("abc def");
  });

  test.each([
    ["https://exemplo.upstash.io", true],
    ["http://127.0.0.1:8080", true],
    ["http://localhost:8080", true],
    ["http://exemplo.upstash.io", false],
    ["https://exemplo.upstash.io/", false],
    ["https://user:senha@exemplo.upstash.io", false],
    ["ftp://exemplo.upstash.io", false],
    ["não é URL", false],
  ])("origem %s → %s", (value, expected) => {
    expect(isUpstashOrigin(value)).toBe(expected);
  });
});

describe("leitura estrita das respostas", () => {
  test("asInteger", () => {
    expect(asInteger(3, 1)).toBe(3);
    expect(asInteger(0, 0)).toBe(0);
    expect(asInteger(0, 1)).toBeNull();
    expect(asInteger(1.5, 0)).toBeNull();
    expect(asInteger("3", 0)).toBeNull();
    expect(asInteger(null, 0)).toBeNull();
    expect(asInteger(undefined, 0)).toBeNull();
    expect(asInteger(Number.MAX_SAFE_INTEGER + 2, 0)).toBeNull();
  });

  test("asStoredCount", () => {
    expect(asStoredCount(null)).toBe(0);
    expect(asStoredCount("0")).toBe(0);
    expect(asStoredCount("123")).toBe(123);
    expect(asStoredCount("999999999999999")).toBe(999_999_999_999_999);
    expect(asStoredCount("1000000000000000")).toBeNull();
    expect(asStoredCount("-1")).toBeNull();
    expect(asStoredCount("1.5")).toBeNull();
    expect(asStoredCount("")).toBeNull();
    expect(asStoredCount(" 1")).toBeNull();
    expect(asStoredCount(5)).toBeNull();
    expect(asStoredCount(undefined)).toBeNull();
  });

  test("isOne", () => {
    expect(isOne(1)).toBe(true);
    expect(isOne(0)).toBe(false);
    expect(isOne("1")).toBe(false);
    expect(isOne(undefined)).toBe(false);
  });

  test("bestEffort não espera, não rejeita e usa um signal que não aborta", async () => {
    const signals: AbortSignal[] = [];
    bestEffort(
      {
        exec: (_commands, signal) => {
          signals.push(signal);
          return Promise.reject(new Error("redis fora do ar"));
        },
      },
      [["DECR", "k"]],
    );
    bestEffort(
      {
        exec: () => {
          throw new Error("síncrono");
        },
      },
      [["DECR", "k"]],
    );
    expect(signals).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });
});

describe("systemClock", () => {
  test("monotônico e com sleep real", async () => {
    const start = systemClock.nowMs();
    await systemClock.sleep(15);
    expect(systemClock.nowMs() - start).toBeGreaterThanOrEqual(10);
  });

  test("sleep com signal já abortado resolve na hora", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = systemClock.nowMs();
    await systemClock.sleep(10_000, controller.signal);
    expect(systemClock.nowMs() - start).toBeLessThan(1_000);
  });

  test("abortar durante o sleep resolve na hora e solta o timer", async () => {
    const controller = new AbortController();
    const start = systemClock.nowMs();
    const pending = systemClock.sleep(10_000, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await pending;
    expect(systemClock.nowMs() - start).toBeLessThan(1_000);
  });

  test("o abort solta o timer: nenhum Timeout fica pendurado no event loop", async () => {
    const timeouts = (): number => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timeouts();
    const controller = new AbortController();
    const pending = systemClock.sleep(60_000, controller.signal);
    expect(timeouts()).toBe(before + 1);
    controller.abort();
    await pending;
    expect(timeouts()).toBe(before);
  });

  test("tempo negativo vira zero; sem signal também funciona", async () => {
    await expect(systemClock.sleep(-5)).resolves.toBeUndefined();
    const controller = new AbortController();
    await expect(systemClock.sleep(1, controller.signal)).resolves.toBeUndefined();
  });
});
