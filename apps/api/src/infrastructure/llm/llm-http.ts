// Helpers HTTP compartilhados pelos adapters de LLM (ADR-022 D2): Workers AI (ADR-020) e Groq.
//
// Nenhum deles lê corpo de erro: o status ≠ 200 vira um valor do enum da porta só pelo número e pelo `Retry-After`
// (SR-12). O corpo de sucesso é lido com teto em bytes, decodificado em UTF-8 estrito e parseado sem chaves de
// protótipo antes de qualquer schema.
import { z } from "zod";

import { LEDGER_POLICY } from "../../application/limits/limit-policy.js";
import { parseJsonWithoutPrototypeKeys } from "../../application/llm/llm-output-guard.js";
import type { ProviderCallOutcome, TokenUsage } from "../../application/ports/job-facts-extractor.js";

export const PERMANENT_FAILURE: ProviderCallOutcome = Object.freeze({ ok: false, failure: "erro_permanente" });
export const TRANSIENT_FAILURE: ProviderCallOutcome = Object.freeze({ ok: false, failure: "erro_transitorio" });
export const NO_USAGE: TokenUsage = Object.freeze({ inputTokens: 0, outputTokens: 0 });

/** IMF-fixdate (RFC 9110 §5.6.7), a única forma de data aceita no `Retry-After`. */
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

const TokenCountSchema = z.int().min(0).max(LEDGER_POLICY.maxTokensPerCall);
/** `usage` no formato OpenAI, comum à Workers AI e ao Groq. */
const UsageSchema = z.object({ prompt_tokens: TokenCountSchema, completion_tokens: TokenCountSchema });

/**
 * `Retry-After` em ms (ADR-020 D7): inteiro de segundos, ou data HTTP no futuro. Qualquer outra coisa é `null`; o
 * router limita a [1 s, 120 s] e usa 60 s com `null` (ADR-009 D5).
 */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  if (/^\d{1,6}$/.test(value)) return Number(value) * 1_000;
  if (!HTTP_DATE.test(value)) return null;
  const at = Date.parse(value);
  return at > nowMs ? at - nowMs : null;
}

/** Lê o corpo contando bytes; `null` acima do teto. Sair do for-await cancela o resto do stream. */
export async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Status ≠ 200 (ADR-020 D6, ADR-022 D6). O corpo nunca é lido: quem chama já o cancelou. 3xx chega aqui porque o
 * redirecionamento não é seguido.
 */
export function failureForStatus(status: number, retryAfter: string | null): ProviderCallOutcome {
  if (status === 429) {
    return { ok: false, failure: "limite_de_taxa", retryAfterMs: parseRetryAfterMs(retryAfter, Date.now()) };
  }
  return (status >= 500 && status <= 599) || status === 408 ? TRANSIENT_FAILURE : PERMANENT_FAILURE;
}

/** Envelope de um 200 já decodificado: parse sem chaves de protótipo e depois o schema. `null` em qualquer falha. */
export function parseEnvelope<T>(text: string, schema: z.ZodType<T>): T | null {
  const json = parseJsonWithoutPrototypeKeys(text);
  if (!json.ok) return null;
  const envelope = schema.safeParse(json.value);
  return envelope.success ? envelope.data : null;
}

/** Ausente ou fora da forma vira zero: o ledger mantém a reserva cheia, que é o lado seguro (ADR-022 D6). */
export function usageFrom(usage: unknown): TokenUsage {
  const counted = UsageSchema.safeParse(usage);
  return counted.success
    ? { inputTokens: counted.data.prompt_tokens, outputTokens: counted.data.completion_tokens }
    : NO_USAGE;
}
