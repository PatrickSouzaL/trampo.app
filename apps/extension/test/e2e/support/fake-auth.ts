// Estado do IdP falso do E2E (ADR-004 §4.4), sem socket: o `authorize` do Supabase falso e as 3 rotas do BFF falso
// dividem o mesmo processo e o mesmo estado. O `authorize` valida os 4 parâmetros e guarda o challenge; a troca confere
// `S256(verifier)` contra ele, com código de uso único e 5 min, e registra o verifier recebido. Assim o PKCE fica provado
// de ponta a ponta, do Service Worker real até o BFF, sem o Supabase real. Os servidores HTTP são o fake-servers.ts.
// O roteiro (05c-2) torna os falsos mais hostis, nunca mais permissivos: ele só age depois das barreiras de sempre.
import { createHash } from "node:crypto";

import type { ApiError, ApiErrorCode } from "@trampo/contracts/api";
import { AUTH_SCHEMA_VERSION, AuthExchangeRequestSchema, AuthLogoutRequestSchema, AuthRefreshRequestSchema } from "@trampo/contracts/auth";
import { z } from "zod";

import { type AccessCanary, type EnvelopeCanary, newAccessCanary, newCodeCanary, newEnvelopeCanary, newErrorCanary } from "./canaries";

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

/**
 * Roteiro do próximo `authorize` válido (ADR-004 §4.4, cenários 7, 8 e 13), consumido nele:
 * - `segurar`: o 302 normal, mas preso no servidor até o `POST /soltar` do canal de controle;
 * - `cancelar`: o IdP negou; volta `error`, `error_code` e `error_description=CANARIO-ERR-<uuid>`, sem código;
 * - `outro_caminho`: o código certo em `/outro`, fora do `redirect_to`;
 * - `fragmento`: o código certo e um `#access_token=` canário (*downgrade* para *implicit*);
 * - `outro_challenge`: um código que a troca recusa, porque nasceu para o challenge de outro fluxo.
 */
export const AUTHORIZE_SCRIPTS = ["segurar", "cancelar", "outro_caminho", "fragmento", "outro_challenge"] as const;
export type AuthorizeScript = (typeof AUTHORIZE_SCRIPTS)[number];

/** O roteiro chega pelo canal de controle e é dado do teste: forma fechada, e ao menos uma chave. */
export const FakeScriptSchema = z
  .strictObject({
    authorize: z.enum(AUTHORIZE_SCRIPTS).optional(),
    /** Quantos logouts com o Bearer vivo, a seguir, respondem 503 sem derrubar a sessão (cenário 14). */
    logout503: z.int().min(1).max(5).optional(),
  })
  .refine((s) => s.authorize !== undefined || s.logout503 !== undefined);
export type FakeScript = z.infer<typeof FakeScriptSchema>;

/** `hold`: o servidor segura a resposta até o `POST /soltar` (o roteiro `segurar`). */
export type HttpReply = { readonly status: number; readonly body?: unknown; readonly location?: string; readonly hold?: true };

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
  /** Cada passo do roteiro que de fato agiu, na ordem (`authorize:<roteiro>` e `logout:503`): o teste sabe que ele disparou. */
  readonly roteiro: readonly string[];
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
  /** Arma o roteiro: cada chave presente substitui a pendente. */
  script(script: FakeScript): void;
  snapshot(): FakeAuthSnapshot;
}

export interface FakeAuthDeps {
  /** O ID derivado da chave efêmera (P17): o `redirect_to` só vale para ele. */
  readonly extensionId: string;
  readonly now: () => number;
  readonly newCode?: () => string;
  readonly newAccess?: () => AccessCanary;
  readonly newEnvelope?: () => EnvelopeCanary;
  readonly newError?: () => string;
}

const apiError = (code: ApiErrorCode): ApiError => ({ code, message: "Recusado pelo BFF falso do E2E.", requestId: null, retryAfterSeconds: null });
const NAO_AUTENTICADO: HttpReply = { status: 401, body: apiError("NAO_AUTENTICADO") };
const PAYLOAD_INVALIDO: HttpReply = { status: 400, body: apiError("PAYLOAD_INVALIDO") };
const SERVICO_INDISPONIVEL: HttpReply = { status: 503, body: apiError("SERVICO_INDISPONIVEL") };

export function createFakeAuth(deps: FakeAuthDeps): FakeAuth {
  const newCode = deps.newCode ?? newCodeCanary;
  const newAccess = deps.newAccess ?? newAccessCanary;
  const newEnvelope = deps.newEnvelope ?? newEnvelopeCanary;
  const newError = deps.newError ?? newErrorCanary;
  const host = `https://${deps.extensionId}.chromiumapp.org`;
  const redirectBase = `${host}/auth`;
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
  const roteiro: string[] = [];
  const codes = new Map<string, { readonly challenge: string; readonly issuedAt: number }>();
  /** Sessões vivas: envelope → access. A renovação gira o par; o logout derruba pelo access. */
  const sessions = new Map<string, string>();
  let pendingAuthorize: AuthorizeScript | undefined;
  let pendingLogout503 = 0;

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
      counters.authorize.ok += 1;
      const state = String(query.get("redirect_to")).slice(statePrefix.length);
      const script = pendingAuthorize;
      pendingAuthorize = undefined;
      if (script !== undefined) roteiro.push(`authorize:${script}`);
      if (script === "cancelar") {
        // Como o GoTrue no fluxo PKCE: o erro vai na query do `redirect_to`, que já traz o `st`. Nenhum código nasce.
        const description = newError();
        canaries.push(description);
        return { status: 302, location: `${statePrefix}${state}&error=access_denied&error_code=access_denied&error_description=${description}` };
      }
      const code = newCode();
      // O challenge de outro fluxo: o S256 de um valor que nenhum SW tem.
      const challenge = script === "outro_challenge" ? s256(newCode()) : String(query.get("code_challenge"));
      codes.set(code, { challenge, issuedAt: deps.now() });
      canaries.push(code);
      const search = `?code=${code}&st=${state}`;
      if (script === "outro_caminho") return { status: 302, location: `${host}/outro${search}` };
      if (script === "fragmento") {
        const access = newAccess();
        canaries.push(access.token, ...access.segments);
        return { status: 302, location: `${redirectBase}${search}#access_token=${access.token}&token_type=bearer` };
      }
      return { status: 302, location: `${redirectBase}${search}`, ...(script === "segurar" ? { hold: true as const } : {}) };
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
      // O 503 do roteiro só vem depois do corpo e do Bearer conferidos, e a sessão continua viva no servidor.
      if (pendingLogout503 > 0) {
        pendingLogout503 -= 1;
        roteiro.push("logout:503");
        return refuse("logout", "roteiro_503", SERVICO_INDISPONIVEL);
      }
      sessions.delete(envelope);
      counters.logout.ok += 1;
      return { status: 204 };
    },

    script(script) {
      if (script.authorize !== undefined) pendingAuthorize = script.authorize;
      if (script.logout503 !== undefined) pendingLogout503 = script.logout503;
    },

    snapshot() {
      return structuredClone({ counters, refusals, verifiers, accessTokens, canaries, roteiro });
    },
  };
}
