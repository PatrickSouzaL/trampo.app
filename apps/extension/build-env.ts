// Variáveis de build da extensão (ADR-004 D13 e D15; ADR-001 §5.0.1), lidas pelo wxt.config.ts no Node. Falha
// fechada: um valor fora da forma derruba o build (ADR-004 §4.6), e a mensagem nunca ecoa o valor.
import { createHash, createPublicKey } from "node:crypto";

type Env = Readonly<Record<string, string | undefined>>;

export interface ExtensionKey {
  /** A chave pública em SPKI DER, base64, como vai ao campo `key` do manifesto. */
  readonly key: string;
  /** O ID que o Chromium deriva dela: a Redirect URL e a origem do CORS dependem dele (D15). */
  readonly id: string;
}

export interface BuildEnv {
  /** Só vai ao `connect-src` e ao api-client. */
  readonly apiOrigin: string | undefined;
  /** Só monta a URL do `authorize`: nunca entra na CSP (D13). */
  readonly supabaseOrigin: string | undefined;
  readonly extensionKey: ExtensionKey | undefined;
}

const EXACT_HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
// Uma chave de extensão do Chromium é RSA; abaixo de 2048 bits, não é a chave que o navegador gerou.
const MIN_RSA_BITS = 2048;

function present(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function exactOrigin(env: Env, name: string, example: string): string | undefined {
  const value = present(env, name);
  if (value === undefined) return undefined;
  if (!EXACT_HTTPS_ORIGIN.test(value) || !URL.canParse(value) || new URL(value).origin !== value) {
    throw new Error(`${name} deve ser uma origem https exata, sem caminho (ex.: ${example})`);
  }
  return value;
}

/** O ID de extensão do Chromium: os 128 primeiros bits do SHA-256 do SPKI, cada dígito hex de 0-f para a-p. */
export function extensionIdFromSpki(der: Uint8Array): string {
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return Array.from(hex, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

function extensionKey(env: Env): ExtensionKey | undefined {
  const value = present(env, "TRAMPO_EXTENSION_KEY");
  if (value === undefined) return undefined;
  const invalid = new Error("TRAMPO_EXTENSION_KEY deve ser a chave pública RSA da extensão (2048 bits ou mais) em SPKI DER, base64 numa linha");
  const der = Buffer.from(value, "base64");
  let canonical: string;
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "rsa" || !(Number(key.asymmetricKeyDetails?.modulusLength) >= MIN_RSA_BITS)) throw invalid;
    canonical = key.export({ type: "spki", format: "der" }).toString("base64");
  } catch {
    throw invalid;
  }
  // A chave reexportada tem de dar o mesmo texto: base64 padrão numa linha (sem quebras, espaços nem base64url),
  // nada sobrando depois do DER e nenhum bit de preenchimento trocado ou "=" a mais.
  if (canonical !== value) throw invalid;
  return { key: value, id: extensionIdFromSpki(der) };
}

export function readBuildEnv(env: Env): BuildEnv {
  return {
    apiOrigin: exactOrigin(env, "TRAMPO_API_ORIGIN", "https://api.exemplo.com"),
    supabaseOrigin: exactOrigin(env, "TRAMPO_SUPABASE_ORIGIN", "https://<projeto>.supabase.co"),
    extensionKey: extensionKey(env),
  };
}
