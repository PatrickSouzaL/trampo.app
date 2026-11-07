// F1-API-07, commit 07a (ADR-004 §6.1 e §6.3; emenda ao ADR-013 D3): o teto do access token tem fonte única, o
// `ACCESS_TOKEN_MAX_CHARS` de @trampo/contracts/limits (F1-AUTH-00). A borda, o CriteriaGuard e o cliente do
// PostgREST usam esse valor, e o `src/` da API não guarda mais nenhum literal dele. Os dois `8_192` que sobram são
// outros limites (saída do LLM e normalização da telemetria), listados por nome.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { AccessTokenSchema } from "@trampo/contracts/auth";
import { ACCESS_TOKEN_MAX_CHARS } from "@trampo/contracts/limits";
import { describe, expect, test } from "vitest";

import { CRITERIA_GUARD_POLICY } from "../src/application/criteria/criteria-guard.js";
import { POSTGREST_CLIENT_POLICY } from "../src/infrastructure/supabase/postgrest-user-client.js";
import { bearerToken } from "../src/presentation/edge/auth.js";

const API_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(API_ROOT, "src");

/** Os três lugares do ADR-004 D7 (comentário do snippet) e do §6.1. */
const TOKEN_CEILING_SITES = [
  "src/presentation/edge/auth.ts",
  "src/application/criteria/criteria-guard.ts",
  "src/infrastructure/supabase/postgrest-user-client.ts",
] as const;

/** Os `8_192` que não são o teto do token (ADR-004 §6.1, emenda do HITL-035). */
const OTHER_8192_LIMITS = ["src/application/llm/llm-output-guard.ts", "src/application/ports/telemetry.ts"] as const;

// 8192 em qualquer grafia numérica que um literal poderia usar: decimal com ou sem separador, hexadecimal, a conta
// 8 * 1024 e a potência 2 ** 13.
const LITERAL_8192 = /\b8_?192\b|\b0x0*2000\b|\b8\s*\*\s*1_?024\b|\b1_?024\s*\*\s*8\b|\b2\s*\*\*\s*13\b/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const relativePath = (path: string): string => relative(API_ROOT, path).split(sep).join("/");
const read = (path: string): string => readFileSync(join(API_ROOT, path), "utf8");

describe("teto do access token com fonte única (07a)", () => {
  test("o contrato fixa 8.192 caracteres (ADR-013 D3)", () => {
    expect(ACCESS_TOKEN_MAX_CHARS).toBe(8_192);
  });

  test("CriteriaGuard e cliente do PostgREST usam o valor do contrato", () => {
    expect(CRITERIA_GUARD_POLICY.accessTokenMaxChars).toBe(ACCESS_TOKEN_MAX_CHARS);
    expect(POSTGREST_CLIENT_POLICY.accessTokenMaxChars).toBe(ACCESS_TOKEN_MAX_CHARS);
  });

  test("a borda aceita exatamente o maior token do contrato e recusa um caractere a mais", () => {
    const atLimit = `${"a".repeat(ACCESS_TOKEN_MAX_CHARS - 4)}.b.c`;
    expect(AccessTokenSchema.safeParse(atLimit).success).toBe(true);
    expect(bearerToken(`Bearer ${atLimit}`)).toBe(atLimit);
    const overLimit = `a${atLimit}`;
    expect(AccessTokenSchema.safeParse(overLimit).success).toBe(false);
    expect(bearerToken(`Bearer ${overLimit}`)).toBeNull();
  });

  test.each(TOKEN_CEILING_SITES)("%s importa o teto de @trampo/contracts/limits", (path) => {
    const source = read(path);
    expect(source).toMatch(/^import \{[^}]*\bACCESS_TOKEN_MAX_CHARS\b[^}]*\} from "@trampo\/contracts\/limits";$/m);
    expect(source).not.toMatch(/\bexport const ACCESS_TOKEN_MAX_CHARS\b/);
  });

  test("nenhum literal 8192 sobra no src/ fora dos dois limites alheios", () => {
    const withLiteral = sourceFiles(SRC)
      .filter((path) => LITERAL_8192.test(readFileSync(path, "utf8")))
      .map(relativePath)
      .sort();
    expect(withLiteral).toEqual([...OTHER_8192_LIMITS].sort());
  });

  test("o detector de literal pega as grafias que ele promete", () => {
    for (const literal of ["8192", "8_192", "0x2000", "0X2000", "8 * 1024", "8*1_024", "1024 * 8", "2 ** 13"]) {
      expect(LITERAL_8192.test(`const x = ${literal};`), literal).toBe(true);
    }
    for (const other of ["81920", "18192", "8_1920", "4096", "16_384"]) {
      expect(LITERAL_8192.test(`const x = ${other};`), other).toBe(false);
    }
  });
});
