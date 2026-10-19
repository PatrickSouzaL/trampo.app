import { z } from 'zod';
import {
  BenefitCategorySchema,
  BrazilUfSchema,
  ContractTypeSchema,
  CurrencySchema,
  LanguageCodeSchema,
  LanguageLevelSchema,
  LlmProviderIdSchema,
  RedFlagSignalSchema,
  SalaryPeriodSchema,
  SeniorityLevelSchema,
  WorkModelSchema,
} from './enums.js';
import { JOB_TITLE_MAX_CHARS, SALARY_MAX } from './limits.js';
import { Sha256HexSchema, VersionTagSchema, safeText, techTagList, uniqueArray } from './primitives.js';

export const JOB_FACTS_SCHEMA_VERSION = 1 as const;

const salaryAmount = z.number().nonnegative().max(SALARY_MAX).nullable();

export const SalaryFactsSchema = z
  .strictObject({
    min: salaryAmount,
    max: salaryAmount,
    currency: CurrencySchema.nullable(),
    period: SalaryPeriodSchema.nullable(),
  })
  .refine((s) => s.min !== null || s.max !== null, { error: 'salario_sem_valor_use_null' })
  .refine((s) => s.min === null || s.max === null || s.min <= s.max, {
    error: 'salario_min_maior_que_max',
    path: ['min'],
  });
export type SalaryFacts = z.infer<typeof SalaryFactsSchema>;

export const LocationFactsSchema = z
  .strictObject({
    city: safeText(80).nullable(),
    stateUf: BrazilUfSchema.nullable(),
    countryIso2: z.string().regex(/^[A-Z]{2}$/).nullable(),
  })
  .refine((l) => l.city !== null || l.stateUf !== null || l.countryIso2 !== null, {
    error: 'localizacao_vazia_use_null',
  });
export type LocationFacts = z.infer<typeof LocationFactsSchema>;

export const LanguageRequirementSchema = z.strictObject({
  language: LanguageCodeSchema,
  /** null = nível não informado na vaga. */
  level: LanguageLevelSchema.nullable(),
  /** false = diferencial ("desejável"). */
  required: z.boolean(),
});
export type LanguageRequirement = z.infer<typeof LanguageRequirementSchema>;

/**
 * Forma dos fatos SEM a confiança. Reutilizada pelo relatório (fatos resolvidos)
 * via spread, sem `.omit()` em schema refinado.
 * Semântica de ausência: array vazio ou null = "não informado" ≠ "não atende" (Blueprint §2).
 */
export const jobFactsShape = {
  title: safeText(JOB_TITLE_MAX_CHARS).nullable(),
  seniorityLevels: uniqueArray(SeniorityLevelSchema, 3),
  yearsExperienceMin: z.int().min(0).max(40).nullable(),
  workModels: uniqueArray(WorkModelSchema, 3),
  location: LocationFactsSchema.nullable(),
  salary: SalaryFactsSchema.nullable(),
  contractTypes: uniqueArray(ContractTypeSchema, 5),
  stackRequired: techTagList(30),
  stackNiceToHave: techTagList(30),
  benefits: uniqueArray(BenefitCategorySchema, BenefitCategorySchema.options.length),
  languageRequirements: z
    .array(LanguageRequirementSchema)
    .max(5)
    .refine((arr) => new Set(arr.map((l) => l.language)).size === arr.length, { error: 'idioma_duplicado' }),
  redFlagSignals: uniqueArray(RedFlagSignalSchema, RedFlagSignalSchema.options.length),
} as const;

function stacksAreDisjoint(f: { stackRequired: string[]; stackNiceToHave: string[] }): boolean {
  const required = new Set(f.stackRequired.map((t) => t.toLowerCase()));
  return f.stackNiceToHave.every((t) => !required.has(t.toLowerCase()));
}

/**
 * CONTRATO DE SAÍDA DO LLM (Camada 2). Estrito: chave desconhecida = extração inválida
 * = falha segura para o fallback determinístico (Blueprint §8, Ameaça 1).
 * O LLM NÃO recebe perfil e NÃO produz nota, veredito, prós ou contras (D1, D2).
 */
export const JobFactsSchema = z
  .strictObject({
    ...jobFactsShape,
    /** Autodeclarada pelo LLM: só um indício; a API calcula a confiança efetiva. */
    extractionConfidence: z.number().min(0).max(1),
  })
  .refine(stacksAreDisjoint, { error: 'stack_obrigatoria_e_desejavel_sobrepostas', path: ['stackNiceToHave'] });
export type JobFacts = z.infer<typeof JobFactsSchema>;

/**
 * Fatos após a fusão Camada 1 + Camada 2 (ou só Camada 1 em curto-circuito/fallback).
 * Campo em conflito entre fontes é rebaixado para "não informado".
 */
export const ResolvedJobFactsSchema = z
  .strictObject(jobFactsShape)
  .refine(stacksAreDisjoint, { error: 'stack_obrigatoria_e_desejavel_sobrepostas', path: ['stackNiceToHave'] });
export type ResolvedJobFacts = z.infer<typeof ResolvedJobFactsSchema>;

/**
 * Entrada do cache compartilhado (Redis). Redis é fronteira de confiança:
 * a API revalida com este schema em TODA leitura. Não contém dado de usuário.
 * Chave: `jobfacts:v{schemaVersion}:{extractorVersion}:{textHash}`.
 */
export const JobFactsCacheEntrySchema = z.strictObject({
  schemaVersion: z.literal(JOB_FACTS_SCHEMA_VERSION),
  extractorVersion: VersionTagSchema,
  textHash: Sha256HexSchema,
  provider: LlmProviderIdSchema,
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,79}$/),
  extractedAt: z.iso.datetime(),
  facts: JobFactsSchema,
});
export type JobFactsCacheEntry = z.infer<typeof JobFactsCacheEntrySchema>;
