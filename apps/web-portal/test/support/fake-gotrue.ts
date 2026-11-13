// GoTrue (Supabase Auth) simulado em socket real (127.0.0.1) para o portal (ADR-027 §4.2). Molde do `fake-gotrue.ts`
// da API, reescrito aqui (o portal não importa a API). Nenhum teste toca o Supabase real.
//
// - `GET /auth/v1/authorize` confere os 4 parâmetros (método `s256`), guarda o challenge e responde 302 para o
//   `redirect_to` com `code`, como o GoTrue depois do IdP. O `redirect_to` precisa casar a allow-list exata (sem query);
// - `grant_type=pkce` aceita só `{ auth_code, code_verifier }`, confere o S256 e apaga o fluxo (uso único);
// - `grant_type=refresh_token` rotaciona; o refresh já trocado vale de novo por `reuseMs` (o reuso de 10 s do projeto);
// - `hookRefuses` faz a renovação responder como a recusa do hook (403 `error_code` `unknown`, ADR-026 D3), sem
//   consumir o refresh;
// - `/logout?scope=local|global` com Bearer; sessão que já não existe dá 403 `session_not_found`;
// - o access é um JWS ES256 de verdade, com o JWKS em `/auth/v1/.well-known/jwks.json`;
// - os modos `lento` e `corta` processam o pedido antes de atrasar ou cortar a resposta.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

/** Valores que nunca podem aparecer fora do simulado (HTML, cookie legível, log do portal). */
export const GOTRUE_CANARIES = Object.freeze({
  email: "canario-portal@exemplo.invalid",
  providerToken: "CANARIO-PORTAL-PROVIDER-TOKEN",
  providerRefreshToken: "CANARIO-PORTAL-PROVIDER-REFRESH",
  userId: "7c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5",
  errorMessage: "CANARIO-PORTAL-ERRO",
});

export type FakeMode =
  | { readonly kind: "normal" }
  | { readonly kind: "responde"; readonly status: number; readonly body: string | Buffer; readonly contentType?: string | null }
  | { readonly kind: "trava" }
  | { readonly kind: "lento"; readonly delayMs: number }
  /** Processa e corta a resposta no meio do corpo; com `vezes`, volta ao normal depois desse número de cortes. */
  | { readonly kind: "corta"; readonly vezes?: number }
  | { readonly kind: "redireciona"; readonly location: string };

export interface FakeRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface AccessClaimsOverride {
  readonly amr?: unknown;
  readonly sessionId?: string | null;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface FakeGotrueOptions {
  readonly publishableKey: string;
  /** Redirect URLs aceitas, exatas e sem query (a allow-list do painel). */
  readonly allowedRedirects?: readonly string[];
  /** Origem pública do simulado (o `iss` é `${issuerOrigin}/auth/v1`). Padrão: a própria. */
  readonly issuerOrigin?: string;
}

export interface FakeGotrue {
  readonly url: URL;
  readonly requests: FakeRequest[];
  mode: FakeMode;
  /** Status da recusa por verifier errado. */
  rejectStatus: number;
  expiresIn: number;
  /** Renovação recusada como o hook da F1-DB-02. */
  hookRefuses: boolean;
  /** Janela de reuso do refresh já trocado. */
  reuseMs: number;
  /** Claims do próximo access emitido (troca ou renovação). */
  claims: AccessClaimsOverride;
  /** Cria uma sessão viva e devolve os tokens e o id dela. */
  addSession(): Promise<{ readonly accessToken: string; readonly refreshToken: string; readonly sessionId: string }>;
  /** Assina um access à parte (para os testes do verificador). */
  sign(payload: Readonly<Record<string, unknown>>, header?: { readonly kid?: string; readonly alg?: string }): Promise<string>;
  readonly jwk: JWK;
  /** Sessões vivas (id). */
  readonly liveSessions: ReadonlySet<string>;
  /** Todo par emitido (troca, renovação e `addSession`), na ordem: os segredos que o E2E procura fora do simulado. */
  readonly issued: ReadonlyArray<{ readonly accessToken: string; readonly refreshToken: string }>;
  close(): Promise<void>;
}

interface Flow {
  readonly challenge: string;
}

interface RefreshEntry {
  readonly sessionId: string;
  /** Instante em que foi trocado; `undefined` enquanto vale. */
  usedAt: number | undefined;
}

const b64 = (bytes: number): string => randomBytes(bytes).toString("base64url");

function gotrueError(status: number, errorCode: string): string {
  return JSON.stringify({ code: status, error_code: errorCode, msg: GOTRUE_CANARIES.errorMessage });
}

function send(response: ServerResponse, status: number, body: string | Buffer, contentType: string | null = "application/json", extra: Record<string, string> = {}): void {
  response.writeHead(status, { ...(contentType === null ? {} : { "content-type": contentType }), ...extra });
  response.end(body);
}

/** Objeto JSON com exatamente as chaves pedidas, todas string; senão `null`. */
function exactStrings(body: string, keys: readonly string[]): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) return null;
  return keys.every((key) => typeof record[key] === "string") ? (record as Record<string, string>) : null;
}

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly contentType?: string | null;
  readonly headers?: Record<string, string>;
}

export async function startFakeGotrue(options: FakeGotrueOptions): Promise<FakeGotrue> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = b64(6);
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  const requests: FakeRequest[] = [];
  const flows = new Map<string, Flow>();
  const refreshes = new Map<string, RefreshEntry>();
  const liveSessions = new Set<string>();
  const issued: Array<{ readonly accessToken: string; readonly refreshToken: string }> = [];
  /** access → sessão, para o logout. */
  const accessSession = new Map<string, string>();
  const state = {
    mode: { kind: "normal" } as FakeMode,
    rejectStatus: 400,
    expiresIn: 900,
    hookRefuses: false,
    reuseMs: 10_000,
    claims: {} as AccessClaimsOverride,
  };
  let issuer = "";

  const sign = (payload: Readonly<Record<string, unknown>>, header: { readonly kid?: string; readonly alg?: string } = {}): Promise<string> =>
    new SignJWT({ ...payload })
      .setProtectedHeader({ alg: header.alg ?? "ES256", typ: "JWT", ...(header.kid === undefined ? { kid } : header.kid === "" ? {} : { kid: header.kid }) })
      .sign(privateKey);

  const mintAccess = async (sessionId: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1_000);
    const override = state.claims;
    const sid = override.sessionId === undefined ? sessionId : override.sessionId;
    const token = await sign({
      iss: issuer,
      aud: "authenticated",
      role: "authenticated",
      sub: GOTRUE_CANARIES.userId,
      email: GOTRUE_CANARIES.email,
      phone: "",
      aal: "aal1",
      is_anonymous: false,
      amr: override.amr ?? [{ method: "oauth", timestamp: now }],
      ...(sid === null ? {} : { session_id: sid }),
      iat: now,
      exp: now + state.expiresIn,
      ...override.extra,
    });
    accessSession.set(token, sessionId);
    return token;
  };

  const issue = async (sessionId: string): Promise<Reply & { accessToken: string; refreshToken: string }> => {
    const accessToken = await mintAccess(sessionId);
    const refreshToken = b64(9);
    refreshes.set(refreshToken, { sessionId, usedAt: undefined });
    issued.push({ accessToken, refreshToken });
    const body = JSON.stringify({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: state.expiresIn,
      expires_at: Math.floor(Date.now() / 1_000) + state.expiresIn,
      refresh_token: refreshToken,
      user: { id: GOTRUE_CANARIES.userId, email: GOTRUE_CANARIES.email },
      provider_token: GOTRUE_CANARIES.providerToken,
      provider_refresh_token: GOTRUE_CANARIES.providerRefreshToken,
    });
    return { status: 200, body, accessToken, refreshToken };
  };

  const notFound: Reply = { status: 404, body: "<html><body>404 Not Found</body></html>", contentType: "text/html" };

  const authorize = (url: URL): Reply => {
    const params = [...url.searchParams.keys()];
    const redirectTo = url.searchParams.get("redirect_to") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    const provider = url.searchParams.get("provider") ?? "";
    if (
      params.join(",") !== "provider,redirect_to,code_challenge,code_challenge_method" ||
      url.searchParams.get("code_challenge_method") !== "s256" ||
      !["google", "github"].includes(provider) ||
      !/^[\w-]{43}$/.test(challenge) ||
      !URL.canParse(redirectTo)
    ) {
      return { status: 400, body: gotrueError(400, "validation_failed") };
    }
    const target = new URL(redirectTo);
    if (!(options.allowedRedirects ?? []).includes(`${target.origin}${target.pathname}`)) {
      return { status: 400, body: gotrueError(400, "validation_failed") };
    }
    const code = randomUUID();
    flows.set(code, { challenge });
    target.searchParams.append("code", code);
    return { status: 302, body: "", contentType: null, headers: { location: target.href } };
  };

  const handle = async (method: string, url: URL, headers: IncomingHttpHeaders, body: string): Promise<Reply> => {
    if (method === "GET" && url.pathname === "/auth/v1/.well-known/jwks.json") return { status: 200, body: JSON.stringify({ keys: [jwk] }) };
    if (method === "GET" && url.pathname === "/auth/v1/authorize") return authorize(url);
    if (method !== "POST" || !url.pathname.startsWith("/auth/v1/")) return notFound;
    if (headers["apikey"] !== options.publishableKey) return { status: 401, body: JSON.stringify({ message: "Invalid API key" }) };

    if (url.pathname === "/auth/v1/token" && url.search === "?grant_type=pkce") {
      const fields = exactStrings(body, ["auth_code", "code_verifier"]);
      if (fields === null) return { status: 400, body: gotrueError(400, "validation_failed") };
      const flow = flows.get(fields["auth_code"] as string);
      if (flow === undefined) return { status: 404, body: gotrueError(404, "flow_state_not_found") };
      const computed = createHash("sha256").update(fields["code_verifier"] as string).digest("base64url");
      if (computed !== flow.challenge) return { status: state.rejectStatus, body: gotrueError(state.rejectStatus, "bad_code_verifier") };
      flows.delete(fields["auth_code"] as string);
      const sessionId = randomUUID();
      liveSessions.add(sessionId);
      return issue(sessionId);
    }

    if (url.pathname === "/auth/v1/token" && url.search === "?grant_type=refresh_token") {
      const fields = exactStrings(body, ["refresh_token"]);
      if (fields === null) return { status: 400, body: gotrueError(400, "validation_failed") };
      const entry = refreshes.get(fields["refresh_token"] as string);
      if (entry === undefined || !liveSessions.has(entry.sessionId)) return { status: 400, body: gotrueError(400, "refresh_token_not_found") };
      // A recusa do hook desfaz a transação: o refresh não é consumido (ADR-026 F7).
      if (state.hookRefuses) return { status: 403, body: JSON.stringify({ code: 403, error_code: "unknown", msg: "sessao acima da idade maxima" }) };
      if (entry.usedAt !== undefined && Date.now() - entry.usedAt > state.reuseMs) {
        return { status: 400, body: gotrueError(400, "refresh_token_already_used") };
      }
      entry.usedAt ??= Date.now();
      return issue(entry.sessionId);
    }

    if (url.pathname === "/auth/v1/logout" && (url.search === "?scope=local" || url.search === "?scope=global")) {
      const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
      if (bearer === undefined) return { status: 401, body: gotrueError(401, "no_authorization") };
      const sessionId = accessSession.get(bearer);
      if (sessionId === undefined) return { status: 403, body: gotrueError(403, "bad_jwt") };
      if (!liveSessions.has(sessionId)) return { status: 403, body: gotrueError(403, "session_not_found") };
      liveSessions.delete(sessionId);
      return { status: 204, body: "", contentType: null };
    }

    return notFound;
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const method = request.method ?? "";
        const url = new URL(request.url ?? "/", "http://gotrue.invalid");
        requests.push({ method, url: request.url ?? "", headers: request.headers, body });
        const mode = state.mode;
        // O JWKS e o authorize nunca falham pelo modo: o modo é da emissão de token e do logout.
        const exempt = method === "GET";
        if (exempt || mode.kind === "normal") {
          const reply = await handle(method, url, request.headers, body);
          send(response, reply.status, reply.body, reply.contentType, reply.headers);
          return;
        }
        switch (mode.kind) {
          case "responde":
            send(response, mode.status, mode.body, mode.contentType);
            return;
          case "trava":
            return;
          case "lento": {
            const reply = await handle(method, url, request.headers, body);
            setTimeout(() => send(response, reply.status, reply.body, reply.contentType), mode.delayMs);
            return;
          }
          case "corta": {
            if (mode.vezes !== undefined) state.mode = mode.vezes > 1 ? { kind: "corta", vezes: mode.vezes - 1 } : { kind: "normal" };
            const reply = await handle(method, url, request.headers, body);
            response.writeHead(reply.status, { "content-type": "application/json", "content-length": String(reply.body.length + 100) });
            response.write(reply.body.slice(0, 20));
            setTimeout(() => response.socket?.destroy(), 20);
            return;
          }
          case "redireciona":
            response.writeHead(307, { location: mode.location });
            response.end();
            return;
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = new URL(`http://127.0.0.1:${port}`);
  issuer = `${options.issuerOrigin ?? url.origin}/auth/v1`;

  return {
    url,
    requests,
    get mode() {
      return state.mode;
    },
    set mode(value: FakeMode) {
      state.mode = value;
    },
    get rejectStatus() {
      return state.rejectStatus;
    },
    set rejectStatus(value: number) {
      state.rejectStatus = value;
    },
    get expiresIn() {
      return state.expiresIn;
    },
    set expiresIn(value: number) {
      state.expiresIn = value;
    },
    get hookRefuses() {
      return state.hookRefuses;
    },
    set hookRefuses(value: boolean) {
      state.hookRefuses = value;
    },
    get reuseMs() {
      return state.reuseMs;
    },
    set reuseMs(value: number) {
      state.reuseMs = value;
    },
    get claims() {
      return state.claims;
    },
    set claims(value: AccessClaimsOverride) {
      state.claims = value;
    },
    async addSession() {
      const sessionId = randomUUID();
      liveSessions.add(sessionId);
      const { accessToken, refreshToken } = await issue(sessionId);
      return { accessToken, refreshToken, sessionId };
    },
    sign,
    jwk,
    liveSessions,
    issued,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
