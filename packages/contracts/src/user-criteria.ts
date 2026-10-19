import { z } from 'zod';
import {
  BenefitCategorySchema,
  BrazilUfSchema,
  ContractTypeSchema,
  CurrencySchema,
  LanguageCodeSchema,
  LanguageLevelSchema,
  RedFlagSignalSchema,
  SalaryPeriodSchema,
  SeniorityLevelSchema,
  WorkModelSchema,
} from './enums.js';
import { SALARY_MAX } from './limits.js';
import { safeText, techTagList, uniqueArray } from './primitives.js';

export const USER_CRITERIA_SCHEMA_VERSION = 1 as const;

/**
 * Importância de uma dimensão (Blueprint §2 "Regras de pontuação"):
 * - eliminatorio: violação => veredito "foge" (deal-breaker);
 * - obrigatorio: violação => penalidade forte; não informado => penalidade leve + alerta (must-have);
 * - ponderado: soma na nota com o peso dado pelo usuário;
 * - ignorar: fora do cálculo.
 * Os VALORES das penalidades/tetos não estão aqui: são regra de domínio (apps/api).
 */
export const CriterionImportanceSchema = z.discriminatedUnion('level', [
  z.strictObject({ level: z.literal('eliminatorio') }),
  z.strictObject({ level: z.literal('obrigatorio') }),
  z.strictObject({ level: z.literal('ponderado'), weight: z.int().min(1).max(5) }),
  z.strictObject({ level: z.literal('ignorar') }),
]);
export type CriterionImportance = z.infer<typeof CriterionImportanceSchema>;

export const WorkModelCriterionSchema = z.strictObject({
  accepted: uniqueArray(WorkModelSchema, WorkModelSchema.options.length, 1),
  importance: CriterionImportanceSchema,
});

export const SeniorityCriterionSchema = z.strictObject({
  accepted: uniqueArray(SeniorityLevelSchema, SeniorityLevelSchema.options.length, 1),
  importance: CriterionImportanceSchema,
});

export const ContractTypeCriterionSchema = z.strictObject({
  accepted: uniqueArray(ContractTypeSchema, ContractTypeSchema.options.length, 1),
  importance: CriterionImportanceSchema,
});

/** Pretensão salarial: dado pessoal sensível ao negócio — cifrado em repouso (Blueprint §5). */
export const SalaryCriterionSchema = z.strictObject({
  minimum: z.number().positive().max(SALARY_MAX),
  currency: CurrencySchema,
  period: SalaryPeriodSchema,
  importance: CriterionImportanceSchema,
});

/** Só se aplica a vagas híbridas/presenciais (regra no domínio). */
export const LocationCriterionSchema = z
  .strictObject({
    acceptedUfs: uniqueArray(BrazilUfSchema, BrazilUfSchema.options.length),
    acceptedCities: uniqueArray(safeText(80), 10),
    importance: CriterionImportanceSchema,
  })
  .refine((l) => l.acceptedUfs.length + l.acceptedCities.length > 0, { error: 'localizacao_sem_opcoes' });

/** A stack tem semântica própria por lista (cada item já carrega sua importância). */
export const StackCriterionSchema = z
  .strictObject({
    mustHave: techTagList(15),
    niceToHave: techTagList(30),
    dealBreakers: techTagList(15),
    /** "somente_obrigatoria": deal-breaker só derruba se estiver na stack exigida; "qualquer_mencao": também na desejável. */
    dealBreakerScope: z.enum(['somente_obrigatoria', 'qualquer_mencao']),
    niceToHaveWeight: z.int().min(0).max(5),
  })
  .refine(
    (s) => {
      const lists = [s.mustHave, s.niceToHave, s.dealBreakers].map((l) => l.map((t) => t.toLowerCase()));
      const all = lists.flat();
      return new Set(all).size === all.length;
    },
    { error: 'tecnologia_em_mais_de_uma_lista' },
  );

export const LanguageProficiencySchema = z.strictObject({
  language: LanguageCodeSchema,
  level: LanguageLevelSchema,
});

export const LanguageCriterionSchema = z.strictObject({
  proficiencies: z
    .array(LanguageProficiencySchema)
    .max(8)
    .refine((arr) => new Set(arr.map((p) => p.language)).size === arr.length, { error: 'idioma_duplicado' }),
  importance: CriterionImportanceSchema,
});

export const BenefitsCriterionSchema = z.strictObject({
  desired: uniqueArray(BenefitCategorySchema, BenefitCategorySchema.options.length, 1),
  importance: CriterionImportanceSchema,
});

export const RedFlagToleranceSchema = z.enum(['ignorar', 'alertar', 'penalizar', 'eliminatorio']);
export type RedFlagTolerance = z.infer<typeof RedFlagToleranceSchema>;

/**
 * Critérios do usuário (portal -> API -> Postgres com RLS). NUNCA vai para a extensão
 * nem para o LLM (D2). Não contém `userId`: o dono vem SEMPRE do token (anti-IDOR/BOPLA);
 * `strictObject` rejeita a tentativa de "mass assignment".
 */
export const UserCriteriaSchema = z.strictObject({
  schemaVersion: z.literal(USER_CRITERIA_SCHEMA_VERSION),
  workModel: WorkModelCriterionSchema,
  seniority: SeniorityCriterionSchema,
  contractType: ContractTypeCriterionSchema,
  salary: SalaryCriterionSchema.nullable(),
  location: LocationCriterionSchema.nullable(),
  stack: StackCriterionSchema,
  languages: LanguageCriterionSchema.nullable(),
  benefits: BenefitsCriterionSchema.nullable(),
  /** Exaustivo: o portal sempre envia todas as chaves (padrões explícitos, sem "default mágico"). */
  redFlagTolerance: z.record(RedFlagSignalSchema, RedFlagToleranceSchema),
  /** Observações livres: não alimentam regra, não vão ao LLM, não são logadas (Blueprint §3). */
  notes: safeText(500, { multiline: true }).nullable(),
});
export type UserCriteria = z.infer<typeof UserCriteriaSchema>;
