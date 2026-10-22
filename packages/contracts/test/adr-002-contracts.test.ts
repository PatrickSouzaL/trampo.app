// As 3 mudanças de contrato do ADR-002 §8.1 (1º commit do F1-DOM-02, contrato antes do motor).
import { expect, test } from 'vitest';
import { CurrencySchema, RedFlagSignalSchema } from '../src/enums.js';
import { VerdictSchema } from '../src/analysis-report.js';
import { JobFactsSchema, SalaryFactsSchema } from '../src/job-facts.js';
import { UserCriteriaSchema } from '../src/user-criteria.js';

test('CurrencySchema aceita ARS (D-S3) e continua fechado', () => {
  expect(CurrencySchema.options).toEqual(['BRL', 'USD', 'EUR', 'ARS']);
  expect(SalaryFactsSchema.safeParse({ min: 3_800_000, max: 3_900_000, currency: 'ARS', period: 'mes' }).success).toBe(true);
  for (const currency of ['ars', 'AR$', 'CLP', '']) {
    expect(CurrencySchema.safeParse(currency).success, currency).toBe(false);
  }
});

test('RedFlagSignalSchema ganha pressao_excessiva no fim, sem reordenar os outros', () => {
  expect(RedFlagSignalSchema.options).toEqual([
    'salario_omitido',
    'escopo_excessivo',
    'sobreaviso_nao_remunerado',
    'teste_tecnico_longo',
    'multiplas_funcoes',
    'linguagem_vaga',
    'pressao_excessiva',
  ]);
});

test('VerdictSchema tem as 5 faixas do D-S9, da melhor para a pior', () => {
  expect(VerdictSchema.options).toEqual(['altamente_recomendado', 'recomendado', 'neutro', 'baixo_alinhamento', 'foge']);
  expect(VerdictSchema.safeParse('altamente recomendado').success).toBe(false);
});

const facts = {
  title: null,
  seniorityLevels: [],
  yearsExperienceMin: null,
  workModels: [],
  location: null,
  salary: { min: null, max: 1_000_000, currency: 'ARS', period: 'mes' },
  contractTypes: [],
  stackRequired: [],
  stackNiceToHave: [],
  benefits: [],
  languageRequirements: [],
  redFlagSignals: ['pressao_excessiva'],
  extractionConfidence: 0.5,
};

test('saída do LLM aceita ARS e pressao_excessiva (alarga o contrato; muda o extractorVersion)', () => {
  expect(JobFactsSchema.safeParse(facts).success).toBe(true);
});

const tolerance = {
  salario_omitido: 'alertar',
  escopo_excessivo: 'alertar',
  sobreaviso_nao_remunerado: 'alertar',
  teste_tecnico_longo: 'alertar',
  multiplas_funcoes: 'alertar',
  linguagem_vaga: 'alertar',
} as const;

const criteria = {
  schemaVersion: 1,
  workModel: { accepted: ['remoto'], importance: { level: 'obrigatorio' } },
  seniority: { accepted: ['pleno'], importance: { level: 'ponderado', weight: 3 } },
  contractType: { accepted: ['clt'], importance: { level: 'ignorar' } },
  salary: { minimum: 2_000_000, currency: 'ARS', period: 'mes', importance: { level: 'obrigatorio' } },
  location: null,
  stack: { mustHave: [], niceToHave: [], dealBreakers: [], dealBreakerScope: 'somente_obrigatoria', niceToHaveWeight: 0 },
  languages: null,
  benefits: null,
  notes: null,
};

test('redFlagTolerance continua exaustivo: critério salvo sem pressao_excessiva precisa de migração', () => {
  expect(UserCriteriaSchema.safeParse({ ...criteria, redFlagTolerance: tolerance }).success).toBe(false);
  const migrated = { ...criteria, redFlagTolerance: { ...tolerance, pressao_excessiva: 'alertar' } };
  expect(UserCriteriaSchema.safeParse(migrated).success).toBe(true);
});
