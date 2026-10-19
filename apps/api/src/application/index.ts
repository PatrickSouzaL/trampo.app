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
