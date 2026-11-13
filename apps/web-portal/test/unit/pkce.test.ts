import { describe, expect, it } from "vitest";

import { createNonce, createState, createVerifier, s256, safeEqual } from "../../src/server/pkce";

describe("PKCE e state (ADR-027 D2; RFC 7636)", () => {
  it("verifier de 32 bytes em base64url: 43 caracteres unreserved, novo a cada chamada", () => {
    const verifier = createVerifier();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    expect(createVerifier()).not.toBe(verifier);
  });

  it("state de 16 bytes em base64url: 22 caracteres", () => {
    expect(createState()).toMatch(/^[\w-]{22}$/);
    expect(createState()).not.toBe(createState());
  });

  it("S256 confere o vetor do RFC 7636, apêndice B", () => {
    expect(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("nonce da CSP: 16 bytes em base64 padrão", () => {
    expect(createNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(createNonce());
  });

  it("safeEqual compara em tempo constante, inclusive com tamanhos diferentes", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    // Diferença só no último caractere (o mutante P-02 comparava só o começo).
    expect(safeEqual("a".repeat(21) + "b", "a".repeat(21) + "c")).toBe(false);
  });
});
