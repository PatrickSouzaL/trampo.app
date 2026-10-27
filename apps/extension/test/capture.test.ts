// F1-EXT-03 parte 1 (ADR-024): limpeza do texto, validação do retorno do extrator como dado hostil e
// texto colado. O extrator em si é provado no navegador (test:browser) e no E2E do build de produção.
import { describe, expect, test, vi } from "vitest";

import {
  CapturedJobSchema,
  DISCARD_REASONS_EXHAUSTIVE,
  GENERIC_LIMITS,
  PASTED_EXTRACTOR_VERSION,
  captureFromTab,
  capturePasted,
  genericExtractorRunner,
  type ScriptingApi,
} from "../src/capture/capture";
import { cleanJobText, countCodePoints } from "../src/capture/job-text";
import { extractGenericJobText } from "../src/extraction/generic-extractor";

const MAX = 15_000;
const MIN = 200;
const body = (n: number, ch = "a") => ch.repeat(n);

describe("cleanJobText", () => {
  test("remove C0 (menos \\t e \\n), DEL e C1, e normaliza CR e CRLF para \\n", () => {
    const c0 = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join("");
    const c1 = Array.from({ length: 0x21 }, (_, i) => String.fromCharCode(0x7f + i)).join("");
    // Sobram \t (0x09), \n (0x0A) e o \r (0x0D) solto, que vira \n.
    expect(cleanJobText(`a${c0}b${c1}c`).text).toBe("a\t\n\nbc");
    expect(cleanJobText("a\r\nb\rc\nd").text).toBe("a\nb\nc\nd");
    expect(cleanJobText("a b").text).toBe("a b");
  });

  test("preserva os invisíveis de formatação para o servidor contar (ADR-023 D5)", () => {
    const cf = "​‌‍⁠‮⁦﻿️\u{E0041}\u{E007F}­";
    expect(cleanJobText(`x${cf}y`).text).toBe(`x${cf}y`);
  });

  test("remove surrogates órfãos e mantém os pares", () => {
    expect(cleanJobText("a\uD83Db").text).toBe("ab");
    expect(cleanJobText("a\uDE00b").text).toBe("ab");
    expect(cleanJobText("a\uDE00\uD83Db").text).toBe("ab");
    expect(cleanJobText("\uD83D😀").text).toBe("\u{1F600}");
    expect(cleanJobText("😀\uDE00").text).toBe("\u{1F600}");
  });

  test("um controle entre metades soltas não as junta num par (Unicode Tags)", () => {
    // U+E0041 = 󠁁. Com os controles removidos antes, as metades virariam um Tag character.
    expect(cleanJobText("x\uDB40\u0007\uDC41y").text).toBe("xy");
    expect(cleanJobText("x\uD83D\u0085\uDE00y").text).toBe("xy");
  });

  test("apara as pontas", () => {
    expect(cleanJobText(" \n\t vaga \n ").text).toBe("vaga");
    expect(cleanJobText("\u0000 vaga \u0001").text).toBe("vaga");
  });

  test("corta em JOB_TEXT_MAX_CHARS code points, exato", () => {
    const emoji = "\u{1F600}";
    expect(cleanJobText(emoji.repeat(MAX))).toEqual({ text: emoji.repeat(MAX), truncated: false });
    const cut = cleanJobText(emoji.repeat(MAX + 1));
    expect(cut.truncated).toBe(true);
    expect(countCodePoints(cut.text)).toBe(MAX);
    expect(cleanJobText(body(MAX))).toEqual({ text: body(MAX), truncated: false });
    expect(cleanJobText(`${body(MAX)}b`)).toEqual({ text: body(MAX), truncated: true });
  });

  test("os espaços que ficam na ponta depois do corte saem", () => {
    expect(cleanJobText(`${body(MAX - 2)}  bbb`)).toEqual({ text: body(MAX - 2), truncated: true });
  });

  test("countCodePoints conta pares como 1", () => {
    expect(countCodePoints("")).toBe(0);
    expect(countCodePoints("a\u{1F600}\u{E0041}")).toBe(3);
  });
});

describe("genericExtractorRunner", () => {
  test("injeta a função do extrator só no frame principal, no mundo ISOLATED, com os limites", async () => {
    const executeScript = vi.fn<ScriptingApi["executeScript"]>().mockResolvedValue("x");
    await expect(genericExtractorRunner({ executeScript })(42)).resolves.toBe("x");
    expect(executeScript).toHaveBeenCalledOnce();
    const injection = executeScript.mock.calls[0]![0];
    expect(injection).toStrictEqual({
      target: { tabId: 42 },
      world: "ISOLATED",
      injectImmediately: false,
      func: extractGenericJobText,
      args: [{ maxChars: 30_000, maxNodes: 50_000, minChars: MIN }],
    });
    expect(Object.keys(injection.target)).toEqual(["tabId"]);
  });

  test("os limites são válidos para o próprio extrator", () => {
    expect(GENERIC_LIMITS.maxChars).toBe(2 * MAX);
    expect(GENERIC_LIMITS.minChars).toBe(MIN);
    expect(DISCARD_REASONS_EXHAUSTIVE).toBe(true);
  });
});

const zeros = {
  naoTexto: 0,
  ruido: 0,
  naoRenderizado: 0,
  ariaHidden: 0,
  opacidade: 0,
  recorte: 0,
  visibilidade: 0,
  fonteMinuscula: 0,
  tamanhoZero: 0,
  foraDaTela: 0,
  cortado: 0,
  corDoFundo: 0,
};
const okResult = (texto: unknown, extra: Record<string, unknown> = {}) => ({ ok: true, versao: "ge1", raiz: "main", texto, truncado: false, descartes: zeros, ...extra });
const frame = (result: unknown, extra: Record<string, unknown> = {}) => ({ documentId: "D0C", frameId: 0, result, ...extra });
const run = (value: unknown) => () => Promise.resolve(value);

describe("captureFromTab", () => {
  test("texto válido vira vaga genérica limpa, com a versão do extrator", async () => {
    const texto = `Título\n\n${body(MIN)}\u0007​`;
    const out = await captureFromTab(7, run([frame(okResult(texto, { descartes: { ...zeros, opacidade: 3 } }))]), 1_000);
    expect(out).toEqual({
      ok: true,
      job: { tabId: 7, capturedAt: 1_000, platform: "generico", extractorVersion: "ge1", text: `Título\n\n${body(MIN)}​`, truncated: false },
    });
    expect(CapturedJobSchema.safeParse(out.ok && out.job).success).toBe(true);
  });

  test("o truncado vem do extrator ou do corte do Service Worker", async () => {
    const byExtractor = await captureFromTab(1, run([frame(okResult(body(MIN), { truncado: true }))]), 0);
    expect(byExtractor.ok && byExtractor.job.truncated).toBe(true);
    const bySw = await captureFromTab(1, run([frame(okResult("\u{1F600}".repeat(MAX + 1)))]), 0);
    expect(bySw.ok && bySw.job.truncated).toBe(true);
    expect(bySw.ok && countCodePoints(bySw.job.text)).toBe(MAX);
  });

  test("o mínimo é refeito em code points depois da limpeza", async () => {
    const exact = await captureFromTab(1, run([frame(okResult(body(MIN)))]), 0);
    expect(exact.ok).toBe(true);
    const short = await captureFromTab(1, run([frame(okResult(`${body(MIN - 1)}${"\u0001".repeat(50)}`))]), 0);
    expect(short).toEqual({ ok: false, motivo: "texto_insuficiente" });
  });

  test("rejeição do executeScript vira sem_acesso, sem levar a mensagem (que pode ter a URL)", async () => {
    const reject = () => Promise.reject(new Error("Cannot access contents of url \"https://vaga.example/123\""));
    const out = await captureFromTab(1, reject, 0);
    expect(out).toEqual({ ok: false, motivo: "sem_acesso" });
    expect(JSON.stringify(out)).not.toContain("vaga.example");
  });

  test("o extrator recusou: texto_insuficiente fica, limites_invalidos é erro", async () => {
    expect(await captureFromTab(1, run([frame({ ok: false, versao: "ge1", motivo: "texto_insuficiente" })]), 0)).toEqual({ ok: false, motivo: "texto_insuficiente" });
    expect(await captureFromTab(1, run([frame({ ok: false, versao: "ge1", motivo: "limites_invalidos" })]), 0)).toEqual({ ok: false, motivo: "erro" });
  });

  const hostile: Array<[string, unknown]> = [
    ["extrator lançou (result null)", [frame(null)]],
    ["sem result", [{ frameId: 0 }]],
    ["nenhum frame", []],
    ["dois frames", [frame(okResult(body(MIN))), frame(okResult(body(MIN)))]],
    ["outro frame", [frame(okResult(body(MIN)), { frameId: 3 })]],
    ["não é array", frame(okResult(body(MIN)))],
    ["undefined", undefined],
    ["chave extra no resultado", [frame(okResult(body(MIN), { html: "<b>" }))]],
    ["versão desconhecida", [frame(okResult(body(MIN), { versao: "ge2" }))]],
    ["raiz desconhecida", [frame(okResult(body(MIN), { raiz: "section" }))]],
    ["texto acima do teto do extrator", [frame(okResult(body(GENERIC_LIMITS.maxChars + 1)))]],
    ["texto não string", [frame(okResult(["x"]))]],
    ["truncado não booleano", [frame(okResult(body(MIN), { truncado: "sim" }))]],
    ["contador ausente", [frame(okResult(body(MIN), { descartes: { ...zeros, corDoFundo: undefined } }))]],
    ["contador extra", [frame(okResult(body(MIN), { descartes: { ...zeros, outro: 1 } }))]],
    ["contador negativo", [frame(okResult(body(MIN), { descartes: { ...zeros, ruido: -1 } }))]],
    ["contador fracionário", [frame(okResult(body(MIN), { descartes: { ...zeros, ruido: 0.5 } }))]],
    ["contador acima do teto de nós", [frame(okResult(body(MIN), { descartes: { ...zeros, ruido: GENERIC_LIMITS.maxNodes + 1 } }))]],
    ["ok:false com motivo desconhecido", [frame({ ok: false, versao: "ge1", motivo: "x" })]],
    ["ok:false com chave extra", [frame({ ok: false, versao: "ge1", motivo: "texto_insuficiente", texto: "x" })]],
    ["ok como string", [frame(okResult(body(MIN), { ok: "true" }))]],
  ];
  test.each(hostile)("retorno fora da forma vira erro: %s", async (_label, value) => {
    expect(await captureFromTab(1, run(value), 0)).toEqual({ ok: false, motivo: "erro" });
  });

  test("o contador no teto de nós ainda vale", async () => {
    const out = await captureFromTab(1, run([frame(okResult(body(MIN), { descartes: { ...zeros, ruido: GENERIC_LIMITS.maxNodes } }))]), 0);
    expect(out.ok).toBe(true);
    const atMax = await captureFromTab(1, run([frame(okResult(body(GENERIC_LIMITS.maxChars)))]), 0);
    expect(atMax.ok && atMax.job.truncated).toBe(true);
  });
});

describe("capturePasted", () => {
  test("texto colado tem a mesma limpeza, sem aba", () => {
    expect(capturePasted(`\uD83D ${body(MIN)}\u0000 `, 5)).toEqual({
      ok: true,
      job: { tabId: null, capturedAt: 5, platform: "texto_colado", extractorVersion: PASTED_EXTRACTOR_VERSION, text: body(MIN), truncated: false },
    });
    expect(PASTED_EXTRACTOR_VERSION).toBe("colado-1");
  });

  test("curto demais depois da limpeza", () => {
    expect(capturePasted(`${body(MIN - 1)}   \u0003`, 0)).toEqual({ ok: false, motivo: "texto_insuficiente" });
    expect(capturePasted("", 0)).toEqual({ ok: false, motivo: "texto_insuficiente" });
  });

  test("texto colado longo é cortado e marcado", () => {
    const out = capturePasted(body(2 * MAX), 0);
    expect(out.ok && out.job.truncated).toBe(true);
    expect(out.ok && out.job.text.length).toBe(MAX);
  });
});

describe("CapturedJobSchema", () => {
  const job = { tabId: 1, capturedAt: 0, platform: "generico", extractorVersion: "ge1", text: body(MIN), truncated: false };
  test("aceita a vaga dentro dos limites, em code points", () => {
    expect(CapturedJobSchema.safeParse(job).success).toBe(true);
    expect(CapturedJobSchema.safeParse({ ...job, text: "\u{1F600}".repeat(MAX) }).success).toBe(true);
    expect(CapturedJobSchema.safeParse({ ...job, tabId: null, platform: "texto_colado" }).success).toBe(true);
  });
  test.each([
    ["texto curto", { text: body(MIN - 1) }],
    ["texto longo", { text: body(MAX + 1) }],
    ["plataforma de produção ainda inexistente", { platform: "linkedin" }],
    ["versão fora do padrão", { extractorVersion: "GE 1" }],
    ["aba negativa", { tabId: -1 }],
    ["chave extra", { url: "https://x" }],
  ])("rejeita: %s", (_label, patch) => {
    expect(CapturedJobSchema.safeParse({ ...job, ...patch }).success).toBe(false);
  });
});
