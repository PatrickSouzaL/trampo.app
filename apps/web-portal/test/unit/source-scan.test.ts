// Fronteiras escritas como regra no ADR-027 (condição 10) e no ADR-028 (D11 e condição 12), agora com prova: nenhum
// "use client" em `src/` (o portal não tem JS de cliente nesta fase) e nenhum `console.` em `src/server` (SR-12).
// Cada "0" tem controle positivo: o mesmo detector acha a diretiva e a chamada plantadas.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.(ts|tsx|mts|cts|js|jsx|mjs)$/.test(name))
    .map((name) => join(dir, name));
}

/** A diretiva "use client" (aspas simples ou duplas) numa linha própria, como o Next a lê. */
const USE_CLIENT_LINE = /^["']use client["'];?$/;
const USE_CLIENT = { test: (text: string): boolean => text.split("\n").some((line) => USE_CLIENT_LINE.test(line.trim())) };
/** Qualquer acesso ao console: `console.log`, `console["log"]`, `globalThis.console`. */
const CONSOLE = /\bconsole\s*(\.|\[)|globalThis\s*\.\s*console\b/;

describe("varredura do código do portal (ADR-028 D11)", () => {
  it("nenhum 'use client' em src/", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(10);
    const found = files.filter((file) => USE_CLIENT.test(readFileSync(file, "utf8"))).map((file) => relative(SRC, file));
    expect(found).toEqual([]);
  });

  it("nenhum console em src/server", () => {
    const files = sources(join(SRC, "server"));
    expect(files.length).toBeGreaterThan(5);
    const found = files.filter((file) => CONSOLE.test(readFileSync(file, "utf8"))).map((file) => relative(SRC, file));
    expect(found).toEqual([]);
  });

  it("controle positivo: o detector acha o que foi plantado", () => {
    for (const planted of ['"use client";\nexport {}', "'use client'\n", '  "use client"  \n']) expect(USE_CLIENT.test(planted), planted).toBe(true);
    expect(USE_CLIENT.test('const x = "use client inline";')).toBe(false);
    for (const planted of ["console.log(x)", 'console["error"](x)', "globalThis.console.info(x)", "console .warn(x)"]) expect(CONSOLE.test(planted), planted).toBe(true);
    expect(CONSOLE.test("const consoleless = 1;")).toBe(false);
  });
});
