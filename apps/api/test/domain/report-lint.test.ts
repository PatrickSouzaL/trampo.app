// F1-DOM-03: fixture negativa da regra do ADR-012 D7 (APPSEC). Em src/domain/report, nenhum texto sai de campo
// livre dos fatos ou do perfil, UserCriteria não entra, e valem as proibições do motor (busca, regex, console).
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, test } from "vitest";

const cwd = fileURLToPath(new URL("../..", import.meta.url));
const eslint = new ESLint({ cwd });

async function ruleHits(code: string, filePath = "src/domain/report/lint-fixture.ts"): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? "parse");
}

const FREE_TEXT: readonly (readonly [string, string])[] = [
  ["título", "export const f = (x: { title: string }): string => x.title;"],
  ["cidade", "export const f = (x: { city: string }): string => x.city;"],
  ["país", "export const f = (x: { countryIso2: string }): string => x.countryIso2;"],
  ["stack exigida", "export const f = (x: { stackRequired: string[] }): string[] => x.stackRequired;"],
  ["stack desejável", "export const f = (x: { stackNiceToHave: string[] }): string[] => x.stackNiceToHave;"],
  ["observações", "export const f = (x: { notes: string }): string => x.notes;"],
  ["pretensão", "export const f = (x: { minimum: number }): number => x.minimum;"],
  ["cidades aceitas", "export const f = (x: { acceptedCities: string[] }): string[] => x.acceptedCities;"],
  ["UFs aceitas", "export const f = (x: { acceptedUfs: string[] }): string[] => x.acceptedUfs;"],
  ["must-have", "export const f = (x: { mustHave: string[] }): string[] => x.mustHave;"],
  ["nice-to-have", "export const f = (x: { niceToHave: string[] }): string[] => x.niceToHave;"],
  ["deal-breakers", "export const f = (x: { dealBreakers: string[] }): string[] => x.dealBreakers;"],
  ["chave computada", "export const f = (x: Record<string, string>): string | undefined => x['title'];"],
  ["desestruturação", "export const f = ({ title }: { title: string }): string => title;"],
  ["desestruturação com chave literal", "export const f = ({ 'city': c }: { city: string }): string => c;"],
  ["import de UserCriteria", "import type { UserCriteria } from '@trampo/contracts';\nexport type X = UserCriteria;"],
  ["import de UserCriteriaSchema", "import type { UserCriteriaSchema } from '@trampo/contracts';\nexport type X = typeof UserCriteriaSchema;"],
];

const INHERITED: readonly (readonly [string, string])[] = [
  ["includes", "export const f = (s: string): boolean => s.includes('x');"],
  ["replace", "export const f = (s: string): string => s.replace('a', 'b');"],
  ["regex literal", "export const r = /x/;"],
  ["new RegExp", "export const r = new RegExp('x');"],
  ["relógio", "export const d = new Date();"],
];

describe("lint de domain/report (ADR-012 D7)", () => {
  beforeAll(async () => {
    await ruleHits("export {};");
  }, 60_000);

  test.each(FREE_TEXT)("recusa %s", async (_name, code) => {
    expect(await ruleHits(code)).toContain("no-restricted-syntax");
  });

  test.each(INHERITED)("mantém a proibição herdada: %s", async (_name, code) => {
    expect(await ruleHits(code)).toContain("no-restricted-syntax");
  });

  test("recusa console", async () => {
    expect(await ruleHits("export const f = (): void => { console.log('x'); };")).toContain("no-console");
  });

  test("aceita concatenação de rótulos de enum, join, filter e Set.has", async () => {
    const code = [
      "const labels: Readonly<Record<string, string>> = { remoto: 'remoto' };",
      "const order = ['remoto'];",
      "export const f = (present: readonly string[]): string => {",
      "  const set = new Set(present);",
      "  return `Na vaga: ${order.filter((v) => set.has(v)).map((v) => labels[v]).join(', ')}.`;",
      "};",
    ].join("\n");
    expect(await ruleHits(code)).toEqual([]);
  });

  test("fora de domain/report a regra de texto livre não se aplica", async () => {
    expect(await ruleHits("export const f = (x: { title: string }): string => x.title;", "src/domain/fusion/lint-fixture.ts")).toEqual([]);
  });
});
