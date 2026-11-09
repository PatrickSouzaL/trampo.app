// F1-EXT-05a (ADR-004 D2, D3 passo 3 e §4.1; SR-18): PKCE S256 e `state` do login no Service Worker.
import { PkceVerifierSchema } from "@trampo/contracts/auth";
import { describe, expect, test, vi } from "vitest";

import { base64url, createPkcePair, createState, s256Challenge, type PkceCrypto } from "../src/auth/pkce";

// RFC 7636, Apêndice B (errata de 2026-11-04 no ADR-004 §4.1: `Melhoa2`, conferido pelo node:crypto).
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const RFC_VERIFIER_BYTES = [
  116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83,
  132, 141, 121,
];

/** Fonte de entropia determinística: devolve os bytes dados, em ordem, e registra cada pedido. */
function fixedSource(...chunks: number[][]): PkceCrypto & { sizes: number[] } {
  const queue = chunks.map((c) => Uint8Array.from(c));
  const sizes: number[] = [];
  return {
    sizes,
    getRandomValues(bytes) {
      sizes.push(bytes.length);
      bytes.set(queue.shift() ?? new Uint8Array(bytes.length));
      return bytes;
    },
    subtle: crypto.subtle,
  };
}

describe("base64url", () => {
  test("sem preenchimento e com o alfabeto de URL (RFC 4648 §5)", () => {
    expect(base64url(Uint8Array.from([0xfb, 0xff]))).toBe("-_8");
    expect(base64url(Uint8Array.from([0xfb, 0xef, 0xbe]))).toBe("----");
    expect(base64url(Uint8Array.from([0xff, 0xff, 0xff]))).toBe("____");
    expect(base64url(Uint8Array.from([0x00]))).toBe("AA");
    expect(base64url(new Uint8Array())).toBe("");
  });
});

describe("s256Challenge", () => {
  test("vetor do RFC 7636, Apêndice B", async () => {
    expect(await s256Challenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  test("sem crypto.subtle, lança: nunca cai para plain", async () => {
    const semSubtle: PkceCrypto = { getRandomValues: (b) => b, subtle: undefined };
    await expect(s256Challenge(RFC_VERIFIER, semSubtle)).rejects.toThrow(/crypto\.subtle/);
    await expect(createPkcePair(semSubtle)).rejects.toThrow(/crypto\.subtle/);
  });

  test("usa SHA-256 do texto UTF-8 do verifier", async () => {
    const digest = vi.fn(async (algorithm: AlgorithmIdentifier, data: BufferSource) => crypto.subtle.digest(algorithm, data));
    await s256Challenge("abc", { getRandomValues: (b) => b, subtle: { digest } });
    expect(digest).toHaveBeenCalledTimes(1);
    expect(digest.mock.calls[0]?.[0]).toBe("SHA-256");
    expect([...new Uint8Array(digest.mock.calls[0]?.[1] as Uint8Array)]).toEqual([97, 98, 99]);
  });
});

describe("createPkcePair", () => {
  test("32 bytes da fonte injetada viram o verifier do RFC e o seu challenge", async () => {
    const source = fixedSource(RFC_VERIFIER_BYTES);
    expect(await createPkcePair(source)).toEqual({ verifier: RFC_VERIFIER, challenge: RFC_CHALLENGE });
    expect(source.sizes).toEqual([32]);
  });

  test("com a entropia real: 43 caracteres unreserved, aceitos pelo contrato, e um par novo a cada login", async () => {
    const a = await createPkcePair();
    const b = await createPkcePair();
    for (const pair of [a, b]) {
      expect(pair.verifier).toMatch(/^[\w-]{43}$/);
      expect(PkceVerifierSchema.safeParse(pair.verifier).success).toBe(true);
      expect(pair.challenge).toBe(await s256Challenge(pair.verifier));
      expect(pair.challenge).not.toBe(pair.verifier);
    }
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("createState", () => {
  test("16 bytes da fonte injetada, em 22 caracteres base64url", () => {
    const source = fixedSource(Array.from({ length: 16 }, () => 0xff));
    expect(createState(source)).toBe("_____________________w");
    expect(source.sizes).toEqual([16]);
  });

  test("com a entropia real, um state novo a cada login", () => {
    const a = createState();
    expect(a).toMatch(/^[\w-]{22}$/);
    expect(createState()).not.toBe(a);
  });
});
