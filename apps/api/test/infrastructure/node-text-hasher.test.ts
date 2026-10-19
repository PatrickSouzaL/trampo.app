// Adapter TextHasher (ADR-005 D1) contra os vetores oficiais do NIST (FIPS 180-2, apêndice B).
import { describe, expect, test } from "vitest";

import { nodeTextHasher } from "../../src/infrastructure/crypto/node-text-hasher.js";

describe("nodeTextHasher.sha256Hex", () => {
  test.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    ["a".repeat(1_000_000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
  ])("vetor NIST %#", (input, digest) => {
    expect(nodeTextHasher.sha256Hex(input)).toBe(digest);
  });

  test("codifica em UTF-8 (não em UTF-16)", () => {
    // Bytes UTF-8 de "ação" (61 c3 a7 c3 a3 6f), digest calculado à parte com o sha256sum do coreutils.
    expect(nodeTextHasher.sha256Hex("ação")).toBe("0664077f33cc3ebbaa4bbdacac0eb70e740983080f01dce29929e73b7785a7ad");
  });
});
