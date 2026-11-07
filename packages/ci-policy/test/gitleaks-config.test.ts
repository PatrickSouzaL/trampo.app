// Leitor do .gitleaks.toml e a regra trampo-auth-seal-keys (ADR-004 §4.8; ADR-019 D6 e emenda do 07h). O CI roda o
// binário do gitleaks só no job `secrets`; aqui, no `pnpm test`, as regex da configuração real passam por casos
// positivos e negativos, e um mutante que afrouxe a regra derruba este arquivo antes do push.
//
// Toda amostra com valor de chave é montada em tempo de execução (`${...}` no meio): o próprio arquivo de teste não
// pode disparar a regra que ele prova.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  GitleaksConfigError,
  findsSecret,
  parseGitleaksConfig,
  portableRegExp,
  type GitleaksConfig,
} from "../src/gitleaks-config.js";

const ROOT_DIR = fileURLToPath(new URL("../../../", import.meta.url));
const real: GitleaksConfig = parseGitleaksConfig(readFileSync(`${ROOT_DIR}.gitleaks.toml`, "utf8"));

const NAME = "AUTH_REFRESH_SEAL_KEYS";
/** 32 bytes em base64url: o formato que o anel do refresh exige (43 caracteres). */
const key = (): string => randomBytes(32).toString("base64url");

const found = (content: string, path = "apps/api/.env"): boolean =>
  findsSecret(real, "trampo-auth-seal-keys", { path, content });
const foundFile = (path: string): boolean => findsSecret(real, "trampo-auth-seal-keys-files", { path, content: "x" });

describe("parseGitleaksConfig: o subconjunto do TOML que o repositório usa", () => {
  it("lê o extend, as allowlists globais e as regras", () => {
    const config = parseGitleaksConfig(
      [
        "# comentário",
        "[extend]",
        "useDefault = true",
        "",
        "[[allowlists]]",
        'description = "falsos"',
        "regexes = [",
        "  # explicação",
        "  '''^a$''',",
        "  '''^b$''',",
        "]",
        "[[rules]]",
        'id = "r1"',
        "description = '''uma'''",
        "regex = '''x\\d+'''",
        'keywords = ["x", "y"]',
        "[[rules]]",
        'id = "r2"',
        'description = "duas"',
        "path = '''\\.pem$'''",
      ].join("\r\n"),
    );
    expect(config.useDefault).toBe(true);
    expect(config.allowlistRegexes).toEqual(["^a$", "^b$"]);
    expect(config.rules).toEqual([
      { id: "r1", description: "uma", regex: "x\\d+", keywords: ["x", "y"] },
      { id: "r2", description: "duas", path: "\\.pem$", keywords: [] },
    ]);
  });

  it("sem extend, useDefault é falso; keywords vazia é lista vazia", () => {
    const config = parseGitleaksConfig("[[rules]]\nid = \"r\"\ndescription = \"d\"\nregex = '''a'''\nkeywords = []\n");
    expect(config.useDefault).toBe(false);
    expect(config.rules[0]?.keywords).toEqual([]);
    expect(parseGitleaksConfig("[extend]\nuseDefault = false\n[[allowlists]]\nregexes = [\n\n]\n")).toEqual({
      useDefault: false,
      allowlistRegexes: [],
      rules: [],
    });
  });

  it.each([
    ["seção desconhecida", "[rules.allowlist]\n"],
    ["chave fora de seção", "id = \"r\"\n"],
    ["chave desconhecida numa regra (entropy)", "[[rules]]\nid = \"r\"\ndescription = \"d\"\nregex = '''a'''\nentropy = 3\n"],
    ["chave desconhecida com valor string numa regra (regexTarget)", "[[rules]]\nid = \"r\"\ndescription = \"d\"\nregex = '''a'''\nregexTarget = \"line\"\n"],
    ["chave repetida numa regra", "[[rules]]\nid = \"r\"\nid = \"s\"\ndescription = \"d\"\nregex = '''a'''\n"],
    ["chave desconhecida no extend", "[extend]\npath = \"x\"\n"],
    ["useDefault que não é booleano", "[extend]\nuseDefault = 1\n"],
    ["chave desconhecida na allowlist (paths, commits, regexTarget)", "[[allowlists]]\npaths = [\n]\n"],
    ["lista de regexes sem fechar", "[[allowlists]]\nregexes = [\n'''^a$''',\n"],
    ["lista de regexes numa linha só", "[[allowlists]]\nregexes = ['''^a$''']\n"],
    ["item da lista fora da forma", "[[allowlists]]\nregexes = [\n\"^a$\",\n]\n"],
    ["linha que não é chave = valor", "[[rules]]\nid\n"],
    ["valor que não é string", "[[rules]]\nid = r\n"],
    ["keywords fora da forma", "[[rules]]\nid = \"r\"\ndescription = \"d\"\nregex = '''a'''\nkeywords = [x]\n"],
    ["regra sem id", "[[rules]]\ndescription = \"d\"\nregex = '''a'''\n"],
    ["regra sem descrição", "[[rules]]\nid = \"r\"\nregex = '''a'''\n"],
    ["regra sem regex nem path", "[[rules]]\nid = \"r\"\ndescription = \"d\"\n"],
    ["id repetido", "[[rules]]\nid = \"r\"\ndescription = \"d\"\nregex = '''a'''\n[[rules]]\nid = \"r\"\ndescription = \"d\"\nregex = '''b'''\n"],
    ["regex que o RE2 não aceita", "[[rules]]\nid = \"r\"\ndescription = \"d\"\nregex = '''a(?=b)'''\n"],
    ["regex da allowlist que o RE2 não aceita", "[[allowlists]]\nregexes = [\n'''^(a)\\1$''',\n]\n"],
  ])("recusa %s", (_name, text) => {
    expect(() => parseGitleaksConfig(text)).toThrow(GitleaksConfigError);
  });
});

describe("portableRegExp: só o que o RE2 do gitleaks e o V8 leem igual", () => {
  it.each([["a(?=b)"], ["a(?!b)"], ["(?<=a)b"], ["(?<!a)b"], ["(a)\\1"], ["(?i)abc"], ["(?P<n>a)"]])("recusa %s", (source) => {
    expect(() => portableRegExp(source)).toThrow(GitleaksConfigError);
  });

  it("aceita a flag em grupo, que os dois leem", () => {
    expect(portableRegExp("(?i:abc)").test("xABCx")).toBe(true);
  });

  it("recusa o que o V8 não compila", () => {
    expect(() => portableRegExp("a(")).toThrow(GitleaksConfigError);
  });
});

describe("findsSecret: a semântica do gitleaks que a regra usa", () => {
  const config = parseGitleaksConfig(
    [
      "[[allowlists]]",
      "regexes = [",
      "'''^K=falsa$''',",
      "]",
      "[[rules]]",
      'id = "kw"',
      'description = "d"',
      "regex = '''K=\\w+'''",
      'keywords = ["segredo"]',
      "[[rules]]",
      'id = "ambos"',
      'description = "d"',
      "regex = '''K=\\w+'''",
      "path = '''\\.env$'''",
    ].join("\n"),
  );

  it("palavra-chave sem diferença de caixa filtra antes da regex", () => {
    expect(findsSecret(config, "kw", { path: "a", content: "SEGREDO K=valor" })).toBe(true);
    // A regex casaria, mas a palavra-chave não está no fragmento: o gitleaks nem roda a regex.
    expect(findsSecret(config, "kw", { path: "a", content: "K=valor" })).toBe(false);
  });

  it("com regex e path, os dois precisam casar", () => {
    expect(findsSecret(config, "ambos", { path: "x/.env", content: "K=valor" })).toBe(true);
    expect(findsSecret(config, "ambos", { path: "x/.envrc", content: "K=valor" })).toBe(false);
    expect(findsSecret(config, "ambos", { path: "x/.env", content: "nada" })).toBe(false);
  });

  it("a allowlist global libera só o valor exato", () => {
    expect(findsSecret(config, "kw", { path: "a", content: "segredo K=falsa" })).toBe(false);
    expect(findsSecret(config, "kw", { path: "a", content: "segredo K=falsas" })).toBe(true);
  });

  it("regra que não existe é erro, não ausência de achado", () => {
    expect(() => findsSecret(config, "nenhuma", { path: "a", content: "K=valor" })).toThrow(GitleaksConfigError);
  });
});

describe(".gitleaks.toml real: trampo-auth-seal-keys (ADR-004 §4.8)", () => {
  it("estende o padrão e tem as duas regras próprias, sem allowlist própria", () => {
    expect(real.useDefault).toBe(true);
    const ids = real.rules.map((rule) => rule.id);
    expect(ids).toContain("trampo-auth-seal-keys");
    expect(ids).toContain("trampo-auth-seal-keys-files");
    const assignment = real.rules.find((rule) => rule.id === "trampo-auth-seal-keys");
    expect(assignment?.keywords).toEqual(["auth_refresh_seal_keys"]);
    expect(assignment?.path).toBeUndefined();
    const files = real.rules.find((rule) => rule.id === "trampo-auth-seal-keys-files");
    expect(files?.regex).toBeUndefined();
  });

  it.each([
    ["dotenv", () => `${NAME}=r1:${key()}`],
    ["dotenv com aspas duplas", () => `${NAME}="r1:${key()}"`],
    ["dotenv com aspas simples e export", () => `export ${NAME}='r1:${key()}'`],
    ["dotenv com espaço em volta do igual", () => `${NAME} = r1:${key()}`],
    ["anel com duas chaves", () => `${NAME}=r2:${key()},r1:${key()}`],
    ["kid fora do contrato (o boot recusaria, mas a chave é real)", () => `${NAME}=R1:${key()}`],
    ["chave em base64 padrão", () => `${NAME}=r1:${randomBytes(32).toString("base64")}`],
    ["chave em hex", () => `${NAME}=r1:${randomBytes(32).toString("hex")}`],
    ["YAML", () => `env:\n  ${NAME}: r1:${key()}\n`],
    ["YAML com aspas", () => `  ${NAME}: "r1:${key()}"`],
    ["YAML com o valor na linha de baixo", () => `env:\n  ${NAME}:\n    r1:${key()}\n`],
    ["material de exatamente 32 caracteres (AES-128 em hex)", () => `${NAME}=r1:${randomBytes(16).toString("hex")}`],
    ["JSON", () => `{"${NAME}": "r1:${key()}"}`],
    ["objeto TypeScript", () => `const env = { ${NAME}: "r1:${key()}" };`],
    ["template literal sem interpolação", () => `{ ${NAME}: \`r1:${key()}\` }`],
    ["process.env com colchete", () => `process.env["${NAME}"] = "r1:${key()}";`],
    ["process.env com ponto", () => `process.env.${NAME} = 'r1:${key()}';`],
    ["PowerShell", () => `$env:${NAME} = "r1:${key()}"`],
    ["docker -e", () => `docker run -e ${NAME}=r1:${key()} img`],
    ["Go ou atribuição :=", () => `${NAME} := "r1:${key()}"`],
    ["seta de hash", () => `"${NAME}" => "r1:${key()}"`],
  ])("pega a atribuição: %s", (_name, sample) => {
    expect(found(sample())).toBe(true);
  });

  it.each([
    ["o .env.example vazio, mesmo seguido de outra variável", () => `${NAME}=\nAUTH_REFRESH_SEAL_ACTIVE_KEY=r1\nOUTRA=r1:${key()}\n`],
    ["a leitura do ambiente no código", () => `parseRefreshKeyring(source["${NAME}"] ?? "", x)`],
    ["valor montado por interpolação", () => `{ ${NAME}: \`r1k1:\${REFRESH_KEY}\` }`],
    ["valor que vem do shell", () => `${NAME}="$SEAL"`],
    ["expressão do Actions", () => `${NAME}: \${{ env.SEAL }}`],
    ["undefined num teste de boot", () => `{ ${NAME}: undefined }`],
    ["material curto demais para ser chave (31)", () => `${NAME}=r1:${"a".repeat(31)}`],
    ["menção em texto", () => `${NAME} e AUTH_REFRESH_SEAL_ACTIVE_KEY precisam de 1 a 4 chaves <kid>:<32 bytes>`],
    ["outra variável com o mesmo formato", () => `CRITERIA_SALARY_KEYS=k1:${key()}`],
  ])("não pega: %s", (_name, sample) => {
    expect(found(sample())).toBe(false);
  });

  it.each([["server.pem"], ["apps/api/certs/chave.pem"], ["CHAVE.PEM"], ["supabase/signing_keys.json"], ["signing_keys.json"]])(
    "pega o arquivo %s pelo caminho, qualquer que seja o conteúdo",
    (path) => {
      expect(foundFile(path)).toBe(true);
    },
  );

  it.each([["pem.ts"], ["docs/pem.md"], ["supabase/signing_keys.json.example"], ["my_signing_keys.json"], ["x.pem.ts"]])(
    "não pega o arquivo %s",
    (path) => {
      expect(foundFile(path)).toBe(false);
    },
  );

  it("nenhum arquivo versionado dispara as duas regras (o espelho local do job secrets na árvore)", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0")
      .filter((name) => name !== "");
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((path) => {
      if (foundFile(path)) return true;
      const content = readFileSync(`${ROOT_DIR}${path}`, "utf8");
      return found(content, path);
    });
    expect(hits).toEqual([]);
  });
});
