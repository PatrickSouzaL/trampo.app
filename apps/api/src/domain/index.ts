// Domínio puro (ADR-001 §7): JobTextNormalizer, DeterministicPreFilter, FactResolver, ScoringEngine...
// Só `import type` de @trampo/contracts (exceção de valor: ./limits, ADR-005 D2) e arquivos do próprio
// domínio; sem rede, relógio, aleatoriedade nem zod em runtime (preset domainPurity + dependency-cruiser).
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
