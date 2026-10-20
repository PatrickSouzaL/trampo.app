import { JOB_TEXT_MAX_CHARS, JOB_TEXT_MIN_CHARS } from '@trampo/contracts';
import { CaseCategorySchema, lengthTag, type CaseCategory } from './case-schema.js';
import { loadCases, validCase } from './load-cases.js';
import { countCodePoints, findPii, hasForbiddenInvisible, hasRawHeaderLeftover } from './text-checks.js';

/*
 * Portão do golden dataset (golden-dataset-spec gd1, §9). Devolve a lista de problemas com o id do
 * caso e o código da regra, nunca o trecho do texto (que poderia ser dado pessoal).
 */

export type Problem =
  | 'arquivo_sem_par'
  | 'json_invalido'
  | 'schema_invalido'
  | 'id_diferente_do_arquivo'
  | 'id_duplicado'
  | 'pasta_incoerente_com_sintetico'
  | 'texto_curto_demais'
  | 'texto_longo_demais'
  | `pii_${'email' | 'telefone' | 'cpf' | 'cnpj' | 'url'}`
  | 'invisivel_fora_de_injection_oculta'
  | 'cabecalho_do_raw_no_texto'
  | 'categoria_com_menos_de_2_casos'
  | 'canary_duplicado'
  | 'tag_de_tamanho_incoerente';

export interface Finding {
  readonly where: string;
  readonly problem: Problem;
}

export const MIN_CASES_PER_CATEGORY = 2;

export interface DatasetReport {
  readonly findings: Finding[];
  readonly totals: { readonly cases: number; readonly byCategory: Readonly<Record<CaseCategory, number>> };
}

export function validateDataset(casesRoot: string, options: { checkCoverage?: boolean } = {}): DatasetReport {
  const { cases, orphans } = loadCases(casesRoot);
  const findings: Finding[] = orphans.map((where) => ({ where, problem: 'arquivo_sem_par' }));
  const byCategory = Object.fromEntries(CaseCategorySchema.options.map((c) => [c, 0])) as Record<CaseCategory, number>;
  const seenIds = new Set<string>();
  const seenCanaries = new Set<string>();

  for (const loaded of cases) {
    const where = `${loaded.dir}/${loaded.fileId}`;
    const add = (problem: Problem): void => {
      findings.push({ where, problem });
    };

    // PII vale para os DOIS arquivos, mesmo que o JSON esteja inválido (§7).
    for (const kind of new Set([...findPii(loaded.text), ...findPii(loaded.rawJson)])) add(`pii_${kind}`);
    if (hasRawHeaderLeftover(loaded.text)) add('cabecalho_do_raw_no_texto');
    const length = countCodePoints(loaded.text);
    if (length < JOB_TEXT_MIN_CHARS) add('texto_curto_demais');
    if (length > JOB_TEXT_MAX_CHARS) add('texto_longo_demais');

    if (loaded.parsed === null) {
      add('json_invalido');
      continue;
    }
    const c = validCase(loaded);
    if (c === null) {
      add('schema_invalido');
      continue;
    }
    if (c.id !== loaded.fileId) add('id_diferente_do_arquivo');
    if (seenIds.has(c.id)) add('id_duplicado');
    seenIds.add(c.id);
    if (c.synthetic !== (loaded.dir === 'synthetic')) add('pasta_incoerente_com_sintetico');
    if (c.category !== 'injection_oculta' && hasForbiddenInvisible(loaded.text)) {
      add('invisivel_fora_de_injection_oculta');
    }
    const expectedLength = lengthTag(countCodePoints(loaded.text.replaceAll('\r\n', '\n')));
    for (const tag of ['curta', 'longa'] as const) {
      if (c.tags.includes(tag) !== (expectedLength === tag)) add('tag_de_tamanho_incoerente');
    }
    if (c.injection !== null) {
      if (seenCanaries.has(c.injection.canary)) add('canary_duplicado');
      seenCanaries.add(c.injection.canary);
    }
    byCategory[c.category] += 1;
  }

  if (options.checkCoverage !== false) {
    for (const category of CaseCategorySchema.options) {
      if (byCategory[category] < MIN_CASES_PER_CATEGORY) {
        findings.push({ where: `categoria/${category}`, problem: 'categoria_com_menos_de_2_casos' });
      }
    }
  }
  return { findings, totals: { cases: cases.length, byCategory } };
}

/** Mensagem do schema sem o valor recebido: só caminho e código, para o log do teste não ecoar texto. */
export function schemaIssues(casesRoot: string, fileId: string): string[] {
  const loaded = loadCases(casesRoot).cases.find((c) => c.fileId === fileId);
  if (loaded?.parsed == null || loaded.parsed.success) return [];
  return loaded.parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}
