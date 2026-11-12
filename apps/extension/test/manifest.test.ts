// Auditoria do manifesto GERADO pelo build de produção (ADR-001 §5.0.1; threat-model SR-02; ADR-004 D13, §4.6 e
// CA-01). Qualquer permissão nova quebra aqui de propósito: ampliar privilégio exige revisão do [APPSEC] e a
// atualização deste teste. Dois builds próprios, em pasta temporária: o "fechado", sem nenhuma variável, e o
// "completo", com as duas origens e a `key` (a forma do build do E2E). A chave é gerada na hora e não vai ao git.
// F1-EXT-05b, 05b-1: a meta CSP do D10 B4 nas páginas e o fecho exato do painel (B5), nos dois builds.
// F1-EXT-06: o `.env` da extensão lido por lista fechada, provado em builds reais com um arquivo de teste (a config
// test/support/wxt.dotenv.config.ts usa a mesma fábrica do wxt.config.ts). Os outros builds rodam com a leitura desligada.
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { extensionIdFromSpki, readBuildEnv } from "../build-env";

const root = fileURLToPath(new URL("..", import.meta.url));
const API = "https://api.trampo.test";
const SUPABASE = "https://projeto.supabase.test";
const KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
const BUILD_SCRIPT =
  "import { build } from 'wxt'; const configFile = process.env.MANIFEST_TEST_CONFIG; await build({ root: process.cwd(), outDir: process.env.MANIFEST_TEST_OUT_DIR, mode: 'production', ...(configFile ? { configFile } : {}) });";
const DOTENV_CONFIG = fileURLToPath(new URL("./support/wxt.dotenv.config.ts", import.meta.url));

/** O ambiente do teste sem nenhuma variável do Trampo nem do Vitest: só o que cada build declara entra. */
function cleanEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!/^(TRAMPO_|VITEST|MANIFEST_TEST_)/.test(name)) env[name] = value;
  // O Vite respeita um NODE_ENV já definido: sem isto, o build sairia com o React de desenvolvimento.
  return { ...env, ...vars, NODE_ENV: "production" };
}

/**
 * `wxt build` de produção em processo próprio (o Vitest já registrou um WXT neste). Sem `dotenv`, é o wxt.config.ts real
 * com a leitura do `.env` desligada (o arquivo do desenvolvedor nunca entra num teste). Com `dotenv`, é a config de teste,
 * que lê o arquivo dado pelo mesmo leitor de lista fechada.
 */
function runBuild(outDir: string, vars: Record<string, string>, dotenv?: string): void {
  const source = dotenv === undefined ? { TRAMPO_IGNORE_DOTENV: "1" } : { MANIFEST_TEST_CONFIG: DOTENV_CONFIG, MANIFEST_TEST_DOTENV: dotenv };
  execFileSync(process.execPath, ["--input-type=module", "-e", BUILD_SCRIPT], {
    cwd: root,
    env: cleanEnv({ ...source, ...vars, MANIFEST_TEST_OUT_DIR: outDir }),
    stdio: "pipe",
  });
}

interface Built {
  readonly manifest: Record<string, unknown>;
  readonly background: string;
  /** Todos os arquivos de texto do artefato, menos o background.js: um superconjunto dos chunks do painel. */
  readonly others: ReadonlyMap<string, string>;
  /** Todos os arquivos de texto do artefato, pelo caminho relativo com "/". */
  readonly all: ReadonlyMap<string, string>;
}

function readBuilt(outDir: string): Built {
  const dir = join(outDir, "chrome-mv3");
  const all = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(js|html|css|json)$/.test(entry.name)) continue;
    const path = relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/");
    all.set(path, readFileSync(join(dir, path), "utf8"));
  }
  return {
    manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>,
    background: readFileSync(join(dir, "background.js"), "utf8"),
    others: new Map([...all].filter(([path]) => path !== "background.js")),
    all,
  };
}

/** Os atributos de uma tag HTML, com as entidades decodificadas (o WXT serializa `'` como `&#39;`). */
function attributes(tag: string): Map<string, string> {
  const decode = (value: string): string =>
    value.replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos);/gi, (_m, entity: string) => {
      const named: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };
      const lower = entity.toLowerCase();
      if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
      return named[lower] ?? "";
    });
  const attrs = new Map<string, string>();
  const body = tag.replace(/^<\s*[a-z]+/i, "").replace(/\/?>$/, "");
  for (const m of body.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs.set((m[1] ?? "").toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return attrs;
}

const tags = (html: string, name: string): Array<{ readonly index: number; readonly attrs: Map<string, string> }> =>
  [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => ({ index: m.index, attrs: attributes(m[0]) }));

/** Os `import` estáticos, os reexports e os `import()` de um chunk; só caminhos do próprio artefato. */
function jsImports(code: string): string[] {
  const specifiers = [
    ...code.matchAll(/\bimport\s*(?:[\w$*{},][\w$*{},\s]*from\s*)?["']([^"']+)["']/g),
    ...code.matchAll(/\bexport\s*(?:\*(?:\s*as\s*[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g),
    ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1] ?? "");
  return specifiers.filter((s) => /^(\.{1,2})?\//.test(s));
}

/**
 * O fecho do B5: a partir da página, o `src` de cada script, o `href` de cada modulepreload e, nos chunks, cada
 * import estático ou dinâmico. Uma referência a arquivo que não está no artefato derruba o teste.
 */
function panelClosure(files: ReadonlyMap<string, string>, page: string): Set<string> {
  const seen = new Set<string>();
  const queue = [page];
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (seen.has(path)) continue;
    const text = files.get(path);
    if (text === undefined) throw new Error(`o painel referencia um arquivo fora do artefato: ${path}`);
    seen.add(path);
    const refs = path.endsWith(".html")
      ? [
          ...tags(text, "script").flatMap(({ attrs }) => (attrs.has("src") ? [attrs.get("src") ?? ""] : [])),
          ...tags(text, "link").flatMap(({ attrs }) => (attrs.get("rel") === "modulepreload" ? [attrs.get("href") ?? ""] : [])),
        ]
      : jsImports(text);
    for (const ref of refs) queue.push(ref.startsWith("/") ? ref.slice(1) : posix.normalize(posix.join(posix.dirname(path), ref)));
  }
  return seen;
}

/** O que nunca pode estar fora do background.js (D10 B5). */
const SESSION_MARKERS = ["launchWebAuthFlow", "getRedirectURL", ".identity.", "storage.session", "/v1/auth/", SUPABASE];

// F1-EXT-06: o `.env` de teste. As 3 chaves do build e, em volta, o que um `.env` copiado da API traria: nada disso pode
// chegar ao artefato. Os canários são montados aqui, e nenhum tem forma de chave.
const API_FILE = "https://api.arquivo.test";
const SUPABASE_FILE = "https://projeto.arquivo.test";
const DOTENV_CANARY = ["CANARIO", "SEGREDO", "DO", "ARQUIVO"].join("-");
const DOTENV_EXTRA_KEYS = ["SUPABASE_SECRET_KEY", "AUTH_REFRESH_SEAL_KEYS", "GROQ_API_KEY", "VITE_CANARIO", "WXT_CANARIO", "TRAMPO_OUTRA"];
const DOTENV_TEXT = [
  "# .env de teste do manifest.test.ts",
  ...DOTENV_EXTRA_KEYS.map((name) => `${name}=${DOTENV_CANARY}`),
  `TRAMPO_API_ORIGIN=${API_FILE}`,
  `TRAMPO_SUPABASE_ORIGIN=${SUPABASE_FILE}`,
  `TRAMPO_EXTENSION_KEY=${KEY}`,
  "",
].join("\n");

type BuildName = "fechado" | "completo" | "arquivo" | "precedencia" | "ignorado";
let work = "";
let dotenvFile = "";
const builds = new Map<BuildName, Built>();
const get = (name: BuildName): Built => builds.get(name) as Built;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "trampo-manifest-"));
  dotenvFile = join(work, "extensao.env");
  writeFileSync(dotenvFile, DOTENV_TEXT);
  runBuild(join(work, "fechado"), {});
  runBuild(join(work, "completo"), { TRAMPO_API_ORIGIN: API, TRAMPO_SUPABASE_ORIGIN: SUPABASE, TRAMPO_EXTENSION_KEY: KEY });
  // As 3 variáveis só do arquivo; a origem da API explícita no ambiente, por cima do arquivo; e a leitura desligada.
  runBuild(join(work, "arquivo"), {}, dotenvFile);
  runBuild(join(work, "precedencia"), { TRAMPO_API_ORIGIN: API }, dotenvFile);
  runBuild(join(work, "ignorado"), { TRAMPO_IGNORE_DOTENV: "1" }, dotenvFile);
  for (const name of ["fechado", "completo", "arquivo", "precedencia", "ignorado"] as const) builds.set(name, readBuilt(join(work, name)));
}, 300_000);

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

describe.each(["fechado", "completo"] as const)("manifest.json de produção (build %s)", (name) => {
  const manifest = () => get(name).manifest;

  test("MV3 e Chrome mínimo 116 (sidePanel.open com gesto)", () => {
    expect(manifest()["manifest_version"]).toBe(3);
    expect(manifest()["minimum_chrome_version"]).toBe("116");
  });

  test("permissões exatas do D13: activeTab, identity, scripting, sidePanel e storage", () => {
    expect([...(manifest()["permissions"] as string[])].sort()).toEqual(["activeTab", "identity", "scripting", "sidePanel", "storage"]);
  });

  test("sem identity.email, sem oauth2 e nada pedido em runtime (D13)", () => {
    expect(manifest()["permissions"]).not.toContain("identity.email");
    expect(manifest()).not.toHaveProperty("oauth2");
    expect(manifest()).not.toHaveProperty("optional_permissions");
  });

  test("sem acesso amplo a sites", () => {
    expect(manifest()).not.toHaveProperty("host_permissions");
    expect(manifest()).not.toHaveProperty("optional_host_permissions");
    expect(manifest()).not.toHaveProperty("content_scripts");
    expect(JSON.stringify(manifest())).not.toContain("<all_urls>");
  });

  test("ação sem popup (o clique precisa disparar action.onClicked e conceder activeTab)", () => {
    expect(manifest()["action"]).toBeTypeOf("object");
    expect(manifest()["action"]).not.toHaveProperty("default_popup");
  });

  test("externally_connectable declarado e vazio (omitir liberaria todas as extensões, D-H7)", () => {
    expect(manifest()["externally_connectable"]).toEqual({ ids: [], matches: [] });
  });

  test("CSP de loja: só 'self' para scripts e nada da CSP de desenvolvimento", () => {
    const csp = (manifest()["content_security_policy"] as { extension_pages: string }).extension_pages;
    expect(csp).toMatch(/(^|; )script-src 'self'(;|$)/);
    expect(csp).toMatch(/(^|; )object-src 'self'(;|$)/);
    expect(csp).toMatch(/(^|; )default-src 'self'(;|$)/);
    // Nada da CSP de desenvolvimento (HMR do WXT) no build de loja.
    expect(csp).not.toMatch(/localhost|127\.0\.0\.1|unsafe-eval|unsafe-inline|wasm-unsafe-eval|ws:|http:/);
  });

  test("sem web_accessible_resources (nenhum recurso da extensão exposto às páginas; B8)", () => {
    expect(manifest()).not.toHaveProperty("web_accessible_resources");
  });

  // F1-EXT-05c, 05c-1: o modo 3 do P20 não tem código, e nenhum marcador do adapter falso existe em artefato algum.
  test.each(["TRAMPO_E2E", "FAKE_IDENTITY", "trampo/e2e/"])("nenhum marcador do build de E2E no artefato: %s (§4.6)", (marker) => {
    for (const text of get(name).all.values()) expect(text).not.toContain(marker);
  });
});

describe("D13: o que muda entre os dois builds (CA-01)", () => {
  const csp = (name: "fechado" | "completo") => (get(name).manifest["content_security_policy"] as { extension_pages: string }).extension_pages;

  test("connect-src fechado sem a origem da API", () => {
    expect(csp("fechado")).toMatch(/(^|; )connect-src 'none'$/);
  });

  test("connect-src só na origem da API; a do Supabase não entra na CSP nem no manifesto", () => {
    expect(csp("completo")).toMatch(new RegExp(`(^|; )connect-src ${API.replaceAll(".", "\\.")}$`));
    expect(JSON.stringify(get("completo").manifest)).not.toContain("supabase");
  });

  test("key presente se e somente se TRAMPO_EXTENSION_KEY estiver definida", () => {
    expect(get("fechado").manifest).not.toHaveProperty("key");
    expect(get("completo").manifest["key"]).toBe(KEY);
  });

  test("o ID derivado da key do manifesto é o do build-env: 128 bits do SHA-256 do SPKI, de 0-f para a-p", () => {
    const spki = Buffer.from(get("completo").manifest["key"] as string, "base64");
    const hex = createHash("sha256").update(spki).digest("hex").slice(0, 32);
    const expected = [...hex].map((d) => "abcdefghijklmnop"[Number.parseInt(d, 16)]).join("");
    expect(expected).toMatch(/^[a-p]{32}$/);
    expect(extensionIdFromSpki(spki)).toBe(expected);
    expect(readBuildEnv({ TRAMPO_EXTENSION_KEY: KEY }).extensionKey?.id).toBe(expected);
  });
});

describe("artefato: a sessão só no background.js (D10 B2 e B5)", () => {
  test("o adapter de identity e as duas origens estão no background.js do build completo", () => {
    const { background } = get("completo");
    expect(background).toContain("launchWebAuthFlow");
    expect(background).toContain("getRedirectURL");
    expect(background).toContain(SUPABASE);
    expect(background).toContain(API);
    expect(background).not.toContain("import.meta.env");
  });

  test("o build fechado não carrega origem nenhuma (o login dá auth_sem_configuracao)", () => {
    expect(get("fechado").background).not.toMatch(/supabase\.test|api\.trampo\.test/);
  });

  test.each(["fechado", "completo"] as const)("build %s: nenhum outro arquivo tem identity, storage.session, rota de auth ou a origem do Supabase", (name) => {
    expect(get(name).others.size).toBeGreaterThan(0);
    for (const [path, text] of get(name).others) {
      for (const marker of SESSION_MARKERS) {
        expect(text.includes(marker), `${marker} em ${path}`).toBe(false);
      }
    }
  });
});

// F1-EXT-07 (revisão adversarial de auth, E-01): o lint barra `setAccessLevel` no código-fonte, e o artefato inteiro,
// background.js incluído, é conferido aqui (uma forma que o lint não veja ainda deixaria o nome no artefato).
describe("artefato: storage.session nunca é aberto a content scripts (T22; E-01)", () => {
  test.each(["fechado", "completo"] as const)("build %s: nenhum arquivo, nem o background.js, tem setAccessLevel", (name) => {
    expect(get(name).all.has("background.js")).toBe(true);
    for (const [path, text] of get(name).all) expect(text.includes("setAccessLevel"), `setAccessLevel em ${path}`).toBe(false);
  });
});

describe("painel: meta CSP do D10 B4 e fecho exato do B5", () => {
  const B4 = "connect-src 'none'; form-action 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types 'none'";

  test.each(["fechado", "completo"] as const)("build %s: a única página, o sidepanel.html, tem uma só meta CSP, exata, no head e antes de qualquer script ou link", (name) => {
    const pages = [...get(name).all.keys()].filter((path) => path.endsWith(".html"));
    expect(pages).toStrictEqual(["sidepanel.html"]);
    const html = get(name).all.get("sidepanel.html") ?? "";
    const csp = tags(html, "meta").filter(({ attrs }) => attrs.get("http-equiv")?.toLowerCase() === "content-security-policy");
    expect(csp).toHaveLength(1);
    const [meta] = csp;
    expect(meta?.attrs.get("content")).toBe(B4);
    const head = html.search(/<head\b/i);
    const firstLoad = Math.min(...["script", "link", "style", "base"].flatMap((tag) => tags(html, tag).map(({ index }) => index)));
    expect(head).toBeGreaterThanOrEqual(0);
    expect(meta?.index).toBeGreaterThan(head);
    expect(meta?.index).toBeLessThan(firstLoad);
    expect(meta?.index).toBeLessThan(html.search(/<\/head>/i));
  });

  test.each(["fechado", "completo"] as const)("build %s: o fecho do painel tem o chunk do sidepanel, não tem o background.js e, com ele, cobre todo .js do artefato", (name) => {
    const closure = panelClosure(get(name).all, "sidepanel.html");
    const js = (paths: Iterable<string>) => [...paths].filter((path) => path.endsWith(".js")).sort();
    expect(js(closure).some((path) => /^chunks\/sidepanel-[\w-]+\.js$/.test(path))).toBe(true);
    expect(closure.has("background.js")).toBe(false);
    // Nenhum .js fora do SW e do painel: um chunk novo, que ninguém carrega, pede revisão deste teste.
    expect([...js(closure), "background.js"].sort()).toStrictEqual(js(get(name).all.keys()));
  });

  test.each(["fechado", "completo"] as const)("build %s: nenhum arquivo do fecho tem identity, storage.session, rota de auth ou a origem do Supabase", (name) => {
    const closure = panelClosure(get(name).all, "sidepanel.html");
    expect(closure.size).toBeGreaterThan(1);
    for (const path of closure) {
      const text = get(name).all.get(path) ?? "";
      for (const marker of SESSION_MARKERS) expect(text.includes(marker), `${marker} em ${path}`).toBe(false);
    }
  });

  test("o leitor do fecho segue import estático, reexport, import() e modulepreload, e falha em referência ausente", () => {
    const files = new Map([
      ["p.html", '<html><head><script type="module" crossorigin src="/chunks/a.js"></script><link rel="modulepreload" href="/chunks/b.js"><link rel="stylesheet" href="/assets/c.css"></head></html>'],
      ["chunks/a.js", 'import{x as y}from"./d.js";export*from"./e.js";const f=()=>import("../chunks/f.js");import"https://cdn.example/x.js";'],
      ["chunks/b.js", ""],
      ["chunks/d.js", 'export{z}from"./g.js";'],
      ["chunks/e.js", ""],
      ["chunks/f.js", ""],
      ["chunks/g.js", ""],
      ["assets/c.css", ""],
    ]);
    expect([...panelClosure(files, "p.html")].sort()).toStrictEqual(["chunks/a.js", "chunks/b.js", "chunks/d.js", "chunks/e.js", "chunks/f.js", "chunks/g.js", "p.html"]);
    expect(() => panelClosure(new Map([["p.html", '<script src="/chunks/sumiu.js"></script>']]), "p.html")).toThrow(/fora do artefato: chunks\/sumiu\.js/);
  });
});

describe("Service Worker gerado", () => {
  test.each(["fechado", "completo"] as const)("build %s: não registra handler do evento fetch (crbug 1463420)", (name) => {
    expect(get(name).background).not.toMatch(/addEventListener\(\s*[`'"]fetch[`'"]/);
    expect(get(name).background).not.toMatch(/\bonfetch\s*=/);
  });

  test("força openPanelOnActionClick: false e abre o painel no clique", () => {
    expect(get("completo").background).toMatch(/setPanelBehavior\(\{openPanelOnActionClick:!1\}\)/);
    expect(get("completo").background).toContain("sidePanel.open(");
  });

  test.each(["fechado", "completo"] as const)("build %s: sem eval nem código remoto", (name) => {
    expect(get(name).background).not.toMatch(/\beval\(|new Function\(|importScripts\(/);
  });
});

describe("F1-EXT-06: o .env da extensão por lista fechada, no build real (§4.6)", () => {
  const csp = (name: BuildName) => (get(name).manifest["content_security_policy"] as { extension_pages: string }).extension_pages;

  test("as 3 variáveis saem do arquivo: key, connect-src na API e as duas origens no background.js", () => {
    expect(get("arquivo").manifest["key"]).toBe(KEY);
    expect(csp("arquivo")).toMatch(/(^|; )connect-src https:\/\/api\.arquivo\.test$/);
    expect(get("arquivo").background).toContain(API_FILE);
    expect(get("arquivo").background).toContain(SUPABASE_FILE);
  });

  test("precedência: a variável do ambiente vence a do arquivo, e as outras duas seguem do arquivo", () => {
    expect(csp("precedencia")).toMatch(/(^|; )connect-src https:\/\/api\.trampo\.test$/);
    expect(get("precedencia").background).toContain(API);
    expect(get("precedencia").background).not.toContain(API_FILE);
    expect(get("precedencia").background).toContain(SUPABASE_FILE);
    expect(get("precedencia").manifest["key"]).toBe(KEY);
  });

  test("TRAMPO_IGNORE_DOTENV=1: o arquivo não é lido, e o build sai fechado", () => {
    expect(get("ignorado").manifest).not.toHaveProperty("key");
    expect(csp("ignorado")).toMatch(/(^|; )connect-src 'none'$/);
    expect(get("ignorado").background).not.toMatch(/arquivo\.test/);
  });

  test.each(["arquivo", "precedencia", "ignorado"] as const)("build %s: nenhuma chave fora da lista chega ao artefato, nem o nome nem o valor", (name) => {
    expect(get(name).all.size).toBeGreaterThan(3);
    for (const [path, text] of get(name).all) {
      for (const marker of [DOTENV_CANARY, ...DOTENV_EXTRA_KEYS, "TRAMPO_IGNORE_DOTENV", "MANIFEST_TEST"]) expect(text.includes(marker), `${marker} em ${path}`).toBe(false);
    }
  });

  test.each(["arquivo", "precedencia"] as const)("build %s: as origens do arquivo ficam só no background.js (grep do D10 B5)", (name) => {
    for (const [path, text] of get(name).others) {
      for (const marker of [...SESSION_MARKERS, SUPABASE_FILE]) expect(text.includes(marker), `${marker} em ${path}`).toBe(false);
    }
  });

  test("variável inválida no arquivo derruba o build, com o nome dela e sem o valor", () => {
    const value = "http://canario-do-arquivo.trampo.test";
    const invalid = join(work, "invalido.env");
    writeFileSync(invalid, `TRAMPO_SUPABASE_ORIGIN=${value}\n`);
    let failure: { status?: number | null; stderr?: Buffer; stdout?: Buffer } | undefined;
    try {
      runBuild(join(work, "falha-arquivo"), {}, invalid);
    } catch (error) {
      failure = error as typeof failure;
    }
    expect(failure?.status).not.toBe(0);
    const output = `${failure?.stderr?.toString() ?? ""}${failure?.stdout?.toString() ?? ""}`;
    expect(output).toContain("TRAMPO_SUPABASE_ORIGIN");
    expect(output).not.toContain(value);
    expect(output).not.toContain("canario-do-arquivo");
  }, 60_000);
});

describe("variável fora da forma derruba o build, sem ecoar o valor (§4.6)", () => {
  // Base64 que não é chave SPKI, montado em tempo de execução: o literal parece chave para o gitleaks
  // (generic-api-key). O valor exato, que já está no histórico (cd141d2), é liberado no .gitleaks.toml (ADR-019 D6).
  const CANARIO_BASE64 = Buffer.from("CANARIO-nao-e-chave").toString("base64");
  test.each([
    ["TRAMPO_EXTENSION_KEY", CANARIO_BASE64],
    ["TRAMPO_SUPABASE_ORIGIN", "https://canario.supabase.test/caminho"],
    ["TRAMPO_API_ORIGIN", "http://canario.trampo.test"],
  ])("%s inválida", (name, value) => {
    let failure: { status?: number | null; stderr?: Buffer; stdout?: Buffer } | undefined;
    try {
      runBuild(join(work, `falha-${name}`), { [name]: value });
    } catch (error) {
      failure = error as typeof failure;
    }
    expect(failure?.status).not.toBe(0);
    const output = `${failure?.stderr?.toString() ?? ""}${failure?.stdout?.toString() ?? ""}`;
    expect(output).toContain(name);
    expect(output).not.toContain(value);
  }, 60_000);

  // F1-EXT-05c, 05c-1 (ADR-004 §4.4 e §4.6): o adapter falso de identidade não existe; a variável derruba o build com ou
  // sem TRAMPO_E2E=1, como o build-env.test.ts prova pela mensagem.
  test.each([
    [{}, "só existe no build de teste, com TRAMPO_E2E=1"],
    [{ TRAMPO_E2E: "1" }, "o modo 3 do P20 não existe"],
  ])("TRAMPO_E2E_FAKE_IDENTITY derruba o build (%j)", (extra, message) => {
    let failure: { status?: number | null; stderr?: Buffer; stdout?: Buffer } | undefined;
    try {
      runBuild(join(work, `falha-fake-identity-${Object.keys(extra).length}`), { ...extra, TRAMPO_E2E_FAKE_IDENTITY: "CANARIO-modo-3" });
    } catch (error) {
      failure = error as typeof failure;
    }
    expect(failure?.status).not.toBe(0);
    const output = `${failure?.stderr?.toString() ?? ""}${failure?.stdout?.toString() ?? ""}`;
    expect(output).toContain(message);
    expect(output).not.toContain("CANARIO-modo-3");
  }, 60_000);
});
