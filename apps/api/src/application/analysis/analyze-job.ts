// AnalyzeJob, o dono do funil E1–E8 (ADR-001 §4; ADR-017). Chama as peças na ordem, escolhe o `decisionPath`,
// junta os avisos, grava no cache sem bloquear, mede a telemetria e valida a própria saída.
//
// Minimização: não recebe o userId, e nenhum campo do UserCriteria vai ao LLM: o payload é só o texto
// normalizado e selecionado (AGENTS §1.3). Os termos marcados (deal-breakers ∪ must-have) só filtram a fusão.
// Não tem logger: os alertas saem por `onAlert`, só com enum, e a rota os leva ao catálogo do ADR-010.
import {
  type AnalysisReport,
  AnalysisReportSchema,
  type AnalysisStageSchema,
  type AnalysisWarning,
  type AnalyzeJobRequest,
  type DecisionPath,
  type LlmProviderId,
  type UserCriteria,
} from "@trampo/contracts";
import type { JobFacts } from "@trampo/contracts/job-facts";
import { VersionTagSchema } from "@trampo/contracts/primitives";
import type { z } from "zod";

import {
  ANALYSIS_WARNINGS,
  DependencyContractError,
  type DeterministicPreFilter,
  type DeterministicSignals,
  type FactResolution,
  type FactResolver,
  type JobTextNormalizer,
  type NormalizedJobText,
  type NormalizedJobTitle,
  type PreFilterDecision,
  type PreFilterRouter,
  type RelevantSectionSelector,
  type ReportComposer,
  type ReportResolution,
  type ScoreResult,
  type ScoringEngine,
} from "../../domain/index.js";
import type { JobFactsCache } from "../cache/job-facts-cache.js";
import type { LlmOutputSanitization } from "../llm/llm-output-guard.js";
import { type LlmProviderRouter, ROUTER_POLICY } from "../llm/llm-provider-router.js";
import { type Clock, deadlineAfter } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { AnalysisCacheStatus, AnalysisEvent, Telemetry } from "../ports/telemetry.js";
import { llmExtractionEvent, telemetryMs } from "../telemetry/extraction-telemetry.js";

export const ANALYZE_JOB_VERSION = "aj1";

export type AnalysisStage = z.infer<typeof AnalysisStageSchema>;
/** Alertas do catálogo do ADR-010 que só o AnalyzeJob enxerga (ADR-015 §4). */
export type AnalysisAlert = "cache_corrompido";

/** A Camada 3 (ADR-009). `null` no AnalyzeJob: não há adapter, e o R4 vai direto ao fallback. */
export type FactsExtraction = Pick<LlmProviderRouter, "extract">;

export interface AnalyzeJobDeps {
  readonly normalizer: Pick<JobTextNormalizer, "normalize" | "normalizeTitle">;
  readonly selector: Pick<RelevantSectionSelector, "select">;
  readonly preFilter: Pick<DeterministicPreFilter, "extract">;
  readonly router: Pick<PreFilterRouter, "route">;
  readonly resolver: Pick<FactResolver, "resolve">;
  readonly engine: Pick<ScoringEngine, "score">;
  readonly composer: Pick<ReportComposer, "compose">;
  /** `null`: sem cache, o R4 vai direto à extração. */
  readonly cache: Pick<JobFactsCache, "extractorVersion" | "lookup" | "store"> | null;
  readonly extraction: FactsExtraction | null;
  /** A `extractorVersionTag` (ADR-015 D2) que vai no relatório do caminho `extracao_llm`; a mesma do cache. */
  readonly extractorVersion: string;
  readonly telemetry: Telemetry;
  /** Monotônico: durações e o prazo do router. */
  readonly clock: Clock;
  /** Relógio de parede em ms, só para o `createdAt`. */
  readonly now: () => number;
  readonly ids: IdGenerator;
}

export interface AnalyzeJobInput {
  readonly request: AnalyzeJobRequest;
  readonly criteria: UserCriteria;
  /** Progresso para o stream. Nunca lança (a rota garante). */
  readonly onStage: (stage: AnalysisStage, elapsedMs: number) => void;
  /** Alerta operacional, só enum. Nunca lança (a rota garante). */
  readonly onAlert: (alert: AnalysisAlert) => void;
}

export class AnalyzeJobConfigError extends Error {
  override readonly name = "AnalyzeJobConfigError";
}

const ANALYSIS_ID = AnalysisReportSchema.shape.analysisId;

/** Fatos do LLM aceitos para a fusão, do cache ou da extração desta requisição. */
interface SemanticFacts {
  readonly path: Extract<DecisionPath, "cache_jobfacts" | "extracao_llm">;
  readonly facts: JobFacts;
  readonly llmOutputInjection: boolean;
  readonly extractorVersion: string;
  readonly provider: LlmProviderId;
  /** Só na extração: o que o cache precisa para decidir a escrita (ADR-015 D3). */
  readonly fresh: { readonly sanitization: LlmOutputSanitization; readonly model: string } | null;
}

interface SemanticLookup {
  readonly facts: SemanticFacts | null;
  readonly cache: AnalysisCacheStatus;
}

/** O que a escolha do caminho entrega ao ReportComposer. */
interface Assessment {
  readonly path: DecisionPath;
  readonly resolution: ReportResolution & Pick<FactResolution, "warnings">;
  readonly score: ScoreResult;
  readonly routeWarnings: readonly AnalysisWarning[];
  readonly extractorVersion: string | null;
  readonly provider: LlmProviderId | null;
  readonly cache: AnalysisCacheStatus;
}

interface RunContext {
  readonly input: AnalyzeJobInput;
  readonly text: NormalizedJobText;
  readonly signals: DeterministicSignals;
  readonly titleHint: string | null;
  readonly decision: PreFilterDecision;
  readonly elapsed: () => number;
}

export class AnalyzeJob {
  readonly #deps: AnalyzeJobDeps;

  /** Lança no boot se a versão do extrator não é uma tag válida ou diverge da do cache. */
  constructor(deps: AnalyzeJobDeps) {
    if (!VersionTagSchema.safeParse(deps.extractorVersion).success) {
      throw new AnalyzeJobConfigError("extractorVersion fora do VersionTagSchema");
    }
    if (deps.cache !== null && deps.cache.extractorVersion !== deps.extractorVersion) {
      throw new AnalyzeJobConfigError("extractorVersion diverge da do cache");
    }
    this.#deps = deps;
  }

  async run(input: AnalyzeJobInput): Promise<AnalysisReport> {
    const { clock, normalizer, preFilter, router } = this.#deps;
    const { request, criteria } = input;
    const startedAt = clock.nowMs();
    const elapsed = (): number => telemetryMs(clock.nowMs() - startedAt);
    input.onStage("recebido", 0);

    input.onStage("normalizando", elapsed());
    const text = normalizer.normalize(request.job.text.text);
    const title = request.job.titleHint === null ? null : nonEmpty(normalizer.normalizeTitle(request.job.titleHint));
    const titleHint = title === null ? null : title.text;

    input.onStage("triagem_deterministica", elapsed());
    const signals = preFilter.extract({ text, title });
    const decision = router.route({ mode: request.mode, signals, titleHint, criteria });

    const context: RunContext = { input, text, signals, titleHint, decision, elapsed };
    const semantic = decision.rule === "R4" ? await this.#semanticFacts(context) : null;

    input.onStage("pontuando", elapsed());
    const assessment = semantic === null ? withoutAi(decision) : this.#assess(context, semantic);
    const truncated = request.job.text.truncatedAtEdge || request.job.clientTruncated || text.signals.truncatedAfterNfkc;
    const warnings = inEnumOrder([
      ...assessment.routeWarnings,
      ...assessment.resolution.warnings,
      ...(truncated ? (["texto_truncado"] as const) : []),
    ]);
    const report = this.#deps.composer.compose({
      envelope: {
        analysisId: this.#newId(),
        requestId: request.requestId,
        createdAt: new Date(this.#deps.now()).toISOString(),
        platform: request.source.platform,
        decisionPath: assessment.path,
        extractorVersion: assessment.extractorVersion,
        provider: assessment.provider,
        durationMs: elapsed(),
      },
      resolution: assessment.resolution,
      warnings,
      score: assessment.score,
    });
    // ADR-001 §5.8: a API valida a própria saída. Falha é defeito e nunca vira relatório parcial; o erro não
    // carrega as issues do Zod (podem ecoar valores do relatório).
    const parsed = AnalysisReportSchema.safeParse(report);
    if (!parsed.success) throw new DependencyContractError("O relatório não passou no AnalysisReportSchema.");

    const event: AnalysisEvent = {
      kind: "analysis",
      platform: request.source.platform,
      mode: request.mode,
      rule: decision.rule,
      decisionPath: assessment.path,
      acceptEligible: decision.acceptEligible,
      cache: assessment.cache,
      injectionLevel: signals.injectionLevel,
      warnings,
      durationMs: parsed.data.meta.durationMs,
    };
    this.#deps.telemetry.record(event);
    return parsed.data;
  }

  /** R4: fatos do cache ou da extração; `facts: null` é o fallback (ADR-017 D3). */
  async #semanticFacts(context: RunContext): Promise<SemanticLookup> {
    const lookup = await this.#fromCache(context);
    return lookup.facts === null ? { facts: await this.#extract(context), cache: lookup.cache } : lookup;
  }

  #assess(context: RunContext, semantic: SemanticLookup): Assessment {
    const { input, decision } = context;
    const llm = semantic.facts;
    if (llm === null) {
      return { ...withoutAi(decision), path: "fallback_deterministico", routeWarnings: ["analise_degradada"], cache: semantic.cache };
    }
    const resolution = this.#deps.resolver.resolve({
      llmFacts: llm.facts,
      llmOutputInjection: llm.llmOutputInjection,
      signals: context.signals,
      titleHint: context.titleHint,
      // O contrato limita cada lista a 15 e as proíbe de repetir termo: a união cabe no teto de 30 (ADR-011 D5).
      markedStackTerms: [...input.criteria.stack.dealBreakers, ...input.criteria.stack.mustHave],
    });
    const score = this.#deps.engine.score(
      { facts: resolution.facts, provenance: resolution.provenance, llmExtracted: true },
      input.criteria,
    );
    if (llm.fresh !== null) this.#storeLater(context, llm, llm.fresh, resolution.effectiveConfidence);
    return {
      path: llm.path,
      resolution,
      score,
      routeWarnings: decision.warnings,
      extractorVersion: llm.extractorVersion,
      provider: llm.provider,
      cache: semantic.cache,
    };
  }

  async #fromCache(context: RunContext): Promise<SemanticLookup> {
    const { cache } = this.#deps;
    if (cache === null) return { facts: null, cache: "nao_consultado" };
    context.input.onStage("consultando_cache", context.elapsed());
    const lookup = await cache.lookup(context.text.textHash);
    if (!lookup.hit) {
      if (lookup.reason === "corrompido") context.input.onAlert("cache_corrompido");
      return { facts: null, cache: lookup.reason };
    }
    const { entry } = lookup;
    // O cache só grava saída sem injection (SR-08) e revalida a entrada na leitura (ADR-015 D4).
    const facts: SemanticFacts = {
      path: "cache_jobfacts",
      facts: entry.facts,
      llmOutputInjection: false,
      extractorVersion: entry.extractorVersion,
      provider: entry.provider,
      fresh: null,
    };
    return { facts, cache: "hit" };
  }

  async #extract(context: RunContext): Promise<SemanticFacts | null> {
    const { extraction, selector, clock, telemetry } = this.#deps;
    if (extraction === null) return null;
    context.input.onStage("extraindo_fatos", context.elapsed());
    // Só o texto normalizado (PII e URL mascaradas) e selecionado: nada do perfil (AGENTS §1.3).
    const payload = { text: selector.select(context.text).text };
    const startedAt = clock.nowMs();
    const outcome = await extraction.extract(payload, deadlineAfter(clock, ROUTER_POLICY.analysisDeadlineMs));
    telemetry.record(
      llmExtractionEvent(outcome, { platform: context.input.request.source.platform, latencyMs: clock.nowMs() - startedAt }),
    );
    if (!outcome.ok) return null;
    return {
      path: "extracao_llm",
      facts: outcome.facts,
      llmOutputInjection: outcome.sanitization.injectionSignal,
      extractorVersion: this.#deps.extractorVersion,
      provider: outcome.provider,
      fresh: { sanitization: outcome.sanitization, model: outcome.model },
    };
  }

  /**
   * SR-08 (ADR-017 D4): grava a saída da guarda, antes da fusão, sem bloquear o relatório. As recusas são todas
   * do JobFactsCache. O `store` nunca rejeita; o `.catch` só impede uma rejeição solta de derrubar o processo.
   */
  #storeLater(
    context: RunContext,
    llm: SemanticFacts,
    fresh: NonNullable<SemanticFacts["fresh"]>,
    effectiveConfidence: number,
  ): void {
    const { cache } = this.#deps;
    if (cache === null) return;
    const candidate = {
      textHash: context.text.textHash,
      facts: llm.facts,
      sanitization: fresh.sanitization,
      injectionLevel: context.signals.injectionLevel,
      effectiveConfidence,
      degraded: false,
      provider: llm.provider,
      model: fresh.model,
    };
    Promise.resolve()
      .then(() => cache.store(candidate))
      .catch(() => undefined);
  }

  #newId(): string {
    const id = this.#deps.ids.uuid();
    if (!ANALYSIS_ID.safeParse(id).success) throw new DependencyContractError("O IdGenerator devolveu um id fora do padrão UUID.");
    return id;
  }
}

/**
 * R1, R2 e R3: os fatos e a nota da Camada 1, sem rodar o resolver e o motor de novo (ADR-016 D9). O R2 é a
 * recusa de chamar a IA, não uma decisão: sai como fallback, com `analise_degradada` (ADR-017 D3).
 */
function withoutAi(decision: PreFilterDecision): Assessment {
  const injection = decision.rule === "R2";
  return {
    path: injection ? "fallback_deterministico" : "triagem_deterministica",
    resolution: decision.deterministic.resolution,
    score: decision.deterministic.score,
    routeWarnings: injection ? [...decision.warnings, "analise_degradada"] : decision.warnings,
    extractorVersion: null,
    provider: null,
    cache: "nao_consultado",
  };
}

/** O título que sobra vazio depois da normalização é ausência de título. */
function nonEmpty(title: NormalizedJobTitle): NormalizedJobTitle | null {
  return title.text.length > 0 ? title : null;
}

/** Sem repetição e na ordem do enum do contrato: a mesma lista vai ao relatório e à telemetria. */
function inEnumOrder(warnings: readonly AnalysisWarning[]): AnalysisWarning[] {
  const present = new Set(warnings);
  return ANALYSIS_WARNINGS.filter((warning) => present.has(warning));
}
