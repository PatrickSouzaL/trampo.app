// Domínio puro (ADR-001 §7): JobTextNormalizer, DeterministicPreFilter, FactResolver, ScoringEngine...
// Só `import type` de @trampo/contracts (exceção de valor: ./limits, ADR-005 D2) e arquivos do próprio
// domínio; sem rede, relógio, aleatoriedade nem zod em runtime (preset domainPurity + dependency-cruiser).
export {
  JOB_TEXT_NORMALIZER_VERSION,
  JobTextNormalizer,
  NormalizerDependencyError,
  type JobTextNormalizerDeps,
  type JobTextSignals,
  type NormalizedJobText,
  type NormalizedJobTitle,
} from "./normalization/job-text-normalizer.js";
export type { TextHasher } from "./ports/text-hasher.js";
