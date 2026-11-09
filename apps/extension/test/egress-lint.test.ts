// F1-EXT-05a, 05a-2 (ADR-004 D10 B2 e §4.1): fixtures negativas da regra "fetch só no api-client". Cada
// forma de alcançar o fetch, e cada outro canal de rede, precisa falhar fora de src/api/api-client.ts.
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, test } from "vitest";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd });

async function ruleHits(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? "parse");
}

const FETCH_FORMS: ReadonlyArray<readonly [string, string, string]> = [
  ["global", 'export const f = () => fetch("https://x.test");\n', "no-restricted-globals"],
  ["referência solta", "export const f = fetch;\n", "no-restricted-globals"],
  ["globalThis.fetch", 'export const f = () => globalThis.fetch("https://x.test");\n', "no-restricted-properties"],
  ["self.fetch", 'export const f = () => self.fetch("https://x.test");\n', "no-restricted-properties"],
  ['globalThis["fetch"]', 'export const f = () => globalThis["fetch"]("https://x.test");\n', "no-restricted-properties"],
  ["desestruturação", "const { fetch: f } = globalThis;\nexport { f };\n", "no-restricted-properties"],
];

const OTHER_CHANNELS: ReadonlyArray<readonly [string, string, string]> = [
  ["XMLHttpRequest", "export const x = new XMLHttpRequest();\n", "no-restricted-globals"],
  ["WebSocket", 'export const x = new WebSocket("wss://x.test");\n', "no-restricted-globals"],
  ["EventSource", 'export const x = new EventSource("https://x.test");\n', "no-restricted-globals"],
  ["sendBeacon", 'export const x = () => navigator.sendBeacon("https://x.test");\n', "no-restricted-properties"],
];

describe("lint B2: fetch só no api-client (ADR-004 D10)", () => {
  // Carregar a configuração (typescript-eslint e presets) custa segundos na primeira chamada.
  beforeAll(async () => {
    await ruleHits("export {};", "src/api/api-client.ts");
  }, 60_000);

  const OUTSIDE = [
    "src/auth/lint-fixture.ts",
    "src/api/outro-cliente.ts",
    "src/entrypoints/background.ts",
    "src/messaging/lint-fixture.ts",
    "src/capture/lint-fixture.ts",
    "src/panel/lint-fixture.ts",
    "src/entrypoints/sidepanel/LintFixture.tsx",
  ];

  test.each(OUTSIDE.flatMap((file) => FETCH_FORMS.map(([form, code, rule]) => [file, form, code, rule] as const)))(
    "%s: fetch por %s é recusado",
    async (file, _form, code, rule) => {
      expect(await ruleHits(code, file)).toContain(rule);
    },
  );

  test.each(FETCH_FORMS)("no api-client, fetch por %s passa", async (_form, code, rule) => {
    expect(await ruleHits(code, "src/api/api-client.ts")).not.toContain(rule);
  });

  test.each([...OUTSIDE, "src/api/api-client.ts"].flatMap((file) => OTHER_CHANNELS.map(([channel, code, rule]) => [file, channel, code, rule] as const)))(
    "%s: %s é recusado, inclusive no api-client",
    async (file, _channel, code, rule) => {
      expect(await ruleHits(code, file)).toContain(rule);
    },
  );

  test("os testes ficam fora da regra (o E2E usa fetch contra o servidor de teste)", async () => {
    expect(await ruleHits('export const f = () => fetch("https://x.test");\n', "test/lint-fixture.test.ts")).not.toContain("no-restricted-globals");
  });

  test("a regra não apaga as outras do api-client: storage fora de session segue proibido", async () => {
    expect(await ruleHits("export const f = () => browser.storage.local.get('k');\n", "src/api/api-client.ts")).toContain("no-restricted-syntax");
  });
});
