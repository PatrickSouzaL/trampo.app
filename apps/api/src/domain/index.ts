// Domínio puro (ADR-001 §7): JobTextNormalizer, DeterministicPreFilter, FactResolver, ScoringEngine, ReportComposer...
// Só `import type` de @trampo/contracts (exceção de valor: ./limits, ADR-005 D2) e arquivos do próprio
// domínio; sem rede, relógio, aleatoriedade nem zod em runtime (preset domainPurity + dependency-cruiser).
export {
  DEFAULT_FACT_RESOLVER_POLICY,
  FACT_RESOLVER_VERSION,
  FactResolver,
  MAX_STACK_TERMS,
  type FactField,
  type FactProvenance,
  type FactResolution,
  type FactResolverDeps,
  type FactResolverInput,
  type FactResolverPolicy,
  type ResolverWarning,
} from "./fusion/fact-resolver.js";
export type {
  DeterministicSignals,
  InjectionLevel,
  SalarySignal,
  SetSignal,
  SignalStrength,
  StackMentionSignal,
} from "./ports/deterministic-signals.js";
export {
  JOB_TEXT_NORMALIZER_VERSION,
  JobTextNormalizer,
  type JobTextNormalizerDeps,
  type JobTextSignals,
  type NormalizedJobText,
  type NormalizedJobTitle,
} from "./normalization/job-text-normalizer.js";
export type { TextHasher } from "./ports/text-hasher.js";
export {
  ANALYSIS_WARNINGS,
  CONTRACT_TYPES,
  DEFAULT_REPORT_CATALOG,
  DIMENSION_OUTCOMES,
  EXPLANATION_MAX,
  ITEM_TEXT_MAX,
  MAX_LISTED_FACTS,
  RED_FLAG_EFFECTS,
  REPORT_CATALOG_VERSION,
  SPECIFIC_REASON_CODES,
  SUMMARY_MAX,
  VERDICTS,
  WORK_MODELS,
  reportCatalogIssues,
  type ReportCatalog,
  type SpecificReasonCode,
} from "./report/report-catalog.js";
export {
  ReportComposer,
  type ReportComposerInput,
  type ReportEnvelope,
  type ReportResolution,
} from "./report/report-composer.js";
export {
  HEADER_CHARS,
  LLM_INPUT_MAX_CHARS,
  OMISSION_MARKER,
  RELEVANT_SECTION_SELECTOR_VERSION,
  RelevantSectionSelector,
  type RelevantSectionSelectorDeps,
  type SelectedJobText,
  type SelectionSignals,
} from "./selection/relevant-section-selector.js";
export { DependencyContractError, countCodePoints, type TruncateCodePoints } from "./text/code-points.js";
export {
  ScoringEngine,
  foldCity,
  type DimensionEvaluation,
  type RedFlagEffect,
  type RedFlagHit,
  type ScoreReasonCode,
  type ScoreResult,
  type ScoringInput,
} from "./scoring/scoring-engine.js";
export {
  CURRENCIES,
  DEFAULT_SCORING_POLICY,
  LANGUAGE_LEVELS,
  MAX_DIMENSION_PENALTY,
  NEVER_ATTENUATED_RED_FLAGS,
  RED_FLAG_SIGNALS,
  SALARY_PERIODS,
  SCORE_DIMENSIONS,
  SCORING_ENGINE_VERSION,
  SENIORITY_LEVELS,
  scoringPolicyIssues,
  type BandedVerdict,
  type ScoringPolicy,
} from "./scoring/scoring-policy.js";
