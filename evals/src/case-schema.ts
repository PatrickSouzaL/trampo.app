import { z } from 'zod';
import { PlatformSchema, ResolvedJobFactsSchema, jobFactsShape } from '@trampo/contracts';

/*
 * Schema de um caso do golden dataset (golden-dataset-spec gd1, §3).
 * `expected` é a saída IDEAL do LLM no contrato v1: os 12 campos de `jobFactsShape`, sem
 * `extractionConfidence` e sem `salario_omitido` (que o código acrescenta depois da fusão, ADR-011).
 */

/** v2 (2026-10-21): `contractGaps` saiu, porque o ADR-002 §8.1 pôs ARS e `pressao_excessiva` no contrato. */
export const CASE_SCHEMA_VERSION = 2 as const;

export const CaseSourceSchema = z.enum(['linkedin', 'gupy', 'geekhunter', '99jobs', 'solides', 'sintetico']);
export const CaseBatchSchema = z.enum(['hitl-003', 'hitl-017', 'sintetico']);

export const CaseCategorySchema = z.enum([
  'normal',
  'ambigua',
  'injection_visivel',
  'injection_oculta',
  'controle_negativo',
  'armadilha_negacao',
]);
export type CaseCategory = z.infer<typeof CaseCategorySchema>;

export const CaseTagSchema = z.enum([
  'estresse',
  'fora_de_ti',
  'com_salario',
  'sem_salario',
  'moeda_estrangeira',
  'internacional',
  'salario_por_contrato',
  'salario_hora',
  'salario_ano',
  'so_pj',
  'clt_ou_pj',
  'estagio',
  'dupla_senioridade',
  'remoto',
  'remoto_ou_hibrido',
  'hibrido',
  'presencial',
  'conflito',
  'ingles',
  'curta',
  'longa',
  'red_flag',
  'multiplas_vagas',
]);

export const CaseTrapSchema = z.enum([
  'negacao',
  'diferencial',
  'termo_ambiguo',
  'ars_contem_r_cifrao',
  'conflito_modelo',
  'conflito_senioridade',
  'salario_por_contrato',
  'beneficio_com_valor',
  'anos_so_desejaveis',
  'stack_na_descricao_da_empresa',
  'texto_em_ingles',
  'multiplas_vagas',
]);

const count = z.int().min(0).max(1000);
export const AnonymizationCountsSchema = z.strictObject({
  pessoa: count,
  email: count,
  telefone: count,
  documento: count,
  url: count,
  empresa: count,
  endereco: count,
});

type FactField = keyof typeof jobFactsShape;
const FACT_FIELDS = Object.keys(jobFactsShape) as FactField[];

/** Cada alternativa é um valor COMPLETO do campo, validado pelo schema do próprio campo (§5.2). */
export const AlternativesSchema = z
  .record(z.string(), z.array(z.unknown()).min(1).max(6))
  .superRefine((alts, ctx) => {
    for (const [field, values] of Object.entries(alts)) {
      if (!FACT_FIELDS.includes(field as FactField)) {
        ctx.addIssue({ code: 'custom', message: 'alternativa_de_campo_desconhecido', path: [field] });
        continue;
      }
      const fieldSchema: z.ZodType = jobFactsShape[field as FactField];
      values.forEach((value, i) => {
        if (!fieldSchema.safeParse(value).success) {
          ctx.addIssue({ code: 'custom', message: 'alternativa_invalida', path: [field, i] });
        }
      });
    }
  });

export const InjectionMetaSchema = z.strictObject({
  technique: z.enum(['texto_visivel', 'unicode_tags', 'zero_width', 'bidi', 'variation_selectors']),
  goal: z.enum(['nota', 'fato', 'url', 'exfiltracao']),
  canary: z.string().regex(/^TRAMPO-CANARY-\d{2}$/),
});

const INJECTION_CATEGORIES: ReadonlySet<CaseCategory> = new Set(['injection_visivel', 'injection_oculta']);

export const GoldenCaseSchema = z
  .strictObject({
    caseSchemaVersion: z.literal(CASE_SCHEMA_VERSION),
    id: z.string().regex(/^(?:linkedin|gupy|geekhunter|99jobs|solides)-\d{2}$|^syn-\d{2}-[a-z0-9-]{3,40}$/),
    source: CaseSourceSchema,
    platform: PlatformSchema,
    batch: CaseBatchSchema,
    synthetic: z.boolean(),
    category: CaseCategorySchema,
    language: z.enum(['pt', 'en', 'es']),
    tags: z.array(CaseTagSchema).max(CaseTagSchema.options.length),
    traps: z.array(CaseTrapSchema).max(CaseTrapSchema.options.length),
    anonymization: AnonymizationCountsSchema,
    expected: ResolvedJobFactsSchema,
    alternatives: AlternativesSchema,
    injection: InjectionMetaSchema.nullable(),
    notes: z.string().max(400),
  })
  .superRefine((c, ctx) => {
    const issue = (message: string, path: PropertyKey[]): void => {
      ctx.addIssue({ code: 'custom', message, path });
    };
    if (new Set(c.tags).size !== c.tags.length) issue('tag_duplicada', ['tags']);
    if (new Set(c.traps).size !== c.traps.length) issue('armadilha_duplicada', ['traps']);

    // §6: sintético <=> id "syn-", lote, fonte e plataforma próprios.
    const synthId = c.id.startsWith('syn-');
    const synthMeta = c.batch === 'sintetico' && c.source === 'sintetico' && c.platform === 'texto_colado';
    if (c.synthetic !== synthId || c.synthetic !== synthMeta) issue('marcacao_de_sintetico_incoerente', ['synthetic']);
    if (!c.synthetic && !c.id.startsWith(`${c.source}-`)) issue('id_nao_bate_com_a_fonte', ['id']);

    // §4.1 e §6: injection só com metadado, e metadado só em injection.
    if (INJECTION_CATEGORIES.has(c.category) !== (c.injection !== null)) {
      issue('injection_sem_metadado_ou_metadado_sem_injection', ['injection']);
    }

    // §3: o código acrescenta `salario_omitido`; o LLM nunca deve.
    if (c.expected.redFlagSignals.includes('salario_omitido')) issue('salario_omitido_no_gabarito', ['expected']);

    // §5.1: vaga estrangeira nunca tem salário com `currency: null` (o motor não assume BRL, ADR-002 §4.2.3).
    const country = c.expected.location?.countryIso2 ?? null;
    if (c.expected.salary !== null && c.expected.salary.currency === null && country !== null && country !== 'BR') {
      issue('moeda_nula_em_vaga_internacional', ['expected', 'salary']);
    }

    const hasSalaryTag = c.tags.includes('com_salario');
    const salaryKnown = c.expected.salary !== null;
    if (hasSalaryTag !== salaryKnown || c.tags.includes('sem_salario') === salaryKnown) {
      issue('tag_de_salario_incoerente', ['tags']);
    }

    // §3: tags que o gabarito determina não podem divergir dele (a anotação foi feita por vários agentes).
    const derived = derivedTags(c);
    for (const tag of DERIVED_TAGS) {
      if (c.tags.includes(tag) !== derived.has(tag)) issue(`tag_derivada_incoerente:${tag}`, ['tags']);
    }
    if (c.tags.includes('remoto_ou_hibrido') && !(derived.has('remoto') && derived.has('hibrido'))) {
      issue('tag_derivada_incoerente:remoto_ou_hibrido', ['tags']);
    }
  });
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

type CaseTag = z.infer<typeof CaseTagSchema>;
type CaseShape = Pick<GoldenCase, 'batch' | 'expected'>;

/**
 * Tags calculadas do gabarito (golden-dataset-spec §3). As outras (`fora_de_ti`, `conflito`,
 * `remoto_ou_hibrido`, `salario_por_contrato`, `multiplas_vagas`) são julgamento do anotador;
 * `curta` e `longa` dependem do texto e são checadas pelo `validateDataset`.
 */
export const DERIVED_TAGS = [
  'estresse',
  'moeda_estrangeira',
  'internacional',
  'salario_hora',
  'salario_ano',
  'so_pj',
  'clt_ou_pj',
  'estagio',
  'dupla_senioridade',
  'remoto',
  'hibrido',
  'presencial',
  'ingles',
  'red_flag',
] as const satisfies readonly CaseTag[];

export function derivedTags(c: CaseShape): Set<CaseTag> {
  const f = c.expected;
  const currency = f.salary?.currency ?? null;
  const period = f.salary?.period ?? null;
  const country = f.location?.countryIso2 ?? null;
  const contracts = new Set(f.contractTypes);
  const tags = new Set<CaseTag>();
  const when = (cond: boolean, tag: CaseTag): void => {
    if (cond) tags.add(tag);
  };
  when(c.batch === 'hitl-017', 'estresse');
  when(currency !== null && currency !== 'BRL', 'moeda_estrangeira');
  when((country !== null && country !== 'BR') || (currency !== null && currency !== 'BRL'), 'internacional');
  when(period === 'hora', 'salario_hora');
  when(period === 'ano', 'salario_ano');
  when(contracts.size === 1 && contracts.has('pj'), 'so_pj');
  when(contracts.has('clt') && contracts.has('pj'), 'clt_ou_pj');
  when(contracts.has('estagio') || f.seniorityLevels.includes('estagio'), 'estagio');
  when(f.seniorityLevels.length >= 2, 'dupla_senioridade');
  for (const m of f.workModels) tags.add(m);
  when(f.languageRequirements.some((l) => l.language === 'ingles'), 'ingles');
  when(f.redFlagSignals.length > 0, 'red_flag');
  return tags;
}

/** `curta` e `longa` (§3), medidas com fim de linha LF para não depender do `core.autocrlf`. */
export function lengthTag(codePointsLf: number): 'curta' | 'longa' | null {
  if (codePointsLf < 1500) return 'curta';
  if (codePointsLf > 8000) return 'longa';
  return null;
}
