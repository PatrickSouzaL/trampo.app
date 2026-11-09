// Servidores HTTP do E2E com IdP falso (ADR-004 §4.4), sobre o estado do fake-auth.ts. Os handlers não sabem de TLS: o
// global-setup os põe atrás de HTTPS nas portas do build (BFF em 47443, Supabase em 47444) e o teste de unidade os roda
// em HTTP puro. Cada pedido fica registrado com a origem e a presença de `Authorization` e `Cookie`, nunca com o valor:
// é o que prova o §4.5 item 10 e o SR-02 (nenhuma requisição com `Origin: chrome-extension://` no Supabase falso).
import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTH_BODY_MAX_BYTES, AUTH_ROUTES } from "@trampo/contracts/auth";

import { type FakeAuth, type FakeAuthSnapshot, type FakeScript, type HttpReply, FakeScriptSchema, createFakeAuth } from "./fake-auth";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface RequestRecord {
  readonly server: "bff" | "supabase" | "chromiumapp";
  readonly method: string;
  /** Só o caminho: a query do `authorize` leva o challenge e o `state`, e o registro não guarda valor. */
  readonly path: string;
  readonly origin: string | null;
  readonly authorization: boolean;
  readonly cookie: boolean;
}

export interface FakeState {
  readonly auth: FakeAuthSnapshot;
  readonly requests: readonly RequestRecord[];
  /** Os 302 do `authorize` presos pelo roteiro `segurar`, à espera do `POST /soltar`. */
  readonly segurados: number;
}

export interface FakeEnvironment {
  readonly bff: Handler;
  readonly supabase: Handler;
  /** O destino do `--host-resolver-rules` de `*.chromiumapp.org`: o navegador intercepta o retorno e pode já ter mandado o GET. */
  readonly chromiumapp: Handler;
  /**
   * Canal do teste (o vitest roda os testes noutro processo), só com o segredo: `GET /estado`, `POST /zerar`,
   * `POST /roteiro` (o roteiro do fake-auth.ts, no corpo) e `POST /soltar` (manda os 302 segurados).
   */
  readonly control: Handler;
  state(): FakeState;
  /** Volta ao início: estado novo, sem roteiro, e os 302 segurados encerrados com 410 (nenhum socket fica preso). */
  reset(): void;
  script(script: FakeScript): void;
  /** Manda os 302 segurados e diz quantos eram. */
  release(): number;
}

export interface FakeEnvironmentOptions {
  readonly extensionId: string;
  readonly now: () => number;
  /** Segredo do canal de controle, gerado no global-setup. */
  readonly controlToken: string;
  /** Para o teste de unidade: o fake-auth com códigos e canários determinísticos. */
  readonly createAuth?: (extensionId: string, now: () => number) => FakeAuth;
}

/** Cabeçalho do segredo do canal de controle. */
export const CONTROL_HEADER = "x-trampo-e2e-controle";
/** O roteiro tem duas chaves curtas: nada maior que isto chega ao parse. */
const CONTROL_BODY_MAX_BYTES = 256;

const BFF_ROUTES: ReadonlySet<string> = new Set(Object.values(AUTH_ROUTES));
const HEALTH_PATH = "/v1/health";

/** O `url` do pedido no servidor sempre existe; a base só completa o caminho relativo. */
const urlOf = (req: IncomingMessage): URL => new URL(String(req.url), "https://falso.invalid");
const pathOf = (req: IncomingMessage): string => urlOf(req).pathname;

function record(server: RequestRecord["server"], req: IncomingMessage): RequestRecord {
  return {
    server,
    method: String(req.method),
    path: pathOf(req),
    origin: req.headers.origin ?? null,
    authorization: req.headers.authorization !== undefined,
    cookie: req.headers.cookie !== undefined,
  };
}

/** O corpo inteiro, ou `undefined` acima do teto (o BFF real corta em 2.048 antes do parse, ADR-004 D4) e no pedido abortado. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      chunks.push(chunk);
    });
    req.on("end", () => resolve(total > maxBytes ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });
}

function parseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function send(res: ServerResponse, reply: HttpReply, headers: Record<string, string> = {}): void {
  const base = { "cache-control": "no-store", ...headers };
  if (reply.body === undefined) {
    res.writeHead(reply.status, base).end();
    return;
  }
  res.writeHead(reply.status, { ...base, "content-type": "application/json" }).end(JSON.stringify(reply.body));
}

export function createFakeEnvironment(options: FakeEnvironmentOptions): FakeEnvironment {
  const createAuth = options.createAuth ?? ((extensionId, now) => createFakeAuth({ extensionId, now }));
  const extensionOrigin = `chrome-extension://${options.extensionId}`;
  let auth = createAuth(options.extensionId, options.now);
  let requests: RequestRecord[] = [];
  let held: Array<{ readonly res: ServerResponse; readonly location: string }> = [];

  const bff: Handler = (req, res) => {
    requests.push(record("bff", req));
    void (async () => {
      const body = await readBody(req, AUTH_BODY_MAX_BYTES);
      // Como a borda da API (EXTENSION_ONLY_ROUTES): só a origem exata da extensão, e sem CORS para o resto.
      if (req.headers.origin !== extensionOrigin) return send(res, { status: 403 });
      const cors = { "access-control-allow-origin": extensionOrigin, vary: "Origin" };
      const path = pathOf(req);
      if (path === HEALTH_PATH && req.method === "GET") return send(res, { status: 200, body: { ok: true } }, cors);
      if (!BFF_ROUTES.has(path)) return send(res, { status: 404 }, cors);
      if (req.method === "OPTIONS") {
        return send(res, { status: 204 }, { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "authorization, content-type" });
      }
      if (req.method !== "POST") return send(res, { status: 405 }, cors);
      if (body === undefined) return send(res, { status: 413 }, cors);
      const json = parseJson(body);
      if (!json.ok) return send(res, { status: 400 }, cors);
      if (path === AUTH_ROUTES.exchange) return send(res, auth.exchange(json.value), cors);
      if (path === AUTH_ROUTES.refresh) return send(res, auth.refresh(json.value), cors);
      return send(res, auth.logout(json.value, req.headers.authorization), cors);
    })();
  };

  const supabase: Handler = (req, res) => {
    requests.push(record("supabase", req));
    req.resume();
    const url = urlOf(req);
    if (req.method !== "GET" || url.pathname !== "/auth/v1/authorize") return send(res, { status: 404 });
    const reply = auth.authorize(url.searchParams);
    if (reply.location === undefined) return send(res, reply);
    if (reply.hold === true) {
      held.push({ res, location: reply.location });
      return;
    }
    send(res, { status: reply.status }, { location: reply.location });
  };

  const chromiumapp: Handler = (req, res) => {
    requests.push(record("chromiumapp", req));
    req.resume();
    send(res, { status: 404 });
  };

  const state = (): FakeState => ({ auth: auth.snapshot(), requests: structuredClone(requests), segurados: held.length });
  const release = (): number => {
    const out = held;
    held = [];
    for (const h of out) send(h.res, { status: 302 }, { location: h.location });
    return out.length;
  };
  const reset = (): void => {
    for (const h of held) send(h.res, { status: 410 });
    held = [];
    auth = createAuth(options.extensionId, options.now);
    requests = [];
  };
  const script = (s: FakeScript): void => auth.script(s);

  const control: Handler = (req, res) => {
    if (req.headers[CONTROL_HEADER] !== options.controlToken) {
      req.resume();
      return send(res, { status: 403 });
    }
    void (async () => {
      const body = await readBody(req, CONTROL_BODY_MAX_BYTES);
      const path = pathOf(req);
      if (req.method === "GET" && path === "/estado") return send(res, { status: 200, body: state() });
      if (req.method !== "POST") return send(res, { status: 404 });
      if (path === "/zerar") {
        reset();
        return send(res, { status: 204 });
      }
      if (path === "/soltar") return send(res, { status: 200, body: { soltos: release() } });
      if (path !== "/roteiro") return send(res, { status: 404 });
      const json = body === undefined ? undefined : parseJson(body);
      const parsed = FakeScriptSchema.safeParse(json?.ok === true ? json.value : undefined);
      if (!parsed.success) return send(res, { status: 400 });
      script(parsed.data);
      send(res, { status: 204 });
    })();
  };

  return { bff, supabase, chromiumapp, control, state, reset, script, release };
}

/** Os pedidos com `Origin: chrome-extension://…` num servidor: no Supabase falso, precisam ficar em 0 (SR-02, P3). */
export const extensionOriginRequests = (state: FakeState, server: RequestRecord["server"]): RequestRecord[] =>
  state.requests.filter((r) => r.server === server && r.origin?.startsWith("chrome-extension://") === true);

/** Cliente do canal de controle, no processo dos testes. */
export interface FakeControl {
  state(): Promise<FakeState>;
  reset(): Promise<void>;
  script(script: FakeScript): Promise<void>;
  release(): Promise<number>;
}

export function fakeControl(url: string, token: string): FakeControl {
  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Response> => {
    const headers: Record<string, string> = { [CONTROL_HEADER]: token };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? null : JSON.stringify(body) });
    if (!response.ok) throw new Error(`canal de controle do E2E respondeu ${response.status} em ${path}`);
    return response;
  };
  return {
    state: async () => (await (await call("GET", "/estado")).json()) as FakeState,
    reset: async () => {
      await call("POST", "/zerar");
    },
    script: async (script) => {
      await call("POST", "/roteiro", script);
    },
    release: async () => ((await (await call("POST", "/soltar")).json()) as { soltos: number }).soltos,
  };
}
