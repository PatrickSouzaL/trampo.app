// F1-PORTAL-03 (ADR-029 D3, D4 e D10): contratos de exportar e excluir a conta, com bordas exatas. Cada limite é
// provado pelo valor na borda (passa) e pelo vizinho de fora (recusado).
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { z } from 'zod';
import {
  ACCOUNT_DELETE_CONFIRMATION,
  ACCOUNT_ROUTES,
  ACCOUNT_SCHEMA_VERSION,
  AccountDeleteRequestSchema,
  AccountDeleteResultSchema,
  AccountExportSchema,
  ExportedAnalysisSchema,
  ExportedFeedbackSchema,
  type AccountDeleteRequest,
  type AccountExport,
} from '../src/account.js';
import { ApiErrorCodeSchema, ApiErrorSchema } from '../src/api.js';
import { RedFlagSignalSchema } from '../src/enums.js';
import * as root from '../src/index.js';
import * as limits from '../src/limits.js';
import { UserCriteriaSchema } from '../src/user-criteria.js';

const ID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const WHEN = '2026-11-15T12:00:00.000Z';
const analysis = { id: ID, createdAt: WHEN, decisionPath: 'extracao_llm', verdict: 'neutro', score: 50 } as const;
const feedback = { analysisId: ID, agreement: 'discordo', reason: 'nota_alta_demais', updatedAt: WHEN } as const;
const empty = { schemaVersion: 1, exportedAt: WHEN, criteria: null, analyses: [], analysesTruncated: false, feedback: [], feedbackTruncated: false } as const;

/** Critérios válidos mínimos, pelo próprio schema (os padrões do contrato). */
const criteria = UserCriteriaSchema.parse({
  schemaVersion: 1,
  workModel: { accepted: ['remoto'], importance: { level: 'eliminatorio' } },
  seniority: { accepted: ['pleno'], importance: { level: 'ponderado', weight: 3 } },
  contractType: { accepted: ['clt'], importance: { level: 'obrigatorio' } },
  salary: { minimum: 9_000, currency: 'BRL', period: 'mes', importance: { level: 'obrigatorio' } },
  location: null,
  stack: { mustHave: ['TypeScript'], niceToHave: [], dealBreakers: [], dealBreakerScope: 'somente_obrigatoria', niceToHaveWeight: 2 },
  languages: null,
  benefits: null,
  redFlagTolerance: Object.fromEntries(RedFlagSignalSchema.options.map((signal) => [signal, 'alertar'])),
  notes: null,
});

describe('constantes (ADR-029 D10)', () => {
  test('versão, rotas exatas e a frase de confirmação', () => {
    expect(ACCOUNT_SCHEMA_VERSION).toBe(1);
    expect(ACCOUNT_ROUTES).toEqual({ export: '/v1/account/export', delete: '/v1/account/delete' });
    expect(Object.isFrozen(ACCOUNT_ROUTES)).toBe(true);
    expect(ACCOUNT_DELETE_CONFIRMATION).toBe('excluir minha conta');
  });

  test('limites na fonte única', () => {
    expect(limits.ACCOUNT_EXPORT_MAX_ROWS).toBe(500);
    expect(limits.ACCOUNT_DELETE_BODY_MAX_BYTES).toBe(256);
    expect(limits.ACCOUNT_RECENT_LOGIN_SECONDS).toBe(600);
    // O corpo válido cabe no teto com folga.
    expect(JSON.stringify({ schemaVersion: 1, confirmation: ACCOUNT_DELETE_CONFIRMATION }).length).toBeLessThan(limits.ACCOUNT_DELETE_BODY_MAX_BYTES / 2);
  });

  test('a raiz e o subpath exportam o contrato', () => {
    expect(root.AccountExportSchema).toBe(AccountExportSchema);
    expect(root.ACCOUNT_ROUTES).toBe(ACCOUNT_ROUTES);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown> };
    expect(pkg.exports['./account']).toEqual({ types: './dist/account.d.ts', default: './dist/account.js' });
  });

  test('o catálogo de erros não muda: o login antigo responde PROIBIDO (ADR-029 D3)', () => {
    expect(ApiErrorCodeSchema.options).toEqual([
      'NAO_AUTENTICADO',
      'PROIBIDO',
      'PAYLOAD_GRANDE_DEMAIS',
      'PAYLOAD_INVALIDO',
      'TEXTO_CURTO_DEMAIS',
      'CRITERIOS_NAO_CONFIGURADOS',
      'LIMITE_DE_TAXA',
      'COTA_DIARIA_ESGOTADA',
      'SERVICO_INDISPONIVEL',
      'ERRO_INTERNO',
    ]);
    expect(ApiErrorSchema.safeParse({ code: 'LOGIN_RECENTE_NECESSARIO', message: 'Entre de novo.', requestId: null, retryAfterSeconds: null }).success).toBe(false);
  });
});

describe('AccountDeleteRequestSchema (ADR-029 D3)', () => {
  test('só a versão 1 com a frase exata', () => {
    const body = { schemaVersion: 1, confirmation: 'excluir minha conta' };
    expect(AccountDeleteRequestSchema.parse(body)).toEqual(body);
    expectTypeOf<AccountDeleteRequest>().toEqualTypeOf<{ schemaVersion: 1; confirmation: 'excluir minha conta' }>();
  });

  test.each([
    ['vazio', {}],
    ['sem a frase', { schemaVersion: 1 }],
    ['sem a versão', { confirmation: 'excluir minha conta' }],
    ['versão 2', { schemaVersion: 2, confirmation: 'excluir minha conta' }],
    ['frase em maiúsculas', { schemaVersion: 1, confirmation: 'EXCLUIR MINHA CONTA' }],
    ['frase com espaço a mais', { schemaVersion: 1, confirmation: 'excluir minha conta ' }],
    ['frase vazia', { schemaVersion: 1, confirmation: '' }],
    ['frase booleana', { schemaVersion: 1, confirmation: true }],
    ['alvo no corpo (chave a mais)', { schemaVersion: 1, confirmation: 'excluir minha conta', userId: ID }],
    ['lista', [{ schemaVersion: 1, confirmation: 'excluir minha conta' }]],
    ['nulo', null],
  ])('recusa: %s', (_caso, body) => {
    expect(AccountDeleteRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('AccountDeleteResultSchema (as três palavras da função, ADR-029 D2)', () => {
  test('lista fechada', () => {
    expect(AccountDeleteResultSchema.options).toEqual(['excluida', 'ja_excluida', 'login_antigo']);
    for (const value of ['Excluida', 'excluida ', '', 'ok', null, 1, ['excluida']]) expect(AccountDeleteResultSchema.safeParse(value).success).toBe(false);
  });
});

describe('ExportedAnalysisSchema e ExportedFeedbackSchema (ADR-029 D4)', () => {
  test('as formas válidas, com a nota nas bordas e o motivo nulo', () => {
    expect(ExportedAnalysisSchema.parse(analysis)).toEqual(analysis);
    for (const score of [0, 100]) expect(ExportedAnalysisSchema.safeParse({ ...analysis, score }).success).toBe(true);
    expect(ExportedFeedbackSchema.parse(feedback)).toEqual(feedback);
    expect(ExportedFeedbackSchema.safeParse({ ...feedback, reason: null }).success).toBe(true);
  });

  test.each([
    ['nota −1', { ...analysis, score: -1 }],
    ['nota 101', { ...analysis, score: 101 }],
    ['nota fracionada', { ...analysis, score: 50.5 }],
    ['id que não é UUID', { ...analysis, id: 'x' }],
    ['data sem hora', { ...analysis, createdAt: '2026-11-15' }],
    ['caminho fora da lista', { ...analysis, decisionPath: 'outro' }],
    ['veredito fora da lista', { ...analysis, verdict: 'otimo' }],
    ['o dono na linha (chave a mais)', { ...analysis, userId: ID }],
    ['texto da vaga na linha (chave a mais)', { ...analysis, jobText: 'vaga' }],
  ])('análise recusada: %s', (_caso, row) => {
    expect(ExportedAnalysisSchema.safeParse(row).success).toBe(false);
  });

  test.each([
    ['concordância fora da lista', { ...feedback, agreement: 'talvez' }],
    ['motivo fora da lista', { ...feedback, reason: 'texto livre' }],
    ['motivo ausente', { analysisId: ID, agreement: 'concordo', updatedAt: WHEN }],
    ['id que não é UUID', { ...feedback, analysisId: '1' }],
    ['data inválida', { ...feedback, updatedAt: 'ontem' }],
    ['chave a mais', { ...feedback, userId: ID }],
  ])('avaliação recusada: %s', (_caso, row) => {
    expect(ExportedFeedbackSchema.safeParse(row).success).toBe(false);
  });
});

describe('AccountExportSchema (ADR-029 D4)', () => {
  test('quem nunca salvou nada: critérios nulos e listas vazias', () => {
    expect(AccountExportSchema.parse(empty)).toEqual(empty);
    expectTypeOf<AccountExport['criteria']>().toEqualTypeOf<z.infer<typeof UserCriteriaSchema> | null>();
  });

  test('com os critérios (a pretensão em claro) e as listas', () => {
    const full = { ...empty, criteria, analyses: [analysis], feedback: [feedback] };
    const parsed = AccountExportSchema.parse(full);
    expect(parsed.criteria?.salary).toEqual(criteria.salary);
    expect(parsed.analyses).toEqual([analysis]);
    expect(parsed.feedback).toEqual([feedback]);
  });

  test('o teto de 500 linhas por lista', () => {
    const rows = (count: number) => Array.from({ length: count }, () => analysis);
    const notes = (count: number) => Array.from({ length: count }, () => feedback);
    expect(AccountExportSchema.safeParse({ ...empty, analyses: rows(limits.ACCOUNT_EXPORT_MAX_ROWS), analysesTruncated: true }).success).toBe(true);
    expect(AccountExportSchema.safeParse({ ...empty, analyses: rows(limits.ACCOUNT_EXPORT_MAX_ROWS + 1) }).success).toBe(false);
    expect(AccountExportSchema.safeParse({ ...empty, feedback: notes(limits.ACCOUNT_EXPORT_MAX_ROWS), feedbackTruncated: true }).success).toBe(true);
    expect(AccountExportSchema.safeParse({ ...empty, feedback: notes(limits.ACCOUNT_EXPORT_MAX_ROWS + 1) }).success).toBe(false);
  });

  test.each([
    ['versão 2', { ...empty, schemaVersion: 2 }],
    ['sem a data', (({ exportedAt: _omit, ...rest }) => rest)(empty)],
    ['data sem fuso', { ...empty, exportedAt: '2026-11-15T12:00:00' }],
    ['critérios fora do contrato', { ...empty, criteria: { schemaVersion: 1 } }],
    ['critérios ausentes', (({ criteria: _omit, ...rest }) => rest)(empty)],
    ['sem a marca de corte', (({ analysesTruncated: _omit, ...rest }) => rest)(empty)],
    ['marca de corte que não é booleana', { ...empty, feedbackTruncated: 'nao' }],
    ['o cifrado da pretensão (chave a mais)', { ...empty, salaryCiphertext: 's1.k.a.b.c' }],
    ['o dono (chave a mais)', { ...empty, userId: ID }],
    ['o e-mail (chave a mais)', { ...empty, email: 'x@exemplo.invalid' }],
    ['lista que não é lista', { ...empty, analyses: {} }],
  ])('recusa: %s', (_caso, value) => {
    expect(AccountExportSchema.safeParse(value).success).toBe(false);
  });
});
