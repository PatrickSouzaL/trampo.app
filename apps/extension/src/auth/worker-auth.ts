// Composição da sessão no Service Worker (ADR-004 D3 passo 2, D9, D12 e D15; F1-EXT-05a e 05b). O background.ts só
// chama createWorkerAuth com as origens do build: a montagem fica aqui, testada, e não na cola do entrypoint. A
// SessaoView sai só pelo canal da sessão (src/messaging/session-channel.ts), saneada pelo toSessaoView.
import { type ApiClient, createApiClient } from "../api/api-client";
import { createSessionChannel } from "../messaging/session-channel";
import type { PanelPort } from "../messaging/worker-port";
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
export function authConfigFrom(origins: BuildOrigins): (AuthConfig & { readonly api: ApiClient }) | undefined {
  const { apiOrigin, supabaseOrigin } = origins;
  if (!isExactHttpsOrigin(apiOrigin) || !isExactHttpsOrigin(supabaseOrigin)) return undefined;
  return { api: createApiClient({ apiOrigin }), supabaseOrigin };
}

export interface WorkerAuthDeps {
  /** Só o motivo da lista fechada do D3 (T23). */
  readonly log: (motivo: AuthLogReason) => void;
}

/** O serviço da sessão já ligado ao painel: a SessaoView só sai pelo canal, saneada (D10 B6). */
export interface WorkerAuth extends Omit<AuthService, "view"> {
  /** O mesmo cliente da sessão, para o envio da vaga (ADR-025 §6 D13); ausente sem as duas origens do build. */
  readonly api: ApiClient | undefined;
  /** Porta confiável depois do `hello`, no fim do handshake: recebe a visão atual e as mudanças seguintes (D12). */
  attach(port: PanelPort): Promise<void>;
}

export function createWorkerAuth(origins: BuildOrigins, deps: WorkerAuthDeps): WorkerAuth {
  const channel = createSessionChannel();
  const config = authConfigFrom(origins);
  const { view, ...service } = createAuthService({
    store: authSessionStore(),
    config,
    codeSource: webAuthFlowSource(),
    now: Date.now,
    setTimer: (callback, ms) => {
      setTimeout(callback, ms);
    },
    emit: channel.emit,
    log: deps.log,
  });
  return { ...service, api: config?.api, attach: (port) => channel.attach(port, view) };
}
