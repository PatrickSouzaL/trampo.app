// ADR-007 D5 e D6: o ambiente da borda falha fechado e recusa configurações permissivas.
import { describe, expect, test } from "vitest";

import { EdgeEnvSchema, isExactOrigin } from "../src/presentation/edge/edge-env.js";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

describe("CORS_ALLOWED_ORIGINS", () => {
  test("ausente ou vazio: nenhuma origem (falha fechado)", () => {
    expect(EdgeEnvSchema.parse({}).CORS_ALLOWED_ORIGINS).toEqual([]);
    expect(EdgeEnvSchema.parse({ CORS_ALLOWED_ORIGINS: " " }).CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  test("lista com espaços é aceita e normalizada", () => {
    const env = EdgeEnvSchema.parse({ CORS_ALLOWED_ORIGINS: ` ${EXTENSION} , https://portal.trampo.example,` });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([EXTENSION, "https://portal.trampo.example"]);
  });

  test.each([
    [EXTENSION],
    ["https://portal.trampo.example"],
    ["https://portal.trampo.example:8443"],
    ["http://localhost:3000"],
    ["http://127.0.0.1:3000"],
  ])("aceita %s", (origin) => {
    expect(isExactOrigin(origin)).toBe(true);
  });

  test.each([
    ["curinga", "*"],
    ["curinga de subdomínio", "https://*.trampo.example"],
    ["origem opaca", "null"],
    ["barra final", "https://portal.trampo.example/"],
    ["caminho", "https://portal.trampo.example/app"],
    ["maiúsculas", "HTTPS://PORTAL.TRAMPO.EXAMPLE"],
    ["porta padrão escrita", "https://portal.trampo.example:443"],
    ["credenciais", "https://u:p@portal.trampo.example"],
    ["http fora do loopback", "http://portal.trampo.example"],
    ["id de extensão curto", "chrome-extension://abc"],
    ["id de extensão fora de a–p", "chrome-extension://abcdefghijklmnopabcdefghijklmnoz"],
    ["esquema estranho", "file://"],
    ["não é URL", "portal.trampo.example"],
  ])("recusa %s", (_label, origin) => {
    expect(isExactOrigin(origin)).toBe(false);
    expect(EdgeEnvSchema.safeParse({ CORS_ALLOWED_ORIGINS: `${EXTENSION},${origin}` }).success).toBe(false);
  });

  test("no máximo 10 origens", () => {
    const many = Array.from({ length: 11 }, (_, i) => `https://p${String(i)}.trampo.example`).join(",");
    expect(EdgeEnvSchema.safeParse({ CORS_ALLOWED_ORIGINS: many }).success).toBe(false);
  });
});

describe("TRUST_PROXY", () => {
  test.each([[undefined], [""], ["false"], [" false "]])("%s: false (X-Forwarded-For ignorado)", (raw) => {
    expect(EdgeEnvSchema.parse(raw === undefined ? {} : { TRUST_PROXY: raw }).TRUST_PROXY).toBe(false);
  });

  test("lista de IPs e CIDRs dos saltos reais", () => {
    const env = EdgeEnvSchema.parse({ TRUST_PROXY: "10.0.0.1, 10.1.0.0/16, fd00::/8, ::1" });
    expect(env.TRUST_PROXY).toEqual(["10.0.0.1", "10.1.0.0/16", "fd00::/8", "::1"]);
  });

  test.each([
    ["true"],
    ["*"],
    ["0.0.0.0/0"],
    ["::/0"],
    ["1"],
    ["loopback"],
    ["10.0.0.1, true"],
  ])("recusa %s (confiança ampla ou não verificável)", (raw) => {
    expect(EdgeEnvSchema.safeParse({ TRUST_PROXY: raw }).success).toBe(false);
  });
});
