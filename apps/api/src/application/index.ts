// Casos de uso e portas (ADR-001 §7): AnalyzeJob, UpdateCriteria, DeleteAccount, RecordFeedback;
// portas JobFactsExtractor, JobFactsCache, CriteriaRepository, RateLimiter, QuotaGuard, Clock,
// IdGenerator, Telemetry. Importa só domain, zod e @trampo/contracts (ADR-008 D1).
export {
  ARRAY_MAX_ITEMS,
  FREE_TEXT_MAX_CHARS,
  LLM_OUTPUT_GUARD_VERSION,
  LLM_OUTPUT_MAX_BYTES,
  LlmOutputGuard,
  type LlmOutputGuardResult,
  type LlmOutputRejection,
  type LlmOutputSanitization,
} from "./llm/llm-output-guard.js";
export {
  BREAKER_POLICY,
  INITIAL_PROVIDER_STATE,
  InMemoryProviderStateStore,
  RATE_LIMIT_COOLDOWN,
  admit,
  recordFailure,
  recordRateLimit,
  recordSuccess,
  releaseProbe,
  type Admission,
} from "./llm/circuit-breaker.js";
export {
  LlmProviderRouter,
  ROUTER_POLICY,
  RouterConfigError,
  type ExtractionFailureReason,
  type ExtractionOutcome,
  type LlmProviderRouterDeps,
  type RouterTrailEntry,
} from "./llm/llm-provider-router.js";
export {
  DEV_ONLY_PROVIDERS,
  PRODUCTION_PROVIDERS,
  ProviderChainConfigError,
  parseLlmProviderChain,
  type ProviderChainOptions,
} from "./llm/provider-chain.js";
export { deadlineAfter, type Clock, type Deadline } from "./ports/clock.js";
export type {
  AttemptControl,
  JobFactsExtractor,
  LlmJobPayload,
  ProviderCallOutcome,
  TokenUsage,
} from "./ports/job-facts-extractor.js";
export type { CircuitPhase, ProviderState, ProviderStateStore } from "./ports/provider-state-store.js";
export type { QuotaDecision, QuotaLedger } from "./ports/quota-ledger.js";
export type { Random } from "./ports/random.js";
export {
  LlmExtractionEventSchema,
  TELEMETRY_LATENCY_MAX_MS,
  TELEMETRY_STEPS_MAX,
  TelemetryEventSchema,
  type LlmExtractionEvent,
  type Telemetry,
  type TelemetryEvent,
} from "./ports/telemetry.js";
export {
  METRIC_CATALOG,
  llmExtractionEvent,
  telemetryMetricSamples,
  type ExtractionTelemetryContext,
  type MetricName,
  type MetricSample,
} from "./telemetry/extraction-telemetry.js";
