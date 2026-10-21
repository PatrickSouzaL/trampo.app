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
