// F1-EXT-05a, 05a-4 (ADR-004 D10 B2 e §4.1): fixtures negativas do resto do lint por módulo. Cada capacidade sensível
// mora num arquivo só (identity no adapter do login, storage.onChanged em src/auth, executeScript na captura,
// tabs.create no background.ts), e os canais laterais ficam proibidos em todo o src/, inclusive nesses arquivos.
// F1-EXT-05b, 05b-1 (ADR-004 D10 B1): o painel não lê armazenamento, não importa a sessão, não navega e não tem rede.
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
  "src/entrypoints/sidepanel/partes/LintFixture.tsx",
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

const PANEL = ["src/panel/lint-fixture.ts", "src/entrypoints/sidepanel/LintFixture.tsx", "src/entrypoints/sidepanel/partes/LintFixture.tsx"];
const NOT_PANEL = ["src/messaging/lint-fixture.ts", "src/consent/lint-fixture.ts", "src/capture/lint-fixture.ts", BACKGROUND];
const IMPORT = "no-restricted-imports";

/** Uma forma por regra nova do B1; o caminho relativo serve aos dois diretórios do painel (o lint não resolve). */
const PANEL_FORMS: readonly Form[] = [
  // Armazenamento: o painel consegue ler storage.session (D10, "Fato que pesa"); a barreira é esta.
  ["browser.storage.session", 'export const f = () => browser.storage.session.get("trampo/sessao/v1");\n', PROP],
  ["chrome.storage.session", 'export const f = () => chrome.storage.session.get("trampo/sessao/v1");\n', PROP],
  ['browser["storage"]', 'export const f = () => browser["storage"].session.get("k");\n', PROP],
  ["desestruturação de storage", 'const { storage } = browser;\nexport const f = () => storage.session.get("k");\n', PROP],
  ["indexedDB", 'export const f = () => indexedDB.open("x");\n', GLOBAL],
  ["window.indexedDB", 'export const f = () => window.indexedDB.open("x");\n', PROP],
  ["caches", 'export const f = () => caches.open("x");\n', GLOBAL],
  ["self.caches", 'export const f = () => self.caches.open("x");\n', PROP],
  ["localStorage", 'export const f = () => localStorage.getItem("k");\n', GLOBAL],
  ["window.sessionStorage", 'export const f = () => window.sessionStorage.getItem("k");\n', PROP],
  // Navegação e canais que a CSP não barra (B4): o lint os barra no código-fonte.
  ["window.open", 'export const f = () => window.open("https://x.test");\n', PROP],
  ["globalThis.open", 'export const f = () => globalThis.open("https://x.test");\n', PROP],
  ["self.open", 'export const f = () => self.open("https://x.test");\n', PROP],
  ["open solto", 'export const f = () => open("https://x.test");\n', GLOBAL],
  ["document.open", "export const f = () => document.open();\n", PROP],
  ["location.href =", 'export const f = () => {\n  location.href = "https://x.test";\n};\n', GLOBAL],
  ["location.assign", 'export const f = () => location.assign("https://x.test");\n', GLOBAL],
  ["window.location", 'export const f = () => {\n  window.location.href = "https://x.test";\n};\n', PROP],
  ["document.location", 'export const f = () => document.location.replace("https://x.test");\n', PROP],
  ["browser.tabs", "export const f = () => browser.tabs.query({});\n", PROP],
  ["chrome.tabs", 'export const f = () => chrome.tabs.update({ url: "https://x.test" });\n', PROP],
  ["desestruturação de tabs", "const { tabs } = browser;\nexport const f = () => tabs.query({});\n", PROP],
  ["runtime.setUninstallURL", 'export const f = () => browser.runtime.setUninstallURL("https://x.test");\n', PROP],
  ["RTCPeerConnection", "export const f = () => new RTCPeerConnection();\n", GLOBAL],
  ["window.RTCPeerConnection", "export const f = () => new window.RTCPeerConnection();\n", PROP],
  ["webkitRTCPeerConnection", "export const f = () => new webkitRTCPeerConnection();\n", GLOBAL],
  ["form.submit", "export const f = (form: HTMLFormElement) => form.submit();\n", PROP],
  ["form.requestSubmit", "export const f = (form: HTMLFormElement) => form.requestSubmit();\n", PROP],
  // Módulos do Service Worker: nem por import estático, nem de tipo, nem reexportado, nem dinâmico.
  ["import de src/auth", 'import { createWorkerAuth } from "../../auth/worker-auth";\nexport const f = createWorkerAuth;\n', IMPORT],
  ["import de tipo de src/auth", 'import type { AuthService } from "../../auth/auth-service";\nexport type T = AuthService;\n', IMPORT],
  ["import do diretório auth", 'import * as a from "../../auth";\nexport const b = a;\n', IMPORT],
  ["reexport de src/auth", 'export { createWorkerAuth } from "../../auth/worker-auth";\n', IMPORT],
  ["import de src/api", 'import { createApiClient } from "../../api/api-client";\nexport const f = createApiClient;\n', IMPORT],
  ["import do session-store", 'import { sessionStore } from "../../messaging/session-store";\nexport const f = sessionStore;\n', IMPORT],
  ["import do session-store com extensão", 'import { sessionStore } from "../messaging/session-store.ts";\nexport const f = sessionStore;\n', IMPORT],
  ["import() dinâmico", 'export const f = () => import("../../messaging/protocol");\n', SYNTAX],
];

describe("lint B1: o painel não lê armazenamento, não importa a sessão e não navega (ADR-004 D10 B1)", () => {
  beforeAll(async () => {
    await ruleHits("export {};", PANEL[0] as string);
  }, 60_000);

  test.each(outside(PANEL_FORMS, PANEL))("%s: %s é recusado", async (file, _f, code, rule) => {
    expect(await ruleHits(code, file)).toContain(rule);
  });

  test.each(PANEL)("%s: o que o painel usa segue liberado", async (file) => {
    // A porta, o protocolo, o contrato público (o /api dos contratos não é o src/api) e um módulo vizinho com "auth" no nome.
    const ok = [
      'import { PANEL_PORT_NAME } from "../../messaging/protocol";\nexport const f = () => browser.runtime.connect({ name: PANEL_PORT_NAME });\n',
      'import type { ApiError } from "@trampo/contracts/api";\nexport type E = ApiError;\n',
      'import { texto } from "./authoring";\nimport { api } from "./api-texts";\nexport const f = () => [texto, api];\n',
      "export const f = (e: { preventDefault(): void }) => e.preventDefault();\n",
    ];
    for (const code of ok) expect(await ruleHits(code, file), code).toStrictEqual([]);
  });

  test.each(NOT_PANEL)("%s: fora do painel, storage.session e tabs seguem nas regras de antes", async (file) => {
    const hits = await ruleHits('export const f = () => browser.storage.session.get("k");\n', file);
    expect(hits).toStrictEqual([]);
    expect(await ruleHits("export const f = () => indexedDB.open(\"x\");\n", file)).toStrictEqual([]);
  });

  test.each(PANEL)("%s: as regras do painel não apagam as outras (a regra não se acumula entre blocos)", async (file) => {
    // B2 (rede e canais), os contratos, os aliases, o HTML e o storage fora de session.
    expect(await ruleHits('export const f = () => fetch("https://x.test");\n', file)).toContain(GLOBAL);
    expect(await ruleHits("export const f = () => new WebSocket(\"wss://x.test\");\n", file)).toContain(GLOBAL);
    expect(await ruleHits('export const f = () => browser.runtime.sendMessage({ kind: "x" });\n', file)).toContain(PROP);
    expect(await ruleHits('export const f = () => browser.identity.getRedirectURL("auth");\n', file)).toContain(PROP);
    expect(await ruleHits('export const f = () => browser.tabs.create({ url: "https://x.test" });\n', file)).toContain(SYNTAX);
    expect(await ruleHits('import { AuthCodeSchema } from "@trampo/contracts/auth";\nexport const s = AuthCodeSchema;\n', file)).toContain(IMPORT);
    expect(await ruleHits('import * as c from "@trampo/contracts";\nexport const s = c;\n', file)).toContain(IMPORT);
    expect(await ruleHits('import * as a from "@/messaging/protocol";\nexport const b = a;\n', file)).toContain(IMPORT);
    expect(await ruleHits("export const f = (e: Element) => {\n  e.innerHTML = \"x\";\n};\n", file)).toContain(SYNTAX);
    expect(await ruleHits('export const f = () => browser.storage.local.get("k");\n', file)).toContain(SYNTAX);
  });

  test("no .tsx do painel, link e atributo que navega seguem proibidos", async () => {
    const hits = await ruleHits('export const F = () => <a href="https://x.test">x</a>;\n', "src/entrypoints/sidepanel/partes/LintFixture.tsx");
    expect(hits.filter((rule) => rule === SYNTAX)).toHaveLength(2);
  });

  test("os testes ficam fora do B1 (o E2E lê o storage e abre abas pelo CDP)", async () => {
    for (const [, code, rule] of PANEL_FORMS.filter(([, , rule]) => rule !== IMPORT)) {
      expect(await ruleHits(code, "test/lint-fixture.test.ts"), code).not.toContain(rule);
    }
  });
});
