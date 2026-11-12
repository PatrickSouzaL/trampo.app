// Casos de uso e portas (ADR-001 §7): AnalyzeJob, UpdateCriteria, DeleteAccount, RecordFeedback;
// portas JobFactsExtractor, JobFactsCache, CriteriaRepository, RateLimiter, DailyQuota, QuotaLedger, Clock,
// IdGenerator, Telemetry. Importa só domain, zod e @trampo/contracts (ADR-008 D1).
export {
  ANALYZE_JOB_VERSION,
  AnalyzeJob,
  AnalyzeJobConfigError,
  type AnalysisAlert,
  type AnalysisStage,
  type AnalyzeJobDeps,
  type AnalyzeJobInput,
  type FactsExtraction,
} from "./analysis/analyze-job.js";
export {
  CACHE_KEY_PREFIX,
  CACHE_POLICY,
  CacheConfigError,
  extractorVersionTag,
  type ExtractorVersionParts,
} from "./cache/cache-policy.js";
export {
  JobFactsCache,
  type AcceptedModel,
  type CacheLookup,
  type CacheMissReason,
  type CacheStoreOutcome,
  type CacheWriteCandidate,
  type CacheWriteRefusal,
  type JobFactsCacheDeps,
} from "./cache/job-facts-cache.js";
export { DailyQuotaGuard, RateLimitGuard } from "./limits/limit-guards.js";
export {
  DAILY_QUOTA_POLICY,
  GROQ_TOKEN_MEASUREMENT,
  LEDGER_POLICY,
  LIMIT_GUARD_POLICY,
  RATE_LIMIT_POLICY,
  STRICTEST_RATE_LIMIT_CLASS,
  WORKERS_AI_NEURON_MEASUREMENT,
  effectiveLimit,
  groqReservedTokensPerCall,
  providerLimits,
  resolveRateLimitClass,
  workersAiCallsPerDay,
  type ProviderLimits,
} from "./limits/limit-policy.js";
export { withDeadline } from "./shared/with-deadline.js";
export {
  isEpochMs,
  quotaDay,
  slidingWindowCount,
  utcDayAndMinute,
  windowPosition,
  windowRetryAfterSeconds,
  type QuotaDay,
  type WindowPosition,
} from "./limits/windows.js";
export {
  ARRAY_MAX_ITEMS,
  FREE_TEXT_MAX_CHARS,
  LLM_OUTPUT_GUARD_VERSION,
  LLM_OUTPUT_MAX_BYTES,
  LlmOutputGuard,
  parseJsonWithoutPrototypeKeys,
  type LlmOutputGuardResult,
  type LlmOutputRejection,
  type LlmOutputSanitization,
} from "./llm/llm-output-guard.js";
export {
  BENEFIT_PROMPT_TERMS,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_RESPONSE_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT_TEMPLATE,
  buildExtractionMessages,
  type ExtractionMessage,
  type ExtractionMessagesResult,
  type JsonSchemaValue,
} from "./llm/extraction-prompt.js";
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
  type AttemptTimeoutMaxMs,
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
export type {
  AccessTokenRejection,
  AccessTokenVerification,
  AccessTokenVerifier,
  Principal,
} from "./ports/access-token-verifier.js";
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
export type { DailyQuota, DailyQuotaDecision } from "./ports/daily-quota.js";
export type { CacheStoreRead, CacheStoreWrite, JobFactsCacheStore } from "./ports/job-facts-cache-store.js";
export type { Random } from "./ports/random.js";
export type { RefreshOpenResult, RefreshSealResult, RefreshSealer, SealedSession } from "./ports/refresh-sealer.js";
export { CRITERIA_GUARD_POLICY, CriteriaGuard } from "./criteria/criteria-guard.js";
export type {
  CriteriaLookup,
  CriteriaReader,
  CriteriaRepository,
  CriteriaSave,
  CriteriaSubject,
  CriteriaWriter,
} from "./ports/criteria-repository.js";
export type { IdGenerator } from "./ports/id-generator.js";
export type { RateLimitClass, RateLimitDecision, RateLimiter, RateLimitSubject } from "./ports/rate-limiter.js";
export {
  AUTH_OPERATIONS,
  AUTH_RESULTS,
  AnalysisCacheStatusSchema,
  AnalysisEventSchema,
  AuthEventSchema,
  LlmExtractionEventSchema,
  TELEMETRY_LATENCY_MAX_MS,
  TELEMETRY_GUARD_NORMALIZATION_MAX,
  TELEMETRY_STEPS_MAX,
  TelemetryEventSchema,
  type AnalysisCacheStatus,
  type AnalysisEvent,
  type AuthEvent,
  type AuthOperation,
  type AuthResult,
  type LlmExtractionEvent,
  type Telemetry,
  type TelemetryEvent,
} from "./ports/telemetry.js";
export { authEvent, authSessionResult, endSessionResult } from "./telemetry/auth-telemetry.js";
export {
  METRIC_CATALOG,
  llmExtractionEvent,
  telemetryMetricSamples,
  telemetryMs,
  type ExtractionTelemetryContext,
  type MetricName,
  type MetricSample,
} from "./telemetry/extraction-telemetry.js";
