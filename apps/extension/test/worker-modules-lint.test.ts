// F1-EXT-05a, 05a-4 (ADR-004 D10 B2 e §4.1): fixtures negativas do resto do lint por módulo. Cada capacidade sensível
// mora num arquivo só (identity no adapter do login, storage.onChanged em src/auth, executeScript na captura,
// tabs.create no background.ts), e os canais laterais ficam proibidos em todo o src/, inclusive nesses arquivos.
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, test } from "vitest";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd });

async function ruleHits(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? "parse");
}

const IDENTITY = "src/auth/web-auth-flow-source.ts";
const CAPTURE = "src/capture/capture.ts";
const BACKGROUND = "src/entrypoints/background.ts";
const API_CLIENT = "src/api/api-client.ts";
const ELSEWHERE = [
  "src/auth/lint-fixture.ts",
  "src/api/lint-fixture.ts",
  "src/messaging/lint-fixture.ts",
  "src/capture/lint-fixture.ts",
  "src/consent/lint-fixture.ts",
  "src/panel/lint-fixture.ts",
  "src/entrypoints/sidepanel/LintFixture.tsx",
  "src/extraction/lint-fixture.ts",
];
const PROP = "no-restricted-properties";
const GLOBAL = "no-restricted-globals";
const SYNTAX = "no-restricted-syntax";

type Form = readonly [form: string, code: string, rule: string];

const IDENTITY_FORMS: readonly Form[] = [
  ["browser.identity", 'export const f = () => browser.identity.launchWebAuthFlow({ url: "https://x.test", interactive: true });\n', PROP],
  ["chrome.identity", 'export const f = () => chrome.identity.getRedirectURL("auth");\n', PROP],
  ['browser["identity"]', 'export const f = () => browser["identity"].getRedirectURL("auth");\n', PROP],
  ["desestruturação", 'const { identity } = browser;\nexport const f = () => identity.getRedirectURL("auth");\n', PROP],
];
const ON_CHANGED_FORMS: readonly Form[] = [
  ["storage.onChanged", "export const f = () => browser.storage.onChanged.addListener(() => undefined);\n", PROP],
  ["storage.session.onChanged", "export const f = () => browser.storage.session.onChanged.addListener(() => undefined);\n", PROP],
  ["desestruturação", "const { onChanged } = browser.storage;\nexport const f = () => onChanged.addListener(() => undefined);\n", PROP],
];
const EXECUTE_SCRIPT_FORMS: readonly Form[] = [
  ["scripting.executeScript", "export const f = () => browser.scripting.executeScript({ target: { tabId: 1 }, func: () => 1 });\n", PROP],
  ["desestruturação", "const { executeScript } = browser.scripting;\nexport const f = executeScript;\n", PROP],
];
const TABS_CREATE_FORMS: readonly Form[] = [
  ["browser.tabs.create", 'export const f = () => browser.tabs.create({ url: "https://x.test" });\n', SYNTAX],
  ["tabs.create solto", 'const { tabs } = browser;\nexport const f = () => tabs.create({ url: "https://x.test" });\n', SYNTAX],
  ["desestruturação", 'const { create } = browser.tabs;\nexport const f = () => create({ url: "https://x.test" });\n', SYNTAX],
];
/** Proibidos em todo o src/, inclusive nos arquivos com exceção. */
const EVERYWHERE: readonly Form[] = [
  ["runtime.onMessageExternal", "export const f = () => browser.runtime.onMessageExternal.addListener(() => undefined);\n", PROP],
  ["runtime.onConnectExternal", "export const f = () => browser.runtime.onConnectExternal.addListener(() => undefined);\n", PROP],
  ["runtime.sendMessage", 'export const f = () => browser.runtime.sendMessage({ kind: "x" });\n', PROP],
  ["tabs.sendMessage", 'export const f = () => browser.tabs.sendMessage(1, { kind: "x" });\n', PROP],
  ["tabs.connect", "export const f = () => browser.tabs.connect(1);\n", SYNTAX],
  ["tabs.connect solto", "const { tabs } = browser;\nexport const f = () => tabs.connect(1);\n", SYNTAX],
  ["tabs.connect desestruturado", "const { connect } = browser.tabs;\nexport const f = () => connect(1);\n", SYNTAX],
  ["BroadcastChannel", 'export const f = () => new BroadcastChannel("x");\n', GLOBAL],
  ["self.BroadcastChannel", 'export const f = () => new self.BroadcastChannel("x");\n', PROP],
  ["MessageChannel", "export const f = () => new MessageChannel();\n", GLOBAL],
  ["clients", "export const f = () => clients.matchAll();\n", GLOBAL],
  ["self.clients", "export const f = () => self.clients.matchAll();\n", PROP],
  ["navigator.serviceWorker", "export const f = () => navigator.serviceWorker.register('/x.js');\n", PROP],
  ["registerContentScripts", "export const f = () => browser.scripting.registerContentScripts([]);\n", PROP],
  ["insertCSS", 'export const f = () => browser.scripting.insertCSS({ target: { tabId: 1 }, css: "x" });\n', PROP],
  ["executeScript com files:", 'export const f = (s: { executeScript(i: unknown): void }) => s.executeScript({ target: { tabId: 1 }, files: ["x.js"] });\n', SYNTAX],
];

const outside = (forms: readonly Form[], files: readonly string[]) =>
  files.flatMap((file) => forms.map(([form, code, rule]) => [file, form, code, rule] as const));

describe("lint B2: cada capacidade num arquivo só (ADR-004 D10)", () => {
  // Carregar a configuração (typescript-eslint e presets) custa segundos na primeira chamada.
  beforeAll(async () => {
    await ruleHits("export {};", IDENTITY);
  }, 60_000);

  test.each(outside(IDENTITY_FORMS, [...ELSEWHERE, BACKGROUND, API_CLIENT, CAPTURE]))("%s: identity por %s é recusado", async (file, _f, code, rule) => {
    expect(await ruleHits(code, file)).toContain(rule);
  });

  test.each(IDENTITY_FORMS)("no adapter do login, identity por %s passa", async (_f, code, rule) => {
    expect(await ruleHits(code, IDENTITY)).not.toContain(rule);
  });

  test.each(outside(ON_CHANGED_FORMS, [...ELSEWHERE.filter((f) => !f.startsWith("src/auth/")), BACKGROUND, API_CLIENT, CAPTURE]))(
    "%s: %s é recusado fora de src/auth",
    async (file, _f, code, rule) => {
      expect(await ruleHits(code, file)).toContain(rule);
    },
  );

  test.each(outside(ON_CHANGED_FORMS, ["src/auth/lint-fixture.ts", IDENTITY]))("%s: %s passa em src/auth", async (file, _f, code, rule) => {
    expect(await ruleHits(code, file)).not.toContain(rule);
  });

  test.each(outside(EXECUTE_SCRIPT_FORMS, [...ELSEWHERE, BACKGROUND, API_CLIENT, IDENTITY]))("%s: executeScript por %s é recusado", async (file, _f, code, rule) => {
    expect(await ruleHits(code, file)).toContain(rule);
  });

  test.each(EXECUTE_SCRIPT_FORMS)("na captura, executeScript por %s passa", async (_f, code, rule) => {
    expect(await ruleHits(code, CAPTURE)).not.toContain(rule);
  });

  test.each(outside(TABS_CREATE_FORMS, [...ELSEWHERE, API_CLIENT, IDENTITY, CAPTURE]))("%s: %s é recusado", async (file, _f, code, rule) => {
    expect(await ruleHits(code, file)).toContain(rule);
  });

  test.each(TABS_CREATE_FORMS)("no background.ts, %s passa", async (_f, code, rule) => {
    expect(await ruleHits(code, BACKGROUND)).not.toContain(rule);
  });

  test.each(outside(EVERYWHERE, [...ELSEWHERE, BACKGROUND, API_CLIENT, IDENTITY, CAPTURE]))("%s: %s é recusado", async (file, _f, code, rule) => {
    expect(await ruleHits(code, file)).toContain(rule);
  });

  test("runtime.connect (o canal do painel) segue liberado", async () => {
    expect(await ruleHits('export const f = () => browser.runtime.connect({ name: "x" });\n', "src/panel/lint-fixture.ts")).toStrictEqual([]);
  });

  test("os testes ficam fora das regras (o E2E e os fakes usam identity e storage)", async () => {
    for (const [, code] of [...IDENTITY_FORMS, ...ON_CHANGED_FORMS, ...TABS_CREATE_FORMS, ...EVERYWHERE]) {
      const hits = await ruleHits(code, "test/lint-fixture.test.ts");
      expect(hits.filter((rule) => rule === PROP || rule === GLOBAL)).toStrictEqual([]);
    }
  });

  test("as exceções não apagam as outras regras do arquivo", async () => {
    // No adapter: fetch e storage fora de session seguem proibidos.
    expect(await ruleHits('export const f = () => fetch("https://x.test");\n', IDENTITY)).toContain(GLOBAL);
    expect(await ruleHits("export const f = () => browser.storage.local.get('k');\n", IDENTITY)).toContain(SYNTAX);
    // No api-client: identity segue proibido. Na captura, fetch. No background, innerHTML e storage.local.
    expect(await ruleHits('export const f = () => browser.identity.getRedirectURL("auth");\n', API_CLIENT)).toContain(PROP);
    expect(await ruleHits('export const f = () => fetch("https://x.test");\n', CAPTURE)).toContain(GLOBAL);
    expect(await ruleHits("export const f = (e: Element) => { e.innerHTML = 'x'; };\n", BACKGROUND)).toContain(SYNTAX);
    expect(await ruleHits("export const f = () => browser.storage.local.get('k');\n", BACKGROUND)).toContain(SYNTAX);
    // No extrator, os seletores próprios continuam.
    expect(await ruleHits("export const f = (n: Element) => n.textContent;\n", "src/extraction/lint-fixture.ts")).toContain(SYNTAX);
  });
});
