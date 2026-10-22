// F1-API-02 (ADR-013 D6): SUPABASE_URL e SUPABASE_JWKS_URL obrigatórias e coerentes; sem elas a API não sobe.
import { describe, expect, test } from "vitest";

import { AuthEnvSchema, isSupabaseOrigin } from "../src/presentation/edge/auth-env.js";

const URL_OK = "https://abcdefghijklmnopqrst.supabase.co";
const JWKS_OK = `${URL_OK}/auth/v1/.well-known/jwks.json`;

describe("AuthEnvSchema", () => {
  test("válido: deriva o issuer e a URL do JWKS", () => {
    const env = AuthEnvSchema.parse({ SUPABASE_URL: URL_OK, SUPABASE_JWKS_URL: JWKS_OK });
    expect(env.issuer).toBe(`${URL_OK}/auth/v1`);
    expect(env.jwksUrl.href).toBe(JWKS_OK);
  });

  test("Supabase local em loopback (http) é aceito", () => {
    const local = "http://127.0.0.1:54321";
    expect(AuthEnvSchema.parse({ SUPABASE_URL: local, SUPABASE_JWKS_URL: `${local}/auth/v1/.well-known/jwks.json` }).issuer).toBe(
      `${local}/auth/v1`,
    );
  });

  test.each<[string, Record<string, string | undefined>]>([
    ["nenhuma variável", {}],
    ["sem SUPABASE_URL", { SUPABASE_JWKS_URL: JWKS_OK }],
    ["sem SUPABASE_JWKS_URL", { SUPABASE_URL: URL_OK }],
    ["vazias", { SUPABASE_URL: "", SUPABASE_JWKS_URL: "" }],
    ["JWKS de outro projeto", { SUPABASE_URL: URL_OK, SUPABASE_JWKS_URL: "https://outro.supabase.co/auth/v1/.well-known/jwks.json" }],
    ["JWKS com caminho errado", { SUPABASE_URL: URL_OK, SUPABASE_JWKS_URL: `${URL_OK}/auth/v1/jwks` }],
    ["JWKS com query", { SUPABASE_URL: URL_OK, SUPABASE_JWKS_URL: `${JWKS_OK}?x=1` }],
    ["URL com barra final", { SUPABASE_URL: `${URL_OK}/`, SUPABASE_JWKS_URL: `${URL_OK}//auth/v1/.well-known/jwks.json` }],
  ])("%s: recusado (falha fechado)", (_label, env) => {
    expect(AuthEnvSchema.safeParse(env).success).toBe(false);
  });

  test.each([
    [URL_OK, true],
    ["http://localhost:54321", true],
    ["http://127.0.0.1:54321", true],
    ["http://abcdefghijklmnopqrst.supabase.co", false],
    [`${URL_OK}/`, false],
    [`${URL_OK}/auth/v1`, false],
    ["https://user:senha@abc.supabase.co", false],
    ["HTTPS://ABC.SUPABASE.CO", false],
    ["ftp://abc.supabase.co", false],
    ["não é URL", false],
  ])("isSupabaseOrigin(%s) → %s", (value, expected) => {
    expect(isSupabaseOrigin(value)).toBe(expected);
  });
});
