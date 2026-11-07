// Sessão no Service Worker (ADR-004 D3, D11 e D12): login com PKCE, renovação preguiçosa e logout. O token
// só circula entre o storage.session (pelo authSessionStore), este módulo e o api-client. O painel recebe só
// a SessaoView, por callback, e o log só motivos da lista fechada do D3: nunca código, verifier, `state`,
// token, envelope, URL nem texto de resposta (T23).
import { ApiErrorSchema } from "@trampo/contracts/api";
import { AUTH_ROUTES, AUTH_SCHEMA_VERSION, type AuthSessionResponse, AuthSessionResponseSchema } from "@trampo/contracts/auth";

import type { ApiClient, ApiResult } from "../api/api-client";
import type { AuthProvider, SessaoView } from "../messaging/protocol";
import type { SessionStore } from "../messaging/session-store";
import { type AuthCodeSource, obtainRedirectSafely } from "./auth-code-source";
import { buildAuthorizeUrl } from "./authorize-url";
import { type PkceCrypto, createPkcePair, createState } from "./pkce";
import { parseAuthRedirect } from "./redirect";
import type { StoredSession, StoredSessionSchema } from "./session-schema";

export const AUTH_SERVICE_POLICY = Object.freeze({
  /** O verifier vive no máximo 5 min (D3 passo 3 e D9). */
  loginDeadlineMs: 300_000,
  /** Renova antes de usar quando faltam 60 s ou menos (D11.1). */
  renewThresholdMs: 60_000,
  /** A única nova tentativa, sequencial, depois de uma chamada sem resposta HTTP (D11.3), e a repetição do logout (D11.5). */
  retryDelayMs: 2_000,
});

/** Os únicos motivos que vão a log (D3). */
export const AUTH_LOG_REASONS = [
  "auth_fluxo_cancelado",
  "auth_retorno_recusado",
  "auth_troca_recusada",
  "auth_indisponivel",
  "auth_renovacao_recusada",
  "auth_sem_configuracao",
  "auth_logout_remoto_falhou",
] as const;
export type AuthLogReason = (typeof AUTH_LOG_REASONS)[number];

export interface AuthConfig {
  readonly api: ApiClient;
  /** Origem https exata do projeto Supabase (`TRAMPO_SUPABASE_ORIGIN`). */
  readonly supabaseOrigin: string;
}

export interface AuthServiceDeps {
  /** O `authSessionStore()` (`trampo/sessao/v1`), que revalida na leitura e apaga valor adulterado. */
  readonly store: SessionStore<typeof StoredSessionSchema>;
  /** Ausente quando o build não tem `TRAMPO_API_ORIGIN` ou `TRAMPO_SUPABASE_ORIGIN` (D3 passo 2). */
  readonly config: AuthConfig | undefined;
  readonly codeSource: AuthCodeSource;
  readonly now: () => number;
  readonly setTimer: (callback: () => void, ms: number) => void;
  /** A ligação à porta do painel é da F1-EXT-05b. */
  readonly emit: (view: SessaoView) => void;
  readonly log: (motivo: AuthLogReason) => void;
  readonly crypto?: PkceCrypto;
}

export interface AuthService {
  /** Handshake do painel: `{ true, … }` com sessão local válida, `{ false, null }` sem ela (D12). */
  view(): Promise<SessaoView>;
  /** Clique em "Entrar". Ignorado com fluxo em curso (que emite no fim) ou com sessão local. Nunca rejeita. */
  login(provider: AuthProvider): Promise<void>;
  /** Clique em "Sair da conta": apaga o local antes da rede (D11.5). Nunca rejeita. */
  logout(): Promise<void>;
  /** O token para o envio à API, renovado antes se faltar 60 s ou menos (D11.1). Nunca rejeita. */
  accessToken(): Promise<string | undefined>;
  /**
   * A análise recebeu 401 (D11.4): na 1ª vez, uma renovação, e o token novo vai no reenvio com o mesmo
   * `requestId`; na 2ª, a sessão é apagada. O tipo do argumento impede o laço. Nunca rejeita.
   */
  onUnauthorized(tentativa: 1 | 2): Promise<string | undefined>;
}

type Outcome =
  | { readonly kind: "ok"; readonly response: AuthSessionResponse }
  | { readonly kind: "recusado" | "limite" | "indisponivel" | "erro" };
type Failure = Exclude<Outcome["kind"], "ok">;

const RECUSADO: Outcome = { kind: "recusado" };
const LIMITE: Outcome = { kind: "limite" };
const INDISPONIVEL: Outcome = { kind: "indisponivel" };
const ERRO: Outcome = { kind: "erro" };

const NAO_LOGADO: SessaoView = { autenticado: false, erro: null };
const AUTENTICADO: SessaoView = { autenticado: true, erro: null };
const FALHA_INTERNA: SessaoView = { autenticado: false, erro: "ERRO_INTERNO" };

/** Mapa da troca para a tabela do D12. Uma resposta fora do contrato conta como a recusa: não há o que repetir. */
const EXCHANGE_FAILURES: Readonly<Record<Failure, readonly [SessaoView, AuthLogReason]>> = {
  recusado: [FALHA_INTERNA, "auth_troca_recusada"],
  erro: [FALHA_INTERNA, "auth_troca_recusada"],
  limite: [{ autenticado: false, erro: "LIMITE_DE_TAXA" }, "auth_indisponivel"],
  indisponivel: [{ autenticado: false, erro: "SERVICO_INDISPONIVEL" }, "auth_indisponivel"],
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * O corpo volta em texto do api-client e é validado aqui. Só um 401 com o `ApiError` `NAO_AUTENTICADO` da
 * API é recusa: um 401 de proxy ou de configuração errada não apaga a sessão nem vira laço de relogin (T30).
 */
function classify(result: ApiResult): Outcome {
  if (!result.ok) return result.reason === "pedido_recusado" ? ERRO : INDISPONIVEL;
  if (result.status === 200) {
    const session = AuthSessionResponseSchema.safeParse(parseJson(result.body));
    return session.success ? { kind: "ok", response: session.data } : ERRO;
  }
  if (result.status === 401) {
    const error = ApiErrorSchema.safeParse(parseJson(result.body));
    return error.success && error.data.code === "NAO_AUTENTICADO" ? RECUSADO : ERRO;
  }
  if (result.status === 429) return LIMITE;
  return result.status >= 500 ? INDISPONIVEL : ERRO;
}

/** Uma tentativa de login. O verifier vive só aqui; a presença dele é a vida do fluxo. */
interface Attempt {
  verifier: string | undefined;
}

interface Prepared {
  readonly redirectUri: string;
  readonly state: string;
  readonly authorizeUrl: string;
  readonly verifier: string;
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const policy = AUTH_SERVICE_POLICY;
  let attempt: Attempt | undefined;
  // "Sair", um 401 que apaga a sessão e um login novo incrementam a geração. Renovação e troca só gravam se
  // a geração ainda for a do início: um refresh em voo não ressuscita a sessão (D11.2).
  let generation = 0;
  let refreshing: { readonly gen: number; readonly promise: Promise<StoredSession | undefined> } | undefined;
  // Falha transitória da última renovação: a sessão continua, e o painel vê o código até a próxima renovação boa.
  let degraded: "SERVICO_INDISPONIVEL" | "LIMITE_DE_TAXA" | null = null;
  // Sessão de um logout cuja parte remota falhou duas vezes: só em memória, para o "Tentar sair de novo" (D11.5).
  let pendingLogout: StoredSession | undefined;

  const wait = (ms: number): Promise<void> => new Promise((resolve) => deps.setTimer(resolve, ms));

  const toStored = (response: AuthSessionResponse): StoredSession => {
    const obtainedAt = deps.now();
    return { v: 1, accessToken: response.accessToken, refreshToken: response.refreshToken, obtainedAt, accessExpiresAt: obtainedAt + response.expiresIn * 1_000 };
  };
  const needsRenewal = (session: StoredSession): boolean => deps.now() >= session.accessExpiresAt - policy.renewThresholdMs;

  /** Fecha a tentativa: apaga o verifier, registra e emite. Só a tentativa da vez fecha. */
  const finish = (a: Attempt, view: SessaoView, motivo?: AuthLogReason): void => {
    if (attempt !== a) return;
    attempt = undefined;
    a.verifier = undefined;
    if (motivo !== undefined) deps.log(motivo);
    deps.emit(view);
  };

  const prepare = async (supabaseOrigin: string, provider: AuthProvider): Promise<Prepared | undefined> => {
    try {
      const redirectUri = deps.codeSource.redirectUri();
      const { verifier, challenge } = await createPkcePair(deps.crypto);
      const state = createState(deps.crypto);
      return { redirectUri, state, verifier, authorizeUrl: buildAuthorizeUrl({ supabaseOrigin, provider, redirectUri, state, challenge }) };
    } catch {
      // Origem fora da forma ou sem `crypto.subtle`: o ambiente não tem o que o login precisa.
      return undefined;
    }
  };

  const runLogin = async (a: Attempt, provider: AuthProvider): Promise<void> => {
    if ((await deps.store.get()) !== undefined) {
      finish(a, { autenticado: true, erro: degraded });
      return;
    }
    const { config } = deps;
    if (config === undefined) {
      finish(a, FALHA_INTERNA, "auth_sem_configuracao");
      return;
    }
    generation += 1;
    const gen = generation;
    const prepared = await prepare(config.supabaseOrigin, provider);
    if (prepared === undefined) {
      finish(a, FALHA_INTERNA, "auth_sem_configuracao");
      return;
    }
    a.verifier = prepared.verifier;
    // O prazo encerra o fluxo e libera o próximo clique, mesmo que a janela do IdP nunca responda.
    deps.setTimer(() => {
      if (a.verifier !== undefined) finish(a, NAO_LOGADO, "auth_fluxo_cancelado");
    }, policy.loginDeadlineMs);

    const redirect = await obtainRedirectSafely(deps.codeSource, { authorizeUrl: prepared.authorizeUrl, redirectUri: prepared.redirectUri });
    const verifier = a.verifier;
    // Retorno depois do prazo: o verifier já foi apagado, e o código não é trocado.
    if (verifier === undefined) return;
    if (!redirect.ok) {
      finish(a, NAO_LOGADO, "auth_fluxo_cancelado");
      return;
    }
    const parsed = parseAuthRedirect(redirect.url, prepared.redirectUri, prepared.state);
    if (!parsed.ok) {
      if (parsed.motivo === "cancelado") finish(a, NAO_LOGADO, "auth_fluxo_cancelado");
      else finish(a, FALHA_INTERNA, "auth_retorno_recusado");
      return;
    }
    // "Sair" durante o login: o código não vai à API.
    if (gen !== generation) {
      finish(a, NAO_LOGADO);
      return;
    }
    const sent = config.api.post({
      path: AUTH_ROUTES.exchange,
      body: { schemaVersion: AUTH_SCHEMA_VERSION, authCode: parsed.code, codeVerifier: verifier },
    });
    // Apagado logo depois do envio, qualquer que seja o resultado (D3 passo 8).
    a.verifier = undefined;
    const outcome = classify(await sent);
    if (outcome.kind !== "ok") {
      const [view, motivo] = EXCHANGE_FAILURES[outcome.kind];
      finish(a, view, motivo);
      return;
    }
    if (gen !== generation) {
      finish(a, NAO_LOGADO);
      return;
    }
    await deps.store.set(toStored(outcome.response));
    degraded = null;
    finish(a, AUTENTICADO);
  };

  /** Um 401 da API: a sessão morreu no servidor. */
  const drop = async (): Promise<void> => {
    generation += 1;
    degraded = null;
    await deps.store.remove();
    deps.log("auth_renovacao_recusada");
    deps.emit({ autenticado: false, erro: "NAO_AUTENTICADO" });
  };

  const postRefresh = (api: ApiClient, refreshToken: string): Promise<ApiResult> =>
    api.post({ path: AUTH_ROUTES.refresh, body: { schemaVersion: AUTH_SCHEMA_VERSION, refreshToken } });

  /** Uma única nova tentativa, sequencial e 2 s depois, só sem resposta HTTP (D11.3; P10). */
  const refreshWithRetry = async (api: ApiClient, refreshToken: string): Promise<Outcome> => {
    let result = await postRefresh(api, refreshToken);
    if (!result.ok && result.reason === "sem_resposta") {
      await wait(policy.retryDelayMs);
      result = await postRefresh(api, refreshToken);
    }
    return classify(result);
  };

  const renew = async (api: ApiClient, session: StoredSession, gen: number): Promise<StoredSession | undefined> => {
    const outcome = await refreshWithRetry(api, session.refreshToken);
    if (gen !== generation) return undefined;
    if (outcome.kind === "ok") {
      const renewed = toStored(outcome.response);
      await deps.store.set(renewed);
      if (degraded !== null) {
        degraded = null;
        deps.emit(AUTENTICADO);
      }
      return renewed;
    }
    if (outcome.kind === "recusado") {
      await drop();
      return undefined;
    }
    // 503, 429, rede ou resposta fora do contrato: a sessão fica, e nunca se pede login (ADR-013 D5; T30).
    degraded = outcome.kind === "limite" ? "LIMITE_DE_TAXA" : "SERVICO_INDISPONIVEL";
    deps.log("auth_indisponivel");
    deps.emit({ autenticado: true, erro: degraded });
    return undefined;
  };

  /** *Single-flight* por geração: todos os chamadores da mesma geração dividem a mesma renovação (T9.3). */
  const renewShared = (api: ApiClient, session: StoredSession): Promise<StoredSession | undefined> => {
    if (refreshing !== undefined && refreshing.gen === generation) return refreshing.promise;
    const gen = generation;
    const promise = renew(api, session, gen).finally(() => {
      if (refreshing !== undefined && refreshing.promise === promise) refreshing = undefined;
    });
    refreshing = { gen, promise };
    return promise;
  };

  /** Parte remota do logout. A renovação, se precisar, fica só em memória e nunca grava (D11.5 passo 2). */
  const logoutRemote = async (api: ApiClient, session: StoredSession): Promise<StoredSession | undefined> => {
    let current = session;
    if (needsRenewal(current)) {
      const outcome = classify(await postRefresh(api, current.refreshToken));
      // 401: a sessão já morreu no servidor, e não há o que encerrar.
      if (outcome.kind === "recusado") return undefined;
      if (outcome.kind !== "ok") return current;
      current = toStored(outcome.response);
    }
    const result = await api.post({ path: AUTH_ROUTES.logout, body: { schemaVersion: AUTH_SCHEMA_VERSION }, accessToken: current.accessToken });
    return result.ok && (result.status === 204 || result.status === 401) ? undefined : current;
  };

  const endRemotely = async (api: ApiClient, session: StoredSession): Promise<void> => {
    let remaining = await logoutRemote(api, session);
    if (remaining === undefined) return;
    await wait(policy.retryDelayMs);
    remaining = await logoutRemote(api, remaining);
    if (remaining === undefined) return;
    pendingLogout = remaining;
    deps.log("auth_logout_remoto_falhou");
    deps.emit({ autenticado: false, erro: "SERVICO_INDISPONIVEL" });
  };

  return {
    async view() {
      try {
        return (await deps.store.get()) === undefined ? NAO_LOGADO : { autenticado: true, erro: degraded };
      } catch {
        return FALHA_INTERNA;
      }
    },

    async login(provider) {
      if (attempt !== undefined) return;
      const a: Attempt = { verifier: undefined };
      attempt = a;
      try {
        await runLogin(a, provider);
      } catch {
        // Storage que falha, por exemplo: a tentativa fecha com erro e não trava o próximo clique.
        finish(a, FALHA_INTERNA);
      }
    },

    async logout() {
      generation += 1;
      degraded = null;
      let target: StoredSession | undefined;
      try {
        target = (await deps.store.get()) ?? pendingLogout;
        await deps.store.remove();
      } catch {
        deps.emit(FALHA_INTERNA);
        return;
      }
      // O logout local é imediato e incondicional: a rede vem depois (D11.5 passo 1).
      deps.emit(NAO_LOGADO);
      pendingLogout = undefined;
      if (target === undefined || deps.config === undefined) return;
      try {
        await endRemotely(deps.config.api, target);
      } catch {
        // O api-client nunca rejeita; só o relógio injetado poderia. O local já está vazio.
        deps.emit({ autenticado: false, erro: "SERVICO_INDISPONIVEL" });
      }
    },

    async accessToken() {
      try {
        const session = await deps.store.get();
        if (session === undefined || deps.config === undefined) return undefined;
        if (!needsRenewal(session)) return session.accessToken;
        const renewed = await renewShared(deps.config.api, session);
        if (renewed !== undefined) return renewed.accessToken;
        // Falha transitória mantém a sessão: o token ainda vale até o vencimento. Um 401 já a apagou.
        const current = await deps.store.get();
        return current !== undefined && deps.now() < current.accessExpiresAt ? current.accessToken : undefined;
      } catch {
        return undefined;
      }
    },

    async onUnauthorized(tentativa) {
      try {
        const session = await deps.store.get();
        if (session === undefined || deps.config === undefined) return undefined;
        if (tentativa === 2) {
          await drop();
          return undefined;
        }
        return (await renewShared(deps.config.api, session))?.accessToken;
      } catch {
        return undefined;
      }
    },
  };
}
