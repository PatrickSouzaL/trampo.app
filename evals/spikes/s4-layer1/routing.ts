// S-4: tabela de roteamento R1–R4 (ADR-001 §5.3) sobre os sinais, e o mesmo julgamento sobre o
// GABARITO (oráculo), para medir falso positivo de rejeição e precisão do aceite.
import type { ContractType, ResolvedJobFacts, SalaryPeriod, SeniorityLevel, WorkModel } from "@trampo/contracts";
import type { DeterministicSignals, SalarySignal, SetSignal } from "../../../apps/api/src/domain/index.js";
import { dictionaryAliases } from "./tech-dictionary.js";
import { fold } from "./text-tools.js";

export type Level = "eliminatorio" | "obrigatorio" | "ponderado" | "ignorar";

export interface Persona {
  readonly id: string;
  readonly workModel: { readonly accepted: readonly WorkModel[]; readonly level: Level };
  readonly seniority: { readonly accepted: readonly SeniorityLevel[]; readonly level: Level };
  readonly contract: { readonly accepted: readonly ContractType[]; readonly level: Level };
  /** BRL por mês (o critério do usuário também passa pela tabela; aqui já está na base). */
  readonly salary: { readonly minimumBrlMonth: number; readonly level: Level } | null;
  readonly stack: {
    readonly mustHave: readonly string[];
    readonly dealBreakers: readonly string[];
    readonly scope: "somente_obrigatoria" | "qualquer_mencao";
  };
  /** Dimensões sem sinal na Camada 1 (localização, idiomas, benefícios) marcadas como obrigatórias. */
  readonly otherMustDimensions: number;
}

const SENIORITY_RANK: Readonly<Record<SeniorityLevel, number>> = {
  estagio: 0, junior: 1, pleno: 2, senior: 3, especialista: 4, lideranca: 4,
};

/** ADR-002 §4.2.3 (`se1`, HITL-016 e HITL-018). */
export const FX_TO_BRL: Readonly<Record<"BRL" | "USD" | "EUR" | "ARS", number>> = { BRL: 1, USD: 5.5, EUR: 6.0, ARS: 0.0034 };
const PERIOD_TO_MONTH: Readonly<Record<SalaryPeriod, number>> = { mes: 1, hora: 220, ano: 1 / 12 };

const ALIAS_TO_CANONICAL = new Map(dictionaryAliases().map((a) => [a.alias, a.canonical.toLowerCase()]));
/** Equivalência de grafia (o runner da spec compara "sem diferenciar maiúsculas e com aliases"). */
export function termKey(term: string): string {
  const f = fold(term).text.trim();
  return ALIAS_TO_CANONICAL.get(f) ?? f;
}

export interface GoldSalary {
  readonly min: number | null;
  readonly max: number | null;
  readonly currency: "BRL" | "USD" | "EUR" | "ARS" | null;
  readonly period: SalaryPeriod | null;
}

/** [lo, hi] em BRL por mês, ou null quando não comparável (moeda nula em vaga estrangeira, ADR-002 §4.2.3). */
export function salaryRangeBrl(s: GoldSalary, international: boolean): [number, number] | null {
  const lo0 = s.min ?? s.max;
  const hi0 = s.max ?? s.min;
  if (lo0 === null || hi0 === null) return null;
  if (s.currency === null && international) return null;
  const fx = FX_TO_BRL[s.currency ?? "BRL"];
  const per = PERIOD_TO_MONTH[s.period ?? "mes"];
  return [lo0 * fx * per, hi0 * fx * per];
}

// ---------- violação de dimensão eliminatória ----------

function setViolates<T extends string>(values: readonly T[], accepted: readonly T[]): boolean {
  return values.length > 0 && values.every((v) => !accepted.includes(v));
}

function seniorityViolates(values: readonly SeniorityLevel[], accepted: readonly SeniorityLevel[]): boolean {
  if (!setViolates(values, accepted)) return false;
  // D-S5: um nível acima é parcial, nunca deal-breaker.
  const maxAccepted = Math.max(...accepted.map((a) => SENIORITY_RANK[a]));
  return !values.some((v) => SENIORITY_RANK[v] === maxAccepted + 1);
}

export type Dimension = "workModel" | "seniority" | "contract" | "salary" | "stack";

/** R1 pelos sinais: dimensões eliminatórias violadas por sinal EXPLÍCITO. */
export function r1Dimensions(p: Persona, s: DeterministicSignals): Dimension[] {
  const out: Dimension[] = [];
  const explicit = <T extends string>(sig: SetSignal<T> | null): readonly T[] | null =>
    sig !== null && sig.strength === "explicita" ? sig.values : null;
  const wm = explicit(s.workModels);
  if (p.workModel.level === "eliminatorio" && wm !== null && setViolates(wm, p.workModel.accepted)) out.push("workModel");
  const sn = explicit(s.seniorityLevels);
  if (p.seniority.level === "eliminatorio" && sn !== null && seniorityViolates(sn, p.seniority.accepted)) out.push("seniority");
  const ct = explicit(s.contractTypes);
  if (p.contract.level === "eliminatorio" && ct !== null && setViolates(ct, p.contract.accepted)) out.push("contract");
  if (p.salary?.level === "eliminatorio" && s.salary?.strength === "explicita") {
    const range = salaryRangeBrl(s.salary.value, false);
    if (range !== null && range[1] < p.salary.minimumBrlMonth) out.push("salary");
  }
  const breakers = new Set(p.stack.dealBreakers.map(termKey));
  if (s.stackMentions.some((m) => m.strength === "explicita" && breakers.has(termKey(m.term)))) out.push("stack");
  return out;
}

// ---------- oráculo sobre o gabarito ----------

export interface GoldView {
  readonly expected: ResolvedJobFacts;
  readonly alternatives: Readonly<Record<string, readonly unknown[]>>;
  readonly arsSalary: GoldSalary | null;
}

function international(f: ResolvedJobFacts, ars: boolean): boolean {
  const country = f.location?.countryIso2 ?? null;
  return ars || (country !== null && country !== "BR") || (f.salary?.currency !== null && f.salary?.currency !== undefined && f.salary.currency !== "BRL");
}

/** Variantes do gabarito: o `expected` e cada alternativa de campo (golden-dataset-spec §5.2). */
function variants(g: GoldView): ResolvedJobFacts[] {
  const out = [g.expected];
  for (const [field, values] of Object.entries(g.alternatives)) {
    for (const v of values) out.push({ ...g.expected, [field]: v } as ResolvedJobFacts);
  }
  return out;
}

function goldSalary(f: ResolvedJobFacts, g: GoldView): GoldSalary | null {
  return f.salary ?? g.arsSalary;
}

function goldViolates(p: Persona, f: ResolvedJobFacts, g: GoldView, d: Dimension): boolean {
  switch (d) {
    case "workModel":
      return setViolates(f.workModels, p.workModel.accepted);
    case "seniority":
      return seniorityViolates(f.seniorityLevels, p.seniority.accepted);
    case "contract":
      return setViolates(f.contractTypes, p.contract.accepted);
    case "salary": {
      const s = goldSalary(f, g);
      if (s === null || p.salary === null) return false;
      const range = salaryRangeBrl(s, international(f, g.arsSalary !== null));
      return range !== null && range[1] < p.salary.minimumBrlMonth;
    }
    case "stack": {
      const breakers = new Set(p.stack.dealBreakers.map(termKey));
      const pool = p.stack.scope === "somente_obrigatoria" ? f.stackRequired : [...f.stackRequired, ...f.stackNiceToHave];
      return pool.some((t) => breakers.has(termKey(t)));
    }
  }
}

/** Uma rejeição é falso positivo se NENHUMA variante do gabarito viola aquela dimensão. */
export function falseRejection(p: Persona, g: GoldView, d: Dimension): boolean {
  return !variants(g).some((f) => goldViolates(p, f, g, d));
}

// ---------- R3 (aceite) ----------

const isMust = (l: Level): boolean => l === "eliminatorio" || l === "obrigatorio";

export function mustCriteriaCount(p: Persona): number {
  return [p.workModel.level, p.seniority.level, p.contract.level, p.salary?.level ?? "ignorar"].filter(isMust).length +
    (p.stack.mustHave.length > 0 ? 1 : 0) + p.otherMustDimensions;
}

/** R3 como escrito no ADR-001 §5.3: todos os eliminatórios e obrigatórios atendidos por sinal explícito. */
export function r3Fires(p: Persona, s: DeterministicSignals): boolean {
  if (s.injectionLevel !== "baixa" || p.otherMustDimensions > 0) return false;
  const subset = <T extends string>(sig: SetSignal<T> | null, accepted: readonly T[]): boolean =>
    sig !== null && sig.strength === "explicita" && sig.values.every((v) => accepted.includes(v));
  if (isMust(p.workModel.level) && !subset(s.workModels, p.workModel.accepted)) return false;
  if (isMust(p.seniority.level) && !subset(s.seniorityLevels, p.seniority.accepted)) return false;
  if (isMust(p.contract.level) && !subset(s.contractTypes, p.contract.accepted)) return false;
  if (p.salary !== null && isMust(p.salary.level) && !salaryMeets(s.salary, p.salary.minimumBrlMonth)) return false;
  const explicitTerms = new Set(s.stackMentions.filter((m) => m.strength === "explicita").map((m) => termKey(m.term)));
  const anyTerms = new Set(s.stackMentions.map((m) => termKey(m.term)));
  if (!p.stack.mustHave.every((t) => explicitTerms.has(termKey(t)))) return false;
  return !p.stack.dealBreakers.some((t) => anyTerms.has(termKey(t)));
}

function salaryMeets(sig: SalarySignal | null, minimum: number): boolean {
  if (sig === null || sig.strength !== "explicita") return false;
  const range = salaryRangeBrl(sig.value, false);
  return range !== null && range[0] >= minimum;
}

/** O aceite estava certo? `strict` exige também zero red flag no gabarito (o LLM os teria visto). */
export function acceptCorrect(p: Persona, g: GoldView, strict: boolean): boolean {
  return variants(g).some((f) => {
    const sub = <T extends string>(values: readonly T[], accepted: readonly T[]): boolean =>
      values.length > 0 && values.every((v) => accepted.includes(v));
    if (isMust(p.workModel.level) && !sub(f.workModels, p.workModel.accepted)) return false;
    if (isMust(p.seniority.level) && !sub(f.seniorityLevels, p.seniority.accepted)) return false;
    if (isMust(p.contract.level) && !sub(f.contractTypes, p.contract.accepted)) return false;
    if (p.salary !== null && isMust(p.salary.level)) {
      const s = goldSalary(f, g);
      const range = s === null ? null : salaryRangeBrl(s, international(f, g.arsSalary !== null));
      if (range === null || range[0] < p.salary.minimumBrlMonth) return false;
    }
    const union = new Set([...f.stackRequired, ...f.stackNiceToHave].map(termKey));
    if (!p.stack.mustHave.every((t) => union.has(termKey(t)))) return false;
    const pool = p.stack.scope === "somente_obrigatoria" ? f.stackRequired : [...f.stackRequired, ...f.stackNiceToHave];
    if (pool.some((t) => p.stack.dealBreakers.map(termKey).includes(termKey(t)))) return false;
    return !strict || f.redFlagSignals.length === 0;
  });
}

// ---------- painel de personas (fixo, sem dado real de ninguém) ----------

export const PERSONAS: readonly Persona[] = [
  {
    id: "p1-backend-java", otherMustDimensions: 0,
    workModel: { accepted: ["remoto"], level: "eliminatorio" },
    seniority: { accepted: ["pleno", "senior"], level: "obrigatorio" },
    contract: { accepted: ["clt"], level: "ponderado" },
    salary: { minimumBrlMonth: 8000, level: "eliminatorio" },
    stack: { mustHave: ["Java", "Spring Boot"], dealBreakers: ["PHP"], scope: "somente_obrigatoria" },
  },
  {
    id: "p2-frontend-react", otherMustDimensions: 0,
    workModel: { accepted: ["remoto", "hibrido"], level: "eliminatorio" },
    seniority: { accepted: ["junior", "pleno"], level: "eliminatorio" },
    contract: { accepted: ["clt", "pj"], level: "obrigatorio" },
    salary: { minimumBrlMonth: 5000, level: "ponderado" },
    stack: { mustHave: ["React", "TypeScript"], dealBreakers: ["Angular"], scope: "qualquer_mencao" },
  },
  {
    id: "p3-dados-senior-pj", otherMustDimensions: 0,
    workModel: { accepted: ["remoto"], level: "obrigatorio" },
    seniority: { accepted: ["senior"], level: "eliminatorio" },
    contract: { accepted: ["pj"], level: "eliminatorio" },
    salary: { minimumBrlMonth: 12000, level: "eliminatorio" },
    stack: { mustHave: ["Python", "SQL"], dealBreakers: ["Java"], scope: "somente_obrigatoria" },
  },
  {
    id: "p4-estagio", otherMustDimensions: 0,
    workModel: { accepted: ["hibrido", "presencial"], level: "ponderado" },
    seniority: { accepted: ["estagio"], level: "eliminatorio" },
    contract: { accepted: ["estagio"], level: "eliminatorio" },
    salary: null,
    stack: { mustHave: [], dealBreakers: [], scope: "somente_obrigatoria" },
  },
  {
    id: "p5-devops-clt", otherMustDimensions: 0,
    workModel: { accepted: ["remoto"], level: "eliminatorio" },
    seniority: { accepted: ["senior", "especialista"], level: "obrigatorio" },
    contract: { accepted: ["clt"], level: "eliminatorio" },
    salary: { minimumBrlMonth: 15000, level: "obrigatorio" },
    stack: { mustHave: ["AWS", "Kubernetes", "Terraform"], dealBreakers: ["Windows Server"], scope: "somente_obrigatoria" },
  },
  {
    id: "p6-lideranca", otherMustDimensions: 0,
    workModel: { accepted: ["remoto", "hibrido", "presencial"], level: "ignorar" },
    seniority: { accepted: ["lideranca"], level: "eliminatorio" },
    contract: { accepted: ["clt"], level: "obrigatorio" },
    salary: { minimumBrlMonth: 20000, level: "eliminatorio" },
    stack: { mustHave: [], dealBreakers: [], scope: "somente_obrigatoria" },
  },
  {
    id: "p7-engenharia-presencial", otherMustDimensions: 1,
    workModel: { accepted: ["presencial", "hibrido"], level: "eliminatorio" },
    seniority: { accepted: ["pleno"], level: "obrigatorio" },
    contract: { accepted: ["clt"], level: "ponderado" },
    salary: { minimumBrlMonth: 6000, level: "ponderado" },
    stack: { mustHave: ["AutoCAD"], dealBreakers: [], scope: "somente_obrigatoria" },
  },
  {
    id: "p8-so-ponderado", otherMustDimensions: 0,
    workModel: { accepted: ["remoto"], level: "ponderado" },
    seniority: { accepted: ["pleno"], level: "ponderado" },
    contract: { accepted: ["clt"], level: "ponderado" },
    salary: { minimumBrlMonth: 7000, level: "ponderado" },
    stack: { mustHave: [], dealBreakers: ["PHP", "Delphi"], scope: "qualquer_mencao" },
  },
];
