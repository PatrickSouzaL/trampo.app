// F1-API-04 parte 2 (ADR-017 D6): o escritor SSE isolado. Enquadramento, validação antes de escrever, fim único
// e nada escrito depois do fim ou com o cliente fora (readable destruído).
import { type AnalysisStreamEvent, AnalysisStreamEventSchema } from "@trampo/contracts/api";
import { describe, expect, test } from "vitest";

import { SSE_CONTENT_TYPE, SSE_HEADERS, SseEventContractError, SseStream, encodeSseEvent } from "../src/presentation/streaming/sse-stream.js";

const STAGE: AnalysisStreamEvent = { type: "stage", stage: "normalizando", elapsedMs: 3 };
const ERROR: AnalysisStreamEvent = {
  type: "error",
  error: { code: "ERRO_INTERNO", message: "Erro interno. Tente de novo em instantes.", requestId: null, retryAfterSeconds: null },
};

async function drain(sse: SseStream): Promise<string> {
  let out = "";
  for await (const chunk of sse.readable) out += String(chunk);
  return out;
}

describe("encodeSseEvent", () => {
  test("um evento: `event:` com o tipo e um único `data:` com o JSON, terminado por linha em branco", () => {
    expect(encodeSseEvent(STAGE)).toBe(`event: stage\ndata: {"type":"stage","stage":"normalizando","elapsedMs":3}\n\n`);
    const frame = encodeSseEvent(ERROR);
    const [event, data, ...rest] = frame.split("\n");
    expect(event).toBe("event: error");
    expect(AnalysisStreamEventSchema.parse(JSON.parse(String(data).slice("data: ".length)))).toEqual(ERROR);
    expect(rest).toEqual(["", ""]);
  });

  test("sem `id:` e sem `retry:` (o cliente não reconecta)", () => {
    for (const event of [STAGE, ERROR]) expect(encodeSseEvent(event)).not.toMatch(/^(?:id|retry):/m);
  });

  test.each<[string, unknown]>([
    ["elapsedMs acima do teto", { type: "stage", stage: "recebido", elapsedMs: 120_001 }],
    ["elapsedMs negativo", { type: "stage", stage: "recebido", elapsedMs: -1 }],
    ["estágio fora do enum", { type: "stage", stage: "segredo-do-estagio", elapsedMs: 0 }],
    ["campo extra", { ...STAGE, extra: "segredo" }],
    ["tipo desconhecido", { type: "fim" }],
    ["relatório inválido", { type: "result", report: { segredo: "valor-do-relatorio" } }],
  ])("fora do contrato (%s): lança com mensagem fixa, sem ecoar valores", (_name, event) => {
    let thrown: unknown;
    try {
      encodeSseEvent(event as AnalysisStreamEvent);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SseEventContractError);
    expect(thrown).toMatchObject({ name: "SseEventContractError", message: "Evento fora do AnalysisStreamEventSchema." });
  });

  test("cabeçalhos do stream (ADR-017 D6)", () => {
    expect(SSE_CONTENT_TYPE).toBe("text/event-stream; charset=utf-8");
    expect(SSE_HEADERS).toEqual({ "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering": "no" });
  });
});

describe("SseStream", () => {
  test("escreve na ordem e termina uma vez", async () => {
    const sse = new SseStream();
    expect(sse.open).toBe(true);
    expect(sse.write(STAGE)).toBe(true);
    expect(sse.write(ERROR)).toBe(true);
    sse.end();
    expect(sse.open).toBe(false);
    sse.end();
    expect(await drain(sse)).toBe(encodeSseEvent(STAGE) + encodeSseEvent(ERROR));
  });

  test("depois do fim, nada é escrito (sem `push after EOF`)", async () => {
    const sse = new SseStream();
    sse.write(STAGE);
    sse.end();
    expect(sse.write(ERROR)).toBe(false);
    expect(await drain(sse)).toBe(encodeSseEvent(STAGE));
  });

  test("cliente fora (readable destruído): write descarta, end não lança, nenhum erro no readable", () => {
    const sse = new SseStream();
    const errors: unknown[] = [];
    sse.readable.on("error", (error) => errors.push(error));
    sse.readable.destroy();
    expect(sse.open).toBe(false);
    expect(sse.write(STAGE)).toBe(false);
    expect(() => {
      sse.end();
    }).not.toThrow();
    expect(errors).toEqual([]);
  });

  test("evento inválido: lança e nada é escrito; o stream continua aberto", async () => {
    const sse = new SseStream();
    expect(() => sse.write({ type: "stage", stage: "recebido", elapsedMs: -5 })).toThrow(SseEventContractError);
    expect(sse.open).toBe(true);
    sse.write(STAGE);
    sse.end();
    expect(await drain(sse)).toBe(encodeSseEvent(STAGE));
  });
});
