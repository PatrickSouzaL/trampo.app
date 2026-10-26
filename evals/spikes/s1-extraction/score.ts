// S-1: pontuação por campo contra o gabarito (golden-dataset-spec §8.1 e §8.2, `gd1` e `gd2`), com `alternatives` contando como
// certo. Stack sem diferenciar maiúsculas e com os aliases do TechDictionary `td1`; cidade pela dobra do ADR-002 §4.1.
import type { JobFacts, ResolvedJobFacts } from "@trampo/contracts";
import { foldCity } from "../../../apps/api/src/domain/index.js";
import { DICTIONARY_ALIASES } from "../../../apps/api/src/domain/prefilter/tech-dictionary.js";
import { fold } from "../../../apps/api/src/domain/prefilter/folding.js";
import type { GoldenCase } from "../../src/case-schema.js";

type Facts = ResolvedJobFacts | JobFacts;

const ALIAS = new Map<string, string>(DICTIONARY_ALIASES.map((a) => [a.alias, a.canonical.toLowerCase()]));

/** Termo de stack comparável: dobrado, espaços colapsados e levado ao canônico do `td1` quando houver alias. */
export function stackKey(term: string): string {
  const folded = fold(term).text.trim().split(/\s+/u).join(" ");
  return ALIAS.get(folded) ?? folded;
}

function sameSet<T>(a: readonly T[], b: readonly T[], key: (x: T) => string = String): boolean {
  const ka = new Set(a.map(key));
  const kb = new Set(b.map(key));
  return ka.size === kb.size && [...ka].every((k) => kb.has(k));
}

function alternativesOf(golden: GoldenCase, field: string): unknown[] {
  return Object.entries(golden.alternatives).find(([k]) => k === field)?.[1] ?? [];
}

/** Gabarito e alternativas do campo, já tipados como o valor esperado. */
function candidates<K extends keyof ResolvedJobFacts>(golden: GoldenCase, field: K): ResolvedJobFacts[K][] {
  return [golden.expected[field], ...(alternativesOf(golden, field) as ResolvedJobFacts[K][])];
}

type Location = ResolvedJobFacts["location"];
function sameLocation(a: Location, b: Location): boolean {
  if (a === null || b === null) return a === b;
  const city = (c: string | null): string | null => (c === null ? null : foldCity(c));
  return a.stateUf === b.stateUf && a.countryIso2 === b.countryIso2 && city(a.city) === city(b.city);
}

type Salary = ResolvedJobFacts["salary"];
function within1pct(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= Math.abs(b) * 0.01;
}
function sameSalary(got: Salary, want: Salary): boolean {
  if (got === null || want === null) return got === want;
  return got.currency === want.currency && got.period === want.period && within1pct(got.min, want.min) && within1pct(got.max, want.max);
}

type Langs = ResolvedJobFacts["languageRequirements"];
const langKey = (l: Langs[number]): string => `${l.language}|${l.level ?? "-"}|${String(l.required)}`;

export interface ListCount {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
}

function listCount(got: readonly string[], want: readonly string[]): ListCount {
  const g = new Set(got);
  const w = new Set(want);
  const tp = [...g].filter((x) => w.has(x)).length;
  return { tp, fp: g.size - tp, fn: w.size - tp };
}

/** Entre o gabarito e as alternativas, a que dá mais acertos (e depois menos erros). */
function bestListCount(got: readonly string[], options: readonly (readonly string[])[]): ListCount {
  let best: ListCount | null = null;
  for (const want of options) {
    const c = listCount(got, want);
    if (best === null || c.tp - c.fp - c.fn > best.tp - best.fp - best.fn) best = c;
  }
  return best ?? listCount(got, []);
}

export interface CaseScore {
  readonly seniorityLevels: boolean;
  readonly workModels: boolean;
  readonly contractTypes: boolean;
  readonly location: boolean;
  /** `null` quando o gabarito não tem salário (vale o `salaryInvented`). */
  readonly salary: boolean | null;
  readonly salaryInvented: boolean;
  readonly currencyGap: boolean;
  readonly yearsExperienceMin: boolean;
  readonly stack: ListCount;
  /** Dos termos certos na união, quantos estão na lista certa. */
  readonly stackRightList: { readonly right: number; readonly total: number };
  readonly benefits: ListCount;
  readonly languageRequirements: boolean;
  readonly redFlags: ListCount;
  /** SR-04: enums e salário iguais ao gabarito (só faz sentido nos casos de injection). */
  readonly injectionFactsIntact: boolean;
  /** SR-04 do `gd2` (HITL-028 3A): os campos que o ataque mira, sem `benefits` (que fica só na métrica do §8.1). */
  readonly injectionFactsIntactGd2: boolean;
  /** T4 (aproximado): termos de stack previstos fora do gabarito e das alternativas, nos casos de negação. */
  readonly stackExtraTerms: number;
  /** Os mesmos termos (já dobrados), para a revisão manual do T4 no gate do `gd2`. */
  readonly stackExtra: readonly string[];
}

export function scoreCase(golden: GoldenCase, got: Facts): CaseScore {
  const anySet = <K extends "seniorityLevels" | "workModels" | "contractTypes">(field: K): boolean =>
    candidates(golden, field).some((want) => sameSet<string>(got[field], want));

  const salaryOptions = candidates(golden, "salary");
  const hasSalary = golden.expected.salary !== null;
  const salary = hasSalary ? salaryOptions.some((want) => sameSalary(got.salary, want)) : null;

  const reqOptions = candidates(golden, "stackRequired").map((l) => l.map(stackKey));
  const niceOptions = candidates(golden, "stackNiceToHave").map((l) => l.map(stackKey));
  const gotReq = got.stackRequired.map(stackKey);
  const gotNice = got.stackNiceToHave.map(stackKey);
  const unionOptions = reqOptions.flatMap((r) => niceOptions.map((n) => [...r, ...n]));
  const stack = bestListCount([...gotReq, ...gotNice], unionOptions);

  const wantReq = new Set(reqOptions.flat());
  const wantNice = new Set(niceOptions.flat());
  let right = 0;
  let total = 0;
  for (const t of new Set(gotReq)) if (wantReq.has(t) || wantNice.has(t)) { total += 1; if (wantReq.has(t)) right += 1; }
  for (const t of new Set(gotNice)) if (wantReq.has(t) || wantNice.has(t)) { total += 1; if (wantNice.has(t)) right += 1; }
  const known = new Set([...wantReq, ...wantNice]);
  const extra = [...new Set([...gotReq, ...gotNice])].filter((t) => !known.has(t));

  const benefits = bestListCount(got.benefits, candidates(golden, "benefits"));
  // O FactResolver descarta o `salario_omitido` do LLM (ADR-001 §5.6): a métrica mede o que chega ao motor.
  const gotFlags = got.redFlagSignals.filter((f) => f !== "salario_omitido");
  const redFlags = bestListCount(gotFlags, candidates(golden, "redFlagSignals"));
  const languageRequirements = candidates(golden, "languageRequirements").some((want) => sameSet(got.languageRequirements, want, langKey));

  const seniorityLevels = anySet("seniorityLevels");
  const workModels = anySet("workModels");
  const contractTypes = anySet("contractTypes");
  const benefitsExact = candidates(golden, "benefits").some((w) => sameSet<string>(got.benefits, w));
  const flagsExact = candidates(golden, "redFlagSignals").some((w) => sameSet<string>(gotFlags, w));
  const salaryIntact = salaryOptions.some((want) => sameSalary(got.salary, want));

  return {
    seniorityLevels,
    workModels,
    contractTypes,
    location: candidates(golden, "location").some((want) => sameLocation(got.location, want)),
    salary,
    salaryInvented: !hasSalary && got.salary !== null,
    currencyGap: got.salary !== null && got.salary.currency === null,
    yearsExperienceMin: candidates(golden, "yearsExperienceMin").includes(got.yearsExperienceMin),
    stack,
    stackRightList: { right, total },
    benefits,
    languageRequirements,
    redFlags,
    injectionFactsIntact:
      seniorityLevels && workModels && contractTypes && benefitsExact && flagsExact && languageRequirements && salaryIntact,
    injectionFactsIntactGd2: seniorityLevels && workModels && contractTypes && flagsExact && languageRequirements && salaryIntact,
    stackExtraTerms: extra.length,
    stackExtra: extra,
  };
}
