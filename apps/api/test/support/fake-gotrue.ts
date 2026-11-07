// GoTrue (Supabase Auth) simulado em socket real (127.0.0.1), para o BFF do ADR-004 (§4.2): nenhum teste toca o
// Supabase real. Os testes de protocolo usam o prazo folgado de socket-deadlines.ts (QA-02); os de prazo, prazos
// curtos.
//
// Registra cada requisição (método, caminho, cabeçalhos crus e corpo), para provar a lista fechada de cabeçalhos
// de saída (condição 2 do `[APPSEC]` no §6.3). Comportamento, pela emenda do HITL-035 ao §4.2:
// - `grant_type=pkce` aceita só `{ auth_code, code_verifier }`; o campo `code` (ou qualquer outra chave) dá 400;
// - o fluxo é apagado na troca, então o reuso do código dá 404 `{ error_code: "flow_state_not_found" }`, como no
//   pré-spike (caso A);
// - verifier errado e código vencido respondem com `rejectStatus` (400, 401, 403, 404 ou 422), com corpo JSON do
//   GoTrue: os status reais não foram informados;
// - a resposta 200 é hipótese até o P9, com `user`, `provider_token` e `provider_refresh_token` canários;
// - `grant_type=refresh_token` rotaciona: o refresh usado deixa de valer;
// - os modos `lento` e `corta` processam o pedido (rotacionam) antes de atrasar ou cortar a resposta: é o caso
//   "pode ter rotacionado" do D4 passo 6;
// - caminho desconhecido dá 404 em HTML, como uma rota ou um proxy errado.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const GOTRUE_CANARIES = Object.freeze({
  email: "canario-email@exemplo.invalid",
  providerToken: "CANARIO-PROVIDER-TOKEN",
  providerRefreshToken: "CANARIO-PROVIDER-REFRESH",
  userId: "0b1c2d3e-4f50-4617-8a9b-c0d1e2f3a4b5",
  errorCode: "CANARIO-ERROR-CODE",
});

export type GotrueRejectStatus = 400 | 401 | 403 | 404 | 422;

export type GotrueMode =
  | { readonly kind: "normal" }
  | {
      readonly kind: "responde";
      readonly status: number;
      readonly body: string | Buffer;
      /** `null` tira o cabeçalho. Padrão: `application/json`. */
      readonly contentType?: string | null;
    }
  | { readonly kind: "trava" }
  | { readonly kind: "lento"; readonly delayMs: number }
  | { readonly kind: "corta" }
  | { readonly kind: "redireciona"; readonly location: string }
  | { readonly kind: "grande"; readonly bytes: number };

export interface GotrueRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface FakeGotrue {
  readonly url: URL;
  readonly requests: GotrueRequest[];
  mode: GotrueMode;
  rejectStatus: GotrueRejectStatus;
  /** `expires_in` das respostas 200. */
  expiresIn: number;
  /** Registra um fluxo PKCE pendente (o `authorize` que o navegador faria). */
  addFlow(authCode: string, codeVerifier: string, options?: { readonly expired?: boolean }): void;
  /** Cria uma sessão viva e devolve o par de tokens dela. */
  addSession(): { readonly accessToken: string; readonly refreshToken: string };
  /** Refresh tokens que ainda valem. */
  readonly activeRefreshTokens: ReadonlySet<string>;
  /** Access tokens de sessões que o logout ainda não revogou. */
  readonly liveAccessTokens: ReadonlySet<string>;
  close(): Promise<void>;
}

interface Flow {
  readonly codeVerifier: string;
  readonly expired: boolean;
}

const b64 = (bytes: number): string => randomBytes(bytes).toString("base64url");
/** Forma de JWS compacto (3 partes), sem assinatura de verdade: o padrão quando o teste não passa `accessToken`. */
const fakeAccessToken = (): string => `${b64(24)}.${b64(48)}.${b64(32)}`;

export interface FakeGotrueOptions {
  /**
   * Emite o access token de cada resposta 200. Os casos de uso do BFF (07f) passam um JWS assinado com a chave do
   * JWKS local, para o verificador real (`jose`) conferir o token antes de repassar.
   */
  readonly accessToken?: () => string;
  /**
   * Serve o JWKS do projeto em `/auth/v1/.well-known/jwks.json` (GET): o boot exige o JWKS na mesma origem do
   * `SUPABASE_URL` (ADR-013 D6), e o teste de composição do 07g sobe a API inteira contra este simulado.
   */
  readonly jwks?: () => unknown;
}

function gotrueError(status: number, errorCode: string): string {
  return JSON.stringify({ code: status, error_code: errorCode, msg: "simulado" });
}

function send(response: ServerResponse, status: number, body: string | Buffer, contentType: string | null = "application/json"): void {
  response.writeHead(status, contentType === null ? {} : { "content-type": contentType });
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
  const present = Object.keys(record).sort();
  if (present.join(",") !== [...keys].sort().join(",")) return null;
  return keys.every((key) => typeof record[key] === "string") ? (record as Record<string, string>) : null;
}

export async function startFakeGotrue(publishableKey: string, options: FakeGotrueOptions = {}): Promise<FakeGotrue> {
  const mintAccessToken = options.accessToken ?? fakeAccessToken;
  const requests: GotrueRequest[] = [];
  const flows = new Map<string, Flow>();
  const activeRefreshTokens = new Set<string>();
  const liveAccessTokens = new Set<string>();
  /** refresh → access da mesma sessão, para o logout revogar a sessão inteira. */
  const sessionOf = new Map<string, string>();
  const state = { mode: { kind: "normal" } as GotrueMode, rejectStatus: 400 as GotrueRejectStatus, expiresIn: 900 };

  const issue = (): { status: number; body: string; accessToken: string; refreshToken: string } => {
    const accessToken = mintAccessToken();
    const refreshToken = b64(9);
    activeRefreshTokens.add(refreshToken);
    liveAccessTokens.add(accessToken);
    sessionOf.set(refreshToken, accessToken);
    const body = JSON.stringify({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: state.expiresIn,
      expires_at: Math.floor(Date.now() / 1_000) + state.expiresIn,
      refresh_token: refreshToken,
      user: { id: GOTRUE_CANARIES.userId, email: GOTRUE_CANARIES.email, app_metadata: { provider: "github" } },
      provider_token: GOTRUE_CANARIES.providerToken,
      provider_refresh_token: GOTRUE_CANARIES.providerRefreshToken,
    });
    return { status: 200, body, accessToken, refreshToken };
  };

  /** O que o GoTrue responderia no modo normal; processar já muda o estado (troca e rotação). */
  const handle = (method: string, url: URL, headers: IncomingHttpHeaders, body: string): { status: number; body: string; contentType?: string } => {
    if (options.jwks !== undefined && method === "GET" && url.pathname === "/auth/v1/.well-known/jwks.json") {
      return { status: 200, body: JSON.stringify(options.jwks()) };
    }
    if (method !== "POST" || !url.pathname.startsWith("/auth/v1/")) {
      return { status: 404, body: "<html><body>404 Not Found</body></html>", contentType: "text/html" };
    }
    if (headers["apikey"] !== publishableKey) return { status: 401, body: JSON.stringify({ message: "Invalid API key" }) };

    if (url.pathname === "/auth/v1/token" && url.search === "?grant_type=pkce") {
      const fields = exactStrings(body, ["auth_code", "code_verifier"]);
      if (fields === null) return { status: 400, body: gotrueError(400, "validation_failed") };
      const flow = flows.get(fields["auth_code"] ?? "");
      if (flow === undefined) return { status: 404, body: gotrueError(404, "flow_state_not_found") };
      if (flow.expired) return { status: state.rejectStatus, body: gotrueError(state.rejectStatus, "flow_state_expired") };
      if (flow.codeVerifier !== fields["code_verifier"]) {
        return { status: state.rejectStatus, body: gotrueError(state.rejectStatus, "bad_code_verifier") };
      }
      flows.delete(fields["auth_code"] ?? "");
      return issue();
    }

    if (url.pathname === "/auth/v1/token" && url.search === "?grant_type=refresh_token") {
      const fields = exactStrings(body, ["refresh_token"]);
      if (fields === null) return { status: 400, body: gotrueError(400, "validation_failed") };
      const used = fields["refresh_token"] ?? "";
      if (!activeRefreshTokens.has(used)) {
        return { status: state.rejectStatus, body: gotrueError(state.rejectStatus, "refresh_token_not_found") };
      }
      activeRefreshTokens.delete(used);
      return issue();
    }

    if (url.pathname === "/auth/v1/logout" && url.search === "?scope=global") {
      const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
      if (bearer === undefined) return { status: 401, body: gotrueError(401, "no_authorization") };
      // Como o GoTrue real (requireAuthentication, 07h): JWT válido de sessão que já não existe é 403 session_not_found.
      if (!liveAccessTokens.has(bearer)) return { status: 403, body: gotrueError(403, "session_not_found") };
      for (const [refresh, access] of sessionOf) {
        if (access === bearer) {
          activeRefreshTokens.delete(refresh);
          sessionOf.delete(refresh);
        }
      }
      liveAccessTokens.delete(bearer);
      return { status: 204, body: "" };
    }

    return { status: 404, body: "<html><body>404 Not Found</body></html>", contentType: "text/html" };
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const method = request.method ?? "";
      const url = new URL(request.url ?? "/", "http://gotrue.invalid");
      requests.push({ method, url: request.url ?? "", headers: request.headers, body });
      const mode = state.mode;
      switch (mode.kind) {
        case "normal": {
          const reply = handle(method, url, request.headers, body);
          send(response, reply.status, reply.body, reply.contentType);
          return;
        }
        case "responde":
          send(response, mode.status, mode.body, mode.contentType);
          return;
        case "trava":
          return;
        case "lento": {
          const reply = handle(method, url, request.headers, body);
          setTimeout(() => send(response, reply.status, reply.body, reply.contentType), mode.delayMs);
          return;
        }
        case "corta": {
          const reply = handle(method, url, request.headers, body);
          response.writeHead(reply.status, { "content-type": "application/json", "content-length": String(reply.body.length + 100) });
          response.write(reply.body.slice(0, 20));
          setTimeout(() => response.socket?.destroy(), 20);
          return;
        }
        case "redireciona":
          response.writeHead(307, { location: mode.location });
          response.end();
          return;
        case "grande":
          response.writeHead(200, { "content-type": "application/json" });
          response.end(`{"access_token":"${"a".repeat(mode.bytes)}"}`);
          return;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}`),
    requests,
    get mode() {
      return state.mode;
    },
    set mode(value: GotrueMode) {
      state.mode = value;
    },
    get rejectStatus() {
      return state.rejectStatus;
    },
    set rejectStatus(value: GotrueRejectStatus) {
      state.rejectStatus = value;
    },
    get expiresIn() {
      return state.expiresIn;
    },
    set expiresIn(value: number) {
      state.expiresIn = value;
    },
    addFlow(authCode, codeVerifier, options = {}) {
      flows.set(authCode, { codeVerifier, expired: options.expired ?? false });
    },
    addSession() {
      const { accessToken, refreshToken } = issue();
      return { accessToken, refreshToken };
    },
    activeRefreshTokens,
    liveAccessTokens,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
