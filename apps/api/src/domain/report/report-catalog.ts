// Catálogo de templates pt-BR do ReportComposer (ADR-012 D3). Só texto fixo e rótulos de enum: nenhum valor do
// perfil (SR-11) e nenhuma string livre dos fatos (título, cidade, tags de stack). O texto final sai por
// concatenação destes pedaços, sem placeholder; o construtor do composer valida o catálogo (D6).
import type {
  AnalysisWarning,
  ContractType,
  Currency,
  DimensionOutcome,
  RedFlagSignal,
  ScoreDimension,
  SeniorityLevel,
  Verdict,
  WorkModel,
} from "@trampo/contracts";

import type { RedFlagEffect, ScoreReasonCode } from "../scoring/scoring-engine.js";
import { CURRENCIES, RED_FLAG_SIGNALS, SCORE_DIMENSIONS, SENIORITY_LEVELS } from "../scoring/scoring-policy.js";
import { countCodePoints } from "../text/code-points.js";

export const REPORT_CATALOG_VERSION = "rc1";

/** Os 14 códigos de `reason` que não são um `DimensionOutcome` (ADR-002 §4.3). */
export type SpecificReasonCode = Exclude<ScoreReasonCode, DimensionOutcome>;

/** Limites do contrato (`ReportItem.text`, `explanation`, `summary`). */
export const ITEM_TEXT_MAX = 140;
export const EXPLANATION_MAX = 160;
export const SUMMARY_MAX = 200;

/** Quantas dimensões cada parte do `summary` lista (ADR-012 D4). */
export const SUMMARY_FAVOR_MAX = 2;
export const SUMMARY_AGAINST_MAX = 2;
export const SUMMARY_ELIMINATED_MAX = 3;

export interface ReportCatalog {
  readonly version: string;
  readonly dimensions: Readonly<Record<ScoreDimension, string>>;
  readonly outcomes: Readonly<Record<DimensionOutcome, string>>;
  readonly reasons: Readonly<Record<SpecificReasonCode, string>>;
  readonly verdicts: Readonly<Record<Verdict, string>>;
  readonly dealBreakerVerdict: string;
  readonly emptyBaseNote: string;
  readonly scoreLabel: string;
  readonly inFavor: string;
  readonly against: string;
  readonly eliminatedBy: string;
  readonly jobValues: string;
  readonly jobCurrency: string;
  readonly workModels: Readonly<Record<WorkModel, string>>;
  readonly seniorityLevels: Readonly<Record<SeniorityLevel, string>>;
  readonly contractTypes: Readonly<Record<ContractType, string>>;
  readonly currencies: Readonly<Record<Currency, string>>;
  readonly redFlags: Readonly<Record<RedFlagSignal, string>>;
  readonly redFlagEffects: Readonly<Record<RedFlagEffect, string>>;
}

// Listas de enum do domínio, na ordem do contrato (um teste compara cada uma com `Schema.options`).
export const DIMENSION_OUTCOMES: readonly DimensionOutcome[] = Object.freeze([
  "atende",
  "atende_parcialmente",
  "nao_atende",
  "nao_informado",
  "conflito",
  "ignorado",
]);
export const VERDICTS: readonly Verdict[] = Object.freeze(["altamente_recomendado", "recomendado", "neutro", "baixo_alinhamento", "foge"]);
export const WORK_MODELS: readonly WorkModel[] = Object.freeze(["remoto", "hibrido", "presencial"]);
export const CONTRACT_TYPES: readonly ContractType[] = Object.freeze(["clt", "pj", "cooperado", "estagio", "temporario"]);
export const ANALYSIS_WARNINGS: readonly AnalysisWarning[] = Object.freeze([
  "possivel_prompt_injection",
  "informacao_contraditoria",
  "baixa_confianca_extracao",
  "texto_truncado",
  "analise_degradada",
  "decisao_sem_ia",
]);
export const RED_FLAG_EFFECTS: readonly RedFlagEffect[] = Object.freeze(["eliminatoria", "penalidade", "alerta"]);

/** `Record` com `true` obriga a completude na compilação; as chaves viram a lista de runtime. */
const SPECIFIC_REASON_KEYS: Readonly<Record<SpecificReasonCode, true>> = {
  deal_breaker_stack_exigida: true,
  deal_breaker_stack_desejavel: true,
  deal_breaker_red_flag: true,
  conflito_eliminatorio: true,
  localizacao_nao_se_aplica: true,
  idioma_nao_exigido: true,
  stack_nao_informada: true,
  salario_convertido: true,
  salario_moeda_indeterminada: true,
  senioridade_adjacente_acima: true,
  senioridade_adjacente_validada: true,
  senioridade_rebaixamento: true,
  idioma_ingles_internacional: true,
  red_flag_atenuada_por_beneficios: true,
};
export const SPECIFIC_REASON_CODES: readonly SpecificReasonCode[] = Object.freeze(Object.keys(SPECIFIC_REASON_KEYS) as SpecificReasonCode[]);

/** Tamanho máximo de cada lista de fatos no contrato (`jobFactsShape`): o pior caso do detalhe (ADR-012 D6). */
export const MAX_LISTED_FACTS = Object.freeze({ workModels: 3, seniorityLevels: 3, contractTypes: 5 });

export const DEFAULT_REPORT_CATALOG: ReportCatalog = Object.freeze({
  version: REPORT_CATALOG_VERSION,
  dimensions: Object.freeze({
    stack: "Stack",
    modelo_trabalho: "Modelo de trabalho",
    senioridade: "Senioridade",
    contrato: "Contrato",
    salario: "Salário",
    localizacao: "Localização",
    idiomas: "Idiomas",
    beneficios: "Benefícios",
    red_flags: "Sinais de alerta",
  }),
  outcomes: Object.freeze({
    atende: "dentro do que você procura.",
    atende_parcialmente: "atende só em parte.",
    nao_atende: "fora do que você aceita.",
    nao_informado: "sem informação na vaga.",
    conflito: "a vaga se contradiz neste ponto.",
    ignorado: "fora do cálculo da nota.",
  }),
  reasons: Object.freeze({
    deal_breaker_stack_exigida: "A vaga exige uma tecnologia que você evita.",
    deal_breaker_stack_desejavel: "A vaga cita como diferencial uma tecnologia que você evita.",
    deal_breaker_red_flag: "Há um sinal de alerta que você marcou como eliminatório.",
    conflito_eliminatorio: "Num critério eliminatório, isso pesa contra a nota.",
    localizacao_nao_se_aplica: "Não se aplica a vaga só remota.",
    idioma_nao_exigido: "A vaga não exige idioma.",
    stack_nao_informada: "A vaga não lista tecnologias.",
    salario_convertido: "Comparado por câmbio de tabela.",
    salario_moeda_indeterminada: "Vaga do exterior sem moeda informada.",
    senioridade_adjacente_acima: "Nível um degrau acima do que você aceita.",
    senioridade_adjacente_validada: "Nível um degrau acima, compensado pela sua stack.",
    senioridade_rebaixamento: "Nível abaixo de tudo o que você aceita.",
    idioma_ingles_internacional: "Inglês avaliado com rigor por ser vaga do exterior.",
    red_flag_atenuada_por_beneficios: "Sinais de cultura atenuados pelos benefícios.",
  }),
  verdicts: Object.freeze({
    altamente_recomendado: "Altamente recomendado: a vaga atende a quase tudo o que você procura.",
    recomendado: "Recomendado: a vaga atende à maior parte do que você procura.",
    neutro: "Neutro (oportunidade): a vaga atende em parte; vale ler os detalhes.",
    baixo_alinhamento: "Baixo alinhamento: a vaga atende pouco do que você procura.",
    foge: "Foge: a nota ficou muito baixa.",
  }),
  dealBreakerVerdict: "Foge: a vaga tem um deal-breaker para você.",
  emptyBaseNote: "Nenhum critério seu entrou na média.",
  scoreLabel: "Nota",
  inFavor: "A favor",
  against: "Contra",
  eliminatedBy: "Eliminada por",
  jobValues: "Na vaga",
  jobCurrency: "Moeda da vaga",
  workModels: Object.freeze({ remoto: "remoto", hibrido: "híbrido", presencial: "presencial" }),
  seniorityLevels: Object.freeze({
    estagio: "estágio",
    junior: "júnior",
    pleno: "pleno",
    senior: "sênior",
    especialista: "especialista",
    lideranca: "liderança",
  }),
  contractTypes: Object.freeze({ clt: "CLT", pj: "PJ", cooperado: "cooperado", estagio: "estágio", temporario: "temporário" }),
  currencies: Object.freeze({ BRL: "real (BRL)", USD: "dólar (USD)", EUR: "euro (EUR)", ARS: "peso argentino (ARS)" }),
  redFlags: Object.freeze({
    salario_omitido: "salário omitido",
    escopo_excessivo: "escopo excessivo",
    sobreaviso_nao_remunerado: "sobreaviso sem remuneração",
    teste_tecnico_longo: "teste técnico longo",
    multiplas_funcoes: "acúmulo de funções",
    linguagem_vaga: "descrição vaga",
    pressao_excessiva: "pressão excessiva",
  }),
  redFlagEffects: Object.freeze({ eliminatoria: "eliminatório para você", penalidade: "pesa contra a nota", alerta: "só alerta" }),
});

// ---------- validação (ADR-012 D6) ----------

/**
 * Lista fechada de caracteres: letras ASCII, letras acentuadas do português, dígitos, espaço e `. , ; : ( ) -`.
 * Sem `/`, `@`, `[`, `]`, `<` e `>`: `://`, `dominio.tld/`, e-mail, link markdown e HTML ficam impossíveis por
 * construção, assim como invisíveis e controles. O resto do `safeText` (`www.`, domínio nu) é provado nos testes.
 */
const EXTRA_CHARACTERS: ReadonlySet<string> = new Set([..."áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ", ..." .,;:()-"]);

const isAsciiAlphanumeric = (ch: string): boolean => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9");

function textIssue(path: string, text: unknown): string | null {
  if (typeof text !== "string" || text.length === 0) return `${path} vazio`;
  if (text[0] === " " || text[text.length - 1] === " ") return `${path} com espaço nas pontas`;
  let previous = "";
  for (const ch of text) {
    if (!isAsciiAlphanumeric(ch) && !EXTRA_CHARACTERS.has(ch)) return `${path} com caractere fora da lista fechada`;
    if (ch === " " && previous === " ") return `${path} com espaço duplo`;
    previous = ch;
  }
  return null;
}

/** O formato do `VersionTagSchema` (`^[a-z0-9][a-z0-9.-]{0,31}$`), por laço e sem regex. */
function isVersionTag(version: unknown): boolean {
  if (typeof version !== "string" || version.length === 0 || version.length > 32) return false;
  return [...version].every((ch, i) => (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || (i > 0 && (ch === "." || ch === "-")));
}

/** Os textos de uma tabela, na ordem das chaves do enum; chave ausente vira `undefined` e cai no `textIssue`. */
const entries = (name: string, keys: readonly string[], table: object): (readonly [string, unknown])[] =>
  keys.map((key) => [`${name}.${key}`, (table as Readonly<Record<string, unknown>>)[key]] as const);

const length = (text: string): number => countCodePoints(text);
const longest = (texts: readonly string[]): number => Math.max(...texts.map(length));

/** Soma dos `k` maiores rótulos. */
const topSum = (labels: readonly string[], k: number): number =>
  labels
    .map(length)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((acc, size) => acc + size, 0);

/** Pior caso de uma lista "a, b, c" de `k` rótulos distintos (k ≤ tamanho do enum). */
const listBound = (labels: readonly string[], k: number): number => topSum(labels, k) + 2 * (k - 1);

/** Limites no pior caso (ADR-012 D6), espelhando a composição do `ReportComposer` (D4). */
function boundIssues(c: ReportCatalog): string[] {
  const issues: string[] = [];
  const dimensionLabels = SCORE_DIMENSIONS.map((d) => c.dimensions[d]);
  const lineTail = 2 + longest(Object.values(c.outcomes)) + 1 + longest(Object.values(c.reasons));
  const listDetail = (labels: readonly string[], k: number): number => 1 + length(c.jobValues) + 2 + listBound(labels, k) + 1;
  const detail: Readonly<Partial<Record<ScoreDimension, number>>> = {
    modelo_trabalho: listDetail(Object.values(c.workModels), MAX_LISTED_FACTS.workModels),
    senioridade: listDetail(Object.values(c.seniorityLevels), MAX_LISTED_FACTS.seniorityLevels),
    contrato: listDetail(Object.values(c.contractTypes), MAX_LISTED_FACTS.contractTypes),
    salario: 1 + length(c.jobCurrency) + 2 + longest(Object.values(c.currencies)) + 1,
  };
  for (const dimension of SCORE_DIMENSIONS) {
    const line = length(c.dimensions[dimension]) + lineTail;
    if (line > ITEM_TEXT_MAX) issues.push(`linha de ${dimension} pode passar de ${ITEM_TEXT_MAX}`);
    if (line + (detail[dimension] ?? 0) > EXPLANATION_MAX) issues.push(`explanation de ${dimension} pode passar de ${EXPLANATION_MAX}`);
  }
  const signalItem = length(c.dimensions.red_flags) + 2 + longest(Object.values(c.redFlags)) + 2 + longest(Object.values(c.redFlagEffects)) + 1;
  if (signalItem > ITEM_TEXT_MAX) issues.push(`item de sinal pode passar de ${ITEM_TEXT_MAX}`);

  // "<faixa> Nota 100." e as partes " <rótulo>: a, b."; "A favor" e a nota da base neutra nunca aparecem juntas, e
  // "A favor" e "Contra" nunca repetem dimensão (D4): as duas listas juntas usam os 4 maiores rótulos distintos.
  const head = (verdict: number): number => verdict + 1 + length(c.scoreLabel) + 1 + 3 + 1;
  const frame = (label: string): number => 1 + length(label) + 2 + 1;
  const banded = head(longest(Object.values(c.verdicts)));
  const favorAndAgainst =
    frame(c.inFavor) + frame(c.against) + topSum(dimensionLabels, SUMMARY_FAVOR_MAX + SUMMARY_AGAINST_MAX) + 2 * (SUMMARY_FAVOR_MAX - 1) + 2 * (SUMMARY_AGAINST_MAX - 1);
  const summary = Math.max(
    banded + favorAndAgainst,
    banded + 1 + length(c.emptyBaseNote) + frame(c.against) + listBound(dimensionLabels, SUMMARY_AGAINST_MAX),
    head(length(c.dealBreakerVerdict)) + frame(c.eliminatedBy) + listBound(dimensionLabels, SUMMARY_ELIMINATED_MAX),
  );
  if (summary > SUMMARY_MAX) issues.push(`summary pode passar de ${SUMMARY_MAX}`);
  return issues;
}

/** Regras do ADR-012 D6 que o catálogo viola (vazio = coerente). O construtor do composer lança `RangeError`. */
export function reportCatalogIssues(c: ReportCatalog): string[] {
  const issues: string[] = [];
  if (!isVersionTag(c.version)) issues.push("version fora do formato VersionTag");
  const texts = [
    ...entries("dimensions", SCORE_DIMENSIONS, c.dimensions),
    ...entries("outcomes", DIMENSION_OUTCOMES, c.outcomes),
    ...entries("reasons", SPECIFIC_REASON_CODES, c.reasons),
    ...entries("verdicts", VERDICTS, c.verdicts),
    ...entries("workModels", WORK_MODELS, c.workModels),
    ...entries("seniorityLevels", SENIORITY_LEVELS, c.seniorityLevels),
    ...entries("contractTypes", CONTRACT_TYPES, c.contractTypes),
    ...entries("currencies", CURRENCIES, c.currencies),
    ...entries("redFlags", RED_FLAG_SIGNALS, c.redFlags),
    ...entries("redFlagEffects", RED_FLAG_EFFECTS, c.redFlagEffects),
    ...(["dealBreakerVerdict", "emptyBaseNote", "scoreLabel", "inFavor", "against", "eliminatedBy", "jobValues", "jobCurrency"] as const).map(
      (key) => [key, c[key]] as const,
    ),
  ];
  for (const [path, text] of texts) {
    const issue = textIssue(path, text);
    if (issue !== null) issues.push(issue);
  }
  // Os limites só fazem sentido sobre textos válidos (um texto ausente quebraria a conta).
  return issues.length > 0 ? issues : boundIssues(c);
}
