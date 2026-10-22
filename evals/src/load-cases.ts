import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoldenCaseSchema, type GoldenCase } from './case-schema.js';

/** As duas pastas versionadas (golden-dataset-spec §2). `raw/` nunca é lida aqui. */
export const CASE_DIRS = ['real', 'synthetic'] as const;
export type CaseDir = (typeof CASE_DIRS)[number];

export interface LoadedCase {
  readonly dir: CaseDir;
  readonly fileId: string;
  readonly text: string;
  /** Resultado do schema; `null` quando o JSON nem faz parse. */
  readonly parsed: ReturnType<typeof GoldenCaseSchema.safeParse> | null;
  readonly rawJson: string;
}

export interface LoadResult {
  readonly cases: LoadedCase[];
  /** Arquivos sem par (`.case.json` sem `.job.txt` ou o contrário) e arquivos com extensão estranha. */
  readonly orphans: string[];
}

const CASE_SUFFIX = '.case.json';
const TEXT_SUFFIX = '.job.txt';

export function loadCases(casesRoot: string): LoadResult {
  const cases: LoadedCase[] = [];
  const orphans: string[] = [];
  for (const dir of CASE_DIRS) {
    const files = readdirSync(join(casesRoot, dir));
    const ids = new Set<string>();
    for (const f of files) {
      if (f.endsWith(CASE_SUFFIX)) ids.add(f.slice(0, -CASE_SUFFIX.length));
      else if (f.endsWith(TEXT_SUFFIX)) ids.add(f.slice(0, -TEXT_SUFFIX.length));
      else if (f !== '.gitkeep') orphans.push(`${dir}/${f}`);
    }
    for (const id of [...ids].sort()) {
      const hasCase = files.includes(id + CASE_SUFFIX);
      const hasText = files.includes(id + TEXT_SUFFIX);
      if (!hasCase || !hasText) {
        orphans.push(`${dir}/${id}`);
        continue;
      }
      const rawJson = readFileSync(join(casesRoot, dir, id + CASE_SUFFIX), 'utf8');
      const text = readFileSync(join(casesRoot, dir, id + TEXT_SUFFIX), 'utf8');
      cases.push({ dir, fileId: id, text, rawJson, parsed: parseJson(rawJson) });
    }
  }
  return { cases, orphans };
}

function parseJson(raw: string): LoadedCase['parsed'] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return GoldenCaseSchema.safeParse(value);
}

export function validCase(c: LoadedCase): GoldenCase | null {
  return c.parsed?.success === true ? c.parsed.data : null;
}
