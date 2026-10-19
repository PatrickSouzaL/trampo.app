// E1 Normalização (ADR-001 §5.2; ADR-005). Domínio puro: o hash e o corte em code points chegam por
// injeção; os tetos vêm de @trampo/contracts/limits, a única exceção de valor no domínio (ADR-005 D2).
import { JOB_TEXT_MAX_CHARS, JOB_TITLE_MAX_CHARS } from "@trampo/contracts/limits";
import type { TextHasher } from "../ports/text-hasher.js";
import {
  DependencyContractError,
  countCodePoints,
  truncateWithinCeiling,
  type TruncateCodePoints,
} from "../text/code-points.js";
import { neutralizeDelimiters } from "./delimiters.js";
import { iterateToFixedPoint } from "./fixed-point.js";
import { removeInvisibleCharacters } from "./invisible-characters.js";
import { maskSensitiveData, type MaskCounts } from "./sensitive-data-masks.js";
import { canonicalizeLineBreaks, collapseWhitespace } from "./whitespace.js";

/**
 * Componente `n` do extractorVersion (ADR-001 §5.4). Qualquer mudança que altere a saída para alguma
 * entrada incrementa a versão, e o cache antigo deixa de ser lido (ADR-005 D5).
 */
export const JOB_TEXT_NORMALIZER_VERSION = "n1";

/** Teto de passadas do ponto fixo (ADR-001 §5.2, item 2). */
export const MAX_NORMALIZATION_PASSES = 4;

/** Expansão do NFKC acima disso é sinal de injection (revisão M1.6, F-01). */
export const SUSPICIOUS_NFKC_EXPANSION_RATIO = 1.5;

/** Sinais para a Camada 1 (InjectionHeuristics, F1-DOM-04). Nunca vão para o LLM. */
export interface JobTextSignals {
  readonly removedInvisibleCount: number;
  /** Code points depois do NFKC sobre code points antes, na primeira passada (0 para texto vazio). */
  readonly nfkcExpansionRatio: number;
  readonly suspiciousNfkcExpansion: boolean;
  readonly truncatedAfterNfkc: boolean;
  /** false: não estabilizou em MAX_NORMALIZATION_PASSES; a Camada 1 trata como injection. */
  readonly fixedPointReached: boolean;
  readonly passes: number;
  readonly maskedCounts: MaskCounts;
  readonly neutralizedDelimiterCount: number;
}

export interface NormalizedJobText {
  readonly text: string;
  /** sha256 do `text` final (já re-truncado e mascarado), em hex minúsculo. */
  readonly textHash: string;
  readonly normalizerVersion: typeof JOB_TEXT_NORMALIZER_VERSION;
  readonly signals: JobTextSignals;
}

export interface NormalizedJobTitle {
  readonly text: string;
  readonly signals: JobTextSignals;
}

export interface JobTextNormalizerDeps {
  readonly hasher: TextHasher;
  /** A função do contrato, a mesma da borda e da extensão (ADR-005 D3). */
  readonly truncateCodePoints: TruncateCodePoints;
}

interface PassStats {
  readonly inputCodePoints: number;
  readonly nfkcCodePoints: number;
  readonly removedInvisible: number;
  readonly truncated: boolean;
  readonly masked: MaskCounts;
  readonly neutralized: number;
}

const SHA256_HEX = /^[a-f0-9]{64}$/u;

export class JobTextNormalizer {
  readonly #deps: JobTextNormalizerDeps;

  constructor(deps: JobTextNormalizerDeps) {
    this.#deps = deps;
  }

  /** Texto da vaga: até JOB_TEXT_MAX_CHARS code points, com hash para a chave de cache. */
  normalize(raw: string): NormalizedJobText {
    const { text, signals } = this.#run(raw, JOB_TEXT_MAX_CHARS, false);
    const textHash = this.#deps.hasher.sha256Hex(text);
    if (!SHA256_HEX.test(textHash)) throw new DependencyContractError("TextHasher devolveu um sha256 inválido.");
    return { text, textHash, normalizerVersion: JOB_TEXT_NORMALIZER_VERSION, signals };
  }

  /** titleHint (revisão M1.6, F-05): o mesmo passo, em linha única, até JOB_TITLE_MAX_CHARS e sem hash. */
  normalizeTitle(raw: string): NormalizedJobTitle {
    return this.#run(raw, JOB_TITLE_MAX_CHARS, true);
  }

  #run(raw: string, maxChars: number, singleLine: boolean): NormalizedJobTitle {
    // toWellFormed uma única vez, antes de tudo: surrogates órfãos viram U+FFFD e não se recombinam.
    const result = iterateToFixedPoint(
      raw.toWellFormed(),
      (value) => this.#step(value, maxChars, singleLine),
      MAX_NORMALIZATION_PASSES,
    );
    const { history } = result;
    const sum = (pick: (stats: PassStats) => number): number => history.reduce((total, s) => total + pick(s), 0);
    const nfkcExpansionRatio = history[0].nfkcCodePoints / Math.max(history[0].inputCodePoints, 1);
    return {
      text: result.value,
      signals: {
        removedInvisibleCount: sum((s) => s.removedInvisible),
        nfkcExpansionRatio,
        suspiciousNfkcExpansion: nfkcExpansionRatio > SUSPICIOUS_NFKC_EXPANSION_RATIO,
        truncatedAfterNfkc: history.some((s) => s.truncated),
        fixedPointReached: result.stable,
        passes: result.passes,
        maskedCounts: {
          email: sum((s) => s.masked.email),
          phone: sum((s) => s.masked.phone),
          document: sum((s) => s.masked.document),
          link: sum((s) => s.masked.link),
        },
        neutralizedDelimiterCount: sum((s) => s.neutralized),
      },
    };
  }

  /** Um passo completo (ADR-005 D4, etapas 2 a 9). Roda até o ponto fixo. */
  #step(value: string, maxChars: number, singleLine: boolean): { value: string; stats: PassStats } {
    const nfkc = value.normalize("NFKC");
    const visible = removeInvisibleCharacters(canonicalizeLineBreaks(nfkc));
    // F-01: o NFKC expande até 18× (U+FDFA). O corte aqui limita todo o trabalho seguinte.
    const cut = this.#truncate(visible.text, maxChars);
    const masked = maskSensitiveData(collapseWhitespace(cut, singleLine));
    const neutralized = neutralizeDelimiters(masked.text);
    // As máscaras podem crescer o texto ("a@b" → "[email]"): a guarda final mantém o teto (SR-09).
    const guarded = this.#truncate(neutralized.text, maxChars).trimEnd();
    return {
      value: guarded,
      stats: {
        inputCodePoints: countCodePoints(value),
        nfkcCodePoints: countCodePoints(nfkc),
        removedInvisible: visible.removed,
        truncated: cut !== visible.text,
        masked: masked.counts,
        neutralized: neutralized.count,
      },
    };
  }

  #truncate(text: string, maxChars: number): string {
    return truncateWithinCeiling(this.#deps.truncateCodePoints, text, maxChars);
  }
}
