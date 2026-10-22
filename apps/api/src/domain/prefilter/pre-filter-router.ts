// Tabela de roteamento R1–R4 da Camada 1 (ADR-001 §5.3; ADR-016 D9). Depende do usuário, mas é pura: o R1
// e o R3 julgam os fatos SÓ determinísticos com o ScoringEngine real, então a decisão sem IA nunca diverge
// da nota (adjacência D-S5, câmbio se1, hora × 220, dealBreakerScope). Nenhum trecho da vaga sai daqui.
import type { AnalysisWarning, ScoreDimension, UserCriteria } from "@trampo/contracts";
import type { FactResolution, FactResolver } from "../fusion/fact-resolver.js";
import type { DeterministicSignals } from "../ports/deterministic-signals.js";
import type { ScoreResult, ScoringEngine } from "../scoring/scoring-engine.js";

export const PRE_FILTER_ROUTER_VERSION = "rt1";

export type AnalysisMode = "auto" | "aprofundada";
export type PreFilterRule = "R1" | "R2" | "R3" | "R4";
export type PreFilterRoute = "curto_circuito_rejeicao" | "somente_deterministico" | "curto_circuito_aceite" | "semantica";

export interface PreFilterRouterPolicy {
  /** D-H3: aceite sem IA. Desligado por padrão (S-4 §5.6: ganho de 2 em 581 pares com critério obrigatório). */
  readonly shortCircuitAccept: boolean;
}

export const DEFAULT_PRE_FILTER_ROUTER_POLICY: PreFilterRouterPolicy = Object.freeze({ shortCircuitAccept: false });

export interface PreFilterRouterDeps {
  readonly resolver: FactResolver;
  readonly engine: ScoringEngine;
  readonly policy?: PreFilterRouterPolicy;
}

export interface PreFilterRoutingInput {
  /** "aprofundada" (botão "Reanalisar com IA") ignora R1 e R3, mas nunca o R2. */
  readonly mode: AnalysisMode;
  readonly signals: DeterministicSignals;
  /** Já passado no `normalizeTitle`. */
  readonly titleHint: string | null;
  readonly criteria: UserCriteria;
}

export interface DeterministicAssessment {
  /** Fatos só da Camada 1 (FactResolver com `llmFacts = null`, ADR-011 D7). */
  readonly resolution: FactResolution;
  /** A nota desses fatos, com `llmExtracted = false`. O AnalyzeJob a reaproveita nos caminhos sem IA. */
  readonly score: ScoreResult;
}

export interface PreFilterDecision {
  readonly rule: PreFilterRule;
  readonly route: PreFilterRoute;
  readonly callsLlm: boolean;
  /** Aviso da própria rota (R2: possivel_prompt_injection; R3: decisao_sem_ia). */
  readonly warnings: readonly AnalysisWarning[];
  /** R1: as dimensões da Camada 1 com deal-breaker (só enum). Vazio nas outras regras. */
  readonly rejectedDimensions: readonly ScoreDimension[];
  /**
   * Todas as condições do R3 menos a flag (inclui a guarda de vacuidade). Com a flag desligada, mede quanto o
   * aceite pouparia em produção, para revisar a D-H3 com dado real.
   */
  readonly acceptEligible: boolean;
  readonly deterministic: DeterministicAssessment;
  readonly routerVersion: typeof PRE_FILTER_ROUTER_VERSION;
}

/** As dimensões que têm sinal na Camada 1. Red flags ficam fora: `salario_omitido` sem IA é ausência de evidência. */
const LAYER1_DIMENSIONS: ReadonlySet<ScoreDimension> = new Set<ScoreDimension>([
  "stack",
  "modelo_trabalho",
  "senioridade",
  "contrato",
  "salario",
]);

type Importance = UserCriteria["workModel"]["importance"];
const isMust = (importance: Importance | undefined): boolean =>
  importance?.level === "eliminatorio" || importance?.level === "obrigatorio";

/**
 * Guarda de vacuidade do R3 (S-4 §5.6): sem nenhum critério eliminatório ou obrigatório, "atende tudo" é
 * vazio, e o aceite sairia sem benefícios, idiomas e red flags. Deal-breaker de stack não conta: ausência não é
 * aderência.
 */
export function hasMustCriterion(criteria: UserCriteria): boolean {
  return (
    [
      criteria.workModel.importance,
      criteria.seniority.importance,
      criteria.contractType.importance,
      criteria.salary?.importance,
      criteria.location?.importance,
      criteria.languages?.importance,
      criteria.benefits?.importance,
    ].some(isMust) || criteria.stack.mustHave.length > 0
  );
}

export class PreFilterRouter {
  readonly #resolver: FactResolver;
  readonly #engine: ScoringEngine;
  readonly #policy: PreFilterRouterPolicy;

  constructor(deps: PreFilterRouterDeps) {
    this.#resolver = deps.resolver;
    this.#engine = deps.engine;
    this.#policy = deps.policy ?? DEFAULT_PRE_FILTER_ROUTER_POLICY;
  }

  route(input: PreFilterRoutingInput): PreFilterDecision {
    const { mode, signals, criteria } = input;
    const resolution = this.#resolver.resolve({
      llmFacts: null,
      llmOutputInjection: false,
      signals,
      titleHint: input.titleHint,
      // Sem LLM, a stack exigida são as menções explícitas e os termos marcados não têm uso (ADR-011 D7):
      // nenhum termo do perfil entra na fusão (minimização, LGPD).
      markedStackTerms: [],
    });
    const score = this.#engine.score({ facts: resolution.facts, provenance: resolution.provenance, llmExtracted: false }, criteria);
    const deterministic = { resolution, score };
    const base: Pick<PreFilterDecision, "deterministic" | "routerVersion" | "rejectedDimensions" | "acceptEligible"> = {
      deterministic,
      routerVersion: PRE_FILTER_ROUTER_VERSION,
      rejectedDimensions: [],
      acceptEligible: false,
    };
    const auto = mode === "auto";

    const rejected = score.breakdown.filter((d) => d.dealBreakerHit && LAYER1_DIMENSIONS.has(d.dimension)).map((d) => d.dimension);
    if (auto && rejected.length > 0) {
      return { ...base, rule: "R1", route: "curto_circuito_rejeicao", callsLlm: false, warnings: [], rejectedDimensions: rejected };
    }
    if (signals.injectionLevel === "alta") {
      return { ...base, rule: "R2", route: "somente_deterministico", callsLlm: false, warnings: ["possivel_prompt_injection"] };
    }
    const acceptEligible = auto && acceptConditionsHold(signals, criteria, score);
    if (acceptEligible && this.#policy.shortCircuitAccept) {
      return { ...base, acceptEligible, rule: "R3", route: "curto_circuito_aceite", callsLlm: false, warnings: ["decisao_sem_ia"] };
    }
    return { ...base, acceptEligible, rule: "R4", route: "semantica", callsLlm: true, warnings: [] };
  }
}

/** R3 sem a flag (ADR-016 D9): vacuidade, injection baixa, red flags toleradas, tudo atendido e nenhum deal-breaker. */
function acceptConditionsHold(signals: DeterministicSignals, criteria: UserCriteria, score: ScoreResult): boolean {
  if (!hasMustCriterion(criteria) || signals.injectionLevel !== "baixa") return false;
  // Red flag que penaliza ou elimina só o LLM vê: sem ele, o aceite seria às cegas.
  if (Object.values(criteria.redFlagTolerance).some((t) => t === "penalizar" || t === "eliminatorio")) return false;
  // Pelo menos uma dimensão estrita avaliada: localização obrigatória em vaga só remota "não se aplica" e não
  // pode, sozinha, furar a guarda de vacuidade.
  const strict = score.breakdown.filter((d) => d.importance === "eliminatorio" || d.importance === "obrigatorio");
  if (strict.length === 0 || !strict.every((d) => d.outcome === "atende")) return false;
  // Deal-breaker em QUALQUER menção, inclusive a fraca (negada, em diferencial, ambígua).
  const breakers = new Set(criteria.stack.dealBreakers.map((t) => t.toLowerCase()));
  return !signals.stackMentions.some((m) => breakers.has(m.term.toLowerCase()));
}
