// Helpers HTTP compartilhados pelos adapters de LLM (ADR-022 D2). O comportamento ponta a ponta já é provado nos
// testes da Workers AI (e no do Groq); aqui ficam as bordas que um servidor simulado não alcança com facilidade.
import { describe, expect, test } from "vitest";
import { z } from "zod";

import { LEDGER_POLICY } from "../../src/application/index.js";
import {
  NO_USAGE,
  PERMANENT_FAILURE,
  TRANSIENT_FAILURE,
  decodeUtf8,
  failureForStatus,
  parseEnvelope,
  readCapped,
  usageFrom,
} from "../../src/infrastructure/llm/llm-http.js";

function streamOf(...chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size).fill(0x61));
      controller.close();
    },
  });
}

describe("failureForStatus (tabela de status ≠ 200)", () => {
  test.each([408, 500, 503, 599])("%i → erro_transitorio", (status) => {
    expect(failureForStatus(status, null)).toBe(TRANSIENT_FAILURE);
  });

  test.each([201, 204, 301, 302, 400, 401, 403, 404, 407, 409, 413, 422, 428, 430, 499, 600, 999])(
    "%i → erro_permanente",
    (status) => {
      expect(failureForStatus(status, null)).toBe(PERMANENT_FAILURE);
    },
  );

  test("429 → limite_de_taxa com o Retry-After em ms, ou null", () => {
    expect(failureForStatus(429, "46")).toEqual({ ok: false, failure: "limite_de_taxa", retryAfterMs: 46_000 });
    expect(failureForStatus(429, null)).toEqual({ ok: false, failure: "limite_de_taxa", retryAfterMs: null });
  });

  test("os resultados de falha são congelados", () => {
    expect(Object.isFrozen(PERMANENT_FAILURE)).toBe(true);
    expect(Object.isFrozen(TRANSIENT_FAILURE)).toBe(true);
    expect(Object.isFrozen(NO_USAGE)).toBe(true);
  });
});

describe("readCapped e decodeUtf8", () => {
  test("lê até o teto exato e devolve null a partir de 1 byte acima", async () => {
    expect((await readCapped(streamOf(10, 6), 16))?.byteLength).toBe(16);
    expect(await readCapped(streamOf(10, 7), 16)).toBeNull();
  });

  test("UTF-8 estrito: sequência inválida dá null", () => {
    expect(decodeUtf8(Buffer.from("ção", "utf8"))).toBe("ção");
    expect(decodeUtf8(Buffer.from([0x61, 0xff, 0x62]))).toBeNull();
  });
});

describe("parseEnvelope", () => {
  const Schema = z.object({ a: z.number() });

  test("válido devolve o dado; JSON inválido, schema falho ou chave de protótipo dão null", () => {
    expect(parseEnvelope('{"a":1,"extra":true}', Schema)).toEqual({ a: 1 });
    expect(parseEnvelope("{", Schema)).toBeNull();
    expect(parseEnvelope('{"a":"1"}', Schema)).toBeNull();
    expect(parseEnvelope('{"a":1,"__proto__":{"x":1}}', Schema)).toBeNull();
  });
});

describe("usageFrom", () => {
  test("formato OpenAI vira TokenUsage; ausente, fracionário, negativo ou acima do teto vira zero", () => {
    expect(usageFrom({ prompt_tokens: 2_500, completion_tokens: 400, x: 1 })).toEqual({
      inputTokens: 2_500,
      outputTokens: 400,
    });
    for (const usage of [
      undefined,
      null,
      { prompt_tokens: 1 },
      { prompt_tokens: 1.5, completion_tokens: 1 },
      { prompt_tokens: -1, completion_tokens: 1 },
      { prompt_tokens: LEDGER_POLICY.maxTokensPerCall + 1, completion_tokens: 1 },
    ]) {
      expect(usageFrom(usage)).toBe(NO_USAGE);
    }
  });
});
