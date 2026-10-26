// S-1: percorre o plano por provedor, com ritmo pelos cabeçalhos de limite e parada no teto diário.
// Saída no console: só id do caso, orçamento, desfecho, status e números.
import { JobFactsSchema } from "@trampo/contracts";
import { LlmOutputGuard, parseJsonWithoutPrototypeKeys } from "../../../apps/api/src/application/llm/llm-output-guard.js";
import type { Budget, PlanItem, SpikeCase } from "./cases.js";
import type { CallRecord, SpikeProvider } from "./providers.js";
import { EXTRACTION_PROMPT_VERSION } from "../../../apps/api/src/application/llm/extraction-prompt.js";
import { LLM_OUTPUT_GUARD_VERSION } from "../../../apps/api/src/application/llm/llm-output-guard.js";
import { appendRow, CURRENT_VERSIONS, doneKeys, readRows, rowKey, type ResultRow } from "./store.js";

/** Prazo do spike: acima do de produção (10 s) para medir a cauda; o relatório conta quantos passaram de 10 s. */
export const SPIKE_TIMEOUT_MS = 30_000;
/** 429 com espera acima disso é o teto diário (RPD, TPD ou neurônios): o provedor para e retoma noutro dia. */
const DAILY_LIMIT_WAIT_MS = 120_000;
const DAILY_LIMIT_CODES = new Set(["3036"]);
/** Folga de tokens por minuto antes da próxima chamada do Groq (~1,3× uma extração de 6k). */
const GROQ_TPM_HEADROOM = 4_500;
const MIN_SPACING_MS = 1_000;

const guard = new LlmOutputGuard();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** "7.66s", "2m59.56s", "120ms" → ms. */
export function parseGroqDuration(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^(?:(\d{1,4})h)?(?:(\d{1,4})m(?!s))?(?:(\d{1,6}(?:\.\d{1,6})?)s)?(?:(\d{1,6}(?:\.\d{1,6})?)ms)?$/u.exec(value);
  if (m === null || value === "") return null;
  const [, h = "0", min = "0", s = "0", ms = "0"] = m;
  return ((Number(h) * 60 + Number(min)) * 60 + Number(s)) * 1_000 + Number(ms);
}

/** Caminhos de topo que o `JobFactsSchema` recusa, ou `["(json)"]` se nem faz parse. */
function issuePaths(raw: string): string[] {
  const parsed = parseJsonWithoutPrototypeKeys(raw);
  if (!parsed.ok) return ["(json)"];
  const result = JobFactsSchema.safeParse(parsed.value);
  return result.success ? [] : [...new Set(result.error.issues.map((i) => (i.path.length === 0 ? "(raiz)" : String(i.path[0]))))];
}

function analyseFailed(call: CallRecord): Pick<ResultRow, "failedGenerationIssuePaths" | "failedGenerationGuardOk"> {
  if (call.failedGeneration === null) return { failedGenerationIssuePaths: null, failedGenerationGuardOk: null };
  return { failedGenerationIssuePaths: issuePaths(call.failedGeneration), failedGenerationGuardOk: guard.inspect(call.failedGeneration).ok };
}

function analyse(c: SpikeCase, call: CallRecord): Pick<
  ResultRow,
  "outputBytes" | "rawSchemaValid" | "rawIssuePaths" | "rawStackOverlap" | "guardOk" | "guardReason" | "sanitization" | "canaryLeak" | "facts"
> {
  if (call.raw === null) {
    return { outputBytes: null, rawSchemaValid: null, rawIssuePaths: [], rawStackOverlap: null, guardOk: null, guardReason: null, sanitization: null, canaryLeak: null, facts: null };
  }
  const canary = c.golden.injection?.canary ?? null;
  const parsed = parseJsonWithoutPrototypeKeys(call.raw);
  let rawSchemaValid = false;
  let rawIssuePaths: string[] = [];
  let rawStackOverlap: boolean | null = null;
  if (parsed.ok) {
    const result = JobFactsSchema.safeParse(parsed.value);
    rawSchemaValid = result.success;
    rawIssuePaths = result.success ? [] : [...new Set(result.error.issues.map((i) => (i.path.length === 0 ? "(raiz)" : String(i.path[0]))))];
    const v = parsed.value;
    if (typeof v === "object" && v !== null && "stackRequired" in v && "stackNiceToHave" in v) {
      const req = v.stackRequired;
      const nice = v.stackNiceToHave;
      if (Array.isArray(req) && Array.isArray(nice)) {
        const lower = new Set(req.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()));
        rawStackOverlap = nice.some((x) => typeof x === "string" && lower.has(x.toLowerCase()));
      }
    }
  }
  const inspected = guard.inspect(call.raw);
  return {
    outputBytes: Buffer.byteLength(call.raw, "utf8"),
    rawSchemaValid,
    rawIssuePaths,
    rawStackOverlap,
    guardOk: inspected.ok,
    guardReason: inspected.ok ? null : inspected.reason,
    sanitization: inspected.ok ? inspected.sanitization : null,
    canaryLeak: canary === null ? null : call.raw.includes(canary),
    facts: inspected.ok ? inspected.facts : null,
  };
}

function toRow(provider: SpikeProvider, c: SpikeCase, budget: Budget, payload: string, call: CallRecord): ResultRow {
  const { raw: _raw, failedGeneration: _failed, ...wire } = call;
  return {
    provider: provider.key,
    model: provider.model,
    variant: provider.variant,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    guardVersion: LLM_OUTPUT_GUARD_VERSION,
    budget,
    caseId: c.golden.id,
    at: new Date().toISOString(),
    payloadChars: [...payload].length,
    ...wire,
    latencyMs: Math.round(call.latencyMs),
    ...analyse(c, call),
    ...analyseFailed(call),
  };
}

export interface RunSummary {
  readonly provider: string;
  readonly done: number;
  readonly remaining: number;
  readonly stoppedBy: "plano_completo" | "teto_diario" | "limite_de_itens";
}

export async function runProvider(
  provider: SpikeProvider,
  plan: readonly PlanItem[],
  cases: ReadonlyMap<string, SpikeCase>,
  maxItems: number,
  log: (line: string) => void,
): Promise<RunSummary> {
  const done = doneKeys(readRows());
  const pending = plan.filter((p) => !done.has(rowKey(CURRENT_VERSIONS, provider.key, provider.model, provider.variant, p.caseId, p.budget)));
  let count = 0;
  let last: ResultRow | undefined;
  for (const item of pending) {
    if (count >= maxItems) return { provider: provider.key, done: count, remaining: pending.length - count, stoppedBy: "limite_de_itens" };
    const c = cases.get(item.caseId);
    const payload = c?.payloads.get(item.budget);
    if (c === undefined || payload === undefined) throw new Error(`item do plano sem caso: ${item.caseId}`);
    for (;;) {
      const call = await provider.call(payload, SPIKE_TIMEOUT_MS);
      const row = toRow(provider, c, item.budget, payload, call);
      appendRow(row);
      last = row;
      log(
        `[${provider.key}] ${item.caseId} ${String(item.budget)} → ${call.outcome} ${String(call.status)} ${String(row.latencyMs)}ms` +
          ` in=${String(call.inputTokens)} out=${String(call.outputTokens)} reas=${String(call.reasoningTokens)}` +
          ` guard=${String(row.guardOk)}${row.guardReason === null ? "" : `:${row.guardReason}`}` +
          (call.errorCode === null ? "" : ` code=${call.errorCode}`),
      );
      if (call.outcome === "limite_de_taxa") {
        const wait = call.retryAfterMs ?? parseGroqDuration(call.rateHeaders["retry-after"]) ?? 60_000;
        if (wait > DAILY_LIMIT_WAIT_MS || (call.errorCode !== null && DAILY_LIMIT_CODES.has(call.errorCode))) {
          return { provider: provider.key, done: count, remaining: pending.length - count, stoppedBy: "teto_diario" };
        }
        await sleep(wait + 500);
        continue;
      }
      break;
    }
    count += 1;
    await pace(provider, last);
  }
  return { provider: provider.key, done: count, remaining: 0, stoppedBy: "plano_completo" };
}

async function pace(provider: SpikeProvider, last: ResultRow | undefined): Promise<void> {
  let wait = MIN_SPACING_MS;
  if (provider.key === "groq" && last !== undefined) {
    const remaining = Number(last.rateHeaders["x-ratelimit-remaining-tokens"]);
    const reset = parseGroqDuration(last.rateHeaders["x-ratelimit-reset-tokens"]);
    if (Number.isFinite(remaining) && remaining < GROQ_TPM_HEADROOM) wait = Math.max(wait, (reset ?? 60_000) + 500);
  }
  await sleep(wait);
}
