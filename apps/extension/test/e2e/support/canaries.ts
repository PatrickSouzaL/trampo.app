// Canários do E2E com IdP falso (ADR-004 §4.4 e §4.5): os valores exatos que os falsos emitem. Todos nascem em tempo de
// execução, de bytes aleatórios: nada com cara de token, envelope ou chave fica no código-fonte, e o gitleaks não tem o
// que achar (cuidado 14 do next-step; ADR-019 D6). Os coletores procuram cada canário em três formas: a crua, a do
// `encodeURIComponent` e a de string JSON escapada.
import { randomBytes, randomUUID } from "node:crypto";

export const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const json64 = (value: unknown): string => base64url(Buffer.from(JSON.stringify(value)));

export interface AccessCanary {
  /** O JWS compacto inteiro, na forma do `AccessTokenSchema` (3 partes base64url). */
  readonly token: string;
  /** Cabeçalho, carga e assinatura: cada um é um canário à parte. */
  readonly segments: readonly [string, string, string];
}

/** Access token falso com `sub` e `session_id` canários na carga. A extensão o trata como opaco (ADR-004 D9). */
export function newAccessCanary(): AccessCanary {
  const header = json64({ alg: "ES256", typ: "JWT", kid: `canario-${randomBytes(4).toString("hex")}` });
  const payload = json64({ sub: `CANARIO-SUB-${randomUUID()}`, session_id: `CANARIO-SID-${randomUUID()}`, aud: "authenticated", amr: [{ method: "oauth" }] });
  const signature = base64url(randomBytes(64));
  return { token: `${header}.${payload}.${signature}`, segments: [header, payload, signature] };
}

export interface EnvelopeCanary {
  /** `r1.<kid>.<iv>.CANARIO_RT_<hex>.<tag>`, na forma do `SealedRefreshSchema`. */
  readonly envelope: string;
  /** O segmento cifrado, também canário. */
  readonly cipher: string;
}

/** Envelope falso do refresh: IV de 96 bits (16 caracteres) e tag de 128 (22), como o do BFF (ADR-004 D5). */
export function newEnvelopeCanary(): EnvelopeCanary {
  const cipher = `CANARIO_RT_${randomBytes(16).toString("hex")}`;
  return { envelope: `r1.e2e.${base64url(randomBytes(12))}.${cipher}.${base64url(randomBytes(16))}`, cipher };
}

/** Código de autorização falso, na forma do `AuthCodeSchema`. */
export const newCodeCanary = (): string => `CANARIO-CODE-${randomUUID()}`;

/** Texto do IdP no cancelamento (cenário 8): nunca chega à tela nem a log. */
export const newErrorCanary = (): string => `CANARIO-ERR-${randomUUID()}`;

/** As três formas de um canário, sem repetição: a crua, a de `encodeURIComponent` e a de string JSON escapada. */
export function canaryForms(value: string): string[] {
  return [...new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])];
}

/** Os canários que aparecem no texto em qualquer das três formas. Canário vazio é erro do teste, nunca "achado". */
export function findCanaries(haystack: string, canaries: Iterable<string>): string[] {
  const hits: string[] = [];
  for (const canary of canaries) {
    if (canary === "") throw new Error("canário vazio: o coletor acharia em qualquer texto");
    if (canaryForms(canary).some((form) => haystack.includes(form))) hits.push(canary);
  }
  return hits;
}

/** Reforço do §4.4: um trecho base64url com 100 caracteres ou mais, a forma de token sem ser canário conhecido. */
export const LONG_TOKEN = /[\w-]{100,}/;
