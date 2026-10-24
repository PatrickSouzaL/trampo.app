// F1-API-05 commit 1: teto de bytes do UserCriteria (ADR-021 D3 e §1.1). O pior caso válido com caracteres de 4
// bytes passaria do `check` de 16 KiB da coluna `criteria` (ADR-018 D2); o contrato o recusa antes.
import { describe, expect, test } from 'vitest';
import {
  BenefitCategorySchema,
  BrazilUfSchema,
  CRITERIA_BODY_MAX_BYTES,
  ContractTypeSchema,
  LanguageCodeSchema,
  RedFlagSignalSchema,
  SeniorityLevelSchema,
  USER_CRITERIA_MAX_JSON_BYTES,
  UserCriteriaSchema,
  WorkModelSchema,
  userCriteriaJsonBytes,
  type UserCriteria,
} from '../src/index.js';

const WEIGHTED = { level: 'ponderado', weight: 5 } as const;
/** Letra de 4 bytes em UTF-8 (`\p{L}`, plano astral, sem caixa): cada tag continua distinta sem diferenciar caixa. */
const astral = (codePoint: number): string => String.fromCodePoint(codePoint);
/** Ideograma do plano 2 (`Lo`), 4 bytes em UTF-8. */
const ideograph = (i: number): string => astral(0x20000 + i);

/** Todas as listas no teto, sem `notes`. `tag(i)` e `city(i)` decidem o alfabeto. */
function fullCriteria(tag: (i: number) => string, city: (i: number) => string): UserCriteria {
  const tags = Array.from({ length: 60 }, (_, i) => tag(i));
  return {
    schemaVersion: 1,
    workModel: { accepted: [...WorkModelSchema.options], importance: WEIGHTED },
    seniority: { accepted: [...SeniorityLevelSchema.options], importance: WEIGHTED },
    contractType: { accepted: [...ContractTypeSchema.options], importance: WEIGHTED },
    // `hora` é o período mais longo do enum: o pior caso também na pretensão.
    salary: { minimum: 9_999_999.123456789, currency: 'BRL', period: 'hora', importance: WEIGHTED },
    location: {
      acceptedUfs: [...BrazilUfSchema.options],
      acceptedCities: Array.from({ length: 10 }, (_, i) => city(i)),
      importance: WEIGHTED,
    },
    stack: {
      mustHave: tags.slice(0, 15),
      niceToHave: tags.slice(15, 45),
      dealBreakers: tags.slice(45, 60),
      dealBreakerScope: 'qualquer_mencao',
      niceToHaveWeight: 5,
    },
    languages: {
      proficiencies: LanguageCodeSchema.options.slice(0, 8).map((language) => ({ language, level: 'intermediario' })),
      importance: WEIGHTED,
    },
    benefits: { desired: [...BenefitCategorySchema.options], importance: WEIGHTED },
    redFlagTolerance: Object.fromEntries(RedFlagSignalSchema.options.map((signal) => [signal, 'eliminatorio'])) as UserCriteria['redFlagTolerance'],
    notes: null,
  };
}

/** O caso de 4 bytes do ADR-021 §1.1: tags de 40, cidades de 80 e notas de 500 code points, todos astrais. */
function astralWorstCase(): UserCriteria {
  const base = fullCriteria(
    (i) => ideograph(i) + astral(0x1d400 + (i % 52)).repeat(39),
    (i) => ideograph(0x100 + i) + astral(0x1d400).repeat(79),
  );
  return { ...base, notes: Array.from({ length: 50 }, () => ideograph(0x500).repeat(9)).join('\n') };
}

/**
 * O caso latino do ADR-021 §1.1: tags ASCII de 40 e cidades de 80. As notas são as mesmas do caso astral (4 bytes),
 * o teto realista para quem escreve com emoji; com `Ã` (2 bytes) o total cai para 6.328.
 */
function latinWorstCase(notes: 'astral' | 'latin1' = 'astral'): UserCriteria {
  const letter = (n: number): string => String.fromCharCode(65 + (n % 26));
  const base = fullCriteria(
    (i) => `T${letter(i)}${letter(Math.floor(i / 26))}${'a'.repeat(37)}`,
    (i) => `${letter(i)}${'a'.repeat(79)}`,
  );
  const line = notes === 'astral' ? ideograph(0x500).repeat(9) : 'Ã'.repeat(9);
  return { ...base, notes: Array.from({ length: 50 }, () => line).join('\n') };
}

/**
 * Perfil válido com exatamente `target` bytes. As tags astrais (163 bytes cada no JSON) põem o tamanho logo
 * abaixo do alvo, e as notas em ASCII acertam o byte: trocar `null` por `"x…x"` soma `k − 2` bytes.
 */
function criteriaWithJsonBytes(target: number): UserCriteria {
  const tag = (i: number): string => ideograph(i) + astral(0x1d400 + (i % 52)).repeat(39);
  const base = fullCriteria((i) => `t${i}`, (i) => `Cidade ${i}`);
  const stack = { ...base.stack, mustHave: [] as string[], niceToHave: [] as string[], dealBreakers: [] as string[] };
  const lists = ['mustHave', 'niceToHave', 'dealBreakers'] as const;
  const caps = { mustHave: 15, niceToHave: 30, dealBreakers: 15 };
  let candidate: UserCriteria = { ...base, stack };
  let next = 0;
  for (const list of lists) {
    while (stack[list].length < caps[list]) {
      const grown = { ...candidate, stack: { ...stack, [list]: [...stack[list], tag(next)] } };
      if (userCriteriaJsonBytes(grown) > target - 200) break;
      stack[list].push(tag(next));
      next += 1;
      candidate = { ...candidate, stack: { ...stack } };
    }
  }
  const notesLength = target - userCriteriaJsonBytes(candidate) + 2;
  return { ...candidate, notes: 'x'.repeat(notesLength) };
}

const issues = (value: unknown): string[] => {
  const result = UserCriteriaSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('UserCriteria: teto de bytes (ADR-021 D3)', () => {
  test('as constantes do ADR-021', () => {
    expect(USER_CRITERIA_MAX_JSON_BYTES).toBe(12_288);
    expect(CRITERIA_BODY_MAX_BYTES).toBe(16_384);
  });

  test('userCriteriaJsonBytes conta bytes UTF-8, não code units', () => {
    expect(userCriteriaJsonBytes('a')).toBe(3);
    expect(userCriteriaJsonBytes('Ã')).toBe(4);
    expect(userCriteriaJsonBytes(ideograph(0))).toBe(6);
    // `{"a":"x\n"}`: a quebra de linha vira o escape de 2 bytes.
    expect(userCriteriaJsonBytes({ a: 'x\n' })).toBe(11);
  });

  test('o pior caso de 4 bytes do §1.1 (16.828 bytes) é recusado só pelo teto', () => {
    const worst = astralWorstCase();
    expect(userCriteriaJsonBytes(worst)).toBe(16_828);
    expect(issues(worst)).toEqual(['criterios_grandes_demais']);
  });

  test('o pior caso latino do §1.1 (7.228 bytes) passa', () => {
    const latin = latinWorstCase();
    expect(userCriteriaJsonBytes(latin)).toBe(7_228);
    expect(issues(latin)).toEqual([]);
    expect(userCriteriaJsonBytes(latinWorstCase('latin1'))).toBe(6_328);
    expect(issues(latinWorstCase('latin1'))).toEqual([]);
  });

  test('borda: 12.288 bytes passam e 12.289 não', () => {
    const atCap = criteriaWithJsonBytes(USER_CRITERIA_MAX_JSON_BYTES);
    const overCap = criteriaWithJsonBytes(USER_CRITERIA_MAX_JSON_BYTES + 1);
    expect(userCriteriaJsonBytes(atCap)).toBe(12_288);
    expect(userCriteriaJsonBytes(overCap)).toBe(12_289);
    expect(issues(atCap)).toEqual([]);
    expect(issues(overCap)).toEqual(['criterios_grandes_demais']);
  });

  test('a medida é sobre o valor parseado: espaços que o trim remove não contam', () => {
    const atCap = criteriaWithJsonBytes(USER_CRITERIA_MAX_JSON_BYTES);
    const padded = { ...atCap, notes: `   ${atCap.notes}   ` };
    expect(userCriteriaJsonBytes(padded)).toBeGreaterThan(USER_CRITERIA_MAX_JSON_BYTES);
    expect(issues(padded)).toEqual([]);
  });

  test('o perfil no teto cabe no bodyLimit da rota, mesmo formatado com recuo', () => {
    const atCap = criteriaWithJsonBytes(USER_CRITERIA_MAX_JSON_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(atCap, null, 2)).length).toBeLessThanOrEqual(CRITERIA_BODY_MAX_BYTES);
  });

  test('entrada fora da forma é recusada pelo schema, sem o teto lançar', () => {
    const atCap = criteriaWithJsonBytes(USER_CRITERIA_MAX_JSON_BYTES);
    const cyclic: Record<string, unknown> = { ...atCap };
    cyclic['notes'] = cyclic;
    expect(UserCriteriaSchema.safeParse(cyclic).success).toBe(false);
    expect(UserCriteriaSchema.safeParse({ ...atCap, notes: 10n }).success).toBe(false);
    expect(UserCriteriaSchema.safeParse({ ...astralWorstCase(), userId: 'outro' }).success).toBe(false);
  });

  test('o schema continua sendo um objeto do zod (o refine não o embrulha)', () => {
    expect(Object.keys(UserCriteriaSchema.shape)).toContain('salary');
  });
});
