// F1-EXT-05a (ADR-004 D10 B3; contratos-zod §2, F-02): fixtures negativas da fronteira de import.
// O subpath @trampo/contracts/auth só entra em src/auth e src/api (e nos testes); o resto da extensão,
// painel e extrator inclusive, nunca vê os contratos da sessão.
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, test } from "vitest";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd });

async function ruleHits(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? "parse");
}

const AUTH_IMPORT = 'import { AuthCodeSchema } from "@trampo/contracts/auth";\nexport const s = AuthCodeSchema;\n';
const TYPE_IMPORT = 'import type { AuthSessionResponse } from "@trampo/contracts/auth";\nexport type T = AuthSessionResponse;\n';

describe("fronteira do @trampo/contracts/auth (ADR-004 D10 B3)", () => {
  // Carregar a configuração (typescript-eslint e presets) custa segundos na primeira chamada.
  beforeAll(async () => {
    await ruleHits("export {};", "src/auth/lint-fixture.ts");
  }, 60_000);

  test.each([
    "src/panel/lint-fixture.ts",
    "src/entrypoints/sidepanel/LintFixture.tsx",
    "src/extraction/lint-fixture.ts",
    "src/capture/lint-fixture.ts",
    "src/consent/lint-fixture.ts",
    "src/messaging/lint-fixture.ts",
    "src/entrypoints/background.ts",
  ])("recusa o import em %s, de valor e de tipo", async (filePath) => {
    expect(await ruleHits(AUTH_IMPORT, filePath)).toContain("no-restricted-imports");
    expect(await ruleHits(TYPE_IMPORT, filePath)).toContain("no-restricted-imports");
  });

  test.each(["src/auth/lint-fixture.ts", "src/api/lint-fixture.ts", "test/lint-fixture.test.ts"])("aceita em %s", async (filePath) => {
    expect(await ruleHits(AUTH_IMPORT, filePath)).not.toContain("no-restricted-imports");
  });

  test("em src/auth, a raiz, o user-criteria e os aliases do WXT seguem proibidos (a regra não se acumula)", async () => {
    const filePath = "src/auth/lint-fixture.ts";
    expect(await ruleHits('import { z } from "@trampo/contracts";\nexport const a = z;\n', filePath)).toContain("no-restricted-imports");
    expect(await ruleHits('import * as u from "@trampo/contracts/user-criteria";\nexport const a = u;\n', filePath)).toContain("no-restricted-imports");
    expect(await ruleHits('import * as a from "@/auth/pkce";\nexport const b = a;\n', filePath)).toContain("no-restricted-imports");
    expect(await ruleHits('import * as a from "@trampo/contracts/auth/x";\nexport const b = a;\n', filePath)).toContain("no-restricted-imports");
  });

  test("em src/auth, os seletores de storage e de HTML continuam valendo", async () => {
    const filePath = "src/auth/lint-fixture.ts";
    expect(await ruleHits("export const f = () => browser.storage.local.get('k');\n", filePath)).toContain("no-restricted-syntax");
    expect(await ruleHits("export const f = (e: Element) => { e.innerHTML = 'x'; };\n", filePath)).toContain("no-restricted-syntax");
  });
});
