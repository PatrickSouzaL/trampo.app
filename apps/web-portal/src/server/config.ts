// Configuração do servidor do portal (ADR-027 D9; o `API_ORIGIN` é do ADR-028 D3). Só este módulo lê o `process.env` (Data Access Layer do Next 16,
// `data-security.md`), uma vez, em falha fechada. As mensagens dizem o campo e nunca repetem o valor.
import { SealKeyringError, parseSealKeyring, type SealKeyring } from "./seal";

export interface PortalConfig {
  /** Origem exata do portal: base do `redirect_to` e do `Origin` conferido no logout. */
  readonly portalOrigin: string;
  /** O portal está em https (liga o `upgrade-insecure-requests` da CSP). */
  readonly https: boolean;
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  /** `${SUPABASE_URL}/auth/v1` (ADR-013 D4). */
  readonly issuer: string;
  /** `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` (ADR-013 D6). */
  readonly jwksUrl: URL;
  readonly sealKeys: SealKeyring;
  /** Origem exata da API (ADR-028 D3): o único destino do cliente da API, nunca vindo do pedido. */
  readonly apiOrigin: string;
}

export class PortalConfigError extends Error {
  constructor(readonly field: string) {
    super(`configuração do portal inválida: ${field}`);
    this.name = "PortalConfigError";
  }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);
// Lista positiva, como na API: a secret (`sb_secret_`) e a legada (`eyJ`) caem na recusa.
const PUBLISHABLE_KEY = /^sb_publishable_[\w-]{1,256}$/;

/** Origem exata em https, ou http só em loopback. Sem caminho, barra final, credenciais nem maiúsculas. */
export function isExactOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.origin !== value) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

function required(env: Readonly<Record<string, string | undefined>>, field: string): string {
  const value = env[field];
  if (value === undefined || value.length === 0) throw new PortalConfigError(field);
  return value;
}

export function parsePortalConfig(env: Readonly<Record<string, string | undefined>>): PortalConfig {
  const portalOrigin = required(env, "PORTAL_ORIGIN");
  if (!isExactOrigin(portalOrigin)) throw new PortalConfigError("PORTAL_ORIGIN");
  const supabaseUrl = required(env, "SUPABASE_URL");
  if (!isExactOrigin(supabaseUrl)) throw new PortalConfigError("SUPABASE_URL");
  const publishableKey = required(env, "SUPABASE_PUBLISHABLE_KEY");
  if (!PUBLISHABLE_KEY.test(publishableKey)) throw new PortalConfigError("SUPABASE_PUBLISHABLE_KEY");
  const apiOrigin = required(env, "API_ORIGIN");
  if (!isExactOrigin(apiOrigin)) throw new PortalConfigError("API_ORIGIN");
  const keys = required(env, "PORTAL_SEAL_KEYS");
  const activeKid = required(env, "PORTAL_SEAL_ACTIVE_KEY");
  let sealKeys: SealKeyring;
  try {
    sealKeys = parseSealKeyring(keys, activeKid);
  } catch (error) {
    // A chave ativa fora do anel é erro do PORTAL_SEAL_ACTIVE_KEY; o resto, do anel.
    const activeMissing = error instanceof SealKeyringError && !keys.split(",").some((entry) => entry.startsWith(`${activeKid}:`));
    throw new PortalConfigError(activeMissing ? "PORTAL_SEAL_ACTIVE_KEY" : "PORTAL_SEAL_KEYS");
  }
  return {
    portalOrigin,
    https: portalOrigin.startsWith("https://"),
    supabaseUrl,
    publishableKey,
    issuer: `${supabaseUrl}/auth/v1`,
    jwksUrl: new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
    sealKeys,
    apiOrigin,
  };
}

let cached: PortalConfig | undefined;

/** A configuração do processo, lida na primeira chamada. */
export function readPortalConfig(): PortalConfig {
  cached ??= parsePortalConfig(process.env);
  return cached;
}

/** Só para os testes trocarem o ambiente entre casos. */
export function resetPortalConfigForTests(): void {
  cached = undefined;
}
