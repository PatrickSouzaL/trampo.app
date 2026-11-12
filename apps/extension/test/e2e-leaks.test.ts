// F1-EXT-05c, 05c-3 (ADR-004 §4.5, SR-23, CA-04): a lógica das provas negativas, sem navegador. A busca por trecho do
// heap acha um pedaço de 16 caracteres de qualquer canário, e nenhum de 15; o texto de cada evento de console traz tudo o
// que o CDP entrega; o total do que os falsos receberam acusa cada regra do item 10; e o manifesto de cada build do E2E
// tem de ser o declarado, mesmo com um `.env` na pasta da extensão. Os canários nascem aqui em tempo de execução.
import { randomBytes, randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { newAccessCanary, newCodeCanary, newEnvelopeCanary } from "./e2e/support/canaries";
import type { FakeState, RequestRecord } from "./e2e/support/fake-servers";
import {
  HEAP_FRAGMENT_CHARS,
  builtManifestViolations,
  canaryFragments,
  consoleText,
  findCanaryFragments,
  requestViolations,
} from "./e2e/support/leaks";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const randomHex = (bytes: number) => randomBytes(bytes).toString("hex");

describe("busca por trecho no heap (§4.5 item 3)", () => {
  test("o trecho tem 16 caracteres, e cada canário dá um trecho por posição", () => {
    expect(HEAP_FRAGMENT_CHARS).toBe(16);
    const canary = `CANARIO-${randomHex(12)}`;
    const fragments = canaryFragments([canary]);
    expect(fragments.windows.size).toBe(canary.length - 15);
    expect([...fragments.windows.values()].every((owners) => owners.length === 1 && owners[0] === 0)).toBe(true);
    expect(fragments.canaries).toEqual([canary]);
  });

  test("acha um pedaço de 16 caracteres de qualquer posição, no meio de um texto maior, e nenhum de 15", () => {
    const access = newAccessCanary();
    const code = newCodeCanary();
    const fragments = canaryFragments([access.token, code]);
    for (const start of [0, 7, access.token.length - 16]) {
      const piece = access.token.slice(start, start + 16);
      expect(findCanaryFragments(`ruído ${randomHex(8)}${piece}${randomHex(8)} fim`, fragments)).toEqual([access.token]);
      expect(findCanaryFragments(`"${piece.slice(0, 15)}"`, fragments)).toEqual([]);
    }
    // Os dois, na ordem da lista e sem repetição, mesmo achados mais de uma vez.
    const both = `${code.slice(-20)} ${access.segments[2]} ${code}`;
    expect(findCanaryFragments(both, fragments)).toEqual([access.token, code]);
  });

  test("o trecho que é o texto inteiro (16 caracteres entre aspas) e o que atravessa o '-' do código e o '.' do envelope acusam", () => {
    const code = newCodeCanary();
    const envelope = newEnvelopeCanary();
    const fragments = canaryFragments([code, envelope.envelope]);
    expect(findCanaryFragments(`"${code.slice(5, 21)}"`, fragments)).toEqual([code]);
    const dot = envelope.envelope.indexOf(".CANARIO_RT_");
    expect(findCanaryFragments(`"${envelope.envelope.slice(dot - 8, dot + 8)}"`, fragments)).toEqual([envelope.envelope]);
  });

  test("o trecho cortado por um caractere fora do alfabeto não é o canário inteiro, mas cada metade com 16+ ainda acusa", () => {
    const canary = `CANARIO-${randomHex(16)}`;
    const fragments = canaryFragments([canary]);
    const cut = `${canary.slice(0, 10)}"${canary.slice(10, 25)}`;
    expect(findCanaryFragments(cut, fragments)).toEqual([]);
    expect(findCanaryFragments(`${canary.slice(0, 20)}"${canary.slice(20)}`, fragments)).toEqual([canary]);
  });

  test("o envelope, o cifrado e o código: cada um acha o seu, e o texto sem canário dá lista vazia", () => {
    const envelope = newEnvelopeCanary();
    const code = newCodeCanary();
    const fragments = canaryFragments([envelope.envelope, envelope.cipher, code]);
    expect(findCanaryFragments(`x=${envelope.cipher}`, fragments)).toEqual([envelope.envelope, envelope.cipher]);
    expect(findCanaryFragments(`OUTRO-${randomUUID()}`, fragments)).toEqual([]);
    expect(findCanaryFragments("", fragments)).toEqual([]);
  });

  test("a forma do encodeURIComponent também entra: o canário com espaço é recusado, e o '%20' fica no alfabeto", () => {
    expect(() => canaryFragments([`CANARIO ${randomHex(12)}`])).toThrow("canário com caractere fora do alfabeto da busca por trecho");
    expect(() => canaryFragments([`CANARIO"${randomHex(12)}`])).toThrow("canário com caractere fora do alfabeto da busca por trecho");
    const percent = `CANARIO%20${randomHex(12)}`;
    expect(findCanaryFragments(encodeURIComponent(percent), canaryFragments([percent]))).toEqual([percent]);
    // Com um "%" em cada 2 caracteres, nenhum trecho cru sobrevive ao escape: só a forma do encodeURIComponent acusa.
    const dense = Array.from(randomHex(12), (digit) => `%${digit}`).join("");
    expect(findCanaryFragments(encodeURIComponent(dense), canaryFragments([dense]))).toEqual([dense]);
    expect(findCanaryFragments(dense, canaryFragments([dense]))).toEqual([dense]);
  });

  test("canário com menos de 16 caracteres é erro do teste, nunca um 0", () => {
    expect(() => canaryFragments(["CANARIO-15chars"])).toThrow("canário com menos de 16 caracteres: a busca por trecho não o cobre");
    expect(canaryFragments([`CANARIO-${randomHex(4)}`]).windows.size).toBe(1);
  });
});

describe("texto dos eventos de console (§4.5 item 9)", () => {
  const marker = `CONTROLE-${randomHex(8)}`;

  test("Runtime.consoleAPICalled: valor, objeto em JSON, valor não serializável, descrição e prévia", () => {
    const text = consoleText({
      method: "Runtime.consoleAPICalled",
      params: {
        args: [
          { value: `a ${marker}` },
          { value: { k: marker } },
          { unserializableValue: "NaN" },
          { description: `Error: ${marker}` },
          { preview: { properties: [{ name: "token", value: marker }, { name: "sem-valor" }] } },
          {},
        ],
      },
    });
    expect(text.split("\n")).toEqual([`a ${marker}`, JSON.stringify({ k: marker }), "NaN", `Error: ${marker}`, "token", marker, "sem-valor", ""]);
  });

  test("Runtime.exceptionThrown: o texto, a URL e a exceção; sem URL nem exceção, só o texto", () => {
    expect(
      consoleText({ method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Uncaught", url: "chrome-extension://x/a.js", exception: { description: marker } } } }),
    ).toBe(`Uncaught\nchrome-extension://x/a.js\n${marker}`);
    expect(consoleText({ method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: marker } } })).toBe(`${marker}\n`);
  });

  test("Log.entryAdded: o texto, a URL e os argumentos; sem eles, só o texto", () => {
    expect(consoleText({ method: "Log.entryAdded", params: { entry: { text: "Refused", url: `https://localhost/${marker}`, args: [{ value: marker }] } } })).toBe(
      `Refused\nhttps://localhost/${marker}\n${marker}`,
    );
    expect(consoleText({ method: "Log.entryAdded", params: { entry: { text: marker } } })).toBe(`${marker}\n`);
  });

  test("outro método é erro do coletor", () => {
    expect(() => consoleText({ method: "Network.requestWillBeSent", params: {} })).toThrow("evento fora do §4.5 item 9: Network.requestWillBeSent");
  });
});

const req = (r: Partial<RequestRecord> & Pick<RequestRecord, "server" | "path">): RequestRecord => ({
  method: "POST",
  origin: r.server === "bff" ? ORIGIN : null,
  authorization: false,
  cookie: false,
  ...r,
});
const stateWith = (requests: RequestRecord[]): FakeState => ({ requests, segurados: 0, analises: { abertas: 0, abortadas: 0 }, auth: {} as FakeState["auth"] });

describe("o total do que os falsos receberam (§4.5 item 10)", () => {
  const clean = [
    req({ server: "supabase", method: "GET", path: "/auth/v1/authorize", cookie: true }),
    req({ server: "chromiumapp", method: "GET", path: "/auth" }),
    req({ server: "bff", path: "/v1/auth/exchange" }),
    req({ server: "bff", path: "/v1/auth/refresh" }),
    req({ server: "bff", method: "OPTIONS", path: "/v1/auth/logout" }),
    req({ server: "bff", path: "/v1/auth/logout", authorization: true }),
    // 04b-3, cenário 12: a análise leva o Bearer, e o preflight dela não.
    req({ server: "bff", method: "OPTIONS", path: "/v1/analyze" }),
    req({ server: "bff", path: "/v1/analyze", authorization: true }),
  ];

  test("o caminho de sempre não fere regra nenhuma (o Supabase pode ver o cookie do IdP)", () => {
    expect(requestViolations(stateWith(clean), ORIGIN)).toEqual([]);
    expect(requestViolations(stateWith([req({ server: "chromiumapp", method: "GET", path: "/outro" })]), ORIGIN, ["/auth", "/outro"])).toEqual([]);
  });

  test.each([
    [req({ server: "bff", path: "/v1/auth/exchange", origin: "chrome-extension://outra" }), "bff POST /v1/auth/exchange: origem diferente da extensão"],
    [req({ server: "bff", path: "/v1/auth/exchange", origin: null }), "bff POST /v1/auth/exchange: origem diferente da extensão"],
    [req({ server: "bff", path: "/v1/auth/refresh", cookie: true }), "bff POST /v1/auth/refresh: Cookie"],
    [req({ server: "bff", path: "/v1/auth/exchange", authorization: true }), "bff POST /v1/auth/exchange: Authorization fora do logout e da análise"],
    [req({ server: "bff", path: "/v1/auth/refresh", authorization: true }), "bff POST /v1/auth/refresh: Authorization fora do logout e da análise"],
    [req({ server: "bff", method: "OPTIONS", path: "/v1/auth/logout", authorization: true }), "bff OPTIONS /v1/auth/logout: Authorization fora do logout e da análise"],
    [req({ server: "bff", path: "/v1/auth/logout" }), "bff POST /v1/auth/logout: logout sem Bearer"],
    [req({ server: "bff", path: "/v1/analyze" }), "bff POST /v1/analyze: análise sem Bearer"],
    [req({ server: "bff", method: "OPTIONS", path: "/v1/analyze", authorization: true }), "bff OPTIONS /v1/analyze: Authorization fora do logout e da análise"],
    [req({ server: "bff", method: "GET", path: "/v1/health", authorization: true }), "bff GET /v1/health: Authorization fora do logout e da análise"],
    [req({ server: "supabase", method: "POST", path: "/auth/v1/authorize" }), "supabase POST /auth/v1/authorize: fora do authorize"],
    [req({ server: "supabase", method: "GET", path: "/auth/v1/token" }), "supabase GET /auth/v1/token: fora do authorize"],
    [req({ server: "supabase", method: "GET", path: "/auth/v1/authorize", authorization: true }), "supabase GET /auth/v1/authorize: Authorization"],
    [req({ server: "supabase", method: "GET", path: "/auth/v1/authorize", origin: ORIGIN }), "supabase GET /auth/v1/authorize: Origin de extensão"],
    [req({ server: "chromiumapp", method: "POST", path: "/auth" }), "chromiumapp POST /auth: fora do retorno"],
    [req({ server: "chromiumapp", method: "GET", path: "/outro" }), "chromiumapp GET /outro: fora do retorno"],
    [req({ server: "chromiumapp", method: "GET", path: "/auth", origin: ORIGIN }), "chromiumapp GET /auth: origem, Authorization ou Cookie"],
    [req({ server: "chromiumapp", method: "GET", path: "/auth", authorization: true }), "chromiumapp GET /auth: origem, Authorization ou Cookie"],
    [req({ server: "chromiumapp", method: "GET", path: "/auth", cookie: true }), "chromiumapp GET /auth: origem, Authorization ou Cookie"],
  ])("%j fere: %s", (bad, rule) => {
    expect(requestViolations(stateWith([...clean, bad]), ORIGIN)).toEqual([rule]);
  });

  test("um pedido que fere duas regras aparece duas vezes", () => {
    expect(requestViolations(stateWith([req({ server: "bff", path: "/v1/auth/exchange", origin: null, cookie: true })]), ORIGIN)).toEqual([
      "bff POST /v1/auth/exchange: origem diferente da extensão",
      "bff POST /v1/auth/exchange: Cookie",
    ]);
  });
});

describe("manifesto de cada build do E2E (o `.env` da extensão nunca chega ao teste)", () => {
  const csp = (connect: string) => ({ extension_pages: `script-src 'self'; object-src 'self'; default-src 'self'; connect-src ${connect}` });
  const key = randomBytes(32).toString("base64");
  const api = "https://localhost:47443";

  test("o fechado (sem key, connect-src 'none') e o auth (a key efêmera e só a API falsa) passam", () => {
    expect(builtManifestViolations({ content_security_policy: csp("'none'") }, {})).toEqual([]);
    expect(builtManifestViolations({ key, content_security_policy: csp(api) }, { key, apiOrigin: api })).toEqual([]);
  });

  test.each([
    [{ key, content_security_policy: csp("'none'") }, {}, ["key presente no build sem chave"]],
    [{ key: `${key}x`, content_security_policy: csp(api) }, { key, apiOrigin: api }, ["key diferente da efêmera"]],
    [{ content_security_policy: csp(api) }, { key, apiOrigin: api }, ["key diferente da efêmera"]],
    [{ content_security_policy: csp("https://api.trampo.test") }, {}, ["connect-src diferente do declarado no build"]],
    [{ key, content_security_policy: csp("'none'") }, { key, apiOrigin: api }, ["connect-src diferente do declarado no build"]],
    [{ key, content_security_policy: csp(`${api} https://outra.test`) }, { key, apiOrigin: api }, ["connect-src diferente do declarado no build"]],
    [{}, {}, ["connect-src diferente do declarado no build"]],
    [{ content_security_policy: { extension_pages: 1 } }, {}, ["connect-src diferente do declarado no build"]],
    [{ content_security_policy: { extension_pages: "default-src 'self'" } }, {}, ["connect-src diferente do declarado no build"]],
  ])("%j contra %j: %j", (manifest, expected, out) => {
    expect(builtManifestViolations(manifest, expected)).toEqual(out);
  });
});
