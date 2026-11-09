// Estado do IdP falso do E2E (ADR-004 §4.4), sem socket: o `authorize` do Supabase falso e as 3 rotas do BFF falso
// dividem o mesmo processo e o mesmo estado. O `authorize` valida os 4 parâmetros e guarda o challenge; a troca confere
// `S256(verifier)` contra ele, com código de uso único e 5 min, e registra o verifier recebido. Assim o PKCE fica provado
// de ponta a ponta, do Service Worker real até o BFF, sem o Supabase real. Os servidores HTTP são o fake-servers.ts.
import { createHash } from "node:crypto";

import type { ApiError, ApiErrorCode } from "@trampo/contracts/api";
import { AUTH_SCHEMA_VERSION, AuthExchangeRequestSchema, AuthLogoutRequestSchema, AuthRefreshRequestSchema } from "@trampo/contracts/auth";

import { type AccessCanary, type EnvelopeCanary, newAccessCanary, newCodeCanary, newEnvelopeCanary } from "./canaries";

export const FAKE_AUTH_POLICY = Object.freeze({
  /** O GoTrue aceita o código por 5 min (P8). Vale até o limite, inclusive. */
  codeTtlMs: 300_000,
  /** O JWT de 900 s do HITL-004. */
  expiresIn: 900,
});

const PROVIDERS: ReadonlySet<string> = new Set(["github", "google"]);
/** Exatamente estes 4, cada um uma vez, como o `buildAuthorizeUrl` monta (ADR-004 D3 passo 5). */
const AUTHORIZE_KEYS = ["provider", "redirect_to", "code_challenge", "code_challenge_method"] as const;
/** S256 de 32 bytes em base64url sem preenchimento. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** O `state` de 16 bytes do SW, em base64url. */
const STATE = /^[A-Za-z0-9_-]{22}$/;

export const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

export type HttpReply = { readonly status: number; readonly body?: unknown; readonly location?: string };

export type AuthorizeRefusal = "parametros" | "provedor" | "metodo" | "challenge" | "redirect_to";
export type ExchangeRefusal = "corpo" | "codigo_desconhecido" | "codigo_vencido" | "verifier_divergente";

export interface FakeAuthCounters {
  readonly authorize: { ok: number; recusado: number };
  readonly exchange: { ok: number; recusado: number };
  readonly refresh: { ok: number; recusado: number };
  readonly logout: { ok: number; recusado: number };
}

export interface FakeAuthSnapshot {
  readonly counters: FakeAuthCounters;
  /** Os motivos das recusas, na ordem: o teste diz qual barreira parou o pedido. */
  readonly refusals: readonly string[];
  /** Os verifiers que chegaram à troca, válidos ou não: são canários também (§4.4). */
  readonly verifiers: readonly string[];
  /** Os access tokens emitidos, na ordem. */
  readonly accessTokens: readonly string[];
  /** Todo valor emitido ou recebido que nunca pode aparecer no painel, na aba, em log nem em `local`/`sync`. */
  readonly canaries: readonly string[];
}

export interface FakeAuth {
  /** `GET /auth/v1/authorize` do Supabase falso: 302 para o chromiumapp com o código, ou 400. */
  authorize(query: URLSearchParams): HttpReply;
  /** `POST /v1/auth/exchange`. */
  exchange(body: unknown): HttpReply;
  /** `POST /v1/auth/refresh`. */
  refresh(body: unknown): HttpReply;
  /** `POST /v1/auth/logout`, com o cabeçalho `Authorization` cru. */
  logout(body: unknown, authorization: string | undefined): HttpReply;
  snapshot(): FakeAuthSnapshot;
}

export interface FakeAuthDeps {
  /** O ID derivado da chave efêmera (P17): o `redirect_to` só vale para ele. */
  readonly extensionId: string;
  readonly now: () => number;
  readonly newCode?: () => string;
  readonly newAccess?: () => AccessCanary;
  readonly newEnvelope?: () => EnvelopeCanary;
}

const apiError = (code: ApiErrorCode): ApiError => ({ code, message: "Recusado pelo BFF falso do E2E.", requestId: null, retryAfterSeconds: null });
const NAO_AUTENTICADO: HttpReply = { status: 401, body: apiError("NAO_AUTENTICADO") };
const PAYLOAD_INVALIDO: HttpReply = { status: 400, body: apiError("PAYLOAD_INVALIDO") };

export function createFakeAuth(deps: FakeAuthDeps): FakeAuth {
  const newCode = deps.newCode ?? newCodeCanary;
  const newAccess = deps.newAccess ?? newAccessCanary;
  const newEnvelope = deps.newEnvelope ?? newEnvelopeCanary;
  const redirectBase = `https://${deps.extensionId}.chromiumapp.org/auth`;
  const counters: FakeAuthCounters = {
    authorize: { ok: 0, recusado: 0 },
    exchange: { ok: 0, recusado: 0 },
    refresh: { ok: 0, recusado: 0 },
    logout: { ok: 0, recusado: 0 },
  };
  const refusals: string[] = [];
  const verifiers: string[] = [];
  const accessTokens: string[] = [];
  const canaries: string[] = [];
  const codes = new Map<string, { readonly challenge: string; readonly issuedAt: number }>();
  /** Sessões vivas: envelope → access. A renovação gira o par; o logout derruba pelo access. */
  const sessions = new Map<string, string>();

  const refuse = (route: keyof FakeAuthCounters, motivo: string, reply: HttpReply): HttpReply => {
    counters[route].recusado += 1;
    refusals.push(`${route}:${motivo}`);
    return reply;
  };

  const issue = (): HttpReply => {
    const access = newAccess();
    const { envelope, cipher } = newEnvelope();
    sessions.set(envelope, access.token);
    accessTokens.push(access.token);
    canaries.push(access.token, ...access.segments, envelope, cipher);
    return { status: 200, body: { schemaVersion: AUTH_SCHEMA_VERSION, accessToken: access.token, refreshToken: envelope, expiresIn: FAKE_AUTH_POLICY.expiresIn } };
  };

  const statePrefix = `${redirectBase}?st=`;
  /** Depois da 1ª barreira, os 4 parâmetros existem uma vez cada: o `String` só tira o `null` do tipo. */
  const authorizeRefusal = (query: URLSearchParams): AuthorizeRefusal | undefined => {
    if ([...query.keys()].length !== AUTHORIZE_KEYS.length || AUTHORIZE_KEYS.some((key) => query.getAll(key).length !== 1)) return "parametros";
    if (!PROVIDERS.has(String(query.get("provider")))) return "provedor";
    if (query.get("code_challenge_method") !== "s256") return "metodo";
    if (!CHALLENGE.test(String(query.get("code_challenge")))) return "challenge";
    const redirectTo = String(query.get("redirect_to"));
    if (!redirectTo.startsWith(statePrefix) || !STATE.test(redirectTo.slice(statePrefix.length))) return "redirect_to";
    return undefined;
  };

  return {
    authorize(query) {
      const motivo = authorizeRefusal(query);
      if (motivo !== undefined) return refuse("authorize", motivo, { status: 400, body: "authorize recusado pelo Supabase falso" });
      const code = newCode();
      codes.set(code, { challenge: String(query.get("code_challenge")), issuedAt: deps.now() });
      canaries.push(code);
      counters.authorize.ok += 1;
      const state = String(query.get("redirect_to")).slice(statePrefix.length);
      return { status: 302, location: `${redirectBase}?code=${code}&st=${state}` };
    },

    exchange(body) {
      const parsed = AuthExchangeRequestSchema.safeParse(body);
      if (!parsed.success) return refuse("exchange", "corpo", PAYLOAD_INVALIDO);
      const { authCode, codeVerifier } = parsed.data;
      verifiers.push(codeVerifier);
      canaries.push(codeVerifier);
      const entry = codes.get(authCode);
      // Uso único: o código morre na primeira troca, qualquer que seja o resultado (P8).
      codes.delete(authCode);
      if (entry === undefined) return refuse("exchange", "codigo_desconhecido", NAO_AUTENTICADO);
      if (deps.now() - entry.issuedAt > FAKE_AUTH_POLICY.codeTtlMs) return refuse("exchange", "codigo_vencido", NAO_AUTENTICADO);
      if (s256(codeVerifier) !== entry.challenge) return refuse("exchange", "verifier_divergente", NAO_AUTENTICADO);
      counters.exchange.ok += 1;
      return issue();
    },

    refresh(body) {
      const parsed = AuthRefreshRequestSchema.safeParse(body);
      if (!parsed.success) return refuse("refresh", "corpo", PAYLOAD_INVALIDO);
      if (!sessions.delete(parsed.data.refreshToken)) return refuse("refresh", "envelope_desconhecido", NAO_AUTENTICADO);
      counters.refresh.ok += 1;
      return issue();
    },

    logout(body, authorization) {
      if (!AuthLogoutRequestSchema.safeParse(body).success) return refuse("logout", "corpo", PAYLOAD_INVALIDO);
      const token = authorization?.startsWith("Bearer ") === true ? authorization.slice("Bearer ".length) : undefined;
      const envelope = [...sessions].find(([, access]) => access === token)?.[0];
      if (envelope === undefined) return refuse("logout", "bearer", NAO_AUTENTICADO);
      sessions.delete(envelope);
      counters.logout.ok += 1;
      return { status: 204 };
    },

    snapshot() {
      return structuredClone({ counters, refusals, verifiers, accessTokens, canaries });
    },
  };
}
