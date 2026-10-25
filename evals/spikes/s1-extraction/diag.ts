// S-1: diagnóstico das saídas que o guard recusa (S1_MODE=diag). Refaz a chamada só em memória, lista as issues do
// Zod e simula o guard com os itens fora do enum removidos. Não grava linha no `s1-results.jsonl` (a medição fica
// limpa). [APPSEC]: a saída bruta nunca vai ao disco nem ao console; sai o caminho, o código da issue e o valor só
// quando ele tem forma de enum (`^[a-z][a-z_]{0,39}$`), que não carrega texto da vaga nem o canário.
import {
  BenefitCategorySchema,
  ContractTypeSchema,
  JobFactsSchema,
  LanguageRequirementSchema,
  RedFlagSignalSchema,
  SeniorityLevelSchema,
  WorkModelSchema,
} from "@trampo/contracts";
import type { z } from "zod";
import { LlmOutputGuard, parseJsonWithoutPrototypeKeys } from "../../../apps/api/src/application/llm/llm-output-guard.js";

const ENUM_LIKE = /^[a-z][a-z_]{0,39}$/u;

const ENUM_ARRAYS: Readonly<Record<string, z.ZodEnum>> = {
  seniorityLevels: SeniorityLevelSchema,
  workModels: WorkModelSchema,
  contractTypes: ContractTypeSchema,
  benefits: BenefitCategorySchema,
  redFlagSignals: RedFlagSignalSchema,
};

export interface DiagIssue {
  readonly path: string;
  readonly code: string;
  /** Mensagem só quando é um id do nosso catálogo (refine), nunca a mensagem padrão do Zod. */
  readonly message: string | null;
  readonly value: string;
}

export interface DiagResult {
  readonly guardOk: boolean;
  readonly issues: readonly DiagIssue[];
  /** O guard aceitaria se os itens fora do enum (e os requisitos de idioma inválidos) saíssem antes dele. */
  readonly guardOkWithoutOffEnum: boolean | null;
  readonly offEnumDropped: number;
}

function valueShape(value: unknown): string {
  if (typeof value === "string") return ENUM_LIKE.test(value) ? value : "texto_fora_do_formato";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function at(root: unknown, path: readonly PropertyKey[]): unknown {
  let node = root;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

/** Remove itens fora do enum dos arrays de enum e requisitos de idioma que não passam no item. */
function dropOffEnum(facts: Record<string, unknown>): number {
  let dropped = 0;
  for (const [key, schema] of Object.entries(ENUM_ARRAYS)) {
    const list = facts[key];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((item: unknown) => schema.safeParse(item).success);
    dropped += list.length - kept.length;
    facts[key] = kept;
  }
  const langs = facts["languageRequirements"];
  if (Array.isArray(langs)) {
    const kept = langs.filter((item: unknown) => LanguageRequirementSchema.safeParse(item).success);
    dropped += langs.length - kept.length;
    facts["languageRequirements"] = kept;
  }
  return dropped;
}

export function diagnose(raw: string, guard: LlmOutputGuard = new LlmOutputGuard()): DiagResult {
  const guardOk = guard.inspect(raw).ok;
  const parsed = parseJsonWithoutPrototypeKeys(raw);
  if (!parsed.ok) return { guardOk, issues: [{ path: "(json)", code: parsed.reason, message: null, value: "-" }], guardOkWithoutOffEnum: null, offEnumDropped: 0 };
  const result = JobFactsSchema.safeParse(parsed.value);
  const issues = result.success
    ? []
    : result.error.issues.map((i) => ({
        path: i.path.length === 0 ? "(raiz)" : i.path.map(String).join("."),
        code: i.code,
        message: ENUM_LIKE.test(i.message) ? i.message : null,
        value: valueShape(at(parsed.value, i.path)),
      }));
  const value = parsed.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { guardOk, issues, guardOkWithoutOffEnum: null, offEnumDropped: 0 };
  }
  const copy = structuredClone(value) as Record<string, unknown>;
  const offEnumDropped = dropOffEnum(copy);
  return { guardOk, issues, guardOkWithoutOffEnum: guard.inspect(JSON.stringify(copy)).ok, offEnumDropped };
}
