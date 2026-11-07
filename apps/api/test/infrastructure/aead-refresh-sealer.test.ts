// F1-API-07, commit 07b (ADR-004 D5, D7 e §4.2; SR-21): o RefreshSealer com AEAD. O envelope `r1` cabe no
// `SealedRefreshSchema` no pior caso; o texto claro tem teto de 768 bytes **em bytes** (emenda da revisão da
// F1-AUTH-00), e o excesso não é selado; o AAD liga o envelope ao `Origin`; adulteração, blob aleatório, base64url não
// canônica, kid desconhecido e texto claro fora do schema não abrem. `seal` e `open` nunca lançam.
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

import { SealedRefreshSchema } from "@trampo/contracts/auth";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import type { SealedSession } from "../../src/application/ports/refresh-sealer.js";
import { AEAD_POLICY, parseAeadKeyring } from "../../src/infrastructure/crypto/aead-envelope.js";
import {
  REFRESH_ENVELOPE_VERSION,
  REFRESH_SEALER_POLICY,
  RefreshKeyringConfigError,
  createAeadRefreshSealer,
  parseRefreshKeyring,
} from "../../src/infrastructure/crypto/aead-refresh-sealer.js";
import { createSalaryCipher } from "../../src/infrastructure/crypto/salary-cipher.js";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OTHER_EXTENSION = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
const SID = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const NOW = 1_790_000_000;

function newKey(): string {
  return randomBytes(AEAD_POLICY.keyBytes).toString("base64url");
}

const session = (overrides: Partial<SealedSession> = {}): SealedSession => ({
  rt: "v1.refresh-token-de-teste",
  sid: SID,
  sst: NOW - 60,
  iat: NOW,
  ...overrides,
});

function sealer(key = newKey(), kid = "k1") {
  return createAeadRefreshSealer(parseRefreshKeyring(`${kid}:${key}`, kid));
}

/** Sela um texto claro arbitrário com a mesma chave e o mesmo AAD: só o conteúdo decifrado é inválido. */
function sealRaw(key: string, origin: string, plaintext: string, kid = "k1"): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`trampo:auth.refresh:r1:${origin}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["r1", kid, iv, ciphertext, cipher.getAuthTag()].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

describe("política fixada contra o ADR-004 D5 e D7", () => {
  test("versão r1, texto claro até 768 bytes, rt até 512 e envelope até 1.100", () => {
    expect(REFRESH_ENVELOPE_VERSION).toBe("r1");
    expect(REFRESH_SEALER_POLICY).toEqual({
      plaintextMaxBytes: 768,
      refreshTokenMaxChars: 512,
      ciphertextMinChars: 20,
      ciphertextMaxChars: 1_024,
      envelopeMaxChars: 1_100,
    });
  });
});

describe("parseRefreshKeyring: anel próprio, falha fechada sem ecoar valor", () => {
  test("erro com os nomes das variáveis e sem o valor", () => {
    const key = newKey();
    let thrown: unknown;
    try {
      parseRefreshKeyring(`K1:${key}`, "K1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RefreshKeyringConfigError);
    const message = (thrown as Error).message;
    expect(message).toContain("AUTH_REFRESH_SEAL_KEYS");
    expect(message).toContain("AUTH_REFRESH_SEAL_ACTIVE_KEY");
    expect(message).toContain("[a-z0-9]{1,16}");
    expect(message).not.toContain(key);
    expect((thrown as Error).name).toBe("RefreshKeyringConfigError");
  });

  test.each([
    ["vazio", "", ""],
    ["ativo ausente", `k1:${newKey()}`, "k9"],
    ["kid fora do contrato", `${"a".repeat(17)}:${newKey()}`, "a".repeat(17)],
  ])("%s → RefreshKeyringConfigError", (_label, keys, active) => {
    expect(() => parseRefreshKeyring(keys, active)).toThrow(RefreshKeyringConfigError);
  });

  test("criar o selador com um anel sem a ativa também falha fechado", () => {
    const keyring = parseRefreshKeyring(`k1:${newKey()}`, "k1");
    expect(() => createAeadRefreshSealer({ activeKid: "k2", keys: keyring.keys })).toThrow(RefreshKeyringConfigError);
  });
});

describe("seal e open", () => {
  test("ida e volta com o mesmo Origin; o envelope cabe no SealedRefreshSchema", () => {
    const s = sealer();
    const sealed = s.seal(session(), EXTENSION);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.envelope.startsWith("r1.k1.")).toBe(true);
    expect(SealedRefreshSchema.safeParse(sealed.envelope).success).toBe(true);
    expect(s.open(sealed.envelope, EXTENSION)).toEqual({ ok: true, session: session() });
  });

  test("outro Origin não abre (AAD trampo:auth.refresh:r1:<Origin>; M-12)", () => {
    const s = sealer();
    const sealed = s.seal(session(), EXTENSION);
    if (!sealed.ok) throw new Error("selagem falhou");
    expect(s.open(sealed.envelope, OTHER_EXTENSION)).toEqual({ ok: false });
    expect(s.open(sealed.envelope, "")).toEqual({ ok: false });
    expect(s.open(sealed.envelope, `${EXTENSION}/`)).toEqual({ ok: false });
  });

  test("o AAD é exatamente trampo:auth.refresh:r1:<Origin> (vetor montado à parte com node:crypto)", () => {
    const key = newKey();
    const envelope = sealRaw(key, EXTENSION, JSON.stringify(session()));
    expect(sealer(key).open(envelope, EXTENSION)).toEqual({ ok: true, session: session() });
  });

  test("pior caso do texto claro: rt de 512 caracteres ASCII sem escape e epochs máximos cabem nos 768 bytes e no contrato", () => {
    const worst = session({ rt: "a".repeat(512), sst: Number.MAX_SAFE_INTEGER, iat: Number.MAX_SAFE_INTEGER });
    const bytes = Buffer.byteLength(JSON.stringify(worst), "utf8");
    expect(bytes).toBeLessThanOrEqual(REFRESH_SEALER_POLICY.plaintextMaxBytes);
    const sealed = sealer().seal(worst, EXTENSION);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.envelope.length).toBeLessThanOrEqual(REFRESH_SEALER_POLICY.envelopeMaxChars);
    expect(SealedRefreshSchema.safeParse(sealed.envelope).success).toBe(true);
  });

  test("texto claro acima de 768 bytes não é selado (rt fora do ASCII ou com escape do JSON)", () => {
    const s = sealer();
    // 512 caracteres de 2 bytes em UTF-8: 1.024 bytes só no rt.
    expect(s.seal(session({ rt: "é".repeat(512) }), EXTENSION)).toEqual({ ok: false });
    // Aspas viram \" no JSON: 512 caracteres, 1.024 bytes.
    expect(s.seal(session({ rt: '"'.repeat(512) }), EXTENSION)).toEqual({ ok: false });
    // Controle vira \u0001: 6 bytes por caractere.
    expect(s.seal(session({ rt: "\u0001".repeat(200) }), EXTENSION)).toEqual({ ok: false });
  });

  test("o limite de 768 bytes é exato: o maior texto claro que cabe sela, um byte a mais não", () => {
    const s = sealer();
    const base = Buffer.byteLength(JSON.stringify(session({ rt: "" })), "utf8");
    // rt de 2 bytes por caractere, até o limite: base + 2n ≤ 768 (e n ≤ 512).
    const room = REFRESH_SEALER_POLICY.plaintextMaxBytes - base;
    const fits = "é".repeat(Math.floor(room / 2));
    const fitsBytes = base + Buffer.byteLength(fits, "utf8");
    const exact = fitsBytes === REFRESH_SEALER_POLICY.plaintextMaxBytes ? fits : `${fits}a`;
    expect(base + Buffer.byteLength(exact, "utf8")).toBe(REFRESH_SEALER_POLICY.plaintextMaxBytes);
    const sealed = s.seal(session({ rt: exact }), EXTENSION);
    expect(sealed.ok).toBe(true);
    if (sealed.ok) expect(SealedRefreshSchema.safeParse(sealed.envelope).success).toBe(true);
    expect(s.seal(session({ rt: `${exact}a` }), EXTENSION)).toEqual({ ok: false });
  });

  test.each([
    ["rt vazio", { rt: "" }],
    ["rt com 513 caracteres", { rt: "a".repeat(513) }],
    ["sid que não é UUID", { sid: "sessao" }],
    ["sst zero", { sst: 0 }],
    ["iat negativo", { iat: -1 }],
    ["sst fracionário", { sst: 1.5 }],
    ["iat acima do inteiro seguro", { iat: Number.MAX_SAFE_INTEGER + 1 }],
  ])("sessão fora do schema não é selada: %s", (_label, overrides) => {
    expect(sealer().seal(session(overrides as Partial<SealedSession>), EXTENSION)).toEqual({ ok: false });
  });

  test("chave a mais na sessão não é selada (strictObject), e seal nunca lança", () => {
    const s = sealer();
    expect(s.seal({ ...session(), extra: 1 } as SealedSession, EXTENSION)).toEqual({ ok: false });
    expect(s.seal(null as unknown as SealedSession, EXTENSION)).toEqual({ ok: false });
  });

  test("blob aleatório, tag adulterada, kid desconhecido e base64url não canônica não abrem", () => {
    const key = newKey();
    const s = sealer(key);
    const sealed = s.seal(session(), EXTENSION);
    if (!sealed.ok) throw new Error("selagem falhou");
    const [version = "", kid = "", iv = "", ciphertext = "", tag = ""] = sealed.envelope.split(".");
    const tagBytes = Buffer.from(tag, "base64url");
    tagBytes[15] = (tagBytes[15] ?? 0) ^ 0x80;
    const lastTagChar = tag.at(-1) ?? "A";
    const twin = "AQgw".includes(lastTagChar) ? String.fromCharCode(lastTagChar.charCodeAt(0) + 1) : "A";
    for (const bad of [
      randomBytes(300).toString("base64url"),
      `r1.k1.${randomBytes(12).toString("base64url")}.${randomBytes(100).toString("base64url")}.${randomBytes(16).toString("base64url")}`,
      [version, kid, iv, ciphertext, tagBytes.toString("base64url")].join("."),
      [version, "k9", iv, ciphertext, tag].join("."),
      [version, kid, iv, ciphertext, `${tag.slice(0, -1)}${twin}`].join("."),
      [version, kid, iv, `${ciphertext}A`, tag].join("."),
      sealed.envelope.replace(/^r1\./, "s1."),
    ]) {
      expect(s.open(bad, EXTENSION), bad).toEqual({ ok: false });
    }
  });

  test("texto claro autenticado mas fora do schema não abre: JSON inválido, chave extra, __proto__ e tipos errados", () => {
    const key = newKey();
    const s = sealer(key);
    const valid = session();
    // O cifrado tem no mínimo 20 caracteres (15 bytes): textos menores param na forma, antes de decifrar.
    for (const plaintext of [
      "não é json, e passa do mínimo do cifrado",
      JSON.stringify({ ...valid, extra: true }),
      `{"__proto__":{"x":1},"rt":"a","sid":"${SID}","sst":1,"iat":1}`,
      JSON.stringify({ ...valid, sid: "x" }),
      JSON.stringify({ ...valid, sst: "1" }),
      JSON.stringify([valid]),
      `null${" ".repeat(20)}`,
      `"rt"${" ".repeat(20)}`,
    ]) {
      expect(Buffer.byteLength(plaintext, "utf8")).toBeGreaterThanOrEqual(15);
      expect(s.open(sealRaw(key, EXTENSION, plaintext), EXTENSION), plaintext).toEqual({ ok: false });
    }
  });

  test("o envelope da pretensão (s1) com a mesma chave não abre como refresh, e vice-versa (finalidades separadas)", () => {
    const key = newKey();
    const keyring = parseAeadKeyring(`k1:${key}`, "k1", () => new Error("x"));
    const salary = createSalaryCipher(keyring);
    const s = createAeadRefreshSealer(keyring);
    const salaryEnvelope = salary.seal(SID, null);
    expect(s.open(salaryEnvelope, EXTENSION)).toEqual({ ok: false });
    expect(s.open(salaryEnvelope.replace(/^s1\./, "r1."), EXTENSION)).toEqual({ ok: false });
    const sealed = s.seal(session(), EXTENSION);
    if (!sealed.ok) throw new Error("selagem falhou");
    expect(salary.open(SID, sealed.envelope)).toEqual({ ok: false });
  });

  test("propriedade: toda sessão válida volta igual, e o envelope sempre cabe no contrato", () => {
    const s = sealer();
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 512, unit: fc.constantFrom(..."abcXYZ0189-_.~") }),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        (rt, sst, iat) => {
          const value = { rt, sid: randomUUID(), sst, iat };
          const sealed = s.seal(value, EXTENSION);
          expect(sealed.ok).toBe(true);
          if (!sealed.ok) return;
          expect(SealedRefreshSchema.safeParse(sealed.envelope).success).toBe(true);
          expect(s.open(sealed.envelope, EXTENSION)).toEqual({ ok: true, session: value });
        },
      ),
      { numRuns: 300 },
    );
  });
});
