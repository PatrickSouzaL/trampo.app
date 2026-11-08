// Composição da sessão no Service Worker (ADR-004 D3 passo 2, D9 e D15; F1-EXT-05a, 05a-4). O background.ts só
// chama createWorkerAuth com as origens do build: a montagem fica aqui, testada, e não na cola do entrypoint.
import { createApiClient } from "../api/api-client";
import type { SessaoView } from "../messaging/protocol";
import { type AuthConfig, type AuthLogReason, type AuthService, createAuthService } from "./auth-service";
import { authSessionStore } from "./session-schema";
import { webAuthFlowSource } from "./web-auth-flow-source";

/** `TRAMPO_API_ORIGIN` e `TRAMPO_SUPABASE_ORIGIN`, validadas no build; `""` quando o build não as tem. */
export interface BuildOrigins {
  readonly apiOrigin: string | undefined;
  readonly supabaseOrigin: string | undefined;
}

const isExactHttpsOrigin = (value: string | undefined): value is string =>
  value !== undefined && value.startsWith("https://") && URL.canParse(value) && new URL(value).origin === value;

/** As duas origens válidas, ou nada: sem uma delas, o login dá `auth_sem_configuracao` (D3 passo 2). Nunca lança. */
export function authConfigFrom(origins: BuildOrigins): AuthConfig | undefined {
  const { apiOrigin, supabaseOrigin } = origins;
  if (!isExactHttpsOrigin(apiOrigin) || !isExactHttpsOrigin(supabaseOrigin)) return undefined;
  return { api: createApiClient({ apiOrigin }), supabaseOrigin };
}

export interface WorkerAuthDeps {
  /** A ligação à porta do painel é da F1-EXT-05b. */
  readonly emit: (view: SessaoView) => void;
  /** Só o motivo da lista fechada do D3 (T23). */
  readonly log: (motivo: AuthLogReason) => void;
}

export function createWorkerAuth(origins: BuildOrigins, deps: WorkerAuthDeps): AuthService {
  return createAuthService({
    store: authSessionStore(),
    config: authConfigFrom(origins),
    codeSource: webAuthFlowSource(),
    now: Date.now,
    setTimer: (callback, ms) => {
      setTimeout(callback, ms);
    },
    emit: deps.emit,
    log: deps.log,
  });
}
