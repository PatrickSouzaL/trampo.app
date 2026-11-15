// Núcleo do login e da sessão do portal (ADR-027 D2 a D7; o acesso à API, ADR-028 D4). Sem Next.js: recebe o que o pedido traz (query, cookies,
// `Origin`, `Sec-Fetch-Site`) e devolve a intenção HTTP (destino e cookies), que as rotas e o proxy só traduzem.
//
// - Nenhum destino sai do pedido: só `/`, `/conta` (de `PORTAL_ORIGIN`) e o `authorize` (de `SUPABASE_URL`).
// - A recusa (do GoTrue, do hook ou do verificador) vira "entre de novo"; o que não chegou ao GoTrue, ou o JWKS fora,
//   vira "indisponível" e nunca apaga a sessão (T30).
// - Nada daqui vai a log, e nenhum token, código, verifier ou `state` sai fora dos cookies selados.
import { z } from "zod";

import type { PortalConfig } from "./config";
import { COOKIE_NAMES, cookieClear, cookieWrite, type CookieWrite } from "./cookies";
import type { GotrueClient, GotrueTokenResult, GotrueTokens } from "./gotrue";
import type { Notice } from "./notices";
import { createState, createVerifier, s256, safeEqual } from "./pkce";
import { SEAL_PURPOSES, createSealer } from "./seal";
import type { AccessTokenVerifier, AccessVerification } from "./verifier";

export const PORTAL_SESSION_POLICY = Object.freeze({
  /** A mesma constante do hook (ADR-026 D4): a sessão morre 24 h depois do login. */
  maxAgeSeconds: 86_400,
  /** Inatividade: 4 h sem renovação (a recomendação do ADR-004 D5). */
  idleSeconds: 14_400,
  /** Renova quando o access tem até 60 s pela frente. */
  renewBeforeSeconds: 60,
  /** O prazo do código (ADR-004 D2). */
  flowMaxAgeSeconds: 300,
  /** O teto do access no cookie (ADR-027 D3): com ele, o pior caso da sessão sempre cabe no selo. */
  accessTokenMaxChars: 2_300,
  /** Prazo da nova tentativa em "pode ter rotacionado" (o reuso de 10 s do GoTrue a cobre). */
  retryTimeoutMs: 2_000,
});

const PROVIDERS: ReadonlySet<string> = new Set(["google", "github"]);
const LOGIN_SITES: ReadonlySet<string> = new Set(["same-origin", "none"]);

export type SessionState = "ativa" | "ausente" | "expirada" | "indisponivel";

export interface Redirect {
  readonly kind: "redirect";
  readonly location: string;
  readonly cookies: readonly CookieWrite[];
}
export interface Forbidden {
  readonly kind: "forbidden";
}
export interface ResolvedSession {
  readonly state: SessionState;
  /** Cookie novo (renovado) ou apagado; ausente quando nada muda. */
  readonly cookie?: CookieWrite;
}

/**
 * Como a DAL pede a sessão para chamar a API (ADR-028 D4):
 * - `leitura`: a página (Server Component, que não grava cookie). Verifica e nunca renova: o proxy já renovou;
 * - `gravacao`: a rota de gravação. Com até 60 s pela frente, renova antes, como o logout;
 * - `forcada`: depois de um 401 da API na gravação. Renova sempre; só a recusa do GoTrue apaga a sessão.
 */
export type ApiAccessMode = "leitura" | "gravacao" | "forcada";
export type ApiAccess =
  | { readonly ok: true; readonly accessToken: string; readonly userId: string; readonly sessionId: string; readonly cookie?: CookieWrite }
  | {
      readonly ok: false;
      readonly state: Exclude<SessionState, "ativa">;
      /** O `sid` do cookie, quando ele abriu (o rascunho se prende a ele). */
      readonly sessionId?: string;
      /** Só nos modos que gravam: o cookie apagado, ou os tokens novos selados com o JWKS fora. */
      readonly cookie?: CookieWrite;
    };

export interface PortalAuthDeps {
  readonly config: PortalConfig;
  readonly gotrue: GotrueClient;
  readonly verifier: AccessTokenVerifier;
  /** Relógio em milissegundos. */
  readonly now: () => number;
  /** Tarefa em segundo plano (o logout da sessão órfã). Nunca rejeita. */
  readonly defer: (task: Promise<unknown>) => void;
}

export interface PortalAuth {
  startLogin(input: { readonly provider: string | null; readonly secFetchSite: string | null }): Promise<Redirect>;
  completeLogin(input: { readonly search: URLSearchParams; readonly flowCookie: string | undefined }): Promise<Redirect>;
  resolveSession(sessionCookie: string | undefined): Promise<ResolvedSession>;
  readSession(sessionCookie: string | undefined): Promise<{ readonly ok: true; readonly userId: string } | { readonly ok: false }>;
  logout(input: {
    readonly origin: string | null;
    readonly secFetchSite: string | null;
    readonly sessionCookie: string | undefined;
  }): Promise<Redirect | Forbidden>;
  /** O access verificado para a API, ou o estado da sessão (ADR-028 D4). */
  apiAccess(sessionCookie: string | undefined, mode: ApiAccessMode): Promise<ApiAccess>;
}

const FlowSchema = z.strictObject({
  v: z.string().regex(/^[\w-]{43}$/),
  st: z.string().regex(/^[\w-]{22}$/),
  p: z.enum(["google", "github"]),
  iat: z.int(),
});

const SessionSchema = z.strictObject({
  at: z.string().max(PORTAL_SESSION_POLICY.accessTokenMaxChars).regex(/^[\w-]+\.[\w-]+\.[\w-]+$/),
  rt: z.string().min(1).max(512),
  sid: z.uuid(),
  /** Início da sessão (login), em segundos. */
  sst: z.int(),
  /** Última selagem (base da inatividade). */
  iat: z.int(),
  /** Fim do access, em segundos. */
  ate: z.int(),
});
type SessionPayload = z.infer<typeof SessionSchema>;

/** O resultado de uma renovação, comum ao proxy (ADR-027 D6) e à DAL da API (ADR-028 D4). */
type Renewal =
  | { readonly kind: "renovada"; readonly payload: SessionPayload; readonly userId: string; readonly cookie: CookieWrite }
  | { readonly kind: "expirada" }
  | { readonly kind: "indisponivel"; readonly cookie?: CookieWrite };

function parseJson<T>(text: string | null, schema: z.ZodType<T>): T | null {
  if (text === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createPortalAuth(deps: PortalAuthDeps): PortalAuth {
  const { config, gotrue, verifier } = deps;
  const sessaoSealer = createSealer(config.sealKeys, SEAL_PURPOSES.sessao, config.portalOrigin);
  const fluxoSealer = createSealer(config.sealKeys, SEAL_PURPOSES.fluxo, config.portalOrigin);
  const nowSeconds = (): number => Math.floor(deps.now() / 1_000);
  const home = (notice: Notice): string => `${config.portalOrigin}/?aviso=${notice}`;
  const clearFlow = cookieClear(COOKIE_NAMES.fluxo);
  const clearSession = cookieClear(COOKIE_NAMES.sessao);

  const openSession = (cookie: string | undefined): SessionPayload | null =>
    cookie === undefined ? null : parseJson(sessaoSealer.open(cookie), SessionSchema);

  const expired = (payload: SessionPayload, now: number): boolean =>
    now - payload.sst > PORTAL_SESSION_POLICY.maxAgeSeconds || now - payload.iat > PORTAL_SESSION_POLICY.idleSeconds;

  /** Sela a sessão; `null` se o access passar do teto do cookie. Dentro do teto, o selo cabe sempre (SEAL_PURPOSES). */
  const sealSession = (payload: SessionPayload): CookieWrite | null => {
    if (payload.at.length > PORTAL_SESSION_POLICY.accessTokenMaxChars) return null;
    const value = sessaoSealer.seal(JSON.stringify(payload)) as string;
    return cookieWrite(COOKIE_NAMES.sessao, value, payload.sst + PORTAL_SESSION_POLICY.maxAgeSeconds - payload.iat);
  };

  /** Sessão órfã (o GoTrue emitiu e o portal não aceitou): uma tentativa de logout, em segundo plano. */
  const dropOrphan = (tokens: GotrueTokens): void => deps.defer(gotrue.logout(tokens.accessToken));

  /** Renovação com uma nova tentativa só em "pode ter rotacionado" (ADR-027 D6). */
  const renew = async (refreshToken: string): Promise<GotrueTokenResult> => {
    const first = await gotrue.refresh(refreshToken);
    if (first.ok || first.reason !== "pode_ter_rotacionado") return first;
    return gotrue.refresh(refreshToken, AbortSignal.timeout(PORTAL_SESSION_POLICY.retryTimeoutMs));
  };

  /** O fim do access: o menor entre o `expires_in` e o `exp` verificado. */
  const accessEnd = (tokens: GotrueTokens, verified: AccessVerification, now: number): number =>
    verified.ok ? Math.min(now + tokens.expiresIn, verified.expiresAt) : now + tokens.expiresIn;

  /** Renova, verifica o access novo contra o `sid` do cookie e sela de novo (mesmo `sst`, `iat` novo). */
  const renewPayload = async (payload: SessionPayload, now: number): Promise<Renewal> => {
    const renewed = await renew(payload.rt);
    if (!renewed.ok) return renewed.reason === "recusado" ? { kind: "expirada" } : { kind: "indisponivel" };
    const { tokens } = renewed;
    const verified = await verifier.verify(tokens.accessToken);
    // Access de outra sessão ou fora da política: a sessão do cookie acabou.
    if (!verified.ok && verified.reason === "invalido") return { kind: "expirada" };
    if (verified.ok && verified.sessionId !== payload.sid) return { kind: "expirada" };
    const next = { ...payload, at: tokens.accessToken, rt: tokens.refreshToken, iat: now, ate: accessEnd(tokens, verified, now) };
    const cookie = sealSession(next);
    // Acima do teto do cookie: o antigo fica (o refresh já rodou, e o reuso de 10 s ainda o aceita).
    if (cookie === null) return { kind: "indisponivel" };
    // JWKS fora: os tokens novos ficam selados (a DAL verifica antes de dar acesso), e o resultado é indisponível.
    return verified.ok ? { kind: "renovada", payload: next, userId: verified.userId, cookie } : { kind: "indisponivel", cookie };
  };

  return {
    async startLogin({ provider, secFetchSite }) {
      if (secFetchSite === null || !LOGIN_SITES.has(secFetchSite) || provider === null || !PROVIDERS.has(provider)) {
        return { kind: "redirect", location: home("entrada_recusada"), cookies: [] };
      }
      const verifierValue = createVerifier();
      const state = createState();
      const flow = fluxoSealer.seal(JSON.stringify({ v: verifierValue, st: state, p: provider, iat: nowSeconds() })) as string;
      const redirectTo = `${config.portalOrigin}/auth/retorno?st=${state}`;
      const query = [
        `provider=${encodeURIComponent(provider)}`,
        `redirect_to=${encodeURIComponent(redirectTo)}`,
        `code_challenge=${encodeURIComponent(s256(verifierValue))}`,
        "code_challenge_method=s256",
      ].join("&");
      return {
        kind: "redirect",
        location: `${config.supabaseUrl}/auth/v1/authorize?${query}`,
        cookies: [cookieWrite(COOKIE_NAMES.fluxo, flow, PORTAL_SESSION_POLICY.flowMaxAgeSeconds)],
      };
    },

    async completeLogin({ search, flowCookie }) {
      const fail = (notice: Notice): Redirect => ({ kind: "redirect", location: home(notice), cookies: [clearFlow] });
      const keys = [...search.keys()].sort();
      const code = search.get("code");
      const st = search.get("st");
      if (keys.join(",") !== "code,st" || code === null || st === null) return fail("login_falhou");
      const flow = flowCookie === undefined ? null : parseJson(fluxoSealer.open(flowCookie), FlowSchema);
      const now = nowSeconds();
      if (flow === null || now - flow.iat > PORTAL_SESSION_POLICY.flowMaxAgeSeconds || !safeEqual(st, flow.st)) return fail("login_falhou");

      const exchanged = await gotrue.exchangePkce(code, flow.v);
      if (!exchanged.ok) return fail(exchanged.reason === "recusado" ? "login_falhou" : "servico_indisponivel");
      const { tokens } = exchanged;
      const verified = await verifier.verify(tokens.accessToken);
      if (!verified.ok) {
        dropOrphan(tokens);
        return fail(verified.reason === "invalido" ? "login_falhou" : "servico_indisponivel");
      }
      const session = sealSession({ at: tokens.accessToken, rt: tokens.refreshToken, sid: verified.sessionId, sst: now, iat: now, ate: accessEnd(tokens, verified, now) });
      if (session === null) {
        dropOrphan(tokens);
        return fail("servico_indisponivel");
      }
      return { kind: "redirect", location: `${config.portalOrigin}/conta`, cookies: [clearFlow, session] };
    },

    async resolveSession(sessionCookie) {
      if (sessionCookie === undefined) return { state: "ausente" };
      const payload = openSession(sessionCookie);
      if (payload === null) return { state: "ausente", cookie: clearSession };
      const now = nowSeconds();
      if (expired(payload, now)) return { state: "expirada", cookie: clearSession };
      if (payload.ate - now > PORTAL_SESSION_POLICY.renewBeforeSeconds) return { state: "ativa" };

      const renewal = await renewPayload(payload, now);
      if (renewal.kind === "expirada") return { state: "expirada", cookie: clearSession };
      if (renewal.kind === "renovada") return { state: "ativa", cookie: renewal.cookie };
      return renewal.cookie === undefined ? { state: "indisponivel" } : { state: "indisponivel", cookie: renewal.cookie };
    },

    async readSession(sessionCookie) {
      const payload = openSession(sessionCookie);
      if (payload === null || expired(payload, nowSeconds())) return { ok: false };
      const verified = await verifier.verify(payload.at);
      return verified.ok && verified.sessionId === payload.sid ? { ok: true, userId: verified.userId } : { ok: false };
    },

    async logout({ origin, secFetchSite, sessionCookie }) {
      if (origin !== config.portalOrigin || secFetchSite !== "same-origin") return { kind: "forbidden" };
      const done = (notice: Notice): Redirect => ({ kind: "redirect", location: home(notice), cookies: [clearSession] });
      const payload = openSession(sessionCookie);
      if (payload === null) return done("saiu");
      let accessToken = payload.at;
      if (payload.ate - nowSeconds() <= PORTAL_SESSION_POLICY.renewBeforeSeconds) {
        const renewed = await renew(payload.rt);
        if (renewed.ok) accessToken = renewed.tokens.accessToken;
      }
      const result = await gotrue.logout(accessToken);
      return done(result.ok ? "saiu" : "saiu_local");
    },

    async apiAccess(sessionCookie, mode) {
      const writes = mode !== "leitura";
      if (sessionCookie === undefined) return { ok: false, state: "ausente" };
      const payload = openSession(sessionCookie);
      if (payload === null) return writes ? { ok: false, state: "ausente", cookie: clearSession } : { ok: false, state: "ausente" };
      const sessionId = payload.sid;
      const gone = (state: "ausente" | "expirada"): ApiAccess => (writes ? { ok: false, state, sessionId, cookie: clearSession } : { ok: false, state, sessionId });
      const now = nowSeconds();
      if (expired(payload, now)) return gone("expirada");

      if (mode === "forcada" || (mode === "gravacao" && payload.ate - now <= PORTAL_SESSION_POLICY.renewBeforeSeconds)) {
        const renewal = await renewPayload(payload, now);
        if (renewal.kind === "expirada") return gone("expirada");
        if (renewal.kind === "renovada") return { ok: true, accessToken: renewal.payload.at, userId: renewal.userId, sessionId, cookie: renewal.cookie };
        return renewal.cookie === undefined ? { ok: false, state: "indisponivel", sessionId } : { ok: false, state: "indisponivel", sessionId, cookie: renewal.cookie };
      }

      // Sem renovar: o access do cookie, verificado de novo (a DAL nunca confia no cookie).
      const verified = await verifier.verify(payload.at);
      if (verified.ok && verified.sessionId === payload.sid) return { ok: true, accessToken: payload.at, userId: verified.userId, sessionId };
      if (!verified.ok && verified.reason === "indisponivel") return { ok: false, state: "indisponivel", sessionId };
      return gone("ausente");
    },
  };
}
