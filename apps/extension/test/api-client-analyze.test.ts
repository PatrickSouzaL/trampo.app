// F1-EXT-04 parte 2, 04b-1 (ADR-025 §6 D9): o `analyze` do api-client, o único caminho do POST /v1/analyze. A mesma
// preparação e as mesmas opções do B9, nenhum cabeçalho novo, prazos de 10 s até o status, 20 s entre pedaços e 45 s
// no total, tetos de 64 KiB no stream e 16 KiB no erro, 200 só em text/event-stream e o leitor que pode parar.
import type { AnalyzeJobRequestInput } from "@trampo/contracts/api";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ANALYZE_PATH, ANALYZE_STREAM_POLICY, API_CLIENT_POLICY, type FetchLike, createApiClient } from "../src/api/api-client";

const ORIGIN = "https://api.trampo.test";
const TOKEN = "aaa.bbb.ccc";
const BODY: AnalyzeJobRequestInput = {
  schemaVersion: 1,
  requestId: "6f1c2a4e-8b3d-4c5e-9f60-718293a4b5c6",
  source: { platform: "gupy", extractorVersion: "gp1" },
  job: { titleHint: null, text: "texto da vaga ".repeat(20), clientTruncated: false },
  mode: "auto",
};
const SSE = { "content-type": "text/event-stream; charset=utf-8" };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Um corpo que o teste alimenta aos poucos; o abort do fetch derruba o stream, como no navegador. */
function controlledBody(signal: AbortSignal | null | undefined) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
    },
  });
  signal?.addEventListener("abort", () => {
    try {
      ctrl.error(new DOMException("abortado", "AbortError"));
    } catch {
      // Já fechado.
    }
  });
  return { body, push: (chunk: Uint8Array) => ctrl.enqueue(chunk), close: () => ctrl.close(), fail: () => ctrl.error(new TypeError("rede")) };
}

type Body = ReturnType<typeof controlledBody>;

function setup(status = 200, headers: Record<string, string> = SSE) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let body: Body | undefined;
  let signal: AbortSignal | undefined;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    signal = init.signal ?? undefined;
    body = controlledBody(init.signal);
    return new Response(body.body, { status, headers });
  };
  const texts: string[] = [];
  const api = createApiClient({ apiOrigin: ORIGIN, fetch });
  const run = (onText: (text: string) => "seguir" | "parar" = (t) => (texts.push(t), "seguir")) => api.analyze({ body: BODY, accessToken: TOKEN }, onText);
  const feed = () => body as Body;
  return { calls, texts, run, feed, aborted: () => signal?.aborted === true };
}

/** O resultado ainda pendente depois de girar as microtarefas. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
  return !done;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pedido (B9 e D9)", () => {
  test("mesma rota, mesmas opções, só content-type e authorization, e o corpo validado", async () => {
    const { calls, run, feed } = setup();
    const result = run();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    feed().close();
    expect(await result).toEqual({ ok: true, stream: true, fim: "completo" });
    const [call] = calls;
    expect(call?.url).toBe(`${ORIGIN}${ANALYZE_PATH}`);
    const { signal, ...init } = call?.init ?? {};
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(init).toEqual({
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(BODY),
      ...API_CLIENT_POLICY.init,
    });
  });

  test.each([
    ["token fora do contrato", { body: BODY, accessToken: "" }],
    ["sem token", { body: BODY }],
    ["corpo fora do contrato", { body: { ...BODY, mode: "turbo" }, accessToken: TOKEN }],
    ["chave extra no corpo", { body: { ...BODY, url: "https://x.test" }, accessToken: TOKEN }],
    ["corpo que não vira JSON", { body: { ...BODY, n: 1n }, accessToken: TOKEN }],
    ["chamada que não é objeto", null],
  ])("%s: nada sai", async (_nome, call) => {
    const { calls } = setup();
    const api = createApiClient({ apiOrigin: ORIGIN, fetch: async (url, init) => (calls.push({ url, init }), new Response("")) });
    const onText = vi.fn(() => "seguir" as const);
    expect(await api.analyze(call as never, onText)).toEqual({ ok: false, reason: "pedido_recusado" });
    expect(calls).toHaveLength(0);
    expect(onText).not.toHaveBeenCalled();
  });

  test("o post continua com a rota (M-07), sem mudar", async () => {
    const api = createApiClient({ apiOrigin: ORIGIN, fetch: async () => new Response("ok", { status: 200 }) });
    expect(await api.post({ path: ANALYZE_PATH, body: BODY, accessToken: TOKEN })).toEqual({ ok: true, status: 200, body: "ok" });
  });
});

describe("antes do status", () => {
  test("rede: sem_resposta", async () => {
    const api = createApiClient({ apiOrigin: ORIGIN, fetch: () => Promise.reject(new TypeError("rede")) });
    expect(await api.analyze({ body: BODY, accessToken: TOKEN }, () => "seguir")).toEqual({ ok: false, reason: "sem_resposta" });
  });

  test("prazo de 10 s até o status: sem_resposta, e o pedido é abortado", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const api = createApiClient({
      apiOrigin: ORIGIN,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(new DOMException("abortado", "AbortError")));
        }),
    });
    const result = api.analyze({ body: BODY, accessToken: TOKEN }, () => "seguir");
    await vi.advanceTimersByTimeAsync(ANALYZE_STREAM_POLICY.statusMs - 1);
    expect(await pending(result)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ ok: false, reason: "sem_resposta" });
    expect(signal?.aborted).toBe(true);
  });

  test("os prazos são os do D9", () => {
    expect(ANALYZE_STREAM_POLICY).toEqual({ statusMs: 10_000, idleMs: 20_000, totalMs: 45_000, streamMaxBytes: 65_536, errorMaxBytes: 16_384 });
    expect(Object.isFrozen(ANALYZE_STREAM_POLICY)).toBe(true);
  });
});

describe("status diferente de 200", () => {
  test.each([401, 409, 429, 503, 201])("%i: o corpo inteiro volta, sem passar pelo leitor", async (status) => {
    const { run, feed, texts } = setup(status, { "content-type": "application/json" });
    const result = run();
    await vi.waitFor(() => expect(feed()).toBeDefined());
    feed().push(encode('{"code":'));
    feed().push(encode('"X"}'));
    feed().close();
    expect(await result).toEqual({ ok: true, stream: false, status, body: '{"code":"X"}' });
    expect(texts).toEqual([]);
  });

  test("corpo nulo: texto vazio", async () => {
    const api = createApiClient({ apiOrigin: ORIGIN, fetch: async () => new Response(null, { status: 503 }) });
    expect(await api.analyze({ body: BODY, accessToken: TOKEN }, () => "seguir")).toEqual({ ok: true, stream: false, status: 503, body: "" });
  });

  test("16 KiB passa; um byte a mais é ilegível", async () => {
    for (const [size, expected] of [
      [ANALYZE_STREAM_POLICY.errorMaxBytes, "ok"],
      [ANALYZE_STREAM_POLICY.errorMaxBytes + 1, "ilegivel"],
    ] as const) {
      const api = createApiClient({ apiOrigin: ORIGIN, fetch: async () => new Response("a".repeat(size), { status: 503 }) });
      const result = await api.analyze({ body: BODY, accessToken: TOKEN }, () => "seguir");
      expect(result.ok).toBe(expected === "ok");
    }
  });

  test("corpo fora de UTF-8: ilegível", async () => {
    const api = createApiClient({ apiOrigin: ORIGIN, fetch: async () => new Response(new Uint8Array([0xff]), { status: 401 }) });
    expect(await api.analyze({ body: BODY, accessToken: TOKEN }, () => "seguir")).toEqual({ ok: false, reason: "resposta_ilegivel" });
  });

  test("corpo que para por 20 s: ilegível", async () => {
    vi.useFakeTimers();
    const { run, feed } = setup(503, { "content-type": "application/json" });
    const result = run();
    await vi.advanceTimersByTimeAsync(0);
    feed().push(encode("{"));
    await vi.advanceTimersByTimeAsync(ANALYZE_STREAM_POLICY.idleMs - 1);
    expect(await pending(result)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ ok: false, reason: "resposta_ilegivel" });
  });
});

describe("200 só em text/event-stream", () => {
  test.each(["text/event-stream", "TEXT/Event-Stream", "text/event-stream ; charset=utf-8"])("%s: stream", async (type) => {
    const { run, feed } = setup(200, { "content-type": type });
    const result = run();
    await vi.waitFor(() => expect(feed()).toBeDefined());
    feed().close();
    expect(await result).toEqual({ ok: true, stream: true, fim: "completo" });
  });

  test.each(["application/json", "text/plain", "text/event-streamx", "", "text/html; x=text/event-stream"])("%j: ilegível, sem ler o corpo", async (type) => {
    const { run, texts, aborted } = setup(200, type === "" ? {} : { "content-type": type });
    expect(await run()).toEqual({ ok: false, reason: "resposta_ilegivel" });
    expect(texts).toEqual([]);
    expect(aborted()).toBe(true);
  });

  test("sem content-type nenhum: ilegível", async () => {
    const api = createApiClient({ apiOrigin: ORIGIN, fetch: async () => new Response(new ReadableStream(), { status: 200, headers: {} }) });
    const response = await api.analyze({ body: BODY, accessToken: TOKEN }, () => "seguir");
    expect(response).toEqual({ ok: false, reason: "resposta_ilegivel" });
  });

  test("200 com corpo nulo: completo, sem texto", async () => {
    const onText = vi.fn(() => "seguir" as const);
    const api = createApiClient({ apiOrigin: ORIGIN, fetch: async () => new Response(null, { status: 200, headers: SSE }) });
    expect(await api.analyze({ body: BODY, accessToken: TOKEN }, onText)).toEqual({ ok: true, stream: true, fim: "completo" });
    expect(onText).not.toHaveBeenCalled();
  });
});

describe("stream 200", () => {
  test("cada pedaço chega decodificado e em ordem; um caractere partido entre pedaços chega inteiro", async () => {
    const { run, feed, texts, aborted } = setup();
    const result = run();
    await vi.waitFor(() => expect(feed()).toBeDefined());
    const bytes = encode("ação");
    feed().push(encode("event: "));
    feed().push(bytes.slice(0, 1));
    // Só o 1º byte do "ç": a decodificação dá "", que não chega ao leitor.
    feed().push(bytes.slice(1, 2));
    feed().push(bytes.slice(2));
    feed().close();
    expect(await result).toEqual({ ok: true, stream: true, fim: "completo" });
    expect(texts.join("")).toBe("event: ação");
    expect(texts).not.toContain("");
    expect(aborted()).toBe(true);
  });

  test("o leitor pede para parar: parado, o fetch é abortado e nada mais chega a ele", async () => {
    const { run, feed, aborted } = setup();
    const seen: string[] = [];
    const result = run((text) => (seen.push(text), "parar"));
    await vi.waitFor(() => expect(feed()).toBeDefined());
    feed().push(encode("a"));
    expect(await result).toEqual({ ok: true, stream: true, fim: "parado" });
    expect(aborted()).toBe(true);
    expect(seen).toEqual(["a"]);
  });

  test("o leitor que lança conta como parar", async () => {
    const { run, feed } = setup();
    const result = run(() => {
      throw new Error("leitor quebrado");
    });
    await vi.waitFor(() => expect(feed()).toBeDefined());
    feed().push(encode("a"));
    expect(await result).toEqual({ ok: true, stream: true, fim: "parado" });
  });

  test("64 KiB passam; um byte a mais é ilegível, e o pedaço que passou do teto não chega ao leitor", async () => {
    const max = ANALYZE_STREAM_POLICY.streamMaxBytes;
    for (const [extra, fim] of [
      [0, "completo"],
      [1, "ilegivel"],
    ] as const) {
      const { run, feed, texts } = setup();
      const result = run();
      await vi.waitFor(() => expect(feed()).toBeDefined());
      feed().push(encode("a".repeat(max - 10)));
      feed().push(encode("b".repeat(10 + extra)));
      if (extra === 0) feed().close();
      expect(await result).toEqual({ ok: true, stream: true, fim });
      expect(texts.join("").includes("b")).toBe(extra === 0);
    }
  });

  test.each([
    ["byte inválido", [0xff]],
    ["sequência cortada no fim", [0xc3]],
  ])("%s: ilegível", async (_nome, raw) => {
    const { run, feed } = setup();
    const result = run();
    await vi.waitFor(() => expect(feed()).toBeDefined());
    feed().push(new Uint8Array(raw));
    feed().close();
    expect(await result).toEqual({ ok: true, stream: true, fim: "ilegivel" });
  });

  test("a rede cai no meio: queda", async () => {
    const { run, feed } = setup();
    const result = run();
    await vi.waitFor(() => expect(feed()).toBeDefined());
    feed().push(encode("event: stage\n"));
    feed().fail();
    expect(await result).toEqual({ ok: true, stream: true, fim: "queda" });
  });

  test("20 s sem pedaço: queda; cada pedaço reabre o prazo", async () => {
    vi.useFakeTimers();
    const { run, feed, aborted } = setup();
    const result = run();
    await vi.advanceTimersByTimeAsync(0);
    // Uma reabertura só: duas somariam mais que os 45 s do total.
    await vi.advanceTimersByTimeAsync(ANALYZE_STREAM_POLICY.idleMs - 1);
    feed().push(encode("x"));
    await vi.advanceTimersByTimeAsync(ANALYZE_STREAM_POLICY.idleMs - 1);
    expect(await pending(result)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ ok: true, stream: true, fim: "queda" });
    expect(aborted()).toBe(true);
  });

  test("o prazo do status não vale depois da resposta: o stream segue além dos 10 s", async () => {
    vi.useFakeTimers();
    const { run, feed } = setup();
    const result = run();
    await vi.advanceTimersByTimeAsync(ANALYZE_STREAM_POLICY.statusMs - 1);
    feed().push(encode("x"));
    await vi.advanceTimersByTimeAsync(ANALYZE_STREAM_POLICY.idleMs - 1);
    feed().close();
    expect(await result).toEqual({ ok: true, stream: true, fim: "completo" });
  });

  test("45 s no total: queda, mesmo com pedaços chegando", async () => {
    vi.useFakeTimers();
    const { run, feed } = setup();
    const result = run();
    let elapsed = 0;
    await vi.advanceTimersByTimeAsync(0);
    while (elapsed + 5_000 < ANALYZE_STREAM_POLICY.totalMs) {
      await vi.advanceTimersByTimeAsync(5_000);
      elapsed += 5_000;
      feed().push(encode("x"));
    }
    await vi.advanceTimersByTimeAsync(ANALYZE_STREAM_POLICY.totalMs - elapsed - 1);
    expect(await pending(result)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ ok: true, stream: true, fim: "queda" });
  });

  test("nenhum relógio sobra depois do fim", async () => {
    vi.useFakeTimers();
    const { run, feed } = setup();
    const result = run();
    await vi.advanceTimersByTimeAsync(0);
    feed().close();
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
