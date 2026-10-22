// Cifra da pretensão salarial (ADR-018 D4): ida e volta, IV único, AAD por dono, adulteração, kid desconhecido,
// rotação, envelope malformado ou não canônico, texto claro fora do schema e anel inválido no boot. As chaves são
// geradas aqui, aleatórias, e nunca saem do teste. Nenhuma mensagem de erro leva material de chave.
import { createCipheriv, randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  SALARY_CIPHER_POLICY,
  SALARY_ENVELOPE_VERSION,
  SalaryKeyringConfigError,
  SalarySealError,
  createSalaryCipher,
  parseSalaryKeyring,
  type SalaryKeyring,
  type SalaryValue,
} from "../../src/infrastructure/index.js";

const A = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const B = "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3";
/** O padrão do `check` da coluna `salary_ciphertext` (ADR-018 D2), que a parte 3 copia na migration. */
const COLUMN_PATTERN = /^s1\.[a-z0-9]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,342}\.[A-Za-z0-9_-]{22}$/;

const SALARY: NonNullable<SalaryValue> = { minimum: 12_345, currency: "BRL", period: "mes", importance: { level: "obrigatorio" } };

function newKey(): string {
  return randomBytes(32).toString("base64url");
}

function ring(entries: Record<string, string>, active: string): SalaryKeyring {
  return parseSalaryKeyring(
    Object.entries(entries)
      .map(([kid, key]) => `${kid}:${key}`)
      .join(","),
    active,
  );
}

/** Cifra um texto claro arbitrário com a mesma chave e o mesmo AAD: só o conteúdo decifrado é inválido. */
function sealRaw(key: string, userId: string, plaintext: string, kid = "k1"): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`trampo:user_criteria.salary:s1:${userId}`, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["s1", kid, iv.toString("base64url"), ct.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

/** Troca a parte `index` do envelope (1 = kid, 2 = IV, 3 = cifrado, 4 = tag). */
function withPart(envelope: string, index: number, value: string): string {
  const parts = envelope.split(".");
  parts[index] = value;
  return parts.join(".");
}

/** Troca o primeiro caractere por outro do alfabeto, mantendo o comprimento (e a forma canônica). */
function flipFirst(text: string): string {
  return `${text[0] === "A" ? "B" : "A"}${text.slice(1)}`;
}

describe("seal e open: ida e volta", () => {
  const key = newKey();
  const cipher = createSalaryCipher(ring({ k1: key }, "k1"));

  test.each<[string, SalaryValue]>([
    ["pretensão informada", SALARY],
    ["pretensão nula (cifra-se também, para a coluna não revelar quem informou)", null],
    ["ponderada", { minimum: 9_999_999.99, currency: "EUR", period: "ano", importance: { level: "ponderado", weight: 5 } }],
  ])("%s", (_name, salary) => {
    const envelope = cipher.seal(A, salary);
    expect(envelope).toMatch(COLUMN_PATTERN);
    expect(envelope.startsWith(`${SALARY_ENVELOPE_VERSION}.k1.`)).toBe(true);
    expect(cipher.open(A, envelope)).toEqual({ ok: true, salary });
  });

  test("o envelope não contém o texto claro, e o IV é único por cifragem", () => {
    const envelopes = Array.from({ length: 50 }, () => cipher.seal(A, SALARY));
    expect(new Set(envelopes).size).toBe(50);
    expect(new Set(envelopes.map((e) => e.split(".")[2])).size).toBe(50);
    for (const envelope of envelopes) {
      expect(envelope).not.toContain("12345");
      expect(Buffer.from(envelope.split(".")[3] ?? "", "base64url").toString("latin1")).not.toContain("12345");
    }
  });

  test("pior caso do schema cabe nos tetos (texto claro ≤ 256 bytes, cifrado ≤ 342 caracteres, envelope ≤ 1.024)", () => {
    const worst: SalaryValue = {
      minimum: 2.2250738585072014e-308,
      currency: "BRL",
      period: "hora",
      importance: { level: "ponderado", weight: 5 },
    };
    expect(Buffer.byteLength(JSON.stringify(worst), "utf8")).toBeLessThanOrEqual(SALARY_CIPHER_POLICY.plaintextMaxBytes);
    const envelope = cipher.seal(A, worst);
    expect(envelope).toMatch(COLUMN_PATTERN);
    expect(envelope.length).toBeLessThanOrEqual(SALARY_CIPHER_POLICY.envelopeMaxChars);
    expect(cipher.open(A, envelope)).toEqual({ ok: true, salary: worst });
  });
});

describe("open: falha fechado (ok: false, nunca lança)", () => {
  const key = newKey();
  const cipher = createSalaryCipher(ring({ k1: key }, "k1"));
  const envelope = cipher.seal(A, SALARY);
  const [, , iv = "", ct = "", tag = ""] = envelope.split(".");

  test("cifrado de A aberto como B (AAD por dono): a linha copiada não abre", () => {
    expect(cipher.open(B, envelope)).toEqual({ ok: false });
  });

  test.each<[string, string]>([
    ["tag adulterada", withPart(envelope, 4, flipFirst(tag))],
    ["IV adulterado", withPart(envelope, 2, flipFirst(iv))],
    ["cifrado adulterado", withPart(envelope, 3, flipFirst(ct))],
    ["kid desconhecido", withPart(envelope, 1, "k9")],
    ["versão desconhecida", `s2${envelope.slice(2)}`],
    ["parte a menos", envelope.split(".").slice(0, 4).join(".")],
    ["parte a mais", `${envelope}.AAAA`],
    ["kid em maiúsculas", withPart(envelope, 1, "K1")],
    ["IV curto", withPart(envelope, 2, iv.slice(1))],
    ["tag curta", withPart(envelope, 4, tag.slice(1))],
    ["tag não canônica (bits sobrando no último caractere)", withPart(envelope, 4, `${tag.slice(0, 21)}${tag.endsWith("B") ? "C" : "B"}`)],
    ["cifrado com comprimento impossível em base64url (resto 1 por 4)", withPart(envelope, 3, `${ct}${"A".repeat((5 - (ct.length % 4)) % 4 || 4)}`)],
    ["cifrado com padding", withPart(envelope, 3, `${ct}=`)],
    ["cifrado vazio", withPart(envelope, 3, "")],
    ["espaço no fim", `${envelope} `],
    ["vazio", ""],
  ])("%s", (_name, tampered) => {
    expect(tampered).not.toBe(envelope);
    expect(cipher.open(A, tampered)).toEqual({ ok: false });
  });

  test.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["número", 42],
    ["objeto", { envelope }],
    ["acima do teto da coluna", `${envelope}${"A".repeat(SALARY_CIPHER_POLICY.envelopeMaxChars)}`],
  ])("envelope que não é string válida (%s)", (_name, value) => {
    expect(cipher.open(A, value)).toEqual({ ok: false });
  });

  test("dono que não é UUID", () => {
    expect(cipher.open("u1", envelope)).toEqual({ ok: false });
  });

  test.each<[string, string]>([
    ["JSON inválido", "não é json"],
    ["poluição de protótipo", '{"__proto__":{"minimum":1}}'],
    ["pretensão negativa", JSON.stringify({ ...SALARY, minimum: -1 })],
    ["campo a mais", JSON.stringify({ ...SALARY, userId: A })],
    ["moeda fora do enum", JSON.stringify({ ...SALARY, currency: "BTC" })],
  ])("tag válida, mas texto claro fora do schema (%s)", (_name, plaintext) => {
    expect(cipher.open(A, sealRaw(key, A, plaintext))).toEqual({ ok: false });
  });
});

describe("rotação de chave", () => {
  const k1 = newKey();
  const k2 = newKey();

  test("a escrita usa a ativa e a leitura aceita qualquer kid do anel", () => {
    const old = createSalaryCipher(ring({ k1 }, "k1")).seal(A, SALARY);
    const rotated = createSalaryCipher(ring({ k1, k2 }, "k2"));
    expect(rotated.open(A, old)).toEqual({ ok: true, salary: SALARY });
    const fresh = rotated.seal(A, SALARY);
    expect(fresh.split(".")[1]).toBe("k2");
    expect(rotated.open(A, fresh)).toEqual({ ok: true, salary: SALARY });
  });

  test("chave retirada do anel: o cifrado antigo não abre (503 no repositório, nunca 409)", () => {
    const old = createSalaryCipher(ring({ k1 }, "k1")).seal(A, SALARY);
    expect(createSalaryCipher(ring({ k2 }, "k2")).open(A, old)).toEqual({ ok: false });
  });

  test("mesmo kid com outra chave: a tag não confere", () => {
    const old = createSalaryCipher(ring({ k1 }, "k1")).seal(A, SALARY);
    expect(createSalaryCipher(ring({ k1: k2 }, "k1")).open(A, old)).toEqual({ ok: false });
  });
});

describe("seal: erro de programação com mensagem fixa", () => {
  const cipher = createSalaryCipher(ring({ k1: newKey() }, "k1"));

  test.each<[string, string, unknown]>([
    ["dono que não é UUID", "u1", SALARY],
    ["pretensão negativa", A, { ...SALARY, minimum: -1 }],
    ["pretensão com campo a mais", A, { ...SALARY, extra: 1 }],
    ["pretensão undefined", A, undefined],
  ])("%s", (_name, userId, salary) => {
    expect(() => cipher.seal(userId, salary as SalaryValue)).toThrow(SalarySealError);
    expect(() => cipher.seal(userId, salary as SalaryValue)).toThrow("pretensão ou dono fora do contrato na cifragem");
  });
});

describe("parseSalaryKeyring: anel do .env, falha cedo e fechado", () => {
  test("uma chave", () => {
    const key = newKey();
    const keyring = parseSalaryKeyring(`k1:${key}`, "k1");
    expect(keyring.activeKid).toBe("k1");
    expect([...keyring.keys.keys()]).toEqual(["k1"]);
    expect(keyring.keys.get("k1")?.equals(Buffer.from(key, "base64url"))).toBe(true);
  });

  test("quatro chaves, kid de 16 caracteres", () => {
    const kid16 = "a".repeat(16);
    const keyring = parseSalaryKeyring(`k1:${newKey()},k2:${newKey()},${kid16}:${newKey()},z9:${newKey()}`, kid16);
    expect(keyring.keys.size).toBe(4);
    expect(keyring.activeKid).toBe(kid16);
  });

  const valid = newKey();
  const noncanonical = `${valid.slice(0, 42)}${valid.endsWith("B") ? "C" : "B"}`;
  test.each<[string, string, string]>([
    ["chaves ausentes (chega como vazio)", "", "k1"],
    ["kid ativo ausente (chega como vazio)", `k1:${valid}`, ""],
    ["vazio", "", "k1"],
    ["sem dois-pontos", valid, "k1"],
    ["kid vazio", `:${valid}`, ""],
    ["kid em maiúsculas", `K1:${valid}`, "K1"],
    ["kid com 17 caracteres", `${"a".repeat(17)}:${valid}`, "a".repeat(17)],
    ["kid repetido", `k1:${valid},k1:${newKey()}`, "k1"],
    ["chave de 31 bytes", `k1:${randomBytes(31).toString("base64url")}`, "k1"],
    ["chave de 33 bytes", `k1:${randomBytes(33).toString("base64url")}`, "k1"],
    ["chave com padding", `k1:${valid}=`, "k1"],
    ["chave em base64 padrão (com + ou /)", `k1:${Buffer.alloc(32, 0xfb).toString("base64")}`, "k1"],
    ["chave não canônica", `k1:${noncanonical}`, "k1"],
    ["espaço depois da vírgula", `k1:${valid}, k2:${newKey()}`, "k1"],
    ["cinco chaves", Array.from({ length: 5 }, (_, i) => `k${i}:${newKey()}`).join(","), "k0"],
    ["kid ativo fora do anel", `k1:${valid}`, "k2"],
  ])("%s", (_name, keys, active) => {
    expect(() => parseSalaryKeyring(keys, active)).toThrow(SalaryKeyringConfigError);
  });

  test("a mensagem não ecoa a chave", () => {
    let message = "";
    try {
      parseSalaryKeyring(`K1:${valid}`, "K1");
    } catch (error) {
      message = String(error) + JSON.stringify(error);
    }
    expect(message).toContain("SalaryKeyringConfigError");
    expect(message).not.toContain(valid);
    expect(message).not.toContain(valid.slice(0, 8));
  });

  test("createSalaryCipher recusa anel montado à mão sem a chave ativa", () => {
    const keyring: SalaryKeyring = { activeKid: "k2", keys: new Map([["k1", randomBytes(32)]]) };
    expect(() => createSalaryCipher(keyring)).toThrow(SalaryKeyringConfigError);
  });
});

describe("política fixada contra o ADR-018 D4", () => {
  test("valores", () => {
    expect(SALARY_ENVELOPE_VERSION).toBe("s1");
    expect(SALARY_CIPHER_POLICY).toEqual({ keyBytes: 32, ivBytes: 12, tagBytes: 16, maxKeys: 4, plaintextMaxBytes: 256, envelopeMaxChars: 1_024 });
  });
});
