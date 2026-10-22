// ApiError autovalidado (contratos-zod §4.7): o que sai do contrato vira um ERRO_INTERNO fixo, e o
// Retry-After do ADR-014 D9 só aparece quando o corpo tem `retryAfterSeconds`.
import { describe, expect, test } from "vitest";

import { apiError } from "../src/presentation/api-error.js";

const REQUEST_ID = "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3";
const INTERNAL = {
  status: 500,
  body: { code: "ERRO_INTERNO", message: "Erro interno. Tente de novo em instantes.", requestId: null, retryAfterSeconds: null },
};

describe("apiError", () => {
  test("429 com retryAfterSeconds dentro do contrato", () => {
    expect(apiError("LIMITE_DE_TAXA", REQUEST_ID, { retryAfterSeconds: 17 })).toEqual({
      status: 429,
      body: {
        code: "LIMITE_DE_TAXA",
        message: "Muitas análises seguidas. Tente de novo em instantes.",
        requestId: REQUEST_ID,
        retryAfterSeconds: 17,
      },
    });
    expect(apiError("COTA_DIARIA_ESGOTADA", REQUEST_ID, { retryAfterSeconds: 86_400 }).body.retryAfterSeconds).toBe(86_400);
  });

  test.each([
    ["requestId fora de UUID", "req-1", {}],
    ["Retry-After acima de 86.400", REQUEST_ID, { retryAfterSeconds: 86_401 }],
    ["Retry-After negativo", REQUEST_ID, { retryAfterSeconds: -1 }],
    ["Retry-After fracionário", REQUEST_ID, { retryAfterSeconds: 1.5 }],
  ])("%s: ERRO_INTERNO fixo, sem ecoar nada", (_name, requestId, options) => {
    expect(apiError("LIMITE_DE_TAXA", requestId, options)).toEqual(INTERNAL);
  });
});
