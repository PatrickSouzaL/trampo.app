import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schemaIssues, validateDataset } from '../src/validate-dataset.js';

/*
 * O portão do dataset versionado (golden-dataset-spec gd1, §9). Roda em todo `pnpm test`:
 * caso inválido, PII, invisível fora de lugar ou categoria sem cobertura derrubam o build.
 */

const CASES_ROOT = fileURLToPath(new URL('../golden/cases', import.meta.url));

describe('golden dataset versionado', () => {
  const report = validateDataset(CASES_ROOT);

  it('não tem nenhum achado do validador', () => {
    const detail = report.findings.map((f) => {
      const id = f.where.split('/')[1] ?? '';
      const issues = f.problem === 'schema_invalido' ? ` -> ${schemaIssues(CASES_ROOT, id).join(' | ')}` : '';
      return `${f.where}: ${f.problem}${issues}`;
    });
    expect(detail).toEqual([]);
  });

  it('tem pelo menos as 63 vagas reais dos lotes HITL-003 e HITL-017', () => {
    expect(report.totals.cases).toBeGreaterThanOrEqual(63);
  });
});
