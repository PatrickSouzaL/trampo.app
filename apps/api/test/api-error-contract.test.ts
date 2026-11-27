// F1-EXT-09 (ADR-017, emenda da sessão 34; condição 1): a tabela de ApiError entre a API e a extensão. Cada linha de
// `packages/contracts/fixtures/api-errors.json` é exatamente o que o `apiError` da API produz para aquele código, com o
// id do servidor no `requestId`. A extensão lê a mesma tabela no teste dela, pelo `analysis-service` real: os dois
// lados conferem o mesmo arquivo, sem import cruzado.
import { readFileSync } from "node:fs";

import { ApiErrorCodeSchema, ApiErrorSchema } from "@trampo/contracts/api";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import { apiError } from "../src/presentation/api-error.js";

const TableSchema = z.strictObject({
  comment: z.string(),
  serverRequestId: z.uuid(),
  rows: z.array(z.strictObject({ status: z.int(), statusOverride: z.literal(true).optional(), body: ApiErrorSchema })).min(1),
});

const table = TableSchema.parse(JSON.parse(readFileSync(new URL("../../../packages/contracts/fixtures/api-errors.json", import.meta.url), "utf8")));

describe("a tabela de ApiError do contrato (F1-EXT-09)", () => {
  test("cobre todo código do ApiErrorCodeSchema, e o requestId de toda linha é o id do servidor", () => {
    expect(new Set(table.rows.map((row) => row.body.code))).toEqual(new Set(ApiErrorCodeSchema.options));
    for (const row of table.rows) expect(row.body.requestId).toBe(table.serverRequestId);
  });

  test.each(table.rows.map((row) => [`${row.status} ${row.body.code}`, row] as const))("%s é o que o apiError da API produz", (_name, row) => {
    const produced = apiError(row.body.code, table.serverRequestId, {
      retryAfterSeconds: row.body.retryAfterSeconds,
      ...(row.statusOverride === true ? { status: row.status } : {}),
    });
    expect(produced).toEqual({ status: row.status, body: row.body });
  });
});
