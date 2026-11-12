// F1-EXT-04 parte 2, 04b-3 (ADR-025 §6.5 D22 e D23): o `POST /v1/analyze` do BFF falso e os roteiros novos, sem
// navegador. O falso nunca fica mais permissivo que a API: origem exata, Bearer de uma sessão viva, tipo de conteúdo e o
// corpo do contrato, sempre antes de qualquer roteiro. Cada stream roteirizado passa pelo leitor de verdade do SW
// (`createSseReader`): o E2E prova a barreira do Service Worker, e não uma resposta mal formada. Todo valor com cara de
// segredo nasce aqui em tempo de execução (cuidado 14 do TRILHAS).
import { randomBytes, randomUUID } from "node:crypto";
import { type IncomingHttpHeaders, type IncomingMessage, type Server, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

import { AnalysisReportSchema } from "@trampo/contracts/analysis-report";
import { type AnalysisStreamEvent, ApiErrorSchema } from "@trampo/contracts/api";
import { AUTH_BODY_MAX_BYTES, AuthSessionResponseSchema } from "@trampo/contracts/auth";
import { HTTP_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import { afterEach, describe, expect, test } from "vitest";

import { ANALYZE_PATH as SW_ANALYZE_PATH, ANALYZE_STREAM_POLICY } from "../src/api/api-client";
import { createSseReader } from "../src/api/sse-reader";
import { buildAuthorizeUrl } from "../src/auth/authorize-url";
import { createPkcePair, createState } from "../src/auth/pkce";
import { newAccessCanary } from "./e2e/support/canaries";
import { ANALYZE_SCRIPTS, FAKE_AUTH_POLICY, FakeScriptSchema, type HttpReply, REFRESH_SCRIPTS, createFakeAuth, textDigest } from "./e2e/support/fake-auth";
import { ANALYZE_PATH, CONTROL_HEADER, type FakeEnvironment, type Handler, createFakeEnvironment, fakeControl } from "./e2e/support/fake-servers";
import { REPORT } from "./fixtures/stream";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${ID}`;
const REDIRECT = `https://${ID}.chromiumapp.org/auth`;
const TEXT = `  Vaga de pessoa desenvolvedora TypeScript. ${"Requisitos e responsabilidades da vaga. ".repeat(6)}`;

const analyzeBody = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  requestId: randomUUID(),
  source: { platform: "texto_colado", extractorVersion: "colado-1" },
  job: { titleHint: null, text: TEXT, clientTruncated: false },
  mode: "auto",
  ...over,
});
const bearer = (token: string) => `Bearer ${token}`;
const refreshBody = (refreshToken: string) => ({ schemaVersion: 1, refreshToken });

interface Login {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

/** Um login inteiro no falso, como o SW faz: o `authorize` com o PKCE de verdade e a troca. */
async function login(auth: Pick<ReturnType<typeof createFakeAuth>, "authorize" | "exchange">): Promise<Login> {
  const { verifier, challenge } = await createPkcePair();
  const url = new URL(buildAuthorizeUrl({ supabaseOrigin: "https://localhost:47444", provider: "github", redirectUri: REDIRECT, state: createState(), challenge }));
  const code = String(new URL(String(auth.authorize(url.searchParams).location)).searchParams.get("code"));
  return AuthSessionResponseSchema.parse(auth.exchange({ schemaVersion: 1, authCode: code, codeVerifier: verifier }).body);
}

async function session() {
  const auth = createFakeAuth({ extensionId: ID, now: () => 0 });
  return { auth, ...(await login(auth)) };
}

/** O stream pelo leitor de verdade do SW: os `stage` entregues, o que cada pedaço devolveu e o fim. */
function readWithSw(reply: HttpReply) {
  const stages: AnalysisStreamEvent[] = [];
  const reader = createSseReader((event) => void stages.push(event));
  const feeds = (reply.sse ?? []).map((chunk) => reader.push(chunk));
  return { stages: stages.map((s) => (s.type === "stage" ? s.stage : s.type)), feeds, end: reader.end() };
}

describe("roteiro do 04b-3: o schema (forma fechada, e só o que deixa o falso mais hostil)", () => {
  test("as listas são as do desenho", () => {
    expect(ANALYZE_SCRIPTS).toEqual(["401", "503", "fora_do_contrato", "silencio", "keep_alive", "depois_do_resultado", "event_divergente", "grande_demais"]);
    expect(REFRESH_SCRIPTS).toEqual(["503", "segurar"]);
  });

  test.each([
    { analyze: ["401"] },
    { analyze: [...ANALYZE_SCRIPTS] },
    { refresh: ["segurar", "segurar", "503", "503"] },
    { expiresIn: 1 },
    { expiresIn: FAKE_AUTH_POLICY.expiresIn },
    { authorize: "segurar", logout503: 1, analyze: ["silencio"], refresh: ["503"], expiresIn: 30 },
  ])("%j é aceito", (script) => {
    expect(FakeScriptSchema.safeParse(script).success).toBe(true);
  });

  test.each([
    {},
    { analyze: [] },
    { analyze: ["200"] },
    { analyze: "401" },
    { analyze: [...ANALYZE_SCRIPTS, "401"] },
    { refresh: [] },
    { refresh: ["401"] },
    { refresh: ["503", "503", "503", "503", "503"] },
    { expiresIn: 0 },
    { expiresIn: 901 },
    { expiresIn: 1.5 },
    { expiresIn: "30" },
    { analyze: ["401"], aceitar: true },
    { exchange: ["503"] },
  ])("%j é recusado", (script) => {
    expect(FakeScriptSchema.safeParse(script).success).toBe(false);
  });
});

describe("fake-auth: POST /v1/analyze (D22)", () => {
  test("Bearer vivo e corpo do contrato: o stream na forma do ADR-017 D6, que o leitor do SW aceita, e o registro sem segredo", async () => {
    const { auth, accessToken } = await session();
    const body = analyzeBody({ mode: "aprofundada", job: { titleHint: null, text: TEXT, clientTruncated: true } });
    const reply = auth.analyze(body, bearer(accessToken));
    expect(reply.status).toBe(200);
    expect(reply.hold).toBeUndefined();
    for (const chunk of reply.sse ?? []) expect(chunk).toMatch(/^event: (stage|result)\ndata: \{.*\}\n\n$/);
    const read = readWithSw(reply);
    expect(read.stages).toEqual(["recebido", "normalizando", "pontuando"]);
    expect(read.feeds).toEqual(["seguir", "seguir", "seguir", "seguir"]);
    expect(read.end).toEqual({ kind: "completo", terminal: { type: "result", report: { ...REPORT, requestId: body.requestId } } });
    expect(AnalysisReportSchema.safeParse({ ...REPORT, requestId: body.requestId }).success).toBe(true);

    const snapshot = auth.snapshot();
    expect(snapshot.counters.analyze).toEqual({ ok: 1, recusado: 0 });
    expect(snapshot.analyses).toEqual([
      {
        requestId: body.requestId,
        mode: "aprofundada",
        platform: "texto_colado",
        extractorVersion: "colado-1",
        clientTruncated: true,
        // O texto como chegou, com os espaços do começo: o contrato apararia.
        textLength: TEXT.length,
        textDigest: textDigest(TEXT),
        access: 0,
        resposta: "stream",
      },
    ]);
    expect(snapshot.roteiro).toEqual([]);
    expect(JSON.stringify(snapshot.analyses)).not.toContain(accessToken);
    expect(JSON.stringify(snapshot.analyses)).not.toContain("Requisitos");
    // O vetor de teste do SHA-256 (FIPS 180-2, "abc").
    expect(textDigest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test.each([
    ["sem Authorization", () => undefined],
    ["Basic", () => "Basic abc"],
    ["bearer em minúsculas com o token vivo", (token: string) => `bearer ${token}`],
    ["o token sem o esquema", (token: string) => token],
    ["outro token", () => bearer(newAccessCanary().token)],
  ])("%s: 401 com o ApiError NAO_AUTENTICADO, sem registro", async (_caso, authorization) => {
    const { auth, accessToken } = await session();
    const reply = auth.analyze(analyzeBody(), authorization(accessToken));
    expect(reply.status).toBe(401);
    expect(ApiErrorSchema.parse(reply.body)).toMatchObject({ code: "NAO_AUTENTICADO", requestId: null });
    expect(reply.sse).toBeUndefined();
    expect(auth.snapshot()).toMatchObject({ counters: { analyze: { ok: 0, recusado: 1 } }, refusals: ["analyze:bearer"], analyses: [] });
  });

  test("só o access de uma sessão viva: o girado, o encerrado e o revogado dão 401", async () => {
    const { auth, accessToken, refreshToken } = await session();
    const renewed = AuthSessionResponseSchema.parse(auth.refresh(refreshBody(refreshToken)).body);
    expect(auth.analyze(analyzeBody(), bearer(accessToken)).status).toBe(401);
    expect(auth.analyze(analyzeBody(), bearer(renewed.accessToken)).status).toBe(200);
    // O índice é o do access na lista dos emitidos: o renovado é o 2º.
    expect(auth.snapshot().analyses.map((a) => a.access)).toEqual([1]);
    expect(auth.logout({ schemaVersion: 1 }, bearer(renewed.accessToken)).status).toBe(204);
    expect(auth.analyze(analyzeBody(), bearer(renewed.accessToken)).status).toBe(401);

    const other = await login(auth);
    expect(auth.analyze(analyzeBody(), bearer(other.accessToken)).status).toBe(200);
    expect(auth.revoke()).toBe(1);
    expect(auth.analyze(analyzeBody(), bearer(other.accessToken)).status).toBe(401);
    expect(auth.snapshot().refusals).toEqual(["analyze:bearer", "analyze:bearer", "analyze:bearer"]);
  });

  test.each([
    ["chave extra", { url: "https://vaga.test/1" }],
    ["modo fora do contrato", { mode: "turbo" }],
    ["requestId que não é UUID", { requestId: "1" }],
    ["texto curto demais", { job: { titleHint: null, text: "curto", clientTruncated: false } }],
    ["chave extra na vaga", { job: { titleHint: null, text: TEXT, clientTruncated: false, perfil: "x" } }],
    ["plataforma fora do contrato", { source: { platform: "orkut", extractorVersion: "colado-1" } }],
  ])("corpo fora do contrato (%s): 400 PAYLOAD_INVALIDO, sem registro", async (_caso, over) => {
    const { auth, accessToken } = await session();
    const reply = auth.analyze(analyzeBody(over), bearer(accessToken));
    expect(reply.status).toBe(400);
    expect(ApiErrorSchema.parse(reply.body).code).toBe("PAYLOAD_INVALIDO");
    expect(auth.snapshot()).toMatchObject({ counters: { analyze: { ok: 0, recusado: 1 } }, refusals: ["analyze:corpo"], analyses: [] });
  });

  test("o Bearer vem antes do corpo, como na API: os dois errados dão 401", async () => {
    const { auth } = await session();
    expect(auth.analyze({}, undefined).status).toBe(401);
    expect(auth.analyze(null, "Bearer x").status).toBe(401);
  });
});

describe("fake-auth: roteiro da análise (D23), só depois das barreiras", () => {
  const scripted = async (step: (typeof ANALYZE_SCRIPTS)[number]) => {
    const s = await session();
    s.auth.script({ analyze: [step] });
    const body = analyzeBody();
    return { ...s, body, reply: s.auth.analyze(body, bearer(s.accessToken)) };
  };

  test("o pedido inválido não consome o roteiro: Bearer errado e corpo errado seguem recusados, e o passo espera o válido", async () => {
    const { auth, accessToken } = await session();
    auth.script({ analyze: ["503", "401"] });
    expect(auth.analyze(analyzeBody(), bearer(newAccessCanary().token)).status).toBe(401);
    expect(auth.analyze(analyzeBody({ mode: "turbo" }), bearer(accessToken)).status).toBe(400);
    expect(auth.snapshot().roteiro).toEqual([]);
    expect(auth.analyze(analyzeBody(), bearer(accessToken)).status).toBe(503);
    expect(auth.analyze(analyzeBody(), bearer(accessToken)).status).toBe(401);
    // A fila acabou: o próximo é o stream de sempre.
    expect(auth.analyze(analyzeBody(), bearer(accessToken)).status).toBe(200);
    expect(auth.snapshot()).toMatchObject({
      counters: { analyze: { ok: 1, recusado: 4 } },
      refusals: ["analyze:bearer", "analyze:corpo", "analyze:roteiro_503", "analyze:roteiro_401"],
      roteiro: ["analyze:503", "analyze:401"],
    });
    expect(auth.snapshot().analyses.map((a) => a.resposta)).toEqual(["503", "401", "stream"]);
  });

  test("um roteiro novo substitui a fila pendente", async () => {
    const { auth, accessToken } = await session();
    auth.script({ analyze: ["401", "401", "401"] });
    auth.script({ analyze: ["503"] });
    expect(auth.analyze(analyzeBody(), bearer(accessToken)).status).toBe(503);
    expect(auth.analyze(analyzeBody(), bearer(accessToken)).status).toBe(200);
  });

  test.each([
    ["401", 401, "NAO_AUTENTICADO"],
    ["503", 503, "SERVICO_INDISPONIVEL"],
  ] as const)("%s: o ApiError do contrato com o requestId do pedido, sem stream", async (step, status, code) => {
    const { reply, body, auth } = await scripted(step);
    expect(reply.status).toBe(status);
    expect(reply.sse).toBeUndefined();
    expect(ApiErrorSchema.parse(reply.body)).toMatchObject({ code, requestId: body.requestId });
    expect(auth.snapshot().counters.analyze).toEqual({ ok: 0, recusado: 1 });
  });

  test("fora_do_contrato: 500 com um corpo que não é ApiError, e o texto dele entra nos canários", async () => {
    const { reply, auth } = await scripted("fora_do_contrato");
    expect(reply.status).toBe(500);
    expect(ApiErrorSchema.safeParse(reply.body).success).toBe(false);
    const erro = (reply.body as { erro: string }).erro;
    expect(erro).toMatch(/^CANARIO-ERR-[0-9a-f-]{36}$/);
    expect(auth.snapshot().canaries).toContain(erro);
    expect(auth.snapshot().refusals).toEqual(["analyze:roteiro_fora_do_contrato"]);
  });

  test("silencio: um stage, e o stream fica aberto; para o leitor do SW, falta o terminal", async () => {
    const { reply, auth } = await scripted("silencio");
    expect(reply).toMatchObject({ status: 200, hold: true });
    const read = readWithSw(reply);
    expect(read.stages).toEqual(["recebido"]);
    expect(read.end).toEqual({ kind: "incompleto" });
    expect(auth.snapshot().counters.analyze).toEqual({ ok: 1, recusado: 0 });
  });

  test.each([
    ["keep_alive", ["recebido"], ["seguir", "violacao", "violacao"]],
    ["depois_do_resultado", ["recebido"], ["seguir", "seguir", "violacao"]],
    ["event_divergente", ["recebido"], ["seguir", "violacao"]],
  ] as const)("%s: o leitor do SW vê a violação, e o resultado nunca sai", async (step, stages, feeds) => {
    const { reply } = await scripted(step);
    expect(reply.status).toBe(200);
    expect(reply.hold).toBeUndefined();
    const read = readWithSw(reply);
    expect(read.stages).toEqual(stages);
    expect(read.feeds).toEqual(feeds);
    expect(read.end).toEqual({ kind: "violacao" });
    // O resultado está de fato no stream: o que o esconde é a barreira do SW.
    expect((reply.sse ?? []).join("")).toContain('"type":"result"');
  });

  test("grande_demais: um byte acima do teto do stream no SW, numa linha sem fim que o leitor ainda não pode recusar", async () => {
    const { reply } = await scripted("grande_demais");
    const bytes = Buffer.byteLength((reply.sse ?? []).join(""));
    expect(bytes).toBeGreaterThan(ANALYZE_STREAM_POLICY.streamMaxBytes);
    expect((reply.sse ?? []).at(-1)).not.toContain("\n");
    expect(readWithSw(reply)).toMatchObject({ stages: ["recebido"], feeds: ["seguir", "seguir"], end: { kind: "incompleto" } });
  });
});

describe("fake-auth: roteiro da renovação, expiresIn e revogação (D23)", () => {
  test("503: só para a renovação que valeria, sem girar o par; a sessão segue viva", async () => {
    const { auth, refreshToken, accessToken } = await session();
    auth.script({ refresh: ["503"] });
    // Corpo fora do contrato e envelope desconhecido seguem recusados como sempre, sem gastar o roteiro.
    expect(auth.refresh({ schemaVersion: 1, refreshToken: "r1.x" }).status).toBe(400);
    expect(auth.refresh(refreshBody(refreshToken.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).status).toBe(401);
    expect(auth.snapshot().roteiro).toEqual([]);
    const reply = auth.refresh(refreshBody(refreshToken));
    expect(reply.status).toBe(503);
    expect(ApiErrorSchema.parse(reply.body).code).toBe("SERVICO_INDISPONIVEL");
    // O access antigo ainda vale, e a renovação seguinte gira o par.
    expect(auth.analyze(analyzeBody(), bearer(accessToken)).status).toBe(200);
    expect(auth.refresh(refreshBody(refreshToken)).status).toBe(200);
    expect(auth.snapshot()).toMatchObject({
      counters: { refresh: { ok: 1, recusado: 3 } },
      refusals: ["refresh:corpo", "refresh:envelope_desconhecido", "refresh:roteiro_503"],
      roteiro: ["refresh:503"],
    });
  });

  test("segurar: a resposta fica presa, e o par só gira na hora de soltar", async () => {
    const { auth, refreshToken, accessToken } = await session();
    auth.script({ refresh: ["segurar"] });
    const held = auth.refresh(refreshBody(refreshToken));
    expect(held).toMatchObject({ status: 200, hold: true });
    expect(held.body).toBeUndefined();
    // Enquanto presa, nada girou: o access antigo vale, e nenhum par novo nasceu.
    expect(auth.snapshot().accessTokens).toHaveLength(1);
    expect(auth.analyze(analyzeBody(), bearer(accessToken)).status).toBe(200);
    const released = held.later?.();
    const next = AuthSessionResponseSchema.parse(released?.body);
    expect(next.accessToken).not.toBe(accessToken);
    expect(auth.analyze(analyzeBody(), bearer(accessToken)).status).toBe(401);
    expect(auth.snapshot()).toMatchObject({ counters: { refresh: { ok: 1, recusado: 0 } }, roteiro: ["refresh:segurar"] });
  });

  test("segurar com a sessão revogada antes de soltar: 401, e nada gira", async () => {
    const { auth, refreshToken } = await session();
    auth.script({ refresh: ["segurar"] });
    const held = auth.refresh(refreshBody(refreshToken));
    expect(auth.revoke()).toBe(1);
    const released = held.later?.();
    expect(released?.status).toBe(401);
    expect(ApiErrorSchema.parse(released?.body).code).toBe("NAO_AUTENTICADO");
    expect(auth.snapshot()).toMatchObject({ counters: { refresh: { ok: 0, recusado: 1 } }, roteiro: ["refresh:segurar", "revogar"] });
  });

  test("um passo por renovação válida, na ordem da fila; um roteiro novo substitui a fila pendente", async () => {
    const { auth, refreshToken } = await session();
    auth.script({ refresh: ["segurar", "segurar", "segurar"] });
    auth.script({ refresh: ["503", "segurar"] });
    expect(auth.refresh(refreshBody(refreshToken)).status).toBe(503);
    expect(auth.refresh(refreshBody(refreshToken)).hold).toBe(true);
    expect(auth.refresh(refreshBody(refreshToken)).status).toBe(200);
  });

  test("expiresIn: vale para os próximos pares (troca e renovação), e o padrão são os 900 s", async () => {
    const auth = createFakeAuth({ extensionId: ID, now: () => 0 });
    expect((await login(auth)).expiresIn).toBe(900);
    auth.script({ expiresIn: 30 });
    const short = await login(auth);
    expect(short.expiresIn).toBe(30);
    expect(AuthSessionResponseSchema.parse(auth.refresh(refreshBody(short.refreshToken)).body).expiresIn).toBe(30);
    // Outro roteiro sem a chave não mexe no prazo.
    auth.script({ logout503: 1 });
    expect((await login(auth)).expiresIn).toBe(30);
  });

  test("revogar: encerra todas as sessões vivas e diz quantas eram; a renovação, a análise e o logout dão 401", async () => {
    const auth = createFakeAuth({ extensionId: ID, now: () => 0 });
    const a = await login(auth);
    const b = await login(auth);
    expect(auth.revoke()).toBe(2);
    expect(auth.revoke()).toBe(0);
    for (const s of [a, b]) {
      expect(auth.refresh(refreshBody(s.refreshToken)).status).toBe(401);
      expect(auth.analyze(analyzeBody(), bearer(s.accessToken)).status).toBe(401);
      expect(auth.logout({ schemaVersion: 1 }, bearer(s.accessToken)).status).toBe(401);
    }
    expect(auth.snapshot().roteiro).toEqual(["revogar", "revogar"]);
    // Um login novo funciona: a revogação não quebra o falso.
    expect(auth.analyze(analyzeBody(), bearer((await login(auth)).accessToken)).status).toBe(200);
  });
});

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((resolve) => {
          s.closeAllConnections();
          s.close(resolve);
        }),
    ),
  );
});

async function serve(handler: Handler): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

interface CallOptions {
  readonly method?: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

function call(port: number, opts: CallOptions): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

/** Um pedido cuja resposta o teste lê aos poucos e pode largar no meio, como o `fetch` abortado do SW. */
function open(port: number, opts: CallOptions) {
  const chunks: string[] = [];
  let response: IncomingMessage | undefined;
  let ended = false;
  const req = request({ host: "127.0.0.1", port, method: opts.method ?? "POST", path: opts.path, headers: opts.headers }, (res) => {
    response = res;
    res.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
    res.on("end", () => {
      ended = true;
    });
  });
  req.on("error", () => undefined);
  req.end(opts.body);
  return { text: () => chunks.join(""), status: () => response?.statusCode, headers: () => response?.headers, ended: () => ended, abort: () => req.destroy() };
}

describe("fake-servers: POST /v1/analyze pelo HTTP (D22)", () => {
  let env: FakeEnvironment;
  /** O BFF falso de pé, com uma sessão aberta no mesmo estado dele (o `createAuth` injetado entrega o falso ao teste). */
  async function bff() {
    let auth: ReturnType<typeof createFakeAuth> | undefined;
    env = createFakeEnvironment({ extensionId: ID, now: () => 0, controlToken: "segredo-de-teste", createAuth: (extensionId, now) => (auth = createFakeAuth({ extensionId, now })) });
    const port = await serve(env.bff);
    const session = await login(auth as ReturnType<typeof createFakeAuth>);
    return { port, session };
  }
  const json = { origin: ORIGIN, "content-type": "application/json" };
  const post = (port: number, token: string | undefined, body: unknown, headers: Record<string, string> = json) =>
    call(port, { method: "POST", path: ANALYZE_PATH, headers: { ...headers, ...(token === undefined ? {} : { authorization: bearer(token) }) }, body: typeof body === "string" ? body : JSON.stringify(body) });

  test("o caminho é o que o SW chama, e o preflight dele responde como o das outras rotas", async () => {
    const { port } = await bff();
    expect(ANALYZE_PATH).toBe(SW_ANALYZE_PATH);
    const reply = await call(port, { method: "OPTIONS", path: ANALYZE_PATH, headers: { origin: ORIGIN } });
    expect(reply.status).toBe(204);
    expect(reply.headers).toMatchObject({ "access-control-allow-origin": ORIGIN, "access-control-allow-methods": "POST", "access-control-allow-headers": "authorization, content-type" });
  });

  test("pedido válido: 200 em text/event-stream, com CORS e no-store, o stream inteiro e o registro com a presença do Authorization", async () => {
    const { port, session } = await bff();
    const body = analyzeBody();
    const reply = await post(port, session.accessToken, body);
    expect(reply.status).toBe(200);
    expect(reply.headers).toMatchObject({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": ORIGIN,
      vary: "Origin",
    });
    expect(readWithSw({ status: 200, sse: [reply.body] }).end).toMatchObject({ kind: "completo", terminal: { type: "result", report: { requestId: body.requestId } } });
    const state = env.state();
    expect(state.requests.at(-1)).toEqual({ server: "bff", method: "POST", path: ANALYZE_PATH, origin: ORIGIN, authorization: true, cookie: false });
    expect(state.analises).toEqual({ abertas: 0, abortadas: 0 });
    expect(JSON.stringify(state.requests)).not.toContain(session.accessToken);
  });

  test("as barreiras do HTTP, nesta ordem, e nenhuma consome o roteiro: origem, método, tamanho, tipo de conteúdo, JSON, Bearer e corpo", async () => {
    const { port, session } = await bff();
    env.script({ analyze: ["503"] });
    const body = analyzeBody();
    const token = session.accessToken;
    const semOrigem = await call(port, { method: "POST", path: ANALYZE_PATH, headers: { "content-type": "application/json", authorization: bearer(token) }, body: JSON.stringify(body) });
    expect(semOrigem.status).toBe(403);
    expect(semOrigem.headers["access-control-allow-origin"]).toBeUndefined();
    expect((await call(port, { path: ANALYZE_PATH, headers: { origin: ORIGIN, authorization: bearer(token) } })).status).toBe(405);
    // O teto é o da API (64 KiB), não o das rotas de auth: 2.049 bytes passam, e 64 KiB + 1 não.
    expect((await post(port, token, " ".repeat(AUTH_BODY_MAX_BYTES + 1) + "{")).status).toBe(400);
    expect((await post(port, token, "x".repeat(HTTP_BODY_MAX_BYTES + 1))).status).toBe(413);
    for (const type of ["text/plain", "application/json; charset=utf-8", "application/x-www-form-urlencoded"]) {
      expect((await post(port, token, body, { origin: ORIGIN, "content-type": type })).status, type).toBe(415);
    }
    expect((await post(port, token, body, { origin: ORIGIN })).status).toBe(415);
    expect((await post(port, token, "{")).status).toBe(400);
    expect((await post(port, undefined, body)).status).toBe(401);
    expect((await post(port, token, { ...body, mode: "turbo" })).status).toBe(400);
    expect(env.state().auth).toMatchObject({ roteiro: [], analyses: [], refusals: ["analyze:bearer", "analyze:corpo"] });
    // Só o pedido que passou por tudo gasta o passo.
    expect((await post(port, token, body)).status).toBe(503);
    expect(env.state().auth.roteiro).toEqual(["analyze:503"]);
  });

  test("as rotas de auth seguem com o teto de 2.048 bytes", async () => {
    const { port } = await bff();
    const reply = await call(port, { method: "POST", path: "/v1/auth/refresh", headers: json, body: "x".repeat(AUTH_BODY_MAX_BYTES + 1) });
    expect(reply.status).toBe(413);
  });

  test("silencio: o cabeçalho e o stage chegam, o stream fica aberto, e o cliente que desiste é contado", async () => {
    const { port, session } = await bff();
    env.script({ analyze: ["silencio"] });
    const pending = open(port, { path: ANALYZE_PATH, headers: { ...json, authorization: bearer(session.accessToken) }, body: JSON.stringify(analyzeBody()) });
    await expect.poll(() => pending.text()).toMatch(/^event: stage\n/);
    expect(pending.status()).toBe(200);
    expect(pending.headers()?.["content-type"]).toBe("text/event-stream; charset=utf-8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pending.ended()).toBe(false);
    expect(env.state().analises).toEqual({ abertas: 1, abortadas: 0 });
    pending.abort();
    await expect.poll(() => env.state().analises).toEqual({ abertas: 0, abortadas: 1 });
  });

  test("o zerar encerra o stream aberto pelo servidor, sem contar como abortado, e zera a conta", async () => {
    const { port, session } = await bff();
    env.script({ analyze: ["silencio", "silencio"] });
    const headers = { ...json, authorization: bearer(session.accessToken) };
    const dropped = open(port, { path: ANALYZE_PATH, headers, body: JSON.stringify(analyzeBody()) });
    await expect.poll(() => env.state().analises.abertas).toBe(1);
    dropped.abort();
    await expect.poll(() => env.state().analises).toEqual({ abertas: 0, abortadas: 1 });
    const kept = open(port, { path: ANALYZE_PATH, headers, body: JSON.stringify(analyzeBody()) });
    await expect.poll(() => env.state().analises.abertas).toBe(1);
    env.reset();
    await expect.poll(() => kept.ended()).toBe(true);
    expect(env.state().analises).toEqual({ abertas: 0, abortadas: 0 });
  });

  test("renovação presa: não responde até o soltar, que gira o par; o zerar encerra a presa com 410", async () => {
    const { port, session } = await bff();
    const refresh = () => call(port, { method: "POST", path: "/v1/auth/refresh", headers: json, body: JSON.stringify(refreshBody(session.refreshToken)) });
    env.script({ refresh: ["segurar"] });
    const held = refresh();
    await expect.poll(() => env.state().segurados).toBe(1);
    expect(env.state().auth.counters.refresh).toEqual({ ok: 0, recusado: 0 });
    expect(env.release()).toBe(1);
    const released = await held;
    expect(released.status).toBe(200);
    expect(released.headers["access-control-allow-origin"]).toBe(ORIGIN);
    const next = AuthSessionResponseSchema.parse(JSON.parse(released.body));
    expect(env.state()).toMatchObject({ segurados: 0, auth: { counters: { refresh: { ok: 1, recusado: 0 } } } });

    env.script({ refresh: ["segurar"] });
    const dropped = call(port, { method: "POST", path: "/v1/auth/refresh", headers: json, body: JSON.stringify(refreshBody(next.refreshToken)) });
    await expect.poll(() => env.state().segurados).toBe(1);
    env.reset();
    expect((await dropped).status).toBe(410);
    expect(env.state().segurados).toBe(0);
  });

  test("renovação presa cujo cliente desistiu: sai da lista sem girar nada, e o envelope segue valendo", async () => {
    const { port, session } = await bff();
    env.script({ refresh: ["segurar"] });
    const pending = open(port, { path: "/v1/auth/refresh", headers: json, body: JSON.stringify(refreshBody(session.refreshToken)) });
    await expect.poll(() => env.state().segurados).toBe(1);
    pending.abort();
    await expect.poll(() => env.state().segurados).toBe(0);
    expect(env.release()).toBe(0);
    expect(env.state().auth.accessTokens).toHaveLength(1);
    const again = await call(port, { method: "POST", path: "/v1/auth/refresh", headers: json, body: JSON.stringify(refreshBody(session.refreshToken)) });
    expect(again.status).toBe(200);
  });
});

describe("fake-servers: canal de controle do 04b-3", () => {
  test("revogar só com o segredo e só por POST; o cliente diz quantas sessões eram, e o estado traz as análises", async () => {
    const token = randomBytes(16).toString("hex");
    let auth: ReturnType<typeof createFakeAuth> | undefined;
    const env = createFakeEnvironment({ extensionId: ID, now: () => 0, controlToken: token, createAuth: (extensionId, now) => (auth = createFakeAuth({ extensionId, now })) });
    const port = await serve(env.control);
    const control = fakeControl(`http://127.0.0.1:${port}`, token);
    const session = await login(auth as ReturnType<typeof createFakeAuth>);
    // Sem o segredo, ou por GET, nada é revogado: a sessão segue viva.
    expect((await call(port, { method: "POST", path: "/revogar" })).status).toBe(403);
    expect((await call(port, { path: "/revogar", headers: { [CONTROL_HEADER]: token } })).status).toBe(404);
    expect(auth?.analyze(analyzeBody(), bearer(session.accessToken)).status).toBe(200);
    expect(await control.revoke()).toBe(1);
    expect(auth?.analyze(analyzeBody(), bearer(session.accessToken)).status).toBe(401);
    expect(env.revoke()).toBe(0);
    await control.script({ analyze: ["silencio"], refresh: ["segurar"], expiresIn: 30 });
    expect(await control.state()).toMatchObject({ segurados: 0, analises: { abertas: 0, abortadas: 0 }, auth: { analyses: [{ resposta: "stream" }], roteiro: ["revogar", "revogar"] } });
  });
});
