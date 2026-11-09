// F1-EXT-05a, 05a-4 (ADR-004 D13, D15 e §4.6): as variáveis de build em falha fechada. Origem fora da forma https
// exata e chave fora do SPKI RSA derrubam o build, sem ecoar o valor. A chave de teste é gerada na hora: nenhum
// material de chave entra no git.
import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "vitest";

import { extensionIdFromSpki, readBuildEnv } from "../build-env";

const rsaSpki = (modulusLength = 2048): Buffer =>
  generateKeyPairSync("rsa", { modulusLength }).publicKey.export({ type: "spki", format: "der" });
const SPKI = rsaSpki();
const KEY = SPKI.toString("base64");

function thrown(env: Record<string, string>): string {
  try {
    readBuildEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  return "não lançou";
}

describe("readBuildEnv: ausentes", () => {
  test("sem nenhuma variável, tudo ausente (build fechado: connect-src 'none', sem key, login sem configuração)", () => {
    expect(readBuildEnv({})).toStrictEqual({ apiOrigin: undefined, supabaseOrigin: undefined, extensionKey: undefined });
  });

  test("vazio conta como ausente", () => {
    expect(readBuildEnv({ TRAMPO_API_ORIGIN: "", TRAMPO_SUPABASE_ORIGIN: "", TRAMPO_EXTENSION_KEY: "" })).toStrictEqual({
      apiOrigin: undefined,
      supabaseOrigin: undefined,
      extensionKey: undefined,
    });
  });
});

describe.each([
  ["TRAMPO_API_ORIGIN", "apiOrigin", "https://api.exemplo.com"],
  ["TRAMPO_SUPABASE_ORIGIN", "supabaseOrigin", "https://<projeto>.supabase.co"],
] as const)("%s", (name, field, example) => {
  test.each(["https://x.test", "https://projeto.supabase.co", "https://localhost:47443"])("aceita %s", (value) => {
    expect(readBuildEnv({ [name]: value })[field]).toBe(value);
  });

  test.each([
    "http://x.test",
    "https://x.test/",
    "https://x.test/v1",
    "https://X.test",
    "https://x.test:443",
    "https://x.test:99999",
    "https://x.test?q",
    "https://user@x.test",
    "https://*.x.test",
    "https://x_y.test",
    " https://x.test",
    "https://x.test\n",
    "x.test",
  ])("recusa %j sem ecoar o valor", (value) => {
    expect(thrown({ [name]: value })).toBe(`${name} deve ser uma origem https exata, sem caminho (ex.: ${example})`);
  });
});

describe("TRAMPO_EXTENSION_KEY (D13: SPKI em base64)", () => {
  const INVALID = "TRAMPO_EXTENSION_KEY deve ser a chave pública RSA da extensão (2048 bits ou mais) em SPKI DER, base64 numa linha";

  test("aceita a chave pública RSA de 2048 bits e deriva o ID do Chromium", () => {
    const hex = createHash("sha256").update(SPKI).digest("hex").slice(0, 32);
    const id = [...hex].map((d) => "abcdefghijklmnop"[Number.parseInt(d, 16)]).join("");
    expect(readBuildEnv({ TRAMPO_EXTENSION_KEY: KEY }).extensionKey).toStrictEqual({ key: KEY, id });
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  test("aceita RSA maior que 2048", () => {
    expect(readBuildEnv({ TRAMPO_EXTENSION_KEY: rsaSpki(3072).toString("base64") }).extensionKey).toBeDefined();
  });

  test("ID do Chromium por vetor fixo: os 16 primeiros bytes do SHA-256, dígito a dígito", () => {
    // SHA-256("") = e3b0c442 98fc1c14 9afbf4c8 996fb924 …: e→o, 3→d, b→l, 0→a, c→m, 4→e, 4→e, 2→c, 9→j, 8→i, …
    expect(extensionIdFromSpki(new Uint8Array())).toBe("odlameecjipmbmbejkplpemijjgpljce");
  });

  test.each([
    ["base64 com quebra de linha", `${KEY.slice(0, 64)}\n${KEY.slice(64)}`],
    ["base64url", KEY.replaceAll("+", "-").replaceAll("/", "_")],
    ["espaço no fim", `${KEY} `],
    ["PEM inteiro", `-----BEGIN PUBLIC KEY-----${KEY}-----END PUBLIC KEY-----`],
    ["base64 que não é DER", Buffer.from("não é uma chave").toString("base64")],
    ["DER com bytes sobrando", Buffer.concat([SPKI, Buffer.from([0])]).toString("base64")],
    ["DER truncado", SPKI.subarray(0, SPKI.length - 1).toString("base64")],
    ["chave EC", generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" }).toString("base64")],
    ["Ed25519", generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64")],
    ["RSA de 1024 bits", rsaSpki(1024).toString("base64")],
    ["RSA-PSS (não é rsaEncryption)", generateKeyPairSync("rsa-pss", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64")],
    [
      "chave privada (PKCS#8)",
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    ],
  ])("recusa %s sem ecoar o valor", (_caso, value) => {
    const message = thrown({ TRAMPO_EXTENSION_KEY: value });
    expect(message).toBe(INVALID);
  });

  test("recusa preenchimento sobrando, que decodifica no mesmo DER", () => {
    expect(Buffer.from(`${KEY}==`, "base64").equals(SPKI)).toBe(true);
    expect(thrown({ TRAMPO_EXTENSION_KEY: `${KEY}==` })).toBe(INVALID);
  });

  test("recusa base64 não canônico (bits de preenchimento trocados), que decodifica no mesmo DER", () => {
    // SPKI RSA de 3072 tem 422 bytes: o base64 termina em um "=", e o caractere antes dele carrega 2 bits que o
    // decodificador ignora. Trocar o último deles não muda os bytes.
    const spki = rsaSpki(3072);
    const key = spki.toString("base64");
    expect(key).toMatch(/[^=]=$/);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const sibling = alphabet[alphabet.indexOf(key.at(-2) ?? "") ^ 1] ?? "";
    const tampered = `${key.slice(0, -2)}${sibling}=`;
    expect(Buffer.from(tampered, "base64").equals(spki)).toBe(true);
    expect(readBuildEnv({ TRAMPO_EXTENSION_KEY: key }).extensionKey?.key).toBe(key);
    expect(thrown({ TRAMPO_EXTENSION_KEY: tampered })).toBe(INVALID);
  });
});

// F1-EXT-05c, 05c-1 (ADR-004 §4.4 e §4.6): o modo 3 do P20 não existe. A variável do adapter falso derruba o build sem
// TRAMPO_E2E=1 e também com ele; sozinho, o TRAMPO_E2E não muda nada no build.
describe("TRAMPO_E2E_FAKE_IDENTITY (P20 no modo 1 no Edge e no Chrome)", () => {
  const SEM_E2E = "TRAMPO_E2E_FAKE_IDENTITY só existe no build de teste, com TRAMPO_E2E=1 (ADR-004 §4.6)";
  const SEM_MODO_3 = "TRAMPO_E2E_FAKE_IDENTITY: o modo 3 do P20 não existe; o Edge e o Chrome rodam o login real em headless (modo 1, ADR-004 §4.4)";

  test.each([
    [{ TRAMPO_E2E_FAKE_IDENTITY: "1" }, SEM_E2E],
    [{ TRAMPO_E2E_FAKE_IDENTITY: "1", TRAMPO_E2E: "" }, SEM_E2E],
    [{ TRAMPO_E2E_FAKE_IDENTITY: "1", TRAMPO_E2E: "0" }, SEM_E2E],
    [{ TRAMPO_E2E_FAKE_IDENTITY: "1", TRAMPO_E2E: "1 " }, SEM_E2E],
    [{ TRAMPO_E2E_FAKE_IDENTITY: "0", TRAMPO_E2E: "true" }, SEM_E2E],
    [{ TRAMPO_E2E_FAKE_IDENTITY: "1", TRAMPO_E2E: "1" }, SEM_MODO_3],
    [{ TRAMPO_E2E_FAKE_IDENTITY: "nao", TRAMPO_E2E: "1" }, SEM_MODO_3],
  ])("recusa %j", (env, message) => {
    expect(thrown(env)).toBe(message);
  });

  test("a recusa vem antes das outras variáveis: nem uma chave válida salva o build", () => {
    expect(thrown({ TRAMPO_E2E_FAKE_IDENTITY: "1", TRAMPO_API_ORIGIN: "https://x.test", TRAMPO_EXTENSION_KEY: KEY })).toBe(SEM_E2E);
  });

  test.each([{ TRAMPO_E2E_FAKE_IDENTITY: "" }, { TRAMPO_E2E: "1" }, { TRAMPO_E2E: "1", TRAMPO_E2E_FAKE_IDENTITY: "" }])("aceita %j: nada muda no build", (env) => {
    expect(readBuildEnv(env)).toStrictEqual({ apiOrigin: undefined, supabaseOrigin: undefined, extensionKey: undefined });
  });
});
