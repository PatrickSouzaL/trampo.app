// F1-EXT-05a, 05a-2 (ADR-004 D10 B9 e §4.1; M-07): o único fetch da extensão. Opções exatas, origem e
// caminhos de lista fechada, Bearer só em /v1/analyze e /v1/auth/logout, prazo de 10 s e teto de resposta.
import { afterEach, describe, expect, test, vi } from "vitest";

import { ANALYZE_PATH, API_CLIENT_POLICY, type ApiCall, type FetchLike, createApiClient } from "../src/api/api-client";

const ORIGIN = "https://api.trampo.test";
const TOKEN = "aaa.bbb.ccc";
const ENVELOPE = `r1.k1.${"A".repeat(16)}.${"B".repeat(20)}.${"C".repeat(22)}`;

const EXCHANGE: ApiCall = { path: "/v1/auth/exchange", body: { schemaVersion: 1, authCode: "codigo-1234", codeVerifier: "v".repeat(43) } };
const REFRESH: ApiCall = { path: "/v1/auth/refresh", body: { schemaVersion: 1, refreshToken: ENVELOPE } };
const LOGOUT: ApiCall = { path: "/v1/auth/logout", body: { schemaVersion: 1 }, accessToken: TOKEN };
const ANALYZE: ApiCall = {
  path: ANALYZE_PATH,
  body: {
    schemaVersion: 1,
    requestId: "6f1c2a4e-8b3d-4c5e-9f60-718293a4b5c6",
    source: { platform: "linkedin", extractorVersion: "li2" },
    job: { titleHint: null, text: "texto da vaga ".repeat(20), clientTruncated: false },
    mode: "auto",
  },
  accessToken: TOKEN,
};

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

function recordingFetch(respond: (init: RequestInit) => Response | Promise<Response> = () => new Response("{}", { status: 200 })) {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond(init);
  };
  return { calls, fetch };
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function streamResponse(chunks: readonly Uint8Array[], signal?: AbortSignal | null, endless = false): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!endless) controller.close();
      signal?.addEventListener("abort", () => controller.error(new DOMException("abortado", "AbortError")));
    },
  });
  return new Response(body, { status: 200 });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("origem da API (B9)", () => {
  test.each(["http://api.trampo.test", "https://api.trampo.test/", "https://API.trampo.test", "https://api.trampo.test:443", "https://api.trampo.test/v1", "api.trampo.test", ""])(
    "recusa %j no construtor",
    (apiOrigin) => {
      expect(() => createApiClient({ apiOrigin })).toThrow(/origem https exata/);
    },
  );

  test("aceita origem https exata com porta", () => {
    expect(() => createApiClient({ apiOrigin: "https://127.0.0.1:8443" })).not.toThrow();
  });
});

describe("opções exatas (B9)", () => {
  test("troca: POST na origem, JSON, sem cookie, sem redirecionamento, sem cache e sem Referer", async () => {
    const { calls, fetch } = recordingFetch();
    await createApiClient({ apiOrigin: ORIGIN, fetch }).post(EXCHANGE);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/auth/exchange`);
    expect(calls[0]?.init).toStrictEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(EXCHANGE.body),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    });
  });

  test("a política exportada é congelada e tem o prazo de 10 s", () => {
    expect(API_CLIENT_POLICY.timeoutMs).toBe(10_000);
    expect(Object.isFrozen(API_CLIENT_POLICY)).toBe(true);
    expect(Object.isFrozen(API_CLIENT_POLICY.init)).toBe(true);
  });

  test("sem fetch injetado, usa o fetch global", async () => {
    const global = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", global);
    expect(await createApiClient({ apiOrigin: ORIGIN }).post(LOGOUT)).toEqual({ ok: true, status: 204, body: "" });
    expect(global).toHaveBeenCalledWith(`${ORIGIN}/v1/auth/logout`, expect.objectContaining({ method: "POST" }));
  });
});

describe("Bearer só nas 2 rotas (B9; M-07)", () => {
  test.each<[string, ApiCall, string | undefined]>([
    ["/v1/auth/exchange", EXCHANGE, undefined],
    ["/v1/auth/refresh", REFRESH, undefined],
    ["/v1/auth/logout", LOGOUT, `Bearer ${TOKEN}`],
    ["/v1/analyze", ANALYZE, `Bearer ${TOKEN}`],
  ])("%s: authorization = %j, e mais nenhum cabeçalho além do content-type", async (path, call, authorization) => {
    const { calls, fetch } = recordingFetch();
    expect(await createApiClient({ apiOrigin: ORIGIN, fetch }).post(call)).toEqual({ ok: true, status: 200, body: "{}" });
    expect(calls[0]?.url).toBe(`${ORIGIN}${path}`);
    expect(calls[0]?.init.headers).toStrictEqual(
      authorization === undefined ? { "content-type": "application/json" } : { "content-type": "application/json", authorization },
    );
    expect(calls[0]?.init.body).toBe(JSON.stringify(call.body));
  });

  test.each<[string, ApiCall]>([
    ["troca", EXCHANGE],
    ["renovação", REFRESH],
  ])("token oferecido à %s (rota pública) é recusado sem rede", async (_rota, call) => {
    const { calls, fetch } = recordingFetch();
    const leaky = { ...call, accessToken: TOKEN } as unknown as ApiCall;
    expect(await createApiClient({ apiOrigin: ORIGIN, fetch }).post(leaky)).toEqual({ ok: false, reason: "pedido_recusado" });
    expect(calls).toHaveLength(0);
  });

  test.each<[string, unknown]>([
    ["ausente", undefined],
    ["fora da forma de JWS", "aaa.bbb"],
    ["com espaço (injeção de cabeçalho)", "aaa.bbb.ccc d"],
    ["com quebra de linha", "aaa.bbb.ccc\r\nx-evil: 1"],
    ["acima de 8.192", `${"a".repeat(8_190)}.b.c`],
    ["que nem é string", 42],
  ])("rota com Bearer e token %s: recusado sem rede", async (_caso, accessToken) => {
    const { calls, fetch } = recordingFetch();
    const client = createApiClient({ apiOrigin: ORIGIN, fetch });
    expect(await client.post({ ...LOGOUT, accessToken } as unknown as ApiCall)).toEqual({ ok: false, reason: "pedido_recusado" });
    expect(await client.post({ ...ANALYZE, accessToken } as unknown as ApiCall)).toEqual({ ok: false, reason: "pedido_recusado" });
    expect(calls).toHaveLength(0);
  });
});

describe("caminhos de lista fechada (B9; M-07)", () => {
  test.each([
    "/v1/criteria",
    "/v1/analyze/",
    "/v1/analyze/feedback",
    "/v1/auth/exchange?x=1",
    "/v1/auth/exchange#x",
    "/V1/analyze",
    "/v1/auth/",
    "//evil.test/v1/analyze",
    "https://evil.test/v1/analyze",
    "@evil.test/v1/analyze",
    "constructor",
    "__proto__",
    "",
  ])("%j é recusado sem rede, com o corpo válido de cada rota, com e sem Bearer", async (path) => {
    const { calls, fetch } = recordingFetch();
    const client = createApiClient({ apiOrigin: ORIGIN, fetch });
    for (const { body } of [EXCHANGE, REFRESH, LOGOUT, ANALYZE]) {
      expect(await client.post({ path, body } as unknown as ApiCall)).toEqual({ ok: false, reason: "pedido_recusado" });
      expect(await client.post({ path, body, accessToken: TOKEN } as unknown as ApiCall)).toEqual({ ok: false, reason: "pedido_recusado" });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("corpo no contrato da rota", () => {
  const cyclic: Record<string, unknown> = { schemaVersion: 1 };
  cyclic["self"] = cyclic;

  test.each<[string, unknown]>([
    ["troca com chave extra state", { ...EXCHANGE, body: { ...EXCHANGE.body, state: "s".repeat(22) } }],
    ["troca sem verifier", { ...EXCHANGE, body: { schemaVersion: 1, authCode: "codigo-1234" } }],
    ["troca com versão 2", { ...EXCHANGE, body: { ...EXCHANGE.body, schemaVersion: 2 } }],
    ["renovação com o refresh cru", { ...REFRESH, body: { schemaVersion: 1, refreshToken: "refresh-cru" } }],
    ["logout com o token no corpo", { ...LOGOUT, body: { schemaVersion: 1, accessToken: TOKEN } }],
    ["análise com URL da página", { ...ANALYZE, body: { ...ANALYZE.body, url: "https://vaga.test" } }],
    ["análise com o corpo de outra rota", { ...ANALYZE, body: LOGOUT.body }],
    ["corpo ausente", { path: "/v1/auth/logout", accessToken: TOKEN }],
    ["corpo com ciclo", { ...LOGOUT, body: cyclic }],
    ["corpo com BigInt", { ...LOGOUT, body: { schemaVersion: 1n } }],
    ["chamada nula", null],
    ["chamada que nem é objeto", "/v1/auth/logout"],
  ])("%s: recusado sem rede", async (_caso, call) => {
    const { calls, fetch } = recordingFetch();
    expect(await createApiClient({ apiOrigin: ORIGIN, fetch }).post(call as ApiCall)).toEqual({ ok: false, reason: "pedido_recusado" });
    expect(calls).toHaveLength(0);
  });

  test("o caminho é lido uma vez: um getter não troca a rota entre a checagem e o envio", async () => {
    const { calls, fetch } = recordingFetch();
    let reads = 0;
    const call = {
      get path() {
        reads += 1;
        return reads === 1 ? "/v1/auth/exchange" : "/v1/criteria";
      },
      body: EXCHANGE.body,
    };
    await createApiClient({ apiOrigin: ORIGIN, fetch }).post(call as unknown as ApiCall);
    expect(reads).toBe(1);
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/auth/exchange`);
  });

  test("o corpo enviado é o JSON validado: um getter não planta outro valor depois da checagem", async () => {
    const { calls, fetch } = recordingFetch();
    let reads = 0;
    const body = {
      schemaVersion: 1,
      get authCode() {
        reads += 1;
        return reads === 1 ? "codigo-1234" : "<plantado>";
      },
      codeVerifier: "v".repeat(43),
    };
    await createApiClient({ apiOrigin: ORIGIN, fetch }).post({ path: "/v1/auth/exchange", body } as unknown as ApiCall);
    expect(calls[0]?.init.body).toBe(JSON.stringify(EXCHANGE.body));
  });

  test("getter que lança na chamada é recusado, sem rejeitar", async () => {
    const { calls, fetch } = recordingFetch();
    const call = {
      get path(): string {
        throw new Error("hostil");
      },
    };
    expect(await createApiClient({ apiOrigin: ORIGIN, fetch }).post(call as unknown as ApiCall)).toEqual({ ok: false, reason: "pedido_recusado" });
    expect(calls).toHaveLength(0);
  });
});

describe("resposta", () => {
  test.each([200, 400, 401, 429, 503])("status %i volta com o corpo inteiro, para quem chamou decidir", async (status) => {
    const { fetch } = recordingFetch(() => new Response(`{"code":"x${status}"}`, { status }));
    expect(await createApiClient({ apiOrigin: ORIGIN, fetch }).post(REFRESH)).toEqual({ ok: true, status, body: `{"code":"x${status}"}` });
  });

  test("204 sem corpo volta com o corpo vazio", async () => {
    const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));
    expect(await createApiClient({ apiOrigin: ORIGIN, fetch }).post(LOGOUT)).toEqual({ ok: true, status: 204, body: "" });
  });

  test.each<[string, FetchLike]>([
    ["rejeita (rede ou redirecionamento recusado)", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["lança na hora", () => {
      throw new TypeError("síncrono");
    }],
  ])("fetch que %s: sem_resposta, sem rejeitar", async (_caso, fetch) => {
    expect(await createApiClient({ apiOrigin: ORIGIN, fetch }).post(EXCHANGE)).toEqual({ ok: false, reason: "sem_resposta" });
  });

  test("caractere de vários bytes partido entre pedaços é lido inteiro", async () => {
    const { fetch } = recordingFetch(() => streamResponse([bytes(0x7b, 0x22, 0xc3), bytes(0xa9, 0x22, 0x7d)]));
    expect(await createApiClient({ apiOrigin: ORIGIN, fetch }).post(EXCHANGE)).toEqual({ ok: true, status: 200, body: '{"é"}' });
  });

  test.each<[string, Uint8Array[]]>([
    ["byte inválido em UTF-8", [bytes(0x7b, 0xff, 0x7d)]],
    ["sequência truncada no fim", [bytes(0x7b, 0xc3)]],
  ])("%s: resposta_ilegivel", async (_caso, chunks) => {
    const { fetch } = recordingFetch(() => streamResponse(chunks));
    expect(await createApiClient({ apiOrigin: ORIGIN, fetch }).post(EXCHANGE)).toEqual({ ok: false, reason: "resposta_ilegivel" });
  });

  test("stream que falha no meio: resposta_ilegivel", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(0x7b));
        controller.error(new TypeError("conexão caiu"));
      },
    });
    const { fetch } = recordingFetch(() => new Response(body, { status: 200 }));
    expect(await createApiClient({ apiOrigin: ORIGIN, fetch }).post(EXCHANGE)).toEqual({ ok: false, reason: "resposta_ilegivel" });
  });
});

describe("teto de resposta (B9)", () => {
  test.each<[string, ApiCall, number]>([
    ["troca", EXCHANGE, 16_384],
    ["renovação", REFRESH, 16_384],
    ["logout", LOGOUT, 16_384],
    ["análise", ANALYZE, 65_536],
  ])("%s: %i bytes passam; um a mais é resposta_ilegivel e derruba o stream", async (_rota, call, max) => {
    const exact = recordingFetch((init) => streamResponse([new Uint8Array(max - 1).fill(0x61), bytes(0x61)], init.signal));
    expect(await createApiClient({ apiOrigin: ORIGIN, fetch: exact.fetch }).post(call)).toEqual({ ok: true, status: 200, body: "a".repeat(max) });

    const over = recordingFetch((init) => streamResponse([new Uint8Array(max).fill(0x61), bytes(0x61)], init.signal, true));
    expect(await createApiClient({ apiOrigin: ORIGIN, fetch: over.fetch }).post(call)).toEqual({ ok: false, reason: "resposta_ilegivel" });
    expect(over.calls[0]?.init.signal?.aborted).toBe(true);
  });
});

describe("prazo de 10 s (B9)", () => {
  function hangingFetch(): { fetch: FetchLike; signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new DOMException("abortado", "AbortError")));
      });
    return { fetch, signals };
  }

  test("sem status em 10 s: sem_resposta; com 9.999 ms ainda espera", async () => {
    vi.useFakeTimers();
    const { fetch, signals } = hangingFetch();
    let settled: unknown;
    const pending = createApiClient({ apiOrigin: ORIGIN, fetch })
      .post(EXCHANGE)
      .then((result) => (settled = result));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBeUndefined();
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toEqual({ ok: false, reason: "sem_resposta" });
  });

  test("o prazo cobre a leitura do corpo: status chegou e o corpo não acabou em 10 s, resposta_ilegivel", async () => {
    vi.useFakeTimers();
    const { fetch } = recordingFetch((init) => streamResponse([bytes(0x7b)], init.signal, true));
    const pending = createApiClient({ apiOrigin: ORIGIN, fetch }).post(EXCHANGE);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ ok: false, reason: "resposta_ilegivel" });
  });

  test("o temporizador é desfeito no fim, com sucesso ou falha", async () => {
    vi.useFakeTimers();
    const ok = recordingFetch();
    await createApiClient({ apiOrigin: ORIGIN, fetch: ok.fetch }).post(EXCHANGE);
    expect(vi.getTimerCount()).toBe(0);
    await createApiClient({ apiOrigin: ORIGIN, fetch: () => Promise.reject(new TypeError("x")) }).post(EXCHANGE);
    expect(vi.getTimerCount()).toBe(0);
  });
});
