// E6 Fusão (ADR-001 §5.6; ADR-011). Domínio puro: funde os fatos do LLM (já aprovados pela guarda E5)
// com os sinais explícitos da Camada 1, registra a proveniência por campo e calcula a confiança efetiva.
// Omissão do LLM não apaga evidência; conflito vira "não informado" com aviso; o perfil só filtra a stack.
import type { AnalysisWarning, JobFacts, RedFlagSignal, ResolvedJobFacts, SalaryFacts } from "@trampo/contracts";

import type { DeterministicSignals, SetSignal } from "../ports/deterministic-signals.js";
import { DependencyContractError } from "../text/code-points.js";

/** Mudou regra de fusão ou limiar padrão: incrementa. Não entra no extractorVersion (ADR-011 D2). */
export const FACT_RESOLVER_VERSION = "fr1";

/** Teto de `stackRequired` (techTagList(30)) e de termos marcados (mustHave 15 + dealBreakers 15). */
export const MAX_STACK_TERMS = 30;

/** Tetos dos conjuntos no contrato (uniqueArray). Só a senioridade é menor que o próprio enum. */
const SET_CEILINGS = { workModels: 3, contractTypes: 5, seniorityLevels: 3 } as const;

export type FactField = keyof ResolvedJobFacts;
export type FactProvenance = "deterministico" | "llm" | "deterministico_e_llm" | "conflito" | "ausente";
export type ResolverWarning = Extract<
  AnalysisWarning,
  "possivel_prompt_injection" | "informacao_contraditoria" | "baixa_confianca_extracao"
>;

/** Hipóteses do ADR-001 §5.6, calibradas no golden dataset (ADR-011 D9). */
export interface FactResolverPolicy {
  readonly salaryTolerance: number;
  readonly lowConfidenceThreshold: number;
  readonly mediumInjectionFactor: number;
}

export const DEFAULT_FACT_RESOLVER_POLICY: FactResolverPolicy = Object.freeze({
  salaryTolerance: 0.05,
  lowConfidenceThreshold: 0.4,
  mediumInjectionFactor: 0.5,
});

export interface FactResolverDeps {
  /** `safeText(JOB_TITLE_MAX_CHARS)` do contrato, injetado: o domínio não roda zod. */
  readonly isSafeTitle: (value: string) => boolean;
  readonly policy?: FactResolverPolicy;
}

export interface FactResolverInput {
  /** null: curto-circuito ou fallback, só a Camada 1. */
  readonly llmFacts: JobFacts | null;
  /** `LlmOutputSanitization.injectionSignal` (ADR-008): a guarda removeu URL ou oculto da saída. */
  readonly llmOutputInjection: boolean;
  readonly signals: DeterministicSignals;
  /** Já passado no `normalizeTitle`. */
  readonly titleHint: string | null;
  /** Só mustHave ∪ dealBreakers do usuário: filtram a stack, nunca viram fato por conta própria. */
  readonly markedStackTerms: readonly string[];
}

export interface FactResolution {
  readonly facts: ResolvedJobFacts;
  readonly provenance: Readonly<Record<FactField, FactProvenance>>;
  readonly effectiveConfidence: number;
  readonly warnings: readonly ResolverWarning[];
  readonly conflicts: readonly FactField[];
  readonly resolverVersion: typeof FACT_RESOLVER_VERSION;
}

interface Fused<T> {
  readonly value: T;
  readonly provenance: FactProvenance;
  readonly comparable: boolean;
  readonly conflict: boolean;
}

const lower = (term: string): string => term.toLowerCase();

const inRange = (value: number, min: number, max: number): boolean => value >= min && value <= max;

function explicitValues<T extends string>(signal: SetSignal<T> | null): readonly T[] {
  return signal?.strength === "explicita" ? [...new Set(signal.values)] : [];
}

function fuseSet<T extends string>(det: readonly T[], llm: readonly T[], ceiling: number): Fused<T[]> {
  if (det.length === 0) {
    return { value: [...llm], provenance: llm.length === 0 ? "ausente" : "llm", comparable: false, conflict: false };
  }
  const union = [...llm, ...det.filter((value) => !llm.includes(value))];
  // Disjuntos, ou mais valores do que o contrato comporta (ex.: 4 senioridades): informação contraditória.
  if (union.length > ceiling || (llm.length > 0 && !det.some((value) => llm.includes(value)))) {
    return { value: [], provenance: "conflito", comparable: true, conflict: true };
  }
  if (llm.length === 0) {
    return { value: union, provenance: "deterministico", comparable: false, conflict: false };
  }
  return { value: union, provenance: "deterministico_e_llm", comparable: true, conflict: false };
}

/** Salário como intervalo [min ?? max, max ?? min]. Salário sem valor viola o contrato. */
function interval(salary: SalaryFacts): readonly [number, number] {
  const low = salary.min ?? salary.max;
  if (low === null) {
    throw new DependencyContractError("Salário sem min nem max: o contrato exige null no lugar.");
  }
  return [low, salary.max ?? low];
}

const compatible = <T>(a: T | null, b: T | null): boolean => a === null || b === null || a === b;

const close = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance * Math.max(a, b);

function fuseSalary(det: SalaryFacts | null, llm: SalaryFacts | null, tolerance: number): Fused<SalaryFacts | null> {
  if (det === null) {
    return { value: llm === null ? null : { ...llm }, provenance: llm === null ? "ausente" : "llm", comparable: false, conflict: false };
  }
  const [detLow, detHigh] = interval(det);
  if (llm === null) {
    return { value: { ...det }, provenance: "deterministico", comparable: false, conflict: false };
  }
  const [llmLow, llmHigh] = interval(llm);
  const agree =
    compatible(det.currency, llm.currency) &&
    compatible(det.period, llm.period) &&
    close(detLow, llmLow, tolerance) &&
    close(detHigh, llmHigh, tolerance);
  if (!agree) {
    return { value: null, provenance: "conflito", comparable: true, conflict: true };
  }
  const value = { ...llm, currency: llm.currency ?? det.currency, period: llm.period ?? det.period };
  return { value, provenance: "deterministico_e_llm", comparable: true, conflict: false };
}

/** Menções explícitas, sem duplicatas (sem diferenciar maiúsculas; a primeira grafia vence). */
function explicitMentions(signals: DeterministicSignals): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const mention of signals.stackMentions) {
    if (mention.strength === "explicita" && !seen.has(lower(mention.term))) {
      seen.add(lower(mention.term));
      out.push(mention.term);
    }
  }
  return out;
}

function fuseStack(llm: JobFacts, mentions: readonly string[], marked: ReadonlySet<string>): Fused<string[]> {
  const isMarked = (term: string): boolean => marked.has(lower(term));
  const llmKnown = new Set([...llm.stackRequired, ...llm.stackNiceToHave].map(lower));
  const evidenced = mentions.filter(isMarked);
  // Grafia do dicionário, nunca a do usuário (ADR-011 D5).
  const missing = evidenced.filter((term) => !llmKnown.has(lower(term)));
  // Teto de 30: saem itens não marcados do fim da lista do LLM; os marcados ficam.
  let unmarkedRoom = MAX_STACK_TERMS - missing.length - llm.stackRequired.filter(isMarked).length;
  const kept: string[] = [];
  for (const term of llm.stackRequired) {
    if (isMarked(term)) {
      kept.push(term);
    } else if (unmarkedRoom > 0) {
      kept.push(term);
      unmarkedRoom -= 1;
    }
  }
  const value = [...kept, ...missing];
  const provenance: FactProvenance =
    missing.length > 0
      ? llm.stackRequired.length > 0
        ? "deterministico_e_llm"
        : "deterministico"
      : value.length > 0
        ? "llm"
        : "ausente";
  return { value, provenance, comparable: evidenced.length > 0, conflict: missing.length > 0 };
}

function redFlags(llm: readonly RedFlagSignal[], salaryMissing: boolean): Fused<RedFlagSignal[]> {
  // `salario_omitido` é do código, não do LLM (ADR-001 §5.6).
  const fromLlm = llm.filter((flag) => flag !== "salario_omitido");
  const value: RedFlagSignal[] = salaryMissing ? [...fromLlm, "salario_omitido"] : fromLlm;
  const provenance: FactProvenance =
    fromLlm.length === 0
      ? salaryMissing
        ? "deterministico"
        : "ausente"
      : salaryMissing
        ? "deterministico_e_llm"
        : "llm";
  return { value, provenance, comparable: false, conflict: false };
}

const fromLlm = (present: boolean): FactProvenance => (present ? "llm" : "ausente");

export class FactResolver {
  readonly #isSafeTitle: (value: string) => boolean;
  readonly #policy: FactResolverPolicy;

  constructor(deps: FactResolverDeps) {
    const policy = deps.policy ?? DEFAULT_FACT_RESOLVER_POLICY;
    if (
      !inRange(policy.salaryTolerance, 0, 0.5) ||
      !inRange(policy.lowConfidenceThreshold, 0, 1) ||
      !inRange(policy.mediumInjectionFactor, 0, 1)
    ) {
      throw new RangeError("FactResolverPolicy fora da faixa (ADR-011 D9).");
    }
    this.#isSafeTitle = deps.isSafeTitle;
    this.#policy = policy;
  }

  resolve(input: FactResolverInput): FactResolution {
    if (input.markedStackTerms.length > MAX_STACK_TERMS) {
      throw new RangeError(`markedStackTerms acima de ${String(MAX_STACK_TERMS)} (ADR-011 D5).`);
    }
    const { signals } = input;
    // Injection alta com fatos do LLM não deveria ocorrer (R2); defesa em profundidade: descarta (D7).
    const llm = signals.injectionLevel === "alta" ? null : input.llmFacts;
    if (llm !== null && !inRange(llm.extractionConfidence, 0, 1)) {
      throw new DependencyContractError("extractionConfidence fora de [0, 1]: a guarda E5 deveria ter barrado.");
    }

    const workModels = fuseSet(explicitValues(signals.workModels), llm?.workModels ?? [], SET_CEILINGS.workModels);
    const contractTypes = fuseSet(
      explicitValues(signals.contractTypes),
      llm?.contractTypes ?? [],
      SET_CEILINGS.contractTypes,
    );
    const seniorityLevels = fuseSet(
      explicitValues(signals.seniorityLevels),
      llm?.seniorityLevels ?? [],
      SET_CEILINGS.seniorityLevels,
    );
    const detSalary = signals.salary?.strength === "explicita" ? signals.salary.value : null;
    const salary = fuseSalary(detSalary, llm?.salary ?? null, this.#policy.salaryTolerance);
    const mentions = explicitMentions(signals);
    const stackRequired: Fused<string[]> =
      llm === null
        ? {
            value: mentions.slice(0, MAX_STACK_TERMS),
            provenance: mentions.length > 0 ? "deterministico" : "ausente",
            comparable: false,
            conflict: false,
          }
        : fuseStack(llm, mentions, new Set(input.markedStackTerms.map(lower)));
    const flags = redFlags(llm?.redFlagSignals ?? [], salary.value === null);

    const hintIsSafe = input.titleHint !== null && this.#isSafeTitle(input.titleHint);
    const title = hintIsSafe ? input.titleHint : (llm?.title ?? null);

    const facts: ResolvedJobFacts = {
      title,
      seniorityLevels: seniorityLevels.value,
      yearsExperienceMin: llm?.yearsExperienceMin ?? null,
      workModels: workModels.value,
      location: llm === null || llm.location === null ? null : { ...llm.location },
      salary: salary.value,
      contractTypes: contractTypes.value,
      stackRequired: stackRequired.value,
      stackNiceToHave: [...(llm?.stackNiceToHave ?? [])],
      benefits: [...(llm?.benefits ?? [])],
      languageRequirements: (llm?.languageRequirements ?? []).map((requirement) => ({ ...requirement })),
      redFlagSignals: flags.value,
    };

    const provenance: Record<FactField, FactProvenance> = {
      title: hintIsSafe ? "deterministico" : fromLlm(facts.title !== null),
      seniorityLevels: seniorityLevels.provenance,
      yearsExperienceMin: fromLlm(facts.yearsExperienceMin !== null),
      workModels: workModels.provenance,
      location: fromLlm(facts.location !== null),
      salary: salary.provenance,
      contractTypes: contractTypes.provenance,
      stackRequired: stackRequired.provenance,
      stackNiceToHave: fromLlm(facts.stackNiceToHave.length > 0),
      benefits: fromLlm(facts.benefits.length > 0),
      languageRequirements: fromLlm(facts.languageRequirements.length > 0),
      redFlagSignals: flags.provenance,
    };

    const compared: ReadonlyArray<readonly [FactField, Fused<unknown>]> = [
      ["workModels", workModels],
      ["contractTypes", contractTypes],
      ["seniorityLevels", seniorityLevels],
      ["salary", salary],
    ];
    const conflicts = compared.filter(([, fused]) => fused.conflict).map(([field]) => field);
    const all = [...compared.map(([, fused]) => fused), stackRequired];
    const comparable = all.filter((fused) => fused.comparable).length;
    const divergent = all.filter((fused) => fused.conflict).length;

    const injection = signals.injectionLevel === "media" || input.llmOutputInjection;
    const corroboration = 1 - divergent / Math.max(1, comparable);
    const effectiveConfidence =
      llm === null
        ? 0
        : Math.min(llm.extractionConfidence, corroboration) * (injection ? this.#policy.mediumInjectionFactor : 1);

    const warnings: ResolverWarning[] = [];
    if (injection || signals.injectionLevel === "alta") warnings.push("possivel_prompt_injection");
    if (conflicts.length > 0) warnings.push("informacao_contraditoria");
    if (llm !== null && effectiveConfidence < this.#policy.lowConfidenceThreshold) {
      warnings.push("baixa_confianca_extracao");
    }

    return { facts, provenance, effectiveConfidence, warnings, conflicts, resolverVersion: FACT_RESOLVER_VERSION };
  }
}
