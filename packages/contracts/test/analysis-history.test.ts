import { describe, expect, test } from 'vitest';

import {
  ANALYSIS_FEEDBACK_ROUTE,
  AnalysisFeedbackParamsSchema,
  AnalysisFeedbackRequestSchema,
  analysisFeedbackPath,
} from '../src/api.js';
import * as limits from '../src/limits.js';

const ID = '0f8e2b9c-4d1a-4c6e-9b3f-2a7d5e8c1b40';

describe('limites da gravação das análises (ADR-031 D2 e D3)', () => {
  test('retenção, teto diário e o corpo do feedback na fonte única', () => {
    expect(limits.ANALYSES_RETENTION_DAYS).toBe(90);
    expect(limits.ANALYSES_DAILY_ROW_CAP).toBe(100);
    expect(limits.ANALYSIS_FEEDBACK_BODY_MAX_BYTES).toBe(256);
  });

  test('o maior corpo válido do feedback cabe no teto com folga', () => {
    const body = JSON.stringify({ agreement: 'discordo', reason: 'fato_extraido_errado' });
    expect(AnalysisFeedbackRequestSchema.safeParse(JSON.parse(body)).success).toBe(true);
    expect(body.length).toBeLessThan(limits.ANALYSIS_FEEDBACK_BODY_MAX_BYTES / 2);
  });
});

describe('rota do feedback (ADR-031 D4)', () => {
  test('o padrão registrado é exato', () => {
    expect(ANALYSIS_FEEDBACK_ROUTE).toBe('/v1/analyses/:analysisId/feedback');
  });

  test('o parâmetro é só um UUID, em objeto estrito', () => {
    expect(AnalysisFeedbackParamsSchema.parse({ analysisId: ID })).toEqual({ analysisId: ID });
    for (const analysisId of ['', 'abc', `${ID}x`, `${ID}/../x`, ID.toUpperCase().replace(/-/g, ''), '..']) {
      expect(AnalysisFeedbackParamsSchema.safeParse({ analysisId }).success).toBe(false);
    }
    expect(AnalysisFeedbackParamsSchema.safeParse({ analysisId: ID, userId: ID }).success).toBe(false);
    expect(AnalysisFeedbackParamsSchema.safeParse({}).success).toBe(false);
  });

  test('o caminho de uma análise sai do padrão e só aceita UUID', () => {
    expect(analysisFeedbackPath(ID)).toBe(`/v1/analyses/${ID}/feedback`);
    for (const hostile of ['', '..', '../account/delete', `${ID}/x`, `${ID}?a=1`, 'x'.repeat(36)]) {
      expect(() => analysisFeedbackPath(hostile)).toThrow();
    }
  });

  test('o corpo continua estrito e sem dono', () => {
    expect(AnalysisFeedbackRequestSchema.safeParse({ agreement: 'concordo', reason: null }).success).toBe(true);
    expect(AnalysisFeedbackRequestSchema.safeParse({ agreement: 'concordo', reason: null, userId: ID }).success).toBe(false);
    expect(AnalysisFeedbackRequestSchema.safeParse({ agreement: 'concordo' }).success).toBe(false);
  });
});
