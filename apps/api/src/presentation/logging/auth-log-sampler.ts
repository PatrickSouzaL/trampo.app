// Amostragem das linhas de log do BFF de autenticação (ADR-004 D8 item 7; ADR-010 D2). As rotas públicas recebem
// tráfego anônimo: uma linha por recusa deixaria um atacante encher o log (*Denial of Wallet*). Cada motivo escreve no
// máximo 1 linha a cada 60 s, por instância, e a linha seguinte leva quantas foram suprimidas no intervalo. O volume
// fica no contador. Nenhum campo além dele: a mensagem é do catálogo e nada da requisição entra (SR-12).
import type { AuthRejectionReason, AuthUnavailableReason } from "../../application/auth/auth-session.js";
import type { Clock } from "../../application/ports/clock.js";

/** As 10 mensagens do D8 item 7: os motivos dos casos de uso (07f), a renovação perdida e o limitador local. */
export type AuthLogMessage = AuthRejectionReason | AuthUnavailableReason | "auth_renovacao_perdida" | "auth_limite_local";

export const AUTH_LOG_MESSAGES = [
  "auth_troca_recusada",
  "auth_renovacao_recusada",
  "auth_envelope_invalido",
  "auth_sessao_idade_maxima",
  "auth_sessao_inativa",
  "auth_provedor_indisponivel",
  "auth_chaves_indisponiveis",
  "auth_token_fora_da_politica",
  "auth_renovacao_perdida",
  "auth_limite_local",
] as const satisfies readonly AuthLogMessage[];

export const AUTH_LOG_SAMPLING = { windowMs: 60_000 } as const;

/** Escreve agora, com o número de linhas suprimidas desde a última escrita do mesmo motivo; ou cala. */
export type AuthLogDecision = { readonly emit: true; readonly suppressed: number } | { readonly emit: false };

export interface AuthLogSampler {
  /** Conta uma ocorrência do motivo e decide se a linha sai. Nunca lança. */
  sample(message: AuthLogMessage): AuthLogDecision;
}

interface MessageState {
  lastEmitMs: number;
  suppressed: number;
}

export function createAuthLogSampler(clock: Clock): AuthLogSampler {
  const states = new Map<AuthLogMessage, MessageState>();
  return {
    sample(message) {
      const nowMs = clock.nowMs();
      const state = states.get(message);
      if (state === undefined) {
        states.set(message, { lastEmitMs: nowMs, suppressed: 0 });
        return { emit: true, suppressed: 0 };
      }
      if (nowMs - state.lastEmitMs < AUTH_LOG_SAMPLING.windowMs) {
        state.suppressed += 1;
        return { emit: false };
      }
      const suppressed = state.suppressed;
      state.lastEmitMs = nowMs;
      state.suppressed = 0;
      return { emit: true, suppressed };
    },
  };
}
