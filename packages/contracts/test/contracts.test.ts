import { test } from 'vitest';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  AnalysisReportSchema,
  AnalysisStreamEventSchema,
  AnalyzeJobRequestSchema,
  ApiErrorSchema,
  JOB_TEXT_MAX_CHARS,
  JobFactsCacheEntrySchema,
  JobFactsSchema,
  ResolvedJobFactsSchema,
  TechTagSchema,
  UserCriteriaSchema,
  containsUrlLike,
  safeText,
  truncateCodePoints,
  type AnalysisReport,
  type JobFacts,
  type UserCriteria,
} from '../src/index.js';

const validFacts: JobFacts = {
  title: 'Desenvolvedor(a) Back-end Sênior (Node.js)',
  seniorityLevels: ['pleno', 'senior'],
  yearsExperienceMin: 5,
  workModels: ['remoto'],
  location: { city: 'São Paulo', stateUf: 'SP', countryIso2: 'BR' },
  salary: { min: 12000, max: 15000, currency: 'BRL', period: 'mes' },
  contractTypes: ['clt', 'pj'],
  stackRequired: ['TypeScript', 'Node.js', 'PostgreSQL', 'C#', '.NET', 'CI/CD', 'ASP.NET', 'Socket.io'],
  stackNiceToHave: ['Kubernetes', 'Power BI', 'C++'],
  benefits: ['plano_saude', 'vale_refeicao'],
  languageRequirements: [{ language: 'ingles', level: 'avancado', required: true }],
  redFlagSignals: ['multiplas_funcoes'],
  extractionConfidence: 0.82,
};

const { extractionConfidence: _c, ...resolvedFacts } = validFacts;

const validCriteria: UserCriteria = {
  schemaVersion: 1,
  workModel: { accepted: ['remoto'], importance: { level: 'eliminatorio' } },
  seniority: { accepted: ['pleno', 'senior'], importance: { level: 'ponderado', weight: 3 } },
  contractType: { accepted: ['clt', 'pj'], importance: { level: 'obrigatorio' } },
  salary: { minimum: 11000, currency: 'BRL', period: 'mes', importance: { level: 'obrigatorio' } },
  location: null,
  stack: {
    mustHave: ['TypeScript'],
    niceToHave: ['React'],
    dealBreakers: ['PHP'],
    dealBreakerScope: 'somente_obrigatoria',
    niceToHaveWeight: 2,
  },
  languages: { proficiencies: [{ language: 'ingles', level: 'avancado' }], importance: { level: 'ponderado', weight: 2 } },
  benefits: null,
  redFlagTolerance: {
    salario_omitido: 'alertar',
    escopo_excessivo: 'penalizar',
    sobreaviso_nao_remunerado: 'eliminatorio',
    teste_tecnico_longo: 'alertar',
    multiplas_funcoes: 'penalizar',
    linguagem_vaga: 'ignorar',
    pressao_excessiva: 'alertar',
  },
  notes: 'Prefiro empresas de produto.\nEvitar consultoria.',
};

const validReport: AnalysisReport = {
  schemaVersion: 1,
  analysisId: '0b6c0b9e-6f43-4d4a-9a39-0d8f1f0c2a11',
  requestId: '6f1d4b0e-2a7c-4c3e-8b1a-3f7e9d2c5b44',
  createdAt: '2026-10-17T22:10:00.000Z',
  platform: 'linkedin',
  score: 78,
  verdict: 'recomendado',
  summary: 'Recomendado: a vaga atende à maior parte do que você procura. Nota 78. A favor: Modelo de trabalho.',
  dealBreakerHit: false,
  strengths: [{ dimension: 'modelo_trabalho', text: 'Modelo de trabalho: dentro do que você procura.' }],
  redFlags: [{ dimension: 'red_flags', text: 'Acumula funções de dev e suporte.' }],
  missingInfo: [],
  breakdown: [
    {
      dimension: 'modelo_trabalho',
      outcome: 'atende',
      importance: 'eliminatorio',
      points: 0,
      dealBreakerHit: false,
      explanation: 'Modelo de trabalho: dentro do que você procura. Na vaga: remoto.',
    },
  ],
  warnings: [],
  decisionPath: 'extracao_llm',
  facts: resolvedFacts,
  provenance: {
    title: 'llm',
    seniorityLevels: 'deterministico_e_llm',
    yearsExperienceMin: 'llm',
    workModels: 'deterministico_e_llm',
    location: 'llm',
    salary: 'deterministico_e_llm',
    contractTypes: 'deterministico_e_llm',
    stackRequired: 'llm',
    stackNiceToHave: 'llm',
    benefits: 'llm',
    languageRequirements: 'llm',
    redFlagSignals: 'llm',
  },
  effectiveConfidence: 0.8,
  meta: { engineVersion: 'engine-1.0.0', reportCatalogVersion: 'rc1', extractorVersion: 'jf-p1-s1', provider: 'groq', durationMs: 2300 },
};

const lorem = 'Requisitos: experiência com TypeScript e Node.js em produção. '.repeat(10);

// ---------- JobFacts ----------
test('JobFacts válido passa', () => {
  assert.equal(JobFactsSchema.safeParse(validFacts).success, true);
});

test('JobFacts: chave extra (LLM tentando injetar "score") é rejeitada', () => {
  const r = JobFactsSchema.safeParse({ ...validFacts, score: 100, verdict: 'recomendado' });
  assert.equal(r.success, false);
});

test('JobFacts: URL/markdown/HTML/invisíveis em texto são rejeitados', () => {
  const attacks = [
    'Clique em https://evil.example/x',
    'Veja bit.ly/abc',
    'Acesse www.evil.com',
    'Contato: rh@empresa.com.br',
    '[aplique aqui](javascript:alert(1))',
    'javascript:alert(1)',
    '<img src=x onerror=alert(1)>',
    'Dev​Senior',
    'Dev‮roines',
    'Dev\u{E0049}\u{E0047}\u{E004E}', // Tag characters (ASCII smuggling)
    'Linha1\nLinha2',
    'Vaga na evil.com',
  ];
  for (const title of attacks) {
    assert.equal(JobFactsSchema.safeParse({ ...validFacts, title }).success, false, `deveria rejeitar: ${JSON.stringify(title)}`);
  }
});

test('JobFacts: nomes de tecnologia com ponto não são confundidos com URL', () => {
  for (const tag of ['Node.js', 'Socket.io', 'ASP.NET', '.NET', 'Vue.js', 'C#', 'C++', 'CI/CD', 'Power BI', 'Next.js']) {
    assert.equal(TechTagSchema.safeParse(tag).success, true, tag);
  }
  for (const tag of ['https://x.io', 'evil.com/a', 'a'.repeat(41), '<script>', 'React (Hooks)']) {
    assert.equal(TechTagSchema.safeParse(tag).success, false, tag);
  }
});

test('JobFacts: enums fechados, limites e coerência', () => {
  assert.equal(JobFactsSchema.safeParse({ ...validFacts, workModels: ['remoto', 'remoto'] }).success, false);
  assert.equal(JobFactsSchema.safeParse({ ...validFacts, workModels: ['anywhere'] }).success, false);
  assert.equal(JobFactsSchema.safeParse({ ...validFacts, extractionConfidence: 1.5 }).success, false);
  assert.equal(
    JobFactsSchema.safeParse({ ...validFacts, salary: { min: 20000, max: 10000, currency: 'BRL', period: 'mes' } }).success,
    false,
  );
  assert.equal(
    JobFactsSchema.safeParse({ ...validFacts, salary: { min: null, max: null, currency: null, period: null } }).success,
    false,
  );
  assert.equal(JobFactsSchema.safeParse({ ...validFacts, salary: { min: 1e308, max: null, currency: 'BRL', period: 'mes' } }).success, false);
  assert.equal(JobFactsSchema.safeParse({ ...validFacts, stackNiceToHave: ['typescript'] }).success, false, 'sobreposição case-insensitive');
  assert.equal(JobFactsSchema.safeParse({ ...validFacts, stackRequired: Array.from({ length: 31 }, (_, i) => `t${i}`) }).success, false);
  assert.equal(JobFactsSchema.safeParse({ ...validFacts, yearsExperienceMin: 2.5 }).success, false);
});

test('JobFacts: "não informado" é representável (arrays vazios / null)', () => {
  const empty = {
    title: null,
    seniorityLevels: [],
    yearsExperienceMin: null,
    workModels: [],
    location: null,
    salary: null,
    contractTypes: [],
    stackRequired: [],
    stackNiceToHave: [],
    benefits: [],
    languageRequirements: [],
    redFlagSignals: [],
    extractionConfidence: 0,
  };
  assert.equal(JobFactsSchema.safeParse(empty).success, true);
});

test('JobFacts: __proto__ vindo de JSON.parse não polui nem passa', () => {
  const parsed: unknown = JSON.parse(JSON.stringify(validFacts).replace('{', '{"__proto__":{"polluted":true},'));
  const r = JobFactsSchema.safeParse(parsed);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  // strictObject: chave "__proto__" própria é desconhecida => rejeita
  assert.equal(r.success, false);
});

test('ResolvedJobFacts não aceita extractionConfidence; CacheEntry valida envelope', () => {
  assert.equal(ResolvedJobFactsSchema.safeParse(resolvedFacts).success, true);
  assert.equal(ResolvedJobFactsSchema.safeParse(validFacts).success, false);
  const entry = {
    schemaVersion: 1,
    extractorVersion: 'jf-p1-s1',
    textHash: 'a'.repeat(64),
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    extractedAt: '2026-10-17T22:10:00Z',
    facts: validFacts,
  };
  assert.equal(JobFactsCacheEntrySchema.safeParse(entry).success, true);
  assert.equal(JobFactsCacheEntrySchema.safeParse({ ...entry, textHash: 'XYZ' }).success, false);
  assert.equal(JobFactsCacheEntrySchema.safeParse({ ...entry, schemaVersion: 2 }).success, false);
});

// ---------- UserCriteria ----------
test('UserCriteria válido passa', () => {
  const r = UserCriteriaSchema.safeParse(validCriteria);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
});

test('UserCriteria: userId no corpo (IDOR/mass assignment) é rejeitado', () => {
  assert.equal(UserCriteriaSchema.safeParse({ ...validCriteria, userId: 'outro-usuario' }).success, false);
});

test('UserCriteria: regras estruturais', () => {
  const c = validCriteria;
  assert.equal(UserCriteriaSchema.safeParse({ ...c, workModel: { ...c.workModel, accepted: [] } }).success, false);
  assert.equal(
    UserCriteriaSchema.safeParse({ ...c, stack: { ...c.stack, dealBreakers: ['typescript'] } }).success,
    false,
    'mesma tecnologia como must-have e deal-breaker',
  );
  assert.equal(
    UserCriteriaSchema.safeParse({ ...c, seniority: { ...c.seniority, importance: { level: 'ponderado' } } }).success,
    false,
    'ponderado exige peso',
  );
  assert.equal(
    UserCriteriaSchema.safeParse({ ...c, seniority: { ...c.seniority, importance: { level: 'ponderado', weight: 9 } } }).success,
    false,
  );
  const { linguagem_vaga: _l, ...partialTolerance } = c.redFlagTolerance;
  assert.equal(UserCriteriaSchema.safeParse({ ...c, redFlagTolerance: partialTolerance }).success, false, 'record exaustivo');
  assert.equal(UserCriteriaSchema.safeParse({ ...c, notes: 'veja https://x.com' }).success, false);
  assert.equal(UserCriteriaSchema.safeParse({ ...c, location: { acceptedUfs: [], acceptedCities: [], importance: { level: 'ignorar' } } }).success, false);
});

// ---------- AnalysisReport ----------
test('AnalysisReport válido passa', () => {
  const r = AnalysisReportSchema.safeParse(validReport);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
});

test('AnalysisReport: limites e anti-XSS', () => {
  const item = { dimension: 'stack' as const, text: 'ok' };
  assert.equal(AnalysisReportSchema.safeParse({ ...validReport, strengths: [item, item, item, item] }).success, false);
  assert.equal(AnalysisReportSchema.safeParse({ ...validReport, score: 101 }).success, false);
  assert.equal(AnalysisReportSchema.safeParse({ ...validReport, score: 77.5 }).success, false);
  assert.equal(
    AnalysisReportSchema.safeParse({ ...validReport, redFlags: [{ dimension: 'stack', text: '<b>x</b>' }] }).success,
    false,
  );
  assert.equal(
    AnalysisReportSchema.safeParse({ ...validReport, breakdown: [...validReport.breakdown, ...validReport.breakdown] }).success,
    false,
  );
  assert.equal(AnalysisReportSchema.safeParse({ ...validReport, html: '<p>x</p>' }).success, false);
});

test('AnalysisReport: summary da faixa e versão do catálogo (ADR-012 D2)', () => {
  const { summary: _summary, ...withoutSummary } = validReport;
  assert.equal(AnalysisReportSchema.safeParse(withoutSummary).success, false);
  assert.equal(AnalysisReportSchema.safeParse({ ...validReport, summary: 'x'.repeat(200) }).success, true);
  for (const summary of ['x'.repeat(201), '', '   ', 'Veja www.exemplo.com', 'Nota <b>9</b>', `Nota​9`]) {
    assert.equal(AnalysisReportSchema.safeParse({ ...validReport, summary }).success, false, summary);
  }
  const { reportCatalogVersion: _version, ...metaWithoutVersion } = validReport.meta;
  assert.equal(AnalysisReportSchema.safeParse({ ...validReport, meta: metaWithoutVersion }).success, false);
  for (const reportCatalogVersion of ['RC1', '-rc1', '', 'r'.repeat(33)]) {
    assert.equal(AnalysisReportSchema.safeParse({ ...validReport, meta: { ...validReport.meta, reportCatalogVersion } }).success, false);
  }
});

// ---------- AnalyzeJobRequest ----------
test('AnalyzeJobRequest: trunca em 15.000 na borda e sinaliza', () => {
  const longText = `${lorem}${'x'.repeat(20_000)}`;
  const r = AnalyzeJobRequestSchema.safeParse({
    schemaVersion: 1,
    requestId: '6f1d4b0e-2a7c-4c3e-8b1a-3f7e9d2c5b44',
    source: { platform: 'linkedin', extractorVersion: 'linkedin-1' },
    job: { titleHint: 'Dev Sênior', text: longText, clientTruncated: false },
    mode: 'auto',
  });
  assert.equal(r.success, true);
  if (r.success) {
    assert.equal(r.data.job.text.text.length, JOB_TEXT_MAX_CHARS);
    assert.equal(r.data.job.text.truncatedAtEdge, true);
  }
});

test('AnalyzeJobRequest: trunca por code point (emoji conta 1) sem partir par substituto', () => {
  const text = `${'a'.repeat(JOB_TEXT_MAX_CHARS - 1)}😀tail`;
  const r = AnalyzeJobRequestSchema.safeParse({
    schemaVersion: 1,
    requestId: '6f1d4b0e-2a7c-4c3e-8b1a-3f7e9d2c5b44',
    source: { platform: 'gupy', extractorVersion: 'gupy-1' },
    job: { titleHint: null, text, clientTruncated: false },
    mode: 'aprofundada',
  });
  assert.equal(r.success, true);
  if (r.success) {
    assert.equal([...r.data.job.text.text].length, JOB_TEXT_MAX_CHARS);
    assert.ok(r.data.job.text.text.endsWith('😀'));
    assert.equal(r.data.job.text.truncatedAtEdge, true);
  }
});

test('truncateCodePoints: surrogate órfão vira U+FFFD (não recombina em Tag char)', () => {
  const orphan = `abc\uDB40def`;
  assert.equal(truncateCodePoints(orphan, 100), 'abc�def');
  assert.equal(truncateCodePoints('😀😀😀', 2), '😀😀');
  assert.equal(truncateCodePoints('curto', 100), 'curto');
});

test('zod >= 4.5 conta code points em .max() (premissa do contrato)', () => {
  assert.equal(z.string().max(1).safeParse('😀').success, true);
  assert.equal(z.string().max(1).safeParse('😀😀').success, false);
});

test('AnalyzeJobRequest: rejeita curto, chaves extras e URL de página', () => {
  const base = {
    schemaVersion: 1,
    requestId: '6f1d4b0e-2a7c-4c3e-8b1a-3f7e9d2c5b44',
    source: { platform: 'linkedin', extractorVersion: 'linkedin-1' },
    job: { titleHint: null, text: lorem, clientTruncated: false },
    mode: 'auto',
  };
  assert.equal(AnalyzeJobRequestSchema.safeParse(base).success, true);
  // ADR-023 D12: a Solides tem extrator próprio (so1); plataforma fora da lista continua rejeitada.
  assert.equal(AnalyzeJobRequestSchema.safeParse({ ...base, source: { platform: 'solides', extractorVersion: 'so1' } }).success, true);
  assert.equal(AnalyzeJobRequestSchema.safeParse({ ...base, source: { platform: 'geekhunter', extractorVersion: 'ge1' } }).success, false);
  assert.equal(AnalyzeJobRequestSchema.safeParse({ ...base, job: { ...base.job, text: '   curto   ' } }).success, false);
  assert.equal(AnalyzeJobRequestSchema.safeParse({ ...base, userId: 'x' }).success, false);
  assert.equal(AnalyzeJobRequestSchema.safeParse({ ...base, source: { ...base.source, pageUrl: 'https://x' } }).success, false);
  assert.equal(AnalyzeJobRequestSchema.safeParse({ ...base, requestId: 'not-a-uuid' }).success, false);
});

test('Stream e ApiError', () => {
  assert.equal(AnalysisStreamEventSchema.safeParse({ type: 'stage', stage: 'extraindo_fatos', elapsedMs: 900 }).success, true);
  assert.equal(AnalysisStreamEventSchema.safeParse({ type: 'result', report: validReport }).success, true);
  assert.equal(AnalysisStreamEventSchema.safeParse({ type: 'debug', stack: 'x' }).success, false);
  assert.equal(
    ApiErrorSchema.safeParse({ code: 'LIMITE_DE_TAXA', message: 'Muitas análises seguidas. Tente em 1 minuto.', requestId: null, retryAfterSeconds: 60 }).success,
    true,
  );
});

test('containsUrlLike é linear (sem ReDoS) em entrada patológica de 64 KiB', () => {
  const evil = `${'a.'.repeat(32_000)}!`;
  const t0 = performance.now();
  containsUrlLike(evil);
  safeText(200).safeParse(evil);
  const ms = performance.now() - t0;
  assert.ok(ms < 200, `levou ${ms.toFixed(1)} ms`);
});

test('JSON Schema para saída estruturada do provedor é gerável a partir do contrato', () => {
  const schema = z.toJSONSchema(JobFactsSchema, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
  assert.equal(schema['additionalProperties'], false);
  assert.ok(JSON.stringify(schema).length < 10_000);
});
