// Snapshot do JSON Schema enviado ao provedor de LLM (contratos-zod §5). Qualquer mudança no
// contrato de saída do LLM aparece como diff legível neste arquivo e exige troca de extractorVersion
// (contratos-zod §8).
import { expect, test } from 'vitest';
import { z } from 'zod';
import { JobFactsSchema } from '../src/job-facts.js';

test('JSON Schema de JobFactsSchema não mudou sem querer', async () => {
  const schema = z.toJSONSchema(JobFactsSchema, { io: 'output', unrepresentable: 'any' });
  await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot('./__snapshots__/job-facts.schema.json');
});

test('modo estrito do provedor: sem chave extra e todos os campos obrigatórios', () => {
  const schema = z.toJSONSchema(JobFactsSchema, { io: 'output', unrepresentable: 'any' }) as {
    additionalProperties: unknown;
    required: string[];
    properties: Record<string, unknown>;
  };
  expect(schema.additionalProperties).toBe(false);
  expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
});
