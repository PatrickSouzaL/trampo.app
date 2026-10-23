// F1-LLM-02: id do modelo com o prefixo estrito `@cf/` da Cloudflare Workers AI (BACKLOG, decisão de 2026-10-22).
import { describe, expect, test } from 'vitest';
import { JobFactsCacheEntrySchema, type JobFacts } from '../src/index.js';

const MODEL = JobFactsCacheEntrySchema.shape.model;

describe('model: ids aceitos', () => {
  test.each([
    'openai/gpt-oss-20b',
    'llama-3.1-8b-instant',
    'qwen3:8b',
    'a',
    '@cf/a',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/openai/gpt-oss-120b',
    'a'.repeat(80),
    `@cf/${'a'.repeat(76)}`,
  ])('%j', (model) => {
    expect(MODEL.safeParse(model).success).toBe(true);
  });
});

describe('model: ids recusados', () => {
  test.each([
    ['vazio', ''],
    ['@ fora do início', 'meta/@cf/llama'],
    ['@ no meio', 'llama@8b'],
    ['@cf/ depois de outro texto', 'x@cf/'],
    ['@cf/ depois de outro texto, com nome', 'x@cf/meta/llama'],
    ['@cf sem barra', '@cf'],
    ['@cf colado no nome', '@cfmeta/llama'],
    ['@CF/ em maiúsculas', '@CF/meta/llama'],
    ['@Cf/ misto', '@Cf/meta/llama'],
    ['@cf// com barra dupla', '@cf//meta'],
    ['@cf/ vazio', '@cf/'],
    ['@cf/ seguido de hífen', '@cf/-meta'],
    ['@cf/ seguido de ponto', '@cf/.meta'],
    ['@cf/ seguido de dois-pontos', '@cf/:meta'],
    ['@cf/ repetido no início', '@cf/@cf/meta'],
    ['@ duplo', '@@cf/meta'],
    ['outro prefixo com @', '@hf/meta/llama'],
    ['só @', '@'],
    ['@ e barra', '@/meta'],
    ['@ no fim', 'meta/llama@'],
    ['espaço antes do prefixo', ' @cf/meta'],
    ['espaço no fim', '@cf/meta '],
    ['quebra de linha no fim', '@cf/meta\n'],
    ['@ de largura total', '＠cf/meta'],
    ['letra cirílica', '@cf/llamа'],
    ['81 caracteres sem prefixo', 'a'.repeat(81)],
    ['81 caracteres com prefixo', `@cf/${'a'.repeat(77)}`],
    ['outro caractere especial', '@cf/meta/llama+8b'],
  ])('%s', (_name, model) => {
    expect(MODEL.safeParse(model).success).toBe(false);
  });
});

describe('JobFactsCacheEntrySchema com o id da Workers AI (espelho do ADR-015)', () => {
  const facts: JobFacts = {
    title: 'Desenvolvedor(a) Back-end',
    seniorityLevels: ['pleno'],
    yearsExperienceMin: null,
    workModels: ['remoto'],
    location: { city: null, stateUf: null, countryIso2: 'BR' },
    salary: null,
    contractTypes: ['clt'],
    stackRequired: ['TypeScript'],
    stackNiceToHave: [],
    benefits: [],
    languageRequirements: [],
    redFlagSignals: [],
    extractionConfidence: 0.8,
  };
  const entry = (model: string) => ({
    schemaVersion: 1,
    extractorVersion: 'jf-p1-s1',
    textHash: 'a'.repeat(64),
    provider: 'cloudflare_workers_ai',
    model,
    extractedAt: '2026-10-23T12:00:00Z',
    facts,
  });

  test('a entrada com @cf/ passa, e a fronteira de leitura recusa as formas vizinhas', () => {
    const ok = JobFactsCacheEntrySchema.safeParse(entry('@cf/openai/gpt-oss-120b'));
    expect(ok.success, JSON.stringify(ok.error?.issues)).toBe(true);
    for (const bad of ['@CF/openai/gpt-oss-120b', '@cf//openai', 'x@cf/openai', '@cf/']) {
      expect(JobFactsCacheEntrySchema.safeParse(entry(bad)).success).toBe(false);
    }
  });
});
