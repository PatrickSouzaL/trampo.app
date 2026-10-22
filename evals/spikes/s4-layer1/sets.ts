// S-4: sinais de conjunto (ADR-001 §5.3): modelo de trabalho, contrato e senioridade.
import type { ContractType, SeniorityLevel, WorkModel } from "@trampo/contracts";
import type { SetSignal } from "../../../apps/api/src/domain/index.js";
import type { LineContext } from "./sections.js";
import { containsAny, findAll, lineAt, tokens, type Line } from "./text-tools.js";

interface Hit<T> {
  readonly value: T;
  readonly line: number;
}

const WORK_MODEL_ALIASES: readonly (readonly [WorkModel, string])[] = [
  ["remoto", "remoto"], ["remoto", "remota"], ["remoto", "home office"], ["remoto", "home-office"],
  ["remoto", "remote"], ["remoto", "teletrabalho"], ["hibrido", "hibrido"], ["hibrido", "hibrida"],
  ["hibrido", "hybrid"], ["presencial", "presencial"], ["presencial", "presencialmente"],
  ["presencial", "on-site"], ["presencial", "onsite"], ["presencial", "in-office"],
];

/** "auxílio home office" é benefício, não modelo de trabalho. */
const BENEFIT_CUES = ["auxilio", "ajuda de custo", "subsidio", "vale", "kit"];
/** "entrevista presencial" é etapa do processo, não modelo de trabalho. */
const NON_MODEL_NEIGHBOURS = [
  "entrevista", "entrevistas", "treinamento", "treinamentos", "encontro", "encontros", "evento", "eventos",
  "reuniao", "reunioes", "integracao", "onboarding", "visita", "visitas", "prova", "dinamica", "etapa",
];
const NEGATORS = ["nao", "not", "no", "sem"];
const DISJUNCTIONS = [
  "remoto ou hibrido", "hibrido ou remoto", "remota ou hibrida", "hibrida ou remota", "remote or hybrid",
  "hybrid or remote", "presencial ou hibrido", "hibrido ou presencial",
];

function neighbours(line: Line, pos: number, len: number): string[] {
  const rel = pos - line.start;
  const before = tokens(line.text.slice(0, rel)).slice(-2);
  const after = tokens(line.text.slice(rel + len)).slice(0, 1);
  return [...before, ...after];
}

export interface WorkModelResult {
  readonly signal: SetSignal<WorkModel> | null;
  readonly negatedMention: boolean;
}

export function detectWorkModels(text: string, lines: readonly Line[], contexts: readonly LineContext[]): WorkModelResult {
  const hits: Hit<WorkModel>[] = [];
  let negatedMention = false;
  for (const [value, alias] of WORK_MODEL_ALIASES) {
    for (const pos of findAll(text, alias)) {
      const line = lineAt(lines, pos);
      if (contexts[line.index]?.context === "beneficio") continue;
      const near = neighbours(line, pos, alias.length);
      // Linha sobre o auxílio home office fala de benefício, não de modelo (de nenhuma família).
      if (containsAny(line.text, BENEFIT_CUES) && containsAny(line.text, ["home office", "home-office", "remoto"])) continue;
      if (near.some((t) => NON_MODEL_NEIGHBOURS.includes(t))) continue;
      if (near.some((t) => NEGATORS.includes(t))) {
        negatedMention = true;
        continue;
      }
      hits.push({ value, line: line.index });
    }
  }
  // Na linha que diz "híbrido", "presencial" e "remoto" descrevem os dias do híbrido.
  // Exceção: disjunção explícita ("remoto ou híbrido") mantém as duas famílias.
  const hybridLines = new Set(
    hits.filter((h) => h.value === "hibrido" && !containsAny(lines[h.line]?.text ?? "", DISJUNCTIONS)).map((h) => h.line),
  );
  const kept = hits.filter((h) => h.value === "hibrido" || !hybridLines.has(h.line));
  const values = unique(kept.map((h) => h.value));
  if (values.length === 0) return { signal: null, negatedMention };
  // ADR-001 §5.3: uma só família é explícita; famílias diferentes viram sinal fraco.
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
const CONTRACT_CUES = ["contrat", "regime", "clt", "modalidade", "vinculo", "prestador", "prestacao de servico", "cnpj"];
const CONTRACT_NEGATORS = ["sem", "nao", "nenhum", "nenhuma", "not", "no"];
const PJ_PRODUCT_CUES = ["credito", "cliente", "clientes", "conta", "cheque", "produto", "produtos", "comunidade", "emprestimo"];

export function detectContractTypes(text: string, lines: readonly Line[]): SetSignal<ContractType> | null {
  const hits: Hit<ContractType>[] = [];
  for (const [value, alias] of CONTRACT_ALIASES) {
    for (const pos of findAll(text, alias)) {
      const line = lineAt(lines, pos);
      if (value === "pj") {
        const cue = CONTRACT_CUES.some((c) => line.text.includes(c));
        if (!cue || containsAny(line.text, PJ_PRODUCT_CUES)) continue;
      }
      // "exclusivamente PJ, sem possibilidade de CLT": contrato negado não conta.
      const before = tokens(line.text.slice(0, pos - line.start)).slice(-3);
      if (before.some((t) => CONTRACT_NEGATORS.includes(t))) continue;
      // "1 ano de experiência (estágio conta)": estágio como experiência, não como contrato.
      if (value === "estagio" && line.text.includes("experiencia")) continue;
      hits.push({ value, line: line.index });
    }
  }
  const values = unique(hits.map((h) => h.value));
  if (values.length === 0) return null;
  // Valores diferentes em linhas diferentes (e nunca juntos numa linha) são suspeitos: fraco.
  const together = new Set(hits.map((h) => h.line)).size === 1 || lineWithAll(hits, values);
  return { values, strength: values.length === 1 || together ? "explicita" : "fraca" };
}

function lineWithAll<T>(hits: readonly Hit<T>[], values: readonly T[]): boolean {
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

/** Senioridade: explícita só no título (ADR-001 §5.3); no corpo, fraca. "Senior" como ERP não conta. */
export function detectSeniority(foldedTitle: string | null, text: string): SetSignal<SeniorityLevel> | null {
  const scan = (hay: string): SeniorityLevel[] => {
    const found: SeniorityLevel[] = [];
    for (const [value, alias] of SENIORITY_ALIASES) {
      for (const pos of findAll(hay, alias)) {
        if (alias === "pl" && hay.startsWith("/sql", pos + 2)) continue;
        if (value === "senior") {
          const around = hay.slice(Math.max(0, pos - 12), pos + alias.length + 12);
          if (around.includes("erp") || around.includes("senior sistemas")) continue;
        }
        found.push(value);
      }
    }
    return unique(found);
  };
  if (foldedTitle !== null) {
    const fromTitle = scan(foldedTitle);
    if (fromTitle.length > 0) return { values: fromTitle, strength: "explicita" };
  }
  const fromBody = scan(text);
  return fromBody.length > 0 ? { values: fromBody, strength: "fraca" } : null;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
