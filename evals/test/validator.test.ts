import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoldenCaseSchema, derivedTags, lengthTag } from '../src/case-schema.js';
import { countCodePoints, findPii, hasForbiddenInvisible, hasRawHeaderLeftover } from '../src/text-checks.js';
import { schemaIssues, validateDataset } from '../src/validate-dataset.js';

/* Cada regra do portão (golden-dataset-spec §9) com um caso negativo. */

const TEXT = 'Vaga de Pessoa Desenvolvedora Backend na Empresa Exemplo. '.repeat(5);

function baseCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caseSchemaVersion: 2,
    id: 'linkedin-01',
    source: 'linkedin',
    platform: 'linkedin',
    batch: 'hitl-003',
    synthetic: false,
    category: 'normal',
    language: 'pt',
    tags: ['sem_salario', 'remoto', 'curta'],
    traps: [],
    anonymization: { pessoa: 0, email: 0, telefone: 0, documento: 0, url: 0, empresa: 0, endereco: 0 },
    expected: {
      title: 'Pessoa Desenvolvedora Backend',
      seniorityLevels: ['pleno'],
      yearsExperienceMin: null,
      workModels: ['remoto'],
      location: null,
      salary: null,
      contractTypes: ['clt'],
      stackRequired: ['Node.js'],
      stackNiceToHave: [],
      benefits: [],
      languageRequirements: [],
      redFlagSignals: [],
    },
    alternatives: {},
    injection: null,
    notes: '',
    ...overrides,
  };
}

function synthCase(n: number, category: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const injection = category.startsWith('injection')
    ? { technique: category === 'injection_oculta' ? 'zero_width' : 'texto_visivel', goal: 'nota', canary: `TRAMPO-CANARY-${String(n).padStart(2, '0')}` }
    : null;
  return baseCase({
    id: `syn-${String(n).padStart(2, '0')}-caso-teste`,
    source: 'sintetico',
    platform: 'texto_colado',
    batch: 'sintetico',
    synthetic: true,
    category,
    injection,
    ...extra,
  });
}

let root: string;

function write(dir: 'real' | 'synthetic', c: Record<string, unknown>, text = TEXT, id = String(c['id'])): void {
  writeFileSync(join(root, dir, `${id}.case.json`), JSON.stringify(c));
  writeFileSync(join(root, dir, `${id}.job.txt`), text);
}

function problems(): string[] {
  return validateDataset(root, { checkCoverage: false }).findings.map((f) => `${f.where}: ${f.problem}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trampo-golden-'));
  mkdirSync(join(root, 'real'));
  mkdirSync(join(root, 'synthetic'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('validateDataset', () => {
  it('aceita um caso real válido', () => {
    write('real', baseCase());
    expect(problems()).toEqual([]);
  });

  it('acusa arquivo sem par e extensão estranha, mas ignora .gitkeep', () => {
    writeFileSync(join(root, 'real', 'linkedin-02.job.txt'), TEXT);
    writeFileSync(join(root, 'real', 'linkedin-03.case.json'), '{}');
    writeFileSync(join(root, 'real', 'notas.md'), 'x');
    writeFileSync(join(root, 'real', '.gitkeep'), '');
    expect(problems()).toEqual(['real/notas.md: arquivo_sem_par', 'real/linkedin-02: arquivo_sem_par', 'real/linkedin-03: arquivo_sem_par']);
  });

  it('acusa JSON inválido e schema inválido, e expõe só caminho e código do schema', () => {
    writeFileSync(join(root, 'real', 'linkedin-01.case.json'), '{ nao e json');
    writeFileSync(join(root, 'real', 'linkedin-01.job.txt'), TEXT);
    write('real', baseCase({ id: 'linkedin-02', category: 'inexistente' }));
    expect(problems()).toEqual(['real/linkedin-01: json_invalido', 'real/linkedin-02: schema_invalido']);
    expect(schemaIssues(root, 'linkedin-02')).toEqual([expect.stringMatching(/^category: /)]);
    expect(schemaIssues(root, 'linkedin-01')).toEqual([]);
    expect(schemaIssues(root, 'nao-existe')).toEqual([]);
  });

  it('acusa id diferente do arquivo e id duplicado', () => {
    write('real', baseCase(), TEXT, 'linkedin-09');
    write('real', baseCase(), TEXT, 'linkedin-01');
    expect(problems()).toEqual(['real/linkedin-09: id_diferente_do_arquivo', 'real/linkedin-09: id_duplicado']);
  });

  it('acusa sintético na pasta real e real na pasta de sintéticos', () => {
    write('real', synthCase(1, 'normal'));
    write('synthetic', baseCase());
    expect(problems()).toEqual(['real/syn-01-caso-teste: pasta_incoerente_com_sintetico', 'synthetic/linkedin-01: pasta_incoerente_com_sintetico']);
  });

  it('acusa texto curto e longo demais (em code points)', () => {
    write('real', baseCase(), 'curto');
    write('real', baseCase({ id: 'linkedin-02', tags: ['sem_salario', 'remoto', 'longa'] }), 'a'.repeat(15_001));
    expect(problems()).toEqual(['real/linkedin-01: texto_curto_demais', 'real/linkedin-02: texto_longo_demais']);
  });

  it('acusa PII no texto e no JSON, mesmo com o JSON inválido, sem ecoar o trecho', () => {
    write('real', baseCase(), `${TEXT} contato: fulana@empresa.com.br`);
    write('real', baseCase({ id: 'linkedin-02', notes: 'ligar (11) 91234-5678' }));
    writeFileSync(join(root, 'real', 'linkedin-03.case.json'), '{ 123.456.789-09');
    writeFileSync(join(root, 'real', 'linkedin-03.job.txt'), TEXT);
    const found = problems();
    expect(found).toContain('real/linkedin-01: pii_email');
    expect(found).toContain('real/linkedin-02: pii_telefone');
    expect(found).toContain('real/linkedin-03: pii_cpf');
    expect(found.join('\n')).not.toMatch(/fulana|91234|123\.456/);
  });

  it('acusa invisível fora de injection_oculta e aceita dentro dela', () => {
    write('real', baseCase(), `${TEXT}​`);
    write('synthetic', synthCase(1, 'injection_oculta'), `${TEXT}\u{E0049}​`);
    expect(problems()).toEqual(['real/linkedin-01: invisivel_fora_de_injection_oculta']);
  });

  it('acusa sobra do cabeçalho do raw', () => {
    write('real', baseCase(), `suspeita_injection: não\n${TEXT}`);
    expect(problems()).toEqual(['real/linkedin-01: cabecalho_do_raw_no_texto']);
  });

  it('acusa canary repetido entre casos de injection', () => {
    write('synthetic', synthCase(1, 'injection_visivel'));
    write('synthetic', synthCase(2, 'injection_visivel', { injection: { technique: 'texto_visivel', goal: 'url', canary: 'TRAMPO-CANARY-01' } }));
    expect(problems()).toEqual(['synthetic/syn-02-caso-teste: canary_duplicado']);
  });

  it('cobra 2 casos por categoria quando a cobertura está ligada', () => {
    write('real', baseCase());
    write('real', baseCase({ id: 'linkedin-02' }));
    const report = validateDataset(root);
    expect(report.totals.byCategory.normal).toBe(2);
    expect(report.findings.map((f) => f.where)).toEqual([
      'categoria/ambigua',
      'categoria/injection_visivel',
      'categoria/injection_oculta',
      'categoria/controle_negativo',
      'categoria/armadilha_negacao',
    ]);
  });
});

describe('GoldenCaseSchema (regras cruzadas)', () => {
  const issues = (c: Record<string, unknown>): string[] => {
    const r = GoldenCaseSchema.safeParse(c);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('recusa tag e armadilha duplicadas', () => {
    expect(issues(baseCase({ tags: ['sem_salario', 'remoto', 'curta', 'remoto'], traps: ['negacao', 'negacao'] }))).toEqual([
      'tag_duplicada',
      'armadilha_duplicada',
    ]);
  });

  it('recusa marcação de sintético incoerente e id que não bate com a fonte', () => {
    expect(issues(baseCase({ synthetic: true }))).toContain('marcacao_de_sintetico_incoerente');
    expect(issues(synthCase(1, 'normal', { batch: 'hitl-003' }))).toContain('marcacao_de_sintetico_incoerente');
    expect(issues(baseCase({ id: 'gupy-01' }))).toEqual(['id_nao_bate_com_a_fonte']);
  });

  it('exige metadado de injection só nas categorias de injection', () => {
    expect(issues(baseCase({ category: 'injection_visivel' }))).toEqual(['injection_sem_metadado_ou_metadado_sem_injection']);
    expect(issues(synthCase(1, 'normal', { injection: { technique: 'bidi', goal: 'fato', canary: 'TRAMPO-CANARY-01' } }))).toEqual([
      'injection_sem_metadado_ou_metadado_sem_injection',
    ]);
  });

  it('recusa salario_omitido no gabarito', () => {
    const c = baseCase();
    c['expected'] = { ...(c['expected'] as object), redFlagSignals: ['salario_omitido'] };
    expect(issues(c)).toEqual(['salario_omitido_no_gabarito', 'tag_derivada_incoerente:red_flag']);
  });

  it('aceita ARS no gabarito, recusa moeda nula em vaga estrangeira e exige tags coerentes', () => {
    const ars = { min: 3_800_000, max: 3_900_000, currency: 'ARS', period: 'mes' };
    const argentina = { city: null, stateUf: null, countryIso2: 'AR' };
    const withSalary = (salary: unknown): Record<string, unknown> => {
      const c = baseCase({ tags: ['com_salario', 'remoto', 'curta', 'moeda_estrangeira', 'internacional'] });
      c['expected'] = { ...(c['expected'] as object), salary, location: argentina };
      return c;
    };
    expect(issues(withSalary(ars))).toEqual([]);
    expect(issues(withSalary({ ...ars, currency: null }))).toContain('moeda_nula_em_vaga_internacional');
    const brazil = baseCase({ tags: ['com_salario', 'remoto', 'curta'] });
    brazil['expected'] = { ...(brazil['expected'] as object), salary: { ...ars, currency: null } };
    expect(issues(brazil)).toEqual([]);
    expect(issues(baseCase({ tags: ['com_salario', 'remoto', 'curta'] }))).toEqual(['tag_de_salario_incoerente']);
    const both = withSalary(ars);
    both['tags'] = ['com_salario', 'sem_salario', 'remoto', 'curta', 'moeda_estrangeira', 'internacional'];
    expect(issues(both)).toEqual(['tag_de_salario_incoerente']);
  });

  it('recusa a chave contractGaps do schema v1 e a versão 1', () => {
    expect(GoldenCaseSchema.safeParse(baseCase({ contractGaps: [] })).success).toBe(false);
    expect(GoldenCaseSchema.safeParse(baseCase({ caseSchemaVersion: 1 })).success).toBe(false);
  });

  it('valida cada alternativa pelo schema do campo e recusa campo desconhecido', () => {
    expect(issues(baseCase({ alternatives: { seniorityLevels: [['junior'], ['pleno', 'senior']] } }))).toEqual([]);
    expect(issues(baseCase({ alternatives: { seniorityLevels: [['chefe']] } }))).toEqual(['alternativa_invalida']);
    expect(issues(baseCase({ alternatives: { nota: [100] } }))).toEqual(['alternativa_de_campo_desconhecido']);
  });

  it('aceita pressao_excessiva no gabarito (ADR-002 §8.1), com a tag red_flag', () => {
    const c = baseCase({ tags: ['sem_salario', 'remoto', 'curta', 'red_flag'] });
    c['expected'] = { ...(c['expected'] as object), redFlagSignals: ['pressao_excessiva'] };
    expect(issues(c)).toEqual([]);
  });
});

describe('verificações de texto', () => {
  it('acha cada tipo de PII e não acusa texto comum de vaga', () => {
    expect(findPii('escreva para rh@empresa.com')).toEqual(['email', 'url']);
    expect(findPii('WhatsApp +55 11 91234-5678')).toEqual(['telefone']);
    expect(findPii('fixo (21) 3456 7890')).toEqual(['telefone']);
    expect(findPii('CPF 123.456.789-09')).toEqual(['cpf']);
    expect(findPii('CNPJ 12.345.678/0001-90')).toEqual(['cnpj']);
    expect(findPii('veja https://exemplo.dev/vaga')).toEqual(['url']);
    expect(findPii('siga @empresa_exemplo no Instagram')).toEqual(['url']);
    expect(findPii('Node.js, ASP.NET, Vue.js; salário de R$ 3.800.000,00; AR$ 3.900.000,00; 2 a 4 anos')).toEqual([]);
  });

  it('tolera ZWJ e VS16 dentro de emoji, CRLF e tabulação; recusa o resto', () => {
    expect(hasForbiddenInvisible('Benefícios ❤️ 👩‍💻 👍🏽 1️⃣\r\n\titem')).toBe(false);
    expect(hasForbiddenInvisible('texto​escondido')).toBe(true);
    expect(hasForbiddenInvisible('a️b')).toBe(true);
    expect(hasForbiddenInvisible('tag \u{E0041}')).toBe(true);
    expect(hasForbiddenInvisible('bidi ‮')).toBe(true);
  });

  it('acha sobra de cabeçalho só no começo de linha', () => {
    expect(hasRawHeaderLeftover('x\ncoletada_em: 2026-10-19')).toBe(true);
    expect(hasRawHeaderLeftover('a vaga diz plataforma: interna')).toBe(false);
  });

  it('conta code points, não unidades UTF-16', () => {
    expect(countCodePoints('a👩‍💻')).toBe(4);
  });
});

describe('tags derivadas do gabarito', () => {
  const facts = (over: Record<string, unknown>): Record<string, unknown> => ({ ...(baseCase()['expected'] as object), ...over });
  const issues = (c: Record<string, unknown>): string[] => {
    const r = GoldenCaseSchema.safeParse(c);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('calcula cada tag derivada', () => {
    const parsed = GoldenCaseSchema.parse(
      baseCase({
        id: 'gupy-16',
        source: 'gupy',
        platform: 'gupy',
        batch: 'hitl-017',
        tags: ['estresse', 'com_salario', 'moeda_estrangeira', 'internacional', 'salario_hora', 'clt_ou_pj', 'estagio', 'dupla_senioridade', 'remoto', 'hibrido', 'remoto_ou_hibrido', 'ingles', 'red_flag', 'curta'],
        expected: facts({
          seniorityLevels: ['estagio', 'junior'],
          workModels: ['remoto', 'hibrido'],
          salary: { min: 30, max: 40, currency: 'USD', period: 'hora' },
          contractTypes: ['clt', 'pj', 'estagio'],
          languageRequirements: [{ language: 'ingles', level: null, required: false }],
          redFlagSignals: ['linguagem_vaga'],
        }),
      }),
    );
    expect([...derivedTags(parsed)].sort()).toEqual(
      ['clt_ou_pj', 'dupla_senioridade', 'estagio', 'estresse', 'hibrido', 'ingles', 'internacional', 'moeda_estrangeira', 'red_flag', 'remoto', 'salario_hora'].sort(),
    );
  });

  it('usa a moeda e o período do salário, e o país da localização', () => {
    const c = GoldenCaseSchema.parse(
      baseCase({
        tags: ['com_salario', 'presencial', 'curta', 'moeda_estrangeira', 'internacional', 'salario_ano', 'so_pj'],
        expected: facts({
          workModels: ['presencial'],
          contractTypes: ['pj'],
          salary: { min: 1, max: 2, currency: 'ARS', period: 'ano' },
          location: { city: null, stateUf: null, countryIso2: 'AR' },
        }),
      }),
    );
    expect([...derivedTags(c)].sort()).toEqual(['internacional', 'moeda_estrangeira', 'presencial', 'salario_ano', 'so_pj']);
    const br = GoldenCaseSchema.parse(baseCase({ expected: facts({ location: { city: null, stateUf: 'SP', countryIso2: 'BR' } }) }));
    expect(derivedTags(br).has('internacional')).toBe(false);
  });

  it('recusa tag derivada ausente ou sobrando, e remoto_ou_hibrido sem os dois modelos', () => {
    expect(issues(baseCase({ tags: ['sem_salario', 'curta'] }))).toEqual(['tag_derivada_incoerente:remoto']);
    expect(issues(baseCase({ tags: ['sem_salario', 'remoto', 'curta', 'internacional'] }))).toEqual(['tag_derivada_incoerente:internacional']);
    expect(issues(baseCase({ tags: ['sem_salario', 'remoto', 'curta', 'remoto_ou_hibrido'] }))).toEqual(['tag_derivada_incoerente:remoto_ou_hibrido']);
  });

  it('mede curta e longa e acusa tag de tamanho incoerente', () => {
    expect([lengthTag(1499), lengthTag(1500), lengthTag(8000), lengthTag(8001)]).toEqual(['curta', null, null, 'longa']);
    write('real', baseCase({ tags: ['sem_salario', 'remoto'] }));
    write('real', baseCase({ id: 'linkedin-02', tags: ['sem_salario', 'remoto', 'curta'] }), 'b'.repeat(1600));
    expect(problems()).toEqual(['real/linkedin-01: tag_de_tamanho_incoerente', 'real/linkedin-02: tag_de_tamanho_incoerente']);
  });
});
