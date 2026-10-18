// Invariantes do contrato sem teste na suíte original de 21 (lacunas achadas pela cobertura na M3).
import { expect, test } from 'vitest';
import { LocationFactsSchema } from '../src/job-facts.js';

test('LocationFacts: basta um campo; todos null é "use null no objeto" (localizacao_vazia_use_null)', () => {
  expect(LocationFactsSchema.safeParse({ city: 'Recife', stateUf: null, countryIso2: null }).success).toBe(true);
  expect(LocationFactsSchema.safeParse({ city: null, stateUf: 'PE', countryIso2: null }).success).toBe(true);
  expect(LocationFactsSchema.safeParse({ city: null, stateUf: null, countryIso2: 'BR' }).success).toBe(true);

  const empty = LocationFactsSchema.safeParse({ city: null, stateUf: null, countryIso2: null });
  expect(empty.success).toBe(false);
  expect(empty.error?.issues[0]?.message).toBe('localizacao_vazia_use_null');
});

test('LocationFacts: país só em ISO 3166-1 alfa-2 maiúsculo', () => {
  for (const countryIso2 of ['br', 'BRA', 'B', '']) {
    expect(LocationFactsSchema.safeParse({ city: null, stateUf: null, countryIso2 }).success, countryIso2).toBe(false);
  }
});
