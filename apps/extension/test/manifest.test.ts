// Auditoria do manifesto GERADO pelo build de produção (ADR-001 §5.0.1; threat-model SR-02; ADR-004 D13, §4.6 e
// CA-01). Qualquer permissão nova quebra aqui de propósito: ampliar privilégio exige revisão do [APPSEC] e a
// atualização deste teste. Dois builds próprios, em pasta temporária: o "fechado", sem nenhuma variável, e o
// "completo", com as duas origens e a `key` (a forma do build do E2E). A chave é gerada na hora e não vai ao git.
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { extensionIdFromSpki, readBuildEnv } from "../build-env";

const root = fileURLToPath(new URL("..", import.meta.url));
const API = "https://api.trampo.test";
const SUPABASE = "https://projeto.supabase.test";
const KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
const BUILD_SCRIPT = "import { build } from 'wxt'; await build({ root: process.cwd(), outDir: process.env.MANIFEST_TEST_OUT_DIR, mode: 'production' });";

/** O ambiente do teste sem nenhuma variável do Trampo nem do Vitest: só o que cada build declara entra. */
function cleanEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!/^(TRAMPO_|VITEST)/.test(name)) env[name] = value;
  // O Vite respeita um NODE_ENV já definido: sem isto, o build sairia com o React de desenvolvimento.
  return { ...env, ...vars, NODE_ENV: "production" };
}

/** `wxt build` de produção em processo próprio (o Vitest já registrou um WXT neste). */
function runBuild(outDir: string, vars: Record<string, string>): void {
  execFileSync(process.execPath, ["--input-type=module", "-e", BUILD_SCRIPT], {
    cwd: root,
    env: cleanEnv({ ...vars, MANIFEST_TEST_OUT_DIR: outDir }),
    stdio: "pipe",
  });
}

interface Built {
  readonly manifest: Record<string, unknown>;
  readonly background: string;
  /** Todos os arquivos de texto do artefato, menos o background.js: um superconjunto dos chunks do painel. */
  readonly others: ReadonlyMap<string, string>;
}

function readBuilt(outDir: string): Built {
  const dir = join(outDir, "chrome-mv3");
  const others = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(js|html|css|json)$/.test(entry.name)) continue;
    const path = relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/");
    if (path !== "background.js") others.set(path, readFileSync(join(dir, path), "utf8"));
  }
  return {
    manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>,
    background: readFileSync(join(dir, "background.js"), "utf8"),
    others,
  };
}

let work = "";
const builds = new Map<"fechado" | "completo", Built>();
const get = (name: "fechado" | "completo"): Built => builds.get(name) as Built;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "trampo-manifest-"));
  runBuild(join(work, "fechado"), {});
  runBuild(join(work, "completo"), { TRAMPO_API_ORIGIN: API, TRAMPO_SUPABASE_ORIGIN: SUPABASE, TRAMPO_EXTENSION_KEY: KEY });
  builds.set("fechado", readBuilt(join(work, "fechado")));
  builds.set("completo", readBuilt(join(work, "completo")));
}, 180_000);

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

  test("nenhum marcador do build de E2E no artefato (§4.6)", () => {
    for (const text of [get(name).background, ...get(name).others.values()]) expect(text).not.toContain("TRAMPO_E2E");
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
      for (const marker of ["launchWebAuthFlow", "getRedirectURL", ".identity.", "storage.session", "/v1/auth/", SUPABASE]) {
        expect(text.includes(marker), `${marker} em ${path}`).toBe(false);
      }
    }
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

describe("variável fora da forma derruba o build, sem ecoar o valor (§4.6)", () => {
  test.each([
    ["TRAMPO_EXTENSION_KEY", "Q0FOQVJJTy1uYW8tZS1jaGF2ZQ=="],
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
});
