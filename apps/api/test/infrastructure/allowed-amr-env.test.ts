// F1-API-07, commit 07d (ADR-004 D6; emenda ao ADR-013 D4): a lista de métodos de autenticação (`amr`) aceitos pelo
// verificador, lida em falha fechada. Padrão `oauth`; `password` só com NODE_ENV=test (a pilha local); qualquer outro
// método, espaço, caixa diferente ou duplicata derruba a subida, e a mensagem não repete o valor recebido.
import { describe, expect, test } from "vitest";

import {
  AMR_METHODS,
  AllowedAmrConfigError,
  DEFAULT_ALLOWED_AMR,
  readAllowedAmr,
} from "../../src/infrastructure/auth/allowed-amr-env.js";

function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("não lançou");
}

describe("readAllowedAmr", () => {
  test("métodos e padrão travados contra o ADR-004 D6", () => {
    expect(AMR_METHODS).toEqual(["oauth", "password"]);
    expect(DEFAULT_ALLOWED_AMR).toEqual(["oauth"]);
  });

  test.each<[string, Record<string, string | undefined>]>([
    ["ausente", {}],
    ["vazia", { AUTH_ALLOWED_AMR: "" }],
    ["ausente, mesmo com NODE_ENV=test", { NODE_ENV: "test" }],
  ])("%s: só oauth (o padrão nunca inclui password)", (_label, source) => {
    expect(readAllowedAmr(source)).toEqual(["oauth"]);
  });

  test("oauth explícito, com ou sem NODE_ENV", () => {
    expect(readAllowedAmr({ AUTH_ALLOWED_AMR: "oauth" })).toEqual(["oauth"]);
    expect(readAllowedAmr({ AUTH_ALLOWED_AMR: "oauth", NODE_ENV: "production" })).toEqual(["oauth"]);
  });

  test("password só com NODE_ENV=test exato", () => {
    expect(readAllowedAmr({ AUTH_ALLOWED_AMR: "oauth,password", NODE_ENV: "test" })).toEqual(["oauth", "password"]);
    expect(readAllowedAmr({ AUTH_ALLOWED_AMR: "password", NODE_ENV: "test" })).toEqual(["password"]);
  });

  test.each<[string, Record<string, string | undefined>]>([
    ["password sem NODE_ENV", { AUTH_ALLOWED_AMR: "oauth,password" }],
    ["password com NODE_ENV=production", { AUTH_ALLOWED_AMR: "oauth,password", NODE_ENV: "production" }],
    ["password com NODE_ENV=development", { AUTH_ALLOWED_AMR: "password", NODE_ENV: "development" }],
    ["password com NODE_ENV vazio", { AUTH_ALLOWED_AMR: "password", NODE_ENV: "" }],
    ["password com NODE_ENV=Test", { AUTH_ALLOWED_AMR: "password", NODE_ENV: "Test" }],
    ["password com NODE_ENV=test e espaço", { AUTH_ALLOWED_AMR: "password", NODE_ENV: "test " }],
    ["otp", { AUTH_ALLOWED_AMR: "oauth,otp", NODE_ENV: "test" }],
    ["magiclink", { AUTH_ALLOWED_AMR: "magiclink" }],
    ["anonymous", { AUTH_ALLOWED_AMR: "anonymous", NODE_ENV: "test" }],
    ["sso/saml", { AUTH_ALLOWED_AMR: "sso/saml" }],
    ["caixa diferente", { AUTH_ALLOWED_AMR: "OAuth" }],
    ["espaço depois da vírgula", { AUTH_ALLOWED_AMR: "oauth, password", NODE_ENV: "test" }],
    ["espaço em volta", { AUTH_ALLOWED_AMR: " oauth" }],
    ["vírgula no fim", { AUTH_ALLOWED_AMR: "oauth," }],
    ["só vírgula", { AUTH_ALLOWED_AMR: "," }],
    ["duplicata", { AUTH_ALLOWED_AMR: "oauth,oauth" }],
    ["curinga", { AUTH_ALLOWED_AMR: "*" }],
  ])("%s: derruba a subida sem repetir o valor", (_label, source) => {
    const error = thrownBy(() => readAllowedAmr(source));
    expect(error).toBeInstanceOf(AllowedAmrConfigError);
    expect(error.name).toBe("AllowedAmrConfigError");
    expect(error.message).toContain("AUTH_ALLOWED_AMR");
    const raw = source["AUTH_ALLOWED_AMR"] ?? "";
    for (const piece of raw.split(",").filter((part) => !["oauth", "password", ""].includes(part))) {
      expect(error.message).not.toContain(piece);
    }
  });
});
