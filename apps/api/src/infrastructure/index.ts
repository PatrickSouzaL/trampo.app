// Adapters (ADR-001 §7): llm/{groq,cloudflare-workers-ai,ollama}, llm/router, llm/output-guard,
// cache/redis-jobfacts, cache/rate-limit, persistence/supabase-criteria, auth/jwks-verifier.
// Implementa as portas da application. O adapter do Gemini está adiado para a Fase 2 (HITL-012).
export {
  JWKS_TIMINGS,
  JWT_POLICY,
  createJoseAccessTokenVerifier,
  type JoseAccessTokenVerifierConfig,
  type JwksTimings,
} from "./auth/jose-access-token-verifier.js";
export {
  AUTH_SESSION_LIMITS,
  AuthSessionConfigError,
  readAuthSessionEnv,
  type AuthSessionConfig,
  type AuthSessionVariable,
} from "./auth/auth-session-env.js";
export {
  AEAD_KEY_ID_PATTERN,
  AEAD_POLICY,
  createAeadEnvelope,
  decodeCanonical,
  parseAeadKeyring,
  type AeadEnvelope,
  type AeadEnvelopeFormat,
  type AeadKeyring,
} from "./crypto/aead-envelope.js";
export {
  REFRESH_ENVELOPE_VERSION,
  REFRESH_SEALER_POLICY,
  RefreshKeyringConfigError,
  createAeadRefreshSealer,
  parseRefreshKeyring,
} from "./crypto/aead-refresh-sealer.js";
export {
  SALARY_CIPHER_POLICY,
  SALARY_ENVELOPE_VERSION,
  SalaryKeyringConfigError,
  SalarySealError,
  createSalaryCipher,
  parseSalaryKeyring,
  type SalaryCipher,
  type SalaryKeyring,
  type SalaryOpenResult,
  type SalaryValue,
} from "./crypto/salary-cipher.js";
export {
  WORKERS_AI_DEFAULT_MODEL,
  WORKERS_AI_POLICY,
  WorkersAiConfigError,
  createCloudflareWorkersAiExtractor,
  type WorkersAiConfigVariable,
  type WorkersAiExtractorConfig,
} from "./llm/cloudflare-workers-ai-extractor.js";
export {
  GROQ_CHAT_COMPLETIONS_URL,
  GROQ_MODEL,
  GROQ_POLICY,
  GroqConfigError,
  createGroqExtractor,
  type GroqConfigVariable,
  type GroqExtractorConfig,
} from "./llm/groq-extractor.js";
export { parseRetryAfterMs } from "./llm/llm-http.js";
export {
  USER_CRITERIA_SELECT,
  createSupabaseCriteriaRepository,
  type SupabaseCriteriaRepositoryDeps,
} from "./persistence/supabase-criteria-repository.js";
export {
  POSTGREST_CLIENT_POLICY,
  PostgrestClientConfigError,
  createPostgrestUserClient,
  type PostgrestRead,
  type PostgrestTable,
  type PostgrestUserClient,
  type PostgrestUserClientConfig,
} from "./supabase/postgrest-user-client.js";
