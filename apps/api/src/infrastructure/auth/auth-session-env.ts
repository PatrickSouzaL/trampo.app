// Ambiente da sessão do BFF de autenticação (ADR-004 D5), lido em falha fechada. O anel do refresh é obrigatório; a
// idade máxima e a inatividade têm padrão (24 h e 4 h, HITL-034 Q2 e Q3) e faixas fixadas contra o ADR. Só inteiros
// decimais sem sinal, espaço, zero à esquerda, expoente ou unidade. Nenhuma mensagem repete o valor recebido.
import { parseRefreshKeyring } from "../crypto/aead-refresh-sealer.js";
import type { AeadKeyring } from "../crypto/aead-envelope.js";

export const AUTH_SESSION_LIMITS = {
  /**
   * O teto é o padrão e o 86.400 do Custom Access Token Hook (F1-API-09, emenda do ADR-004 D5): acima disso o hook
   * recusaria a renovação sem aviso. O test:db prende o teto e o padrão à constante da migration.
   */
  maxAgeSeconds: { fallback: 86_400, min: 3_600, max: 86_400 },
  /** O teto da inatividade é a idade máxima configurada. */
  idleSeconds: { fallback: 14_400, min: 900 },
} as const;

export type AuthSessionVariable = "AUTH_SESSION_MAX_AGE_SECONDS" | "AUTH_SESSION_IDLE_SECONDS";

export class AuthSessionConfigError extends Error {
  constructor(variable: AuthSessionVariable) {
    super(`${variable} precisa ser um inteiro de segundos dentro da faixa do ADR-004 D5`);
    this.name = "AuthSessionConfigError";
  }
}

export interface AuthSessionConfig {
  readonly keyring: AeadKeyring;
  readonly maxAgeSeconds: number;
  readonly idleSeconds: number;
}

// Até 7 dígitos: só a forma, com folga sobre o teto de 86.400 (o corte por faixa vem depois, com a mesma mensagem) e
// antes de qualquer número fora do inteiro seguro.
const DECIMAL_SECONDS = /^[1-9][0-9]{0,6}$/;

function seconds(
  source: Readonly<Record<string, string | undefined>>,
  variable: AuthSessionVariable,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = source[variable] ?? "";
  if (raw === "") return fallback;
  if (!DECIMAL_SECONDS.test(raw)) throw new AuthSessionConfigError(variable);
  const value = Number(raw);
  if (value < min || value > max) throw new AuthSessionConfigError(variable);
  return value;
}

export function readAuthSessionEnv(source: Readonly<Record<string, string | undefined>>): AuthSessionConfig {
  const keyring = parseRefreshKeyring(source["AUTH_REFRESH_SEAL_KEYS"] ?? "", source["AUTH_REFRESH_SEAL_ACTIVE_KEY"] ?? "");
  const { maxAgeSeconds: age, idleSeconds: idle } = AUTH_SESSION_LIMITS;
  const maxAgeSeconds = seconds(source, "AUTH_SESSION_MAX_AGE_SECONDS", age.fallback, age.min, age.max);
  const idleSeconds = seconds(source, "AUTH_SESSION_IDLE_SECONDS", idle.fallback, idle.min, maxAgeSeconds);
  return { keyring, maxAgeSeconds, idleSeconds };
}
