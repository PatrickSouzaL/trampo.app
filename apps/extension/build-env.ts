// Variáveis de build da extensão (ADR-004 D13 e D15; ADR-001 §5.0.1), lidas pelo wxt.config.ts no Node. Falha
// fechada: um valor fora da forma derruba o build (ADR-004 §4.6), e a mensagem nunca ecoa o valor.
//
// F1-EXT-06: o WXT só carrega o `.env` da pasta da extensão depois de avaliar o wxt.config.ts, então o build real saía
// fechado mesmo com o arquivo certo. O `loadBuildEnv` lê o arquivo antes, por lista fechada: só as 3 variáveis do build
// (duas origens e uma chave pública) saem dele. Qualquer outra chave é descartada aqui dentro e nunca chega ao
// `process.env`, ao `define` nem ao artefato, porque um `.env` copiado da API traria os segredos dela para um artefato
// público. A variável já definida no `process.env` vence a do arquivo, e `TRAMPO_IGNORE_DOTENV=1` desliga a leitura (os
// testes e o E2E não dependem do arquivo do desenvolvedor).
import { createHash, createPublicKey } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { parseEnv } from "node:util";

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

/**
 * O adapter falso de identidade (modo 3 do P20, ADR-004 §4.4) só poderia existir no build de teste, com `TRAMPO_E2E=1`
 * (§4.6). A sondagem do 05c-1 pôs o Edge e o Chrome no modo 1 (o login real em headless), e o modo 3 ficou sem código:
 * a variável derruba o build com ou sem `TRAMPO_E2E=1`, e nenhum marcador dele chega a artefato algum.
 */
function refuseFakeIdentity(env: Env): void {
  if (present(env, "TRAMPO_E2E_FAKE_IDENTITY") === undefined) return;
  if (env["TRAMPO_E2E"] !== "1") throw new Error("TRAMPO_E2E_FAKE_IDENTITY só existe no build de teste, com TRAMPO_E2E=1 (ADR-004 §4.6)");
  throw new Error("TRAMPO_E2E_FAKE_IDENTITY: o modo 3 do P20 não existe; o Edge e o Chrome rodam o login real em headless (modo 1, ADR-004 §4.4)");
}

/** As únicas chaves que saem do `.env` da extensão. Valores públicos: duas origens e a SPKI pública da extensão. */
export const DOTENV_KEYS = Object.freeze(["TRAMPO_API_ORIGIN", "TRAMPO_SUPABASE_ORIGIN", "TRAMPO_EXTENSION_KEY"] as const);
/** Teto do arquivo: 3 linhas curtas cabem com folga, e um arquivo maior não é o `.env` da extensão. */
export const DOTENV_MAX_BYTES = 16 * 1024;
const IGNORE_DOTENV = "TRAMPO_IGNORE_DOTENV";

const isMissingFile = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Os bytes do arquivo, ou `undefined` se ele não existe. Um descritor só, lido até o teto mais um byte: sem `stat` antes
 * (o arquivo não troca entre a conferência e a leitura) e sem carregar um arquivo grande. A mensagem não leva o caminho.
 */
function readDotenvBytes(path: string): Buffer | undefined {
  const buffer = Buffer.alloc(DOTENV_MAX_BYTES + 1);
  let length = 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.byteLength - length, null);
      if (read === 0) break;
      length += read;
      if (length > DOTENV_MAX_BYTES) break;
    }
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new Error("o .env da extensão existe, mas não pôde ser lido");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (length > DOTENV_MAX_BYTES) throw new Error(`o .env da extensão passa de ${DOTENV_MAX_BYTES} bytes: ele só leva as 3 variáveis do build`);
  return buffer.subarray(0, length);
}

/** Quantas linhas do arquivo definem a chave (com ou sem `export`). */
function definitions(text: string, name: string): number {
  return text.match(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=`, "gm"))?.length ?? 0;
}

/**
 * As 3 chaves do build que o `.env` da extensão traz. O `parseEnv` do Node lê o arquivo inteiro, e daqui só saem as
 * chaves da lista: o resto morre nesta função. Chave da lista repetida derruba o build (nenhuma das duas vale).
 */
function dotenvValues(path: string): Readonly<Partial<Record<(typeof DOTENV_KEYS)[number], string>>> {
  const bytes = readDotenvBytes(path);
  if (bytes === undefined) return {};
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("o .env da extensão não é UTF-8 válido");
  }
  const parsed = parseEnv(text);
  const picked: Partial<Record<(typeof DOTENV_KEYS)[number], string>> = {};
  for (const name of DOTENV_KEYS) {
    if (definitions(text, name) > 1) throw new Error(`${name} aparece mais de uma vez no .env da extensão`);
    const value = Object.hasOwn(parsed, name) ? parsed[name] : undefined;
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

/**
 * As variáveis do build, do `process.env` e do `.env` da extensão (F1-EXT-06). A variável definida no ambiente, mesmo
 * vazia, vence a do arquivo. O ambiente recebido não é alterado, e o arquivo só fornece as chaves do `DOTENV_KEYS`: o
 * `TRAMPO_E2E`, o `TRAMPO_E2E_FAKE_IDENTITY` e o próprio `TRAMPO_IGNORE_DOTENV` só valem vindos do ambiente.
 */
export function loadBuildEnv(env: Env, dotenvPath: string): BuildEnv {
  const ignore = present(env, IGNORE_DOTENV);
  if (ignore !== undefined && ignore !== "1") throw new Error(`${IGNORE_DOTENV} só aceita 1 (ADR-004 §4.6)`);
  if (ignore === "1") return readBuildEnv(env);
  const fromFile = dotenvValues(dotenvPath);
  const merged: Record<string, string | undefined> = { ...env };
  for (const name of DOTENV_KEYS) if (env[name] === undefined) merged[name] = fromFile[name];
  return readBuildEnv(merged);
}

export function readBuildEnv(env: Env): BuildEnv {
  refuseFakeIdentity(env);
  return {
    apiOrigin: exactOrigin(env, "TRAMPO_API_ORIGIN", "https://api.exemplo.com"),
    supabaseOrigin: exactOrigin(env, "TRAMPO_SUPABASE_ORIGIN", "https://<projeto>.supabase.co"),
    extensionKey: extensionKey(env),
  };
}
