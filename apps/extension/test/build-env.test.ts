// F1-EXT-05a, 05a-4 (ADR-004 D13, D15 e §4.6): as variáveis de build em falha fechada. Origem fora da forma https
// exata e chave fora do SPKI RSA derrubam o build, sem ecoar o valor. A chave de teste é gerada na hora: nenhum
// material de chave entra no git.
// F1-EXT-06 (ADR-004 §4.6): o leitor de lista fechada do `.env` da extensão. Só as 3 chaves do build saem do arquivo, o
// `process.env` explícito vence, o `TRAMPO_IGNORE_DOTENV=1` isola os testes, e nada do arquivo vai a mensagem.
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { DOTENV_KEYS, DOTENV_MAX_BYTES, extensionIdFromSpki, loadBuildEnv, readBuildEnv } from "../build-env";

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

// F1-EXT-06: o `.env` da extensão, lido antes do `readBuildEnv` (o WXT só o carrega depois de avaliar o wxt.config.ts).
describe("loadBuildEnv: leitor de lista fechada do .env da extensão (F1-EXT-06)", () => {
  const work = mkdtempSync(join(tmpdir(), "trampo-build-env-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const API = "https://api.arquivo.test";
  const SUPABASE = "https://projeto.arquivo.test";
  const CLOSED = { apiOrigin: undefined, supabaseOrigin: undefined, extensionKey: undefined };
  const FULL = `TRAMPO_API_ORIGIN=${API}\nTRAMPO_SUPABASE_ORIGIN=${SUPABASE}\nTRAMPO_EXTENSION_KEY=${KEY}\n`;
  let files = 0;
  /** Um `.env` novo na pasta temporária, com o conteúdo dado. */
  const dotenv = (content: string | Uint8Array): string => {
    files += 1;
    const path = join(work, `caso-${files}.env`);
    writeFileSync(path, content);
    return path;
  };
  const failure = (env: Record<string, string | undefined>, path: string): string => {
    try {
      loadBuildEnv(env, path);
    } catch (error) {
      return (error as Error).message;
    }
    return "não lançou";
  };

  test("a lista é fechada nas 3 variáveis do build", () => {
    expect(DOTENV_KEYS).toStrictEqual(["TRAMPO_API_ORIGIN", "TRAMPO_SUPABASE_ORIGIN", "TRAMPO_EXTENSION_KEY"]);
    expect(Object.isFrozen(DOTENV_KEYS)).toBe(true);
  });

  test("lê as 3 chaves do arquivo", () => {
    expect(loadBuildEnv({}, dotenv(FULL))).toStrictEqual({ apiOrigin: API, supabaseOrigin: SUPABASE, extensionKey: readBuildEnv({ TRAMPO_EXTENSION_KEY: KEY }).extensionKey });
  });

  test.each([
    ["aspas duplas", `TRAMPO_API_ORIGIN="${API}"\n`],
    ["aspas simples", `TRAMPO_API_ORIGIN='${API}'\n`],
    ["export", `export TRAMPO_API_ORIGIN=${API}\n`],
    ["CRLF", `TRAMPO_API_ORIGIN=${API}\r\n`],
    ["sem quebra no fim", `TRAMPO_API_ORIGIN=${API}`],
    ["comentário e linha vazia", `# origem da API\n\nTRAMPO_API_ORIGIN=${API} # produção\n`],
    ["BOM no início", `\uFEFFTRAMPO_API_ORIGIN=${API}\n`],
    ["espaços em volta do =", `TRAMPO_API_ORIGIN = ${API}\n`],
  ])("aceita a sintaxe de .env do Node: %s", (_caso, content) => {
    expect(loadBuildEnv({}, dotenv(content)).apiOrigin).toBe(API);
  });

  test("chave fora da lista é descartada: nada dela chega ao resultado nem ao process.env", () => {
    const CANARIO = "CANARIO-SEGREDO-DA-API";
    const extras = [
      `SUPABASE_SECRET_KEY=${CANARIO}`,
      `AUTH_REFRESH_SEAL_KEYS=${CANARIO}`,
      `TRAMPO_E2E=1`,
      `TRAMPO_E2E_FAKE_IDENTITY=${CANARIO}`,
      `TRAMPO_IGNORE_DOTENV=${CANARIO}`,
      `TRAMPO_API_ORIGIN_EXTRA=${CANARIO}`,
      `trampo_api_origin=${CANARIO}`,
      `NODE_ENV=${CANARIO}`,
      `__proto__=${CANARIO}`,
      `constructor=${CANARIO}`,
    ];
    const before = { ...process.env };
    const env: Record<string, string | undefined> = {};
    const built = loadBuildEnv(env, dotenv(`${extras.join("\n")}\n${FULL}`));
    expect(built.apiOrigin).toBe(API);
    expect(JSON.stringify(built)).not.toContain(CANARIO);
    expect(Object.keys(built).sort()).toStrictEqual(["apiOrigin", "extensionKey", "supabaseOrigin"]);
    // O objeto recebido não é tocado, e o process.env do build fica como estava.
    expect(env).toStrictEqual({});
    expect({ ...process.env }).toStrictEqual(before);
    expect(JSON.stringify(process.env)).not.toContain(CANARIO);
    for (const name of ["SUPABASE_SECRET_KEY", "AUTH_REFRESH_SEAL_KEYS"]) expect(process.env[name]).toBeUndefined();
  });

  test("só chave fora da lista: o build sai fechado", () => {
    expect(loadBuildEnv({}, dotenv("SUPABASE_SECRET_KEY=CANARIO\nAPI_ORIGIN=https://x.test\n"))).toStrictEqual(CLOSED);
  });

  test("o adapter falso de identidade não entra pelo arquivo: só o process.env o decide", () => {
    const path = dotenv(`TRAMPO_E2E_FAKE_IDENTITY=1\nTRAMPO_E2E=1\n${FULL}`);
    expect(loadBuildEnv({}, path).apiOrigin).toBe(API);
    expect(failure({ TRAMPO_E2E_FAKE_IDENTITY: "1" }, path)).toBe("TRAMPO_E2E_FAKE_IDENTITY só existe no build de teste, com TRAMPO_E2E=1 (ADR-004 §4.6)");
  });

  test("precedência: a variável explícita do process.env vence a do arquivo, uma a uma", () => {
    const path = dotenv(FULL);
    expect(loadBuildEnv({ TRAMPO_API_ORIGIN: "https://api.explicita.test" }, path)).toMatchObject({ apiOrigin: "https://api.explicita.test", supabaseOrigin: SUPABASE });
    expect(loadBuildEnv({ TRAMPO_SUPABASE_ORIGIN: "https://projeto.explicito.test" }, path)).toMatchObject({ apiOrigin: API, supabaseOrigin: "https://projeto.explicito.test" });
    const other = rsaSpki().toString("base64");
    expect(loadBuildEnv({ TRAMPO_EXTENSION_KEY: other }, path).extensionKey?.key).toBe(other);
  });

  test("precedência: vazio explícito no process.env também vence (a variável fica ausente, e o build, mais fechado)", () => {
    expect(loadBuildEnv({ TRAMPO_API_ORIGIN: "", TRAMPO_SUPABASE_ORIGIN: "", TRAMPO_EXTENSION_KEY: "" }, dotenv(FULL))).toStrictEqual(CLOSED);
  });

  test("precedência: a variável explícita inválida derruba o build, mesmo com o arquivo válido", () => {
    expect(failure({ TRAMPO_API_ORIGIN: "http://canario.explicito.test" }, dotenv(FULL))).toBe("TRAMPO_API_ORIGIN deve ser uma origem https exata, sem caminho (ex.: https://api.exemplo.com)");
  });

  test("undefined no objeto do ambiente conta como não definida: vale o arquivo", () => {
    expect(loadBuildEnv({ TRAMPO_API_ORIGIN: undefined }, dotenv(FULL)).apiOrigin).toBe(API);
  });

  test("sem arquivo, só o process.env (o CI e o build fechado)", () => {
    const missing = join(work, "nao-existe.env");
    expect(loadBuildEnv({}, missing)).toStrictEqual(CLOSED);
    expect(loadBuildEnv({ TRAMPO_API_ORIGIN: API }, missing).apiOrigin).toBe(API);
  });

  test("arquivo vazio ou só com comentários: build fechado", () => {
    expect(loadBuildEnv({}, dotenv(""))).toStrictEqual(CLOSED);
    expect(loadBuildEnv({}, dotenv("# nada aqui\n"))).toStrictEqual(CLOSED);
  });

  test("TRAMPO_IGNORE_DOTENV=1: o arquivo nem é aberto (testes e E2E isolados do .env do desenvolvedor)", () => {
    const valid = dotenv(FULL);
    expect(loadBuildEnv({ TRAMPO_IGNORE_DOTENV: "1" }, valid)).toStrictEqual(CLOSED);
    expect(loadBuildEnv({ TRAMPO_IGNORE_DOTENV: "1", TRAMPO_API_ORIGIN: "https://api.explicita.test" }, valid)).toMatchObject({ apiOrigin: "https://api.explicita.test", supabaseOrigin: undefined });
    // Nem um arquivo que derrubaria o build é lido: uma pasta no lugar do arquivo e um valor inválido.
    const folder = join(work, "pasta.env");
    mkdirSync(folder);
    expect(loadBuildEnv({ TRAMPO_IGNORE_DOTENV: "1" }, folder)).toStrictEqual(CLOSED);
    expect(loadBuildEnv({ TRAMPO_IGNORE_DOTENV: "1" }, dotenv("TRAMPO_API_ORIGIN=http://canario.test\n"))).toStrictEqual(CLOSED);
  });

  test("TRAMPO_IGNORE_DOTENV vazio ou ausente: o arquivo é lido", () => {
    expect(loadBuildEnv({ TRAMPO_IGNORE_DOTENV: "" }, dotenv(FULL)).apiOrigin).toBe(API);
    expect(loadBuildEnv({ TRAMPO_IGNORE_DOTENV: undefined }, dotenv(FULL)).apiOrigin).toBe(API);
  });

  test.each(["0", "true", "1 ", " 1", "01", "sim", "CANARIO-valor"])("TRAMPO_IGNORE_DOTENV=%j derruba o build sem ecoar o valor (sem coerção)", (value) => {
    expect(failure({ TRAMPO_IGNORE_DOTENV: value }, dotenv(FULL))).toBe("TRAMPO_IGNORE_DOTENV só aceita 1 (ADR-004 §4.6)");
  });

  test("o TRAMPO_IGNORE_DOTENV do arquivo não vale: só o do process.env", () => {
    expect(loadBuildEnv({}, dotenv(`TRAMPO_IGNORE_DOTENV=1\n${FULL}`)).apiOrigin).toBe(API);
  });

  test.each([
    ["TRAMPO_API_ORIGIN", "http://canario.arquivo.test", "TRAMPO_API_ORIGIN deve ser uma origem https exata, sem caminho (ex.: https://api.exemplo.com)"],
    ["TRAMPO_SUPABASE_ORIGIN", "https://canario.arquivo.test/caminho", "TRAMPO_SUPABASE_ORIGIN deve ser uma origem https exata, sem caminho (ex.: https://<projeto>.supabase.co)"],
    ["TRAMPO_EXTENSION_KEY", Buffer.from("CANARIO-nao-e-chave-do-arquivo").toString("base64"), "TRAMPO_EXTENSION_KEY deve ser a chave pública RSA da extensão (2048 bits ou mais) em SPKI DER, base64 numa linha"],
  ])("%s inválida no arquivo derruba o build sem ecoar o valor", (name, value, message) => {
    const got = failure({}, dotenv(`${name}=${value}\n`));
    expect(got).toBe(message);
    expect(got).not.toContain(value);
  });

  test.each([
    ["duas linhas", `TRAMPO_API_ORIGIN=${API}\nTRAMPO_API_ORIGIN=https://canario.segunda.test\n`],
    ["a segunda com export", `TRAMPO_API_ORIGIN=${API}\nexport TRAMPO_API_ORIGIN=https://canario.segunda.test\n`],
    ["a segunda recuada e com espaço antes do =", `TRAMPO_API_ORIGIN=${API}\n  TRAMPO_API_ORIGIN =https://canario.segunda.test\n`],
    ["valores iguais", `TRAMPO_API_ORIGIN=${API}\r\nTRAMPO_API_ORIGIN=${API}\r\n`],
  ])("chave da lista repetida no arquivo (%s) derruba o build sem ecoar valor: nenhuma das duas vale", (_caso, content) => {
    const got = failure({}, dotenv(content));
    expect(got).toBe("TRAMPO_API_ORIGIN aparece mais de uma vez no .env da extensão");
  });

  test("a repetição é contada por chave: as 3 chaves, uma vez cada, passam, e um nome que só começa igual não conta", () => {
    expect(loadBuildEnv({}, dotenv(`${FULL}TRAMPO_API_ORIGIN_EXTRA=x\n# TRAMPO_API_ORIGIN=comentada\n`)).apiOrigin).toBe(API);
  });

  test("chave repetida que o process.env já define também derruba: o arquivo ambíguo não passa", () => {
    const path = dotenv(`TRAMPO_EXTENSION_KEY=${KEY}\nTRAMPO_EXTENSION_KEY=${KEY}\n`);
    expect(failure({ TRAMPO_EXTENSION_KEY: KEY }, path)).toBe("TRAMPO_EXTENSION_KEY aparece mais de uma vez no .env da extensão");
  });

  test("arquivo que existe e não pode ser lido (uma pasta no lugar) derruba o build, sem o caminho na mensagem", () => {
    const folder = join(work, "outra-pasta.env");
    mkdirSync(folder);
    const got = failure({}, folder);
    expect(got).toBe("o .env da extensão existe, mas não pôde ser lido");
    expect(got).not.toContain(work);
  });

  test("teto de tamanho: no limite passa; um byte acima derruba o build, sem ler o resto", () => {
    const line = `TRAMPO_API_ORIGIN=${API}\n`;
    const atLimit = `${line}#${"x".repeat(DOTENV_MAX_BYTES - line.length - 1)}`;
    expect(Buffer.byteLength(atLimit)).toBe(DOTENV_MAX_BYTES);
    expect(loadBuildEnv({}, dotenv(atLimit)).apiOrigin).toBe(API);
    expect(failure({}, dotenv(`${atLimit}x`))).toBe(`o .env da extensão passa de ${DOTENV_MAX_BYTES} bytes: ele só leva as 3 variáveis do build`);
    expect(failure({}, dotenv(`${line}#${"x".repeat(DOTENV_MAX_BYTES * 4)}`))).toBe(`o .env da extensão passa de ${DOTENV_MAX_BYTES} bytes: ele só leva as 3 variáveis do build`);
    expect(DOTENV_MAX_BYTES).toBe(16 * 1024);
  });

  test("arquivo que não é UTF-8 derruba o build, sem ecoar os bytes", () => {
    const bytes = Buffer.concat([Buffer.from(`TRAMPO_API_ORIGIN=${API}\n# `), Buffer.from([0xc3, 0x28]), Buffer.from("\n")]);
    expect(failure({}, dotenv(bytes))).toBe("o .env da extensão não é UTF-8 válido");
  });
});
