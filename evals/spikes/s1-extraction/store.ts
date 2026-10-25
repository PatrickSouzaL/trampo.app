// S-1: uma linha JSON por chamada em `out/s1-results.jsonl` (ignorado pelo git). Retoma de onde parou: um item
// do plano está feito quando tem linha com desfecho que não seja 429. Nunca guarda o texto da vaga nem a saída
// bruta; guarda os fatos já saneados pelo `LlmOutputGuard` (para repontuar sem gastar cota).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JobFacts } from "@trampo/contracts";
import type { LlmOutputSanitization } from "../../../apps/api/src/application/llm/llm-output-guard.js";
import type { Budget } from "./cases.js";
import type { CallOutcome, ProviderKey, Variant } from "./providers.js";

export const OUT_DIR = join(import.meta.dirname, "out");
export const RESULTS_PATH = join(OUT_DIR, "s1-results.jsonl");

export interface ResultRow {
  readonly provider: ProviderKey;
  readonly model: string;
  /** Linhas antigas (antes da variante) são `estrito`; `composto` só existe no relatório (report.ts). */
  readonly variant: Variant | "composto";
  readonly budget: Budget;
  readonly caseId: string;
  readonly at: string;
  readonly payloadChars: number;
  readonly outcome: CallOutcome;
  readonly status: number | null;
  readonly latencyMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly finishReason: string | null;
  readonly rateHeaders: Readonly<Record<string, string>>;
  readonly errorCode: string | null;
  readonly retryAfterMs: number | null;
  readonly responseShape: string | null;
  readonly outputBytes: number | null;
  /** `JobFactsSchema` direto na saída crua (antes do saneamento) e os caminhos que falharam (só os nomes). */
  readonly rawSchemaValid: boolean | null;
  readonly rawIssuePaths: readonly string[];
  /** As duas listas de stack com termo em comum na saída crua (ADR-008). */
  readonly rawStackOverlap: boolean | null;
  readonly guardOk: boolean | null;
  readonly guardReason: string | null;
  readonly sanitization: LlmOutputSanitization | null;
  readonly canaryLeak: boolean | null;
  readonly facts: JobFacts | null;
  /** Groq 400: o que o Zod e o guard diriam da geração recusada (só caminhos e desfecho). */
  readonly failedGenerationIssuePaths: readonly string[] | null;
  readonly failedGenerationGuardOk: boolean | null;
}

export function readRows(path: string = RESULTS_PATH): ResultRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => ({ variant: "estrito", failedGenerationIssuePaths: null, failedGenerationGuardOk: null, ...(JSON.parse(l) as Partial<ResultRow>) }) as ResultRow);
}

export function appendRow(row: ResultRow, path: string = RESULTS_PATH): void {
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
}

export const rowKey = (provider: string, model: string, variant: string, caseId: string, budget: number): string =>
  `${provider}|${model}|${variant}|${caseId}|${String(budget)}`;

export function doneKeys(rows: readonly ResultRow[]): Set<string> {
  return new Set(rows.filter((r) => r.outcome !== "limite_de_taxa").map((r) => rowKey(r.provider, r.model, r.variant, r.caseId, r.budget)));
}
