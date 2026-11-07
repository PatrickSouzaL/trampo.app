// F1-API-07, commit 07b (ADR-004 D5; generalização do ADR-018 D4): AEAD por finalidade. Ida e volta, IV único,
// AAD que não confere, tag e cifrado adulterados, kid desconhecido, rotação, base64url não canônica (SR-21: envelope
// não maleável), prefixo de outra finalidade e anel inválido no boot. O kid do anel fica preso à regex do contrato
// (`SealedRefreshSchema`): o boot aceita exatamente os kids que o contrato aceita. Chaves aleatórias, só no teste.
import { createCipheriv, randomBytes } from "node:crypto";

import { SealedRefreshSchema } from "@trampo/contracts/auth";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import {
  AEAD_KEY_ID_PATTERN,
  AEAD_POLICY,
  createAeadEnvelope,
  decodeCanonical,
  parseAeadKeyring,
  type AeadEnvelopeFormat,
  type AeadKeyring,
} from "../../src/infrastructure/crypto/aead-envelope.js";

class TestRingError extends Error {
  constructor() {
    super("anel de teste inválido");
  }
}
const invalid = (): Error => new TestRingError();

const FORMAT: AeadEnvelopeFormat = { version: "t1", aadPrefix: "trampo:teste:t1:", ciphertextChars: { min: 2, max: 40 } };

function newKey(): string {
  return randomBytes(AEAD_POLICY.keyBytes).toString("base64url");
}

function ring(entries: Record<string, string>, active: string): AeadKeyring {
  return parseAeadKeyring(
    Object.entries(entries)
      .map(([kid, key]) => `${kid}:${key}`)
      .join(","),
    active,
    invalid,
  );
}

const plain = (text: string): Buffer => Buffer.from(text, "utf8");

function parts(envelope: string): [string, string, string, string, string] {
  const [version = "", kid = "", iv = "", ciphertext = "", tag = ""] = envelope.split(".");
  return [version, kid, iv, ciphertext, tag];
}

/** Troca o último caractere por outro que decodifica nos mesmos bytes (bits de sobra diferentes). */
function nonCanonical(text: string): string {
  const last = text.at(-1) ?? "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const twin = [...alphabet].find(
    (c) => c !== last && Buffer.from(`${text.slice(0, -1)}${c}`, "base64url").equals(Buffer.from(text, "base64url")),
  );
  if (twin === undefined) throw new Error("sem gêmeo não canônico");
  return `${text.slice(0, -1)}${twin}`;
}

describe("decodeCanonical", () => {
  test("aceita só a forma que volta igual", () => {
    expect(decodeCanonical("AQ")).toEqual(Buffer.from([1]));
    expect(decodeCanonical("AR")).toBeNull();
    expect(decodeCanonical("AQ==")).toBeNull();
    expect(decodeCanonical("A+")).toBeNull();
    expect(decodeCanonical("")).toEqual(Buffer.alloc(0));
  });
});

describe("parseAeadKeyring: falha fechada no boot, sem ecoar valor", () => {
  test("anel válido de 1 a 4 chaves, com a ativa", () => {
    const keys = { a: newKey(), b2: newKey(), c33: newKey(), z9z9z9z9z9z9z9z9: newKey() };
    const parsed = ring(keys, "b2");
    expect(parsed.activeKid).toBe("b2");
    expect([...parsed.keys.keys()]).toEqual(Object.keys(keys));
    expect(parsed.keys.get("a")).toEqual(Buffer.from(keys.a, "base64url"));
  });

  test.each([
    ["anel vazio", "", ""],
    ["kid ativo vazio", `k1:${newKey()}`, ""],
    ["kid ativo fora do anel", `k1:${newKey()}`, "k2"],
    ["5 chaves", ["a", "b", "c", "d", "e"].map((k) => `${k}:${newKey()}`).join(","), "a"],
    ["kid repetido", `k1:${newKey()},k1:${newKey()}`, "k1"],
    ["sem dois-pontos", newKey(), "k1"],
    ["kid vazio", `:${newKey()}`, ""],
    ["kid com maiúscula", `K1:${newKey()}`, "K1"],
    ["kid com hífen", `k-1:${newKey()}`, "k-1"],
    ["kid com 17 caracteres", `${"a".repeat(17)}:${newKey()}`, "a".repeat(17)],
    ["chave de 31 bytes", `k1:${randomBytes(31).toString("base64url")}`, "k1"],
    ["chave de 33 bytes", `k1:${randomBytes(33).toString("base64url")}`, "k1"],
    ["chave com padding", `k1:${randomBytes(32).toString("base64")}`, "k1"],
    ["chave não canônica", `k1:${nonCanonical(newKey())}`, "k1"],
    ["vírgula sobrando", `k1:${newKey()},`, "k1"],
    ["espaço em volta", ` k1:${newKey()}`, "k1"],
  ])("%s → o erro da finalidade, sem o valor", (_label, keys, active) => {
    let thrown: unknown;
    try {
      parseAeadKeyring(keys, active, invalid);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TestRingError);
    const message = (thrown as Error).message;
    for (const piece of keys.split(/[,:]/).filter((p) => p.length > 2)) expect(message).not.toContain(piece);
  });

  test("o kid aceito no boot é exatamente o kid aceito pelo SealedRefreshSchema (ADR-004 D5, emenda da F1-AUTH-00)", () => {
    const [, , iv, ciphertext, tag] = parts(createAeadEnvelope(FORMAT, ring({ k1: newKey() }, "k1"), invalid).seal(plain("x"), "a"));
    const contractAccepts = (kid: string): boolean =>
      SealedRefreshSchema.safeParse(`r1.${kid}.${iv}.${ciphertext.padEnd(20, "A")}.${tag}`).success;
    const bootAccepts = (kid: string): boolean => {
      try {
        parseAeadKeyring(`${kid}:${newKey()}`, kid, invalid);
        return true;
      } catch {
        return false;
      }
    };
    const fixed = ["a", "0", "k1", "a".repeat(16), "a".repeat(17), "", "K1", "k-1", "k_1", "k.1", "k 1", "kĩ", "k1\n", "ſ"];
    for (const kid of fixed) expect(bootAccepts(kid), JSON.stringify(kid)).toBe(contractAccepts(kid));
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (kid) => {
        fc.pre(!kid.includes(",") && !kid.includes(":") && !kid.includes("."));
        expect(bootAccepts(kid)).toBe(contractAccepts(kid));
        expect(bootAccepts(kid)).toBe(AEAD_KEY_ID_PATTERN.test(kid));
      }),
      { numRuns: 2_000 },
    );
  });
});

describe("createAeadEnvelope", () => {
  test("ida e volta, com a forma <versão>.<kid>.<iv>.<cifrado>.<tag> em base64url canônico", () => {
    const aead = createAeadEnvelope(FORMAT, ring({ k1: newKey() }, "k1"), invalid);
    const envelope = aead.seal(plain("olá"), "dono:A");
    const [version, kid, iv, ciphertext, tag] = parts(envelope);
    expect(version).toBe("t1");
    expect(kid).toBe("k1");
    expect(Buffer.from(iv, "base64url")).toHaveLength(AEAD_POLICY.ivBytes);
    expect(Buffer.from(tag, "base64url")).toHaveLength(AEAD_POLICY.tagBytes);
    for (const part of [iv, ciphertext, tag]) expect(decodeCanonical(part)?.toString("base64url")).toBe(part);
    expect(aead.open(envelope, "dono:A")?.toString("utf8")).toBe("olá");
  });

  test("IV novo a cada selagem: o mesmo texto dá envelopes diferentes", () => {
    const aead = createAeadEnvelope(FORMAT, ring({ k1: newKey() }, "k1"), invalid);
    const envelopes = new Set(Array.from({ length: 64 }, () => aead.seal(plain("igual"), "a")));
    expect(envelopes.size).toBe(64);
    expect(new Set([...envelopes].map((e) => parts(e)[2])).size).toBe(64);
  });

  test("contexto do AAD que não confere não abre (M-12: o AAD entra na conta)", () => {
    const aead = createAeadEnvelope(FORMAT, ring({ k1: newKey() }, "k1"), invalid);
    const envelope = aead.seal(plain("segredo"), "trampo:t:chrome-extension://a");
    expect(aead.open(envelope, "trampo:t:chrome-extension://b")).toBeNull();
    expect(aead.open(envelope, "")).toBeNull();
  });

  test("tag, cifrado ou IV adulterados não abrem (M-12: a tag é conferida)", () => {
    const aead = createAeadEnvelope(FORMAT, ring({ k1: newKey() }, "k1"), invalid);
    const envelope = aead.seal(plain("segredo longo o bastante"), "a");
    const [version, kid, iv, ciphertext, tag] = parts(envelope);
    const flip = (text: string): string => {
      const bytes = Buffer.from(text, "base64url");
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      return bytes.toString("base64url");
    };
    expect(aead.open([version, kid, iv, ciphertext, flip(tag)].join("."), "a")).toBeNull();
    expect(aead.open([version, kid, iv, flip(ciphertext), tag].join("."), "a")).toBeNull();
    expect(aead.open([version, kid, flip(iv), ciphertext, tag].join("."), "a")).toBeNull();
  });

  test("base64url não canônica na tag ou no cifrado não abre, mesmo decodificando nos mesmos bytes (SR-21)", () => {
    const aead = createAeadEnvelope(FORMAT, ring({ k1: newKey() }, "k1"), invalid);
    // 4 bytes de texto claro dão 6 caracteres de cifrado, com 4 bits de sobra no último.
    const envelope = aead.seal(plain("abcd"), "a");
    const [version, kid, iv, ciphertext, tag] = parts(envelope);
    expect(aead.open([version, kid, iv, ciphertext, nonCanonical(tag)].join("."), "a")).toBeNull();
    expect(aead.open([version, kid, iv, nonCanonical(ciphertext), tag].join("."), "a")).toBeNull();
    // Comprimento ≡ 1 (mod 4): o decodificador do Node descarta o caractere solto.
    expect(aead.open([version, kid, iv, `${ciphertext}A`, tag].join("."), "a")).toBeNull();
    expect(aead.open(envelope, "a")?.toString("utf8")).toBe("abcd");
  });

  test("kid desconhecido, outra versão, partes a mais ou a menos e lixo não abrem", () => {
    const aead = createAeadEnvelope(FORMAT, ring({ k1: newKey() }, "k1"), invalid);
    const envelope = aead.seal(plain("abc"), "a");
    const [, , iv, ciphertext, tag] = parts(envelope);
    for (const bad of [
      ["t1", "k2", iv, ciphertext, tag].join("."),
      ["s1", "k1", iv, ciphertext, tag].join("."),
      ["T1", "k1", iv, ciphertext, tag].join("."),
      ["t1", "k1", iv, ciphertext].join("."),
      `${envelope}.x`,
      ` ${envelope}`,
      `${envelope}\n`,
      "",
      "t1.k1....",
      randomBytes(48).toString("base64url"),
    ]) {
      expect(aead.open(bad, "a"), bad).toBeNull();
    }
  });

  test("o cifrado fica na faixa do formato: fora dela, a forma recusa antes de decifrar", () => {
    const aead = createAeadEnvelope(FORMAT, ring({ k1: newKey() }, "k1"), invalid);
    const [version, kid, iv, , tag] = parts(aead.seal(plain("a"), "a"));
    expect(aead.open([version, kid, iv, "A", tag].join("."), "a")).toBeNull();
    expect(aead.open([version, kid, iv, "A".repeat(41), tag].join("."), "a")).toBeNull();
  });

  test("rotação: sela com a ativa e abre com qualquer kid do anel; retirar a chave derruba o envelope", () => {
    const old = newKey();
    const before = createAeadEnvelope(FORMAT, ring({ old }, "old"), invalid);
    const sealedOld = before.seal(plain("antigo"), "a");
    const rotated = createAeadEnvelope(FORMAT, ring({ old, novo: newKey() }, "novo"), invalid);
    expect(parts(rotated.seal(plain("x"), "a"))[1]).toBe("novo");
    expect(rotated.open(sealedOld, "a")?.toString("utf8")).toBe("antigo");
    const retired = createAeadEnvelope(FORMAT, ring({ novo: newKey() }, "novo"), invalid);
    expect(retired.open(sealedOld, "a")).toBeNull();
  });

  test("finalidades separadas: o mesmo anel com outro prefixo não abre o envelope", () => {
    const keyring = ring({ k1: newKey() }, "k1");
    const t1 = createAeadEnvelope(FORMAT, keyring, invalid);
    const u1 = createAeadEnvelope({ ...FORMAT, version: "u1", aadPrefix: "trampo:teste:u1:" }, keyring, invalid);
    const envelope = t1.seal(plain("abc"), "a");
    expect(u1.open(envelope, "a")).toBeNull();
    expect(u1.open(envelope.replace(/^t1\./, "u1."), "a")).toBeNull();
  });

  test("anel sem a chave ativa ou versão fora de [a-z][0-9] derrubam a criação", () => {
    const keyring = ring({ k1: newKey() }, "k1");
    expect(() => createAeadEnvelope(FORMAT, { activeKid: "k2", keys: keyring.keys }, invalid)).toThrow(TestRingError);
    for (const version of ["", "t", "t12", "T1", "1t", ".1", "t.", "r1|", "(?:)"]) {
      expect(() => createAeadEnvelope({ ...FORMAT, version, aadPrefix: `x:${version}:` }, keyring, invalid), version).toThrow(
        TestRingError,
      );
    }
  });

  test("prefixo do AAD que não termina em :<versão>: derruba a criação (o prefixo do envelope fica amarrado)", () => {
    const keyring = ring({ k1: newKey() }, "k1");
    for (const aadPrefix of ["", "trampo:teste:", "trampo:teste:t1", "trampo:teste:u1:", "t1:", "trampo:teste:t1:x"]) {
      expect(() => createAeadEnvelope({ ...FORMAT, aadPrefix }, keyring, invalid), aadPrefix).toThrow(TestRingError);
    }
    expect(createAeadEnvelope({ ...FORMAT, aadPrefix: ":t1:" }, keyring, invalid).open("x", "")).toBeNull();
  });

  test("o AAD é exatamente aadPrefix + contexto (vetor montado à parte com node:crypto)", () => {
    const key = newKey();
    const aead = createAeadEnvelope(FORMAT, ring({ k1: key }, "k1"), invalid);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from("trampo:teste:t1:dono", "utf8"));
    const ciphertext = Buffer.concat([cipher.update("vetor", "utf8"), cipher.final()]);
    const envelope = ["t1", "k1", iv, ciphertext, cipher.getAuthTag()].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
    expect(aead.open(envelope, "dono")?.toString("utf8")).toBe("vetor");
    expect(aead.open(envelope, "outro")).toBeNull();
  });

  test("faixa do cifrado inválida derruba a criação", () => {
    const keyring = ring({ k1: newKey() }, "k1");
    for (const ciphertextChars of [
      { min: 0, max: 10 },
      { min: 5, max: 4 },
      { min: 1.5, max: 10 },
      { min: 1, max: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => createAeadEnvelope({ ...FORMAT, ciphertextChars }, keyring, invalid)).toThrow(TestRingError);
    }
  });
});
