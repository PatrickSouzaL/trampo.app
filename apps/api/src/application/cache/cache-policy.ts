// Política do JobFactsCache (ADR-001 §5.4; ADR-015 D2, D3 e D6). Hipóteses da Fase 1, que mudam só por ADR.
// Um teste fixa estes valores contra o ADR-015.
import { JOB_FACTS_SCHEMA_VERSION } from "@trampo/contracts/job-facts";
import { VersionTagSchema } from "@trampo/contracts/primitives";

export const CACHE_POLICY = {
  /** 10 dias (ADR-001 §5.4, dentro dos 7 a 14 do Blueprint). */
  ttlSeconds: 864_000,
  /** `CACHE_MIN_CONFIDENCE` do ADR-001. */
  minConfidence: 0.5,
  /** Teto da entrada serializada, na escrita e na leitura. */
  entryMaxChars: 16_384,
  lookupTimeoutMs: 150,
  storeTimeoutMs: 250,
  /** Tolerância de relógio para um `extractedAt` no futuro. */
  clockSkewMs: 300_000,
  /** Além do TTL, um dia de margem antes de tratar a entrada como velha demais. */
  maxAgeMarginMs: 86_400_000,
} as const;

export const CACHE_KEY_PREFIX = `jobfacts:v${JOB_FACTS_SCHEMA_VERSION}`;

export class CacheConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheConfigError";
  }
}

export interface ExtractorVersionParts {
  /** Versão do prompt do extrator (F1-LLM-01 parte 2). */
  readonly prompt: string;
  readonly normalizer: string;
  readonly selector: string;
  readonly guard: string;
  /** Orçamento do RelevantSectionSelector, em caracteres. */
  readonly budgetChars: number;
}

/**
 * `jf-{prompt}-s{schema}-{normalizador}-{seletor}-{guarda}-b{orçamento}` (ADR-015 D2). Qualquer peça que muda o
 * que o LLM recebe ou o que a guarda aceita muda a chave, e o fato velho nem é lido. Lança no boot se a tag
 * montada não couber no VersionTagSchema.
 */
export function extractorVersionTag(parts: ExtractorVersionParts): string {
  const tag = `jf-${parts.prompt}-s${JOB_FACTS_SCHEMA_VERSION}-${parts.normalizer}-${parts.selector}-${parts.guard}-b${parts.budgetChars}`;
  const budgetOk = Number.isSafeInteger(parts.budgetChars) && parts.budgetChars > 0;
  if (!budgetOk || !VersionTagSchema.safeParse(tag).success) {
    throw new CacheConfigError("a versão do extrator não cabe no VersionTagSchema");
  }
  return tag;
}
