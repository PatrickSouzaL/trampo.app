// F1-EXT-04 parte 2, 04b-1 (ADR-025 §6 D8): o leitor do SSE do /v1/analyze. Só a forma do servidor (ADR-017 D6), cada
// `data:` no AnalysisStreamEventSchema, o `stage` na hora e o terminal só no fim, se nada vier depois dele.
import type { AnalysisStreamEvent } from "@trampo/contracts/api";
import { describe, expect, test } from "vitest";

import { createSseReader } from "../src/api/sse-reader";
import { REPORT, REQUEST_ID } from "./fixtures/stream";

const STAGE: AnalysisStreamEvent = { type: "stage", stage: "recebido", elapsedMs: 0 };
const STAGE2: AnalysisStreamEvent = { type: "stage", stage: "pontuando", elapsedMs: 1200 };
const RESULT: AnalysisStreamEvent = { type: "result", report: REPORT };
const ERROR: AnalysisStreamEvent = {
  type: "error",
  error: { code: "ERRO_INTERNO", message: "Erro interno.", requestId: REQUEST_ID, retryAfterSeconds: null },
};

const frame = (event: AnalysisStreamEvent, name: string = event.type): string => `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;

function read(...pieces: string[]) {
  const stages: AnalysisStreamEvent[] = [];
  const reader = createSseReader((event) => stages.push(event));
  const feeds = pieces.map((piece) => reader.push(piece));
  return { stages, feeds, end: reader.end(), reader };
}

describe("forma do servidor (ADR-017 D6)", () => {
  test("stages na hora e o resultado no fim: completo", () => {
    const { stages, feeds, end } = read(frame(STAGE), frame(STAGE2), frame(RESULT));
    expect(stages).toEqual([STAGE, STAGE2]);
    expect(feeds).toEqual(["seguir", "seguir", "seguir"]);
    expect(end).toEqual({ kind: "completo", terminal: RESULT });
  });

  test("o erro também é terminal", () => {
    expect(read(frame(STAGE), frame(ERROR)).end).toEqual({ kind: "completo", terminal: ERROR });
  });

  test("o stage sai na linha em branco, antes do fim do stream", () => {
    const stages: AnalysisStreamEvent[] = [];
    const reader = createSseReader((event) => stages.push(event));
    const text = frame(STAGE);
    expect(reader.push(text.slice(0, -1))).toBe("seguir");
    expect(stages).toEqual([]);
    expect(reader.push("\n")).toBe("seguir");
    expect(stages).toEqual([STAGE]);
  });

  test("pedaços de qualquer tamanho dão o mesmo resultado", () => {
    const text = frame(STAGE) + frame(STAGE2) + frame(RESULT);
    for (const size of [1, 2, 3, 7, 64, 1000]) {
      const pieces: string[] = [];
      for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
      const { stages, end } = read(...pieces);
      expect(stages).toEqual([STAGE, STAGE2]);
      expect(end).toEqual({ kind: "completo", terminal: RESULT });
    }
  });

  test("U+2028 dentro do JSON não é fim de linha", () => {
    const report = { ...REPORT, summary: "linha outra" };
    const event = { type: "result", report } as AnalysisStreamEvent;
    const parsed = read(frame(event)).end;
    expect(parsed.kind).toBe("completo");
  });
});

describe("terminal só no fim", () => {
  test("o terminal não sai antes do fim do stream", () => {
    const { reader } = read(frame(RESULT));
    expect(reader.end()).toEqual({ kind: "completo", terminal: RESULT });
  });

  test.each([
    ["outro evento", frame(STAGE)],
    ["outro terminal", frame(ERROR)],
    ["um byte", "x"],
    ["uma linha em branco", "\n"],
  ])("%s depois do terminal é violação, e o terminal se perde", (_nome, extra) => {
    const { feeds, end, stages } = read(frame(RESULT), extra);
    expect(feeds).toEqual(["seguir", "violacao"]);
    expect(end).toEqual({ kind: "violacao" });
    expect(stages).toEqual([]);
  });

  test("sem terminal: incompleto", () => {
    expect(read(frame(STAGE)).end).toEqual({ kind: "incompleto" });
    expect(read().end).toEqual({ kind: "incompleto" });
  });

  test.each([
    ["no meio do event", "event: res"],
    ["depois do event", "event: result\n"],
    ["no meio do data", `event: result\ndata: {"type":"res`],
    ["sem a linha em branco", `event: result\ndata: ${JSON.stringify(RESULT)}\n`],
  ])("corte %s: incompleto, nada sai", (_nome, text) => {
    const { end, stages } = read(frame(STAGE), text);
    expect(stages).toEqual([STAGE]);
    expect(end).toEqual({ kind: "incompleto" });
  });
});

describe("qualquer outra forma é violação", () => {
  const data = `data: ${JSON.stringify(STAGE)}`;
  test.each([
    ["comentário", `: keep-alive\n\n`],
    ["id", `id: 1\nevent: stage\n${data}\n\n`],
    ["retry", `retry: 1000\nevent: stage\n${data}\n\n`],
    ["data sem event", `${data}\n\n`],
    ["dois data", `event: stage\n${data}\n${data}\n\n`],
    ["linha em branco solta", `\n`],
    ["event sem espaço", `event:stage\n${data}\n\n`],
    ["data sem espaço", `event: stage\ndata:${JSON.stringify(STAGE)}\n\n`],
    ["dois espaços", `event:  stage\n${data}\n\n`],
    ["event duas vezes", `event: stage\nevent: stage\n${data}\n\n`],
    ["campo desconhecido", `foo: bar\n\n`],
    ["CRLF", `event: stage\r\n${data}\r\n\r\n`],
    ["CR no fim do event", `event: stage\r\n${data}\n\n`],
    ["CR solto", `event: stage\n${data}\n\r\n`],
    ["event com outro nome", frame(STAGE, "result")],
    ["event desconhecido", frame(STAGE, "progresso")],
    ["event vazio", frame(STAGE, "")],
    ["JSON quebrado", `event: stage\ndata: {"type":\n\n`],
    ["JSON fora do contrato", `event: stage\ndata: {"type":"stage","stage":"recebido","elapsedMs":-1}\n\n`],
    ["chave extra", `event: stage\ndata: ${JSON.stringify({ ...STAGE, extra: 1 })}\n\n`],
    ["data vazio", `event: stage\ndata: \n\n`],
    ["linha extra antes da linha em branco", `event: stage\n${data}\nevent: stage\n\n`],
    ["CR no fim do data (o JSON.parse aceitaria)", `event: stage\n${data}\r\n\n`],
    ["outro campo de 6 caracteres com JSON válido", `event: stage\ndados:${JSON.stringify(STAGE)}\n\n`],
    ["terminal e outro evento no mesmo pedaço", frame(RESULT) + frame(STAGE)],
  ])("%s", (_nome, text) => {
    const { feeds, end, stages } = read(text);
    expect(feeds).toEqual(["violacao"]);
    expect(end).toEqual({ kind: "violacao" });
    expect(stages).toEqual([]);
  });

  test("depois da violação, nada mais sai, nem um stage válido", () => {
    const { feeds, stages, end } = read(": x\n", frame(STAGE), frame(RESULT));
    expect(feeds).toEqual(["violacao", "violacao", "violacao"]);
    expect(stages).toEqual([]);
    expect(end).toEqual({ kind: "violacao" });
  });

  test("a violação vale mesmo com o stage anterior já entregue", () => {
    const { stages, end } = read(frame(STAGE), "id: 2\n");
    expect(stages).toEqual([STAGE]);
    expect(end).toEqual({ kind: "violacao" });
  });

  test("o evento entregue é a cópia validada, sem chave do JSON cru", () => {
    const stages: AnalysisStreamEvent[] = [];
    const reader = createSseReader((event) => stages.push(event));
    reader.push(frame(STAGE));
    expect(Object.keys(stages[0] ?? {})).toEqual(["type", "stage", "elapsedMs"]);
  });

  test("um stage cujo destino lança vira violação", () => {
    const reader = createSseReader(() => {
      throw new Error("destino quebrado");
    });
    expect(reader.push(frame(STAGE))).toBe("violacao");
    expect(reader.end()).toEqual({ kind: "violacao" });
  });
});

test("o terminal e um resto sem fim de linha no mesmo pedaço: violação", () => {
  const { feeds, end } = read(`${frame(RESULT)}x`);
  expect(feeds).toEqual(["violacao"]);
  expect(end).toEqual({ kind: "violacao" });
});
