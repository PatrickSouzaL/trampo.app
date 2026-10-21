// F1-DOM-02: fixture negativa da regra do ADR-002 §5.1 (APPSEC). Em src/domain/scoring, string vinda dos
// fatos só entra por igualdade exata contra lista fechada; nada de busca em string, regex ou console.
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, test } from "vitest";

const cwd = fileURLToPath(new URL("../..", import.meta.url));
const eslint = new ESLint({ cwd });

async function ruleHits(code: string, filePath = "src/domain/scoring/lint-fixture.ts"): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? "parse");
}

const NEGATIVE: readonly (readonly [string, string])[] = [
  ["includes", "export const f = (s: string): boolean => s.includes('java');"],
  ["startsWith", "export const f = (s: string): boolean => s.startsWith('ja');"],
  ["endsWith", "export const f = (s: string): boolean => s.endsWith('va');"],
  ["indexOf", "export const f = (s: string): boolean => s.indexOf('a') >= 0;"],
  ["lastIndexOf", "export const f = (s: string): boolean => s.lastIndexOf('a') >= 0;"],
  ["search", "export const f = (s: string): number => s.search('a');"],
  ["match", "export const f = (s: string): unknown => s.match('a');"],
  ["matchAll", "export const f = (s: string): unknown => s.matchAll(/a/g);"],
  ["replace", "export const f = (s: string): string => s.replace('a', '');"],
  ["replaceAll", "export const f = (s: string): string => s.replaceAll('a', '');"],
  ["split", "export const f = (s: string): string[] => s.split(' ');"],
  ["localeCompare", "export const f = (a: string, b: string): boolean => a.localeCompare(b) === 0;"],
  ["referência sem chamada", "const s = 'x'; export const f = s.includes;"],
  ["chave computada literal", "export const f = (s: string): boolean => s['includes']('x');"],
  ["regex literal", "export const r = /java/i;"],
  ["new RegExp", "export const f = (s: string): boolean => new RegExp('java').exec(s) !== null;"],
  ["RegExp()", "export const r = RegExp('java');"],
  ["array includes", "export const f = (xs: readonly string[], x: string): boolean => xs.includes(x);"],
];

describe("lint de domain/scoring (ADR-002 §5.1)", () => {
  // Carregar a configuração (typescript-eslint e presets) custa segundos na primeira chamada, mais que o
  // timeout padrão por teste quando a suíte inteira disputa CPU.
  beforeAll(async () => {
    await ruleHits("export {};");
  }, 60_000);

  test.each(NEGATIVE)("recusa %s", async (_name, code) => {
    expect(await ruleHits(code)).toContain("no-restricted-syntax");
  });

  test("recusa console (o motor não tem logger)", async () => {
    expect(await ruleHits("export const f = (): void => { console.log('x'); };")).toContain("no-console");
  });

  test("mantém a pureza do domínio no mesmo bloco (a regra não se acumula)", async () => {
    expect(await ruleHits("export const d = new Date();")).toContain("no-restricted-syntax");
    expect(await ruleHits("export const m = () => import('./x.js');")).toContain("no-restricted-syntax");
  });

  test("aceita igualdade por Set.has e ===, e normalização sem busca", async () => {
    const code = [
      "const accepted = new Set(['java', 'go']);",
      "export const f = (s: string): boolean => accepted.has(s.toLowerCase()) || s === 'rust';",
      "export const g = (s: string): string => s.normalize('NFKC');",
    ].join("\n");
    expect(await ruleHits(code)).toEqual([]);
  });

  test("fora de domain/scoring a regra não se aplica", async () => {
    expect(await ruleHits("export const f = (s: string): boolean => s.includes('x');", "src/domain/fusion/lint-fixture.ts")).toEqual([]);
  });
});
