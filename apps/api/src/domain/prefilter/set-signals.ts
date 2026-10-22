// Sinais de conjunto (ADR-001 §5.3; ADR-016 D4): modelo de trabalho, contrato e senioridade, com as regras
// provadas no S-4. Cada pista de linha é calculada uma vez por linha, e cada janela é limitada (SR-09).
import type { ContractType, SeniorityLevel, WorkModel } from "@trampo/contracts";
import type { SetSignal } from "../ports/deterministic-signals.js";
import { containsAny, findAll, itemAt, lineAt, perLine, textAfter, textBefore, tokens, type Line } from "./folding.js";
import type { MentionContext } from "./line-context.js";

interface Hit<T> {
  readonly value: T;
  readonly line: number;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

const WORK_MODEL_ALIASES: readonly (readonly [WorkModel, string])[] = [
  ["remoto", "remoto"], ["remoto", "remota"], ["remoto", "home office"], ["remoto", "home-office"],
  ["remoto", "remote"], ["remoto", "teletrabalho"], ["hibrido", "hibrido"], ["hibrido", "hibrida"],
  ["hibrido", "hybrid"], ["presencial", "presencial"], ["presencial", "presencialmente"],
  ["presencial", "on-site"], ["presencial", "onsite"], ["presencial", "in-office"],
];

/** "auxílio home office" é benefício, não modelo de trabalho. */
const BENEFIT_CUES: readonly string[] = ["auxilio", "ajuda de custo", "subsidio", "vale", "kit"];
const HOME_OFFICE_CUES: readonly string[] = ["home office", "home-office", "remoto"];
/** "entrevista presencial" é etapa do processo, não modelo de trabalho. */
const NON_MODEL_NEIGHBOURS: readonly string[] = [
  "entrevista", "entrevistas", "treinamento", "treinamentos", "encontro", "encontros", "evento", "eventos",
  "reuniao", "reunioes", "integracao", "onboarding", "visita", "visitas", "prova", "dinamica", "etapa",
];
const WORK_MODEL_NEGATORS: readonly string[] = ["nao", "not", "no", "sem"];
/** Disjunção explícita: as duas famílias continuam na linha do híbrido (S-4). */
const DISJUNCTIONS: readonly string[] = [
  "remoto ou hibrido", "hibrido ou remoto", "remota ou hibrida", "hibrida ou remota", "remote or hybrid",
  "hybrid or remote", "presencial ou hibrido", "hibrido ou presencial",
];

/** Dois tokens antes e um depois, na mesma linha. */
function neighbours(line: Line, pos: number, length: number): string[] {
  return [...tokens(textBefore(line, pos)).slice(-2), ...tokens(textAfter(line, pos + length)).slice(0, 1)];
}

export interface WorkModelDetection {
  readonly signal: SetSignal<WorkModel> | null;
  /** Alguma menção negada ("não é remoto"): rebaixa o sinal para fraco. */
  readonly negatedMention: boolean;
}

export function detectWorkModels(text: string, lines: readonly Line[], contexts: readonly MentionContext[]): WorkModelDetection {
  const benefitLine = perLine((t) => containsAny(t, BENEFIT_CUES) && containsAny(t, HOME_OFFICE_CUES));
  const disjunctionLine = perLine((t) => containsAny(t, DISJUNCTIONS));
  const hits: Hit<WorkModel>[] = [];
  let negatedMention = false;
  for (const [value, alias] of WORK_MODEL_ALIASES) {
    for (const pos of findAll(text, alias)) {
      const line = lineAt(lines, pos);
      // A seção de benefícios e a linha do auxílio home office falam de benefício (de nenhuma família).
      if (contexts[line.index] === "beneficio" || benefitLine(line)) continue;
      const near = neighbours(line, pos, alias.length);
      if (near.some((t) => NON_MODEL_NEIGHBOURS.includes(t))) continue;
      if (near.some((t) => WORK_MODEL_NEGATORS.includes(t))) {
        negatedMention = true;
        continue;
      }
      hits.push({ value, line: line.index });
    }
  }
  // Na linha que diz "híbrido", "presencial" e "remoto" descrevem os dias do híbrido.
  const hybridLines = new Set(
    hits.filter((h) => h.value === "hibrido" && !disjunctionLine(itemAt(lines, h.line))).map((h) => h.line),
  );
  const values = unique(hits.filter((h) => h.value === "hibrido" || !hybridLines.has(h.line)).map((h) => h.value));
  if (values.length === 0) return { signal: null, negatedMention };
  // ADR-001 §5.3: uma só família é explícita; famílias diferentes ou menção negada viram sinal fraco.
  const strength = values.length === 1 && !negatedMention ? "explicita" : "fraca";
  return { signal: { values, strength }, negatedMention };
}

const CONTRACT_ALIASES: readonly (readonly [ContractType, string])[] = [
  ["clt", "clt"], ["clt", "efetivo"], ["clt", "efetiva"], ["clt", "carteira assinada"],
  ["pj", "pj"], ["pj", "pessoa juridica"], ["estagio", "estagio"], ["estagio", "estagiario"],
  ["estagio", "estagiaria"], ["estagio", "internship"], ["temporario", "temporario"], ["temporario", "temporaria"],
  ["temporario", "prazo determinado"], ["cooperado", "cooperado"], ["cooperado", "cooperativa"],
];

/** "PJ" só é contrato com pista de contratação na linha (gupy-15: comunidade "PJ"; geekhunter-04: "Crédito PJ"). */
const CONTRACT_CUES: readonly string[] = ["contrat", "regime", "clt", "modalidade", "vinculo", "prestador", "prestacao de servico", "cnpj"];
const CONTRACT_NEGATORS: readonly string[] = ["sem", "nao", "nenhum", "nenhuma", "not", "no"];
const PJ_PRODUCT_CUES: readonly string[] = ["credito", "cliente", "clientes", "conta", "cheque", "produto", "produtos", "comunidade", "emprestimo"];

export function detectContractTypes(text: string, lines: readonly Line[]): SetSignal<ContractType> | null {
  const hiringLine = perLine((t) => CONTRACT_CUES.some((c) => t.includes(c)) && !containsAny(t, PJ_PRODUCT_CUES));
  const experienceLine = perLine((t) => t.includes("experiencia"));
  const hits: Hit<ContractType>[] = [];
  for (const [value, alias] of CONTRACT_ALIASES) {
    for (const pos of findAll(text, alias)) {
      const line = lineAt(lines, pos);
      if (value === "pj" && !hiringLine(line)) continue;
      // "exclusivamente PJ, sem possibilidade de CLT": contrato negado não conta.
      if (tokens(textBefore(line, pos)).slice(-3).some((t) => CONTRACT_NEGATORS.includes(t))) continue;
      // "1 ano de experiência (estágio conta)": estágio como experiência, não como contrato.
      if (value === "estagio" && experienceLine(line)) continue;
      hits.push({ value, line: line.index });
    }
  }
  const values = unique(hits.map((h) => h.value));
  if (values.length === 0) return null;
  // Valores diferentes que nunca aparecem todos juntos numa linha são suspeitos: fraco.
  return { values, strength: values.length === 1 || someLineHasAll(hits, values) ? "explicita" : "fraca" };
}

function someLineHasAll<T>(hits: readonly Hit<T>[], values: readonly T[]): boolean {
  const byLine = new Map<number, Set<T>>();
  for (const h of hits) byLine.set(h.line, (byLine.get(h.line) ?? new Set<T>()).add(h.value));
  return [...byLine.values()].some((set) => values.every((v) => set.has(v)));
}

const SENIORITY_ALIASES: readonly (readonly [SeniorityLevel, string])[] = [
  ["estagio", "estagio"], ["estagio", "estagiario"], ["estagio", "estagiaria"], ["estagio", "intern"],
  ["estagio", "internship"], ["junior", "junior"], ["junior", "jr"], ["pleno", "pleno"], ["pleno", "pl"],
  ["pleno", "mid-level"], ["pleno", "mid level"], ["senior", "senior"], ["senior", "sr"], ["especialista", "especialista"],
  ["especialista", "specialist"], ["lideranca", "coordenador"], ["lideranca", "coordenadora"], ["lideranca", "gerente"],
  ["lideranca", "head"], ["lideranca", "tech lead"], ["lideranca", "techlead"], ["lideranca", "lider"], ["lideranca", "lead"],
];

const SENIOR_ERP_WINDOW = 12;

function scanSeniority(hay: string): SeniorityLevel[] {
  const found: SeniorityLevel[] = [];
  for (const [value, alias] of SENIORITY_ALIASES) {
    for (const pos of findAll(hay, alias)) {
      // "PL/SQL" não é pleno.
      if (alias === "pl" && hay.startsWith("/sql", pos + alias.length)) continue;
      // "Senior" como ERP (linkedin-11) não é senioridade.
      if (value === "senior") {
        const around = hay.slice(Math.max(0, pos - SENIOR_ERP_WINDOW), pos + alias.length + SENIOR_ERP_WINDOW);
        if (around.includes("erp") || around.includes("senior sistemas")) continue;
      }
      found.push(value);
    }
  }
  return unique(found);
}

/** Senioridade: explícita só no título (ADR-001 §5.3); no corpo, fraca. */
export function detectSeniority(foldedTitle: string | null, text: string): SetSignal<SeniorityLevel> | null {
  const fromTitle = foldedTitle === null ? [] : scanSeniority(foldedTitle);
  if (fromTitle.length > 0) return { values: fromTitle, strength: "explicita" };
  const fromBody = scanSeniority(text);
  return fromBody.length > 0 ? { values: fromBody, strength: "fraca" } : null;
}
