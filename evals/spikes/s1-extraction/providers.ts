// S-1: os dois provedores medidos. O Groq não tem adapter (F1-LLM-01 parte 2 espera o S-1), então o spike faz a
// chamada com o mesmo prompt da API (`extraction-prompt.ts`); a Workers AI passa pelo adapter real (ADR-020) com um `fetch` instrumentado.
// [APPSEC]: nenhuma requisição leva `tools` (SR-01); só cabeçalhos de lista fechada e códigos de erro numéricos ou
// curtos são guardados; o corpo de sucesso só é lido para o tipo de `result.response` e a presença de `usage`.
import { randomBytes } from "node:crypto";
import {
  EXTRACTION_RESPONSE_SCHEMA,
  buildExtractionMessages,
} from "../../../apps/api/src/application/llm/extraction-prompt.js";
import { parseRetryAfterMs } from "../../../apps/api/src/infrastructure/llm/cloudflare-workers-ai-extractor.js";
import { createCloudflareWorkersAiExtractor } from "../../../apps/api/src/infrastructure/llm/cloudflare-workers-ai-extractor.js";

export type ProviderKey = "groq" | "cloudflare_workers_ai";

export type CallOutcome =
  | "ok"
  | "limite_de_taxa"
  | "erro_transitorio"
  | "erro_permanente"
  | "timeout"
  | "recusa_do_prompt";

export interface CallRecord {
  readonly outcome: CallOutcome;
  readonly status: number | null;
  readonly latencyMs: number;
  /** Só em memória: nunca persistido (vai para o guard e para a busca do canário). */
  readonly raw: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly finishReason: string | null;
  readonly rateHeaders: Readonly<Record<string, string>>;
  readonly errorCode: string | null;
  readonly retryAfterMs: number | null;
  /** Workers AI: tipo de `result.response` e presença de `usage` (ADR-020 §1.1). */
  readonly responseShape: string | null;
  /** Groq 400 `json_validate_failed`: a geração recusada, só em memória (vai para o Zod e o guard, nunca ao disco). */
  readonly failedGeneration: string | null;
}

/** `estrito`: o modo de produção previsto (json_schema estrito). `nao_estrito`: json_schema sem `strict`, com o guard. */
export type Variant = "estrito" | "nao_estrito";

export interface SpikeProvider {
  readonly key: ProviderKey;
  readonly model: string;
  readonly variant: Variant;
  call(text: string, timeoutMs: number): Promise<CallRecord>;
}

const RATE_HEADER = /^(?:x-ratelimit-[a-z-]{1,40}|retry-after)$/u;
const SHORT_CODE = /^[\w.-]{1,60}$/u;

function rateHeaders(headers: Headers): Record<string, string> {
  const out = new Map<string, string>();
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (RATE_HEADER.test(lower)) out.set(lower, value.slice(0, 40));
  });
  return Object.fromEntries(out);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Primeiro código de erro curto do corpo (`error.code` do Groq ou `errors[].code` da Cloudflare); nunca a mensagem. */
function errorCodeOf(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const candidates: unknown[] = [];
  const err = body["error"];
  if (isRecord(err)) candidates.push(err["code"], err["type"]);
  const errs = body["errors"];
  if (Array.isArray(errs)) for (const e of errs) if (isRecord(e)) candidates.push(e["code"]);
  for (const c of candidates) {
    const s = typeof c === "number" ? String(c) : c;
    if (typeof s === "string" && SHORT_CODE.test(s)) return s;
  }
  return null;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text()) as unknown;
  } catch {
    return null;
  }
}

const EMPTY: Omit<CallRecord, "outcome" | "status" | "latencyMs"> = {
  raw: null,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  finishReason: null,
  rateHeaders: {},
  errorCode: null,
  retryAfterMs: null,
  responseShape: null,
  failedGeneration: null,
};

export const GROQ_MODEL = "openai/gpt-oss-20b";
/** Teto do spike: largo de propósito, para medir quanto o raciocínio realmente gasta (ADR-001 §5.5, H6). */
export const GROQ_MAX_COMPLETION_TOKENS = 2_048;

export function groqRequestBody(messages: readonly unknown[], strict = true): Record<string, unknown> {
  return {
    model: GROQ_MODEL,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: { name: "job_facts", strict, schema: EXTRACTION_RESPONSE_SCHEMA },
    },
    reasoning_effort: "low",
    include_reasoning: false,
    temperature: 0,
    max_completion_tokens: GROQ_MAX_COMPLETION_TOKENS,
  };
}

export function createGroqProvider(apiKey: string, variant: Variant = "estrito", fetchImpl: typeof fetch = fetch): SpikeProvider {
  return {
    key: "groq",
    model: GROQ_MODEL,
    variant,
    async call(text, timeoutMs) {
      const built = buildExtractionMessages({ text }, randomBytes(16).toString("hex"));
      if (!built.ok) return { ...EMPTY, outcome: "recusa_do_prompt", status: null, latencyMs: 0 };
      const body = groqRequestBody(built.messages, variant === "estrito");
      if ("tools" in body) throw new Error("SR-01: requisição com tools");
      const started = performance.now();
      let res: Response;
      try {
        res = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        return { ...EMPTY, outcome: timedOut ? "timeout" : "erro_transitorio", status: null, latencyMs: performance.now() - started };
      }
      const json = await safeJson(res);
      const latencyMs = performance.now() - started;
      const base = { ...EMPTY, status: res.status, latencyMs, rateHeaders: rateHeaders(res.headers) };
      if (res.status === 429) {
        return { ...base, outcome: "limite_de_taxa", errorCode: errorCodeOf(json), retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after"), Date.now()) };
      }
      if (!res.ok) {
        const err = isRecord(json) ? json["error"] : null;
        const failed = isRecord(err) && typeof err["failed_generation"] === "string" ? err["failed_generation"] : null;
        return { ...base, outcome: res.status >= 500 ? "erro_transitorio" : "erro_permanente", errorCode: errorCodeOf(json), failedGeneration: failed };
      }
      const choice = isRecord(json) && Array.isArray(json["choices"]) ? (json["choices"][0] as unknown) : null;
      const message = isRecord(choice) ? choice["message"] : null;
      const content = isRecord(message) ? message["content"] : null;
      const usage = isRecord(json) ? json["usage"] : null;
      const details = isRecord(usage) ? usage["completion_tokens_details"] : null;
      return {
        ...base,
        outcome: typeof content === "string" ? "ok" : "erro_permanente",
        raw: typeof content === "string" ? content : null,
        inputTokens: isRecord(usage) ? count(usage["prompt_tokens"]) : null,
        outputTokens: isRecord(usage) ? count(usage["completion_tokens"]) : null,
        reasoningTokens: isRecord(details) ? count(details["reasoning_tokens"]) : null,
        finishReason: isRecord(choice) && typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : null,
      };
    },
  };
}

interface WireNote {
  status: number | null;
  rateHeaders: Record<string, string>;
  errorCode: string | null;
  responseShape: string | null;
}

export function createWorkersAiProvider(
  config: { accountId: string; apiToken: string; model: string },
  fetchImpl: typeof fetch = fetch,
): SpikeProvider {
  let note: WireNote = { status: null, rateHeaders: {}, errorCode: null, responseShape: null };
  const instrumented: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    if (isRecord(body) && "tools" in body) throw new Error("SR-01: requisição com tools");
    const res = await fetchImpl(input, init);
    note.status = res.status;
    note.rateHeaders = rateHeaders(res.headers);
    const parsed = await safeJson(res.clone());
    if (res.ok) {
      const result = isRecord(parsed) ? parsed["result"] : null;
      const response = isRecord(result) ? result["response"] : undefined;
      const kind = response === undefined ? "ausente" : isRecord(response) ? "objeto" : typeof response;
      note.responseShape = `response:${kind};usage:${isRecord(result) && isRecord(result["usage"]) ? "sim" : "nao"}`;
    } else {
      note.errorCode = errorCodeOf(parsed);
    }
    return res;
  };
  const extractor = createCloudflareWorkersAiExtractor({ ...config, fetch: instrumented });
  return {
    key: "cloudflare_workers_ai",
    model: config.model,
    variant: "estrito",
    async call(text, timeoutMs) {
      note = { status: null, rateHeaders: {}, errorCode: null, responseShape: null };
      const controller = new AbortController();
      const started = performance.now();
      const outcome = await extractor.call({ text }, { signal: controller.signal, timeoutMs });
      const latencyMs = performance.now() - started;
      const base = { ...EMPTY, ...note, latencyMs };
      if (outcome.ok) {
        return { ...base, outcome: "ok", raw: outcome.raw, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens };
      }
      if (outcome.failure === "limite_de_taxa") return { ...base, outcome: "limite_de_taxa", retryAfterMs: outcome.retryAfterMs };
      const timedOut = note.status === null && latencyMs >= timeoutMs - 50;
      return { ...base, outcome: timedOut ? "timeout" : outcome.failure };
    },
  };
}

/** Preço publicado do Llama 3.3 70B fp8-fast (runbook llm §2): neurônios por milhão de tokens. */
export const WORKERS_AI_NEURONS_PER_M = { input: 26_668, output: 204_805 } as const;

export function neuronsOf(inputTokens: number, outputTokens: number): number {
  return (inputTokens * WORKERS_AI_NEURONS_PER_M.input + outputTokens * WORKERS_AI_NEURONS_PER_M.output) / 1_000_000;
}
