// S-4: detector de salário (ADR-001 §5.3; ADR-002 §5.9). Varredura manual de caracteres, sem regex.
// `R$` exige fronteira à esquerda: "AR$" (peso argentino) e "US$" contêm "R$" e "$".
import type { Currency, SalaryFacts, SalaryPeriod } from "@trampo/contracts";
import type { SalarySignal } from "../../../apps/api/src/domain/index.js";
import { containsAny, findAll, isWordChar, type Line } from "./text-tools.js";

/** Marcadores já dobrados. A ordem importa: os mais longos primeiro. */
const CURRENCY_MARKERS: readonly (readonly [Currency, string])[] = [
  ["ARS", "ar$"], ["USD", "us$"], ["USD", "usd"], ["BRL", "r$"], ["BRL", "brl"], ["BRL", "reais"],
  ["EUR", "eur"], ["EUR", "euros"], ["EUR", "€"], ["ARS", "ars"], ["ARS", "pesos"],
];

const SALARY_CUES = [
  "salario", "salarial", "salarios", "remuneracao", "bolsa-auxilio", "bolsa auxilio", "compensation", "salary",
  "pay range", "sueldo", "remuneracion", "vencimento", "base pay", "rate",
];
const BENEFIT_CUES = [
  "vale", "vr", "va", "auxilio", "refeicao", "alimentacao", "plano", "seguro", "gympass", "wellhub", "plr", "bonus",
  "comissao", "comissoes", "premio", "premiacao", "/dia", "por dia", "diaria", "desconto", "reembolso", "ajuda de custo",
];

const PERIODS: readonly (readonly [SalaryPeriod, string])[] = [
  ["mes", "/mes"], ["mes", "/ mes"], ["mes", "por mes"], ["mes", "mensal"], ["mes", "mensais"], ["mes", "/month"],
  ["mes", "per month"], ["mes", "monthly"], ["mes", "al mes"], ["mes", "ao mes"],
  ["hora", "/hora"], ["hora", "/ hora"], ["hora", "por hora"], ["hora", "/h"], ["hora", "per hour"], ["hora", "hourly"],
  ["hora", "/hour"], ["hora", "an hour"], ["ano", "/ano"], ["ano", "/ ano"], ["ano", "por ano"], ["ano", "anual"],
  ["ano", "anuais"], ["ano", "per year"], ["ano", "annual"], ["ano", "/year"], ["ano", "a year"], ["ano", "yearly"],
  ["ano", "al ano"], ["ano", "per annum"],
];

const CONNECTORS = ["-", "–", "a", "ate", "e", "to", "y", "/"];

interface Amount {
  readonly value: number;
  readonly start: number;
  readonly end: number;
  currency: Currency | null;
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/** "3.800.000,00" → 3800000; "8.000" → 8000; "12,5" → 12.5; "5,000.00" → 5000. */
export function parseNumber(raw: string): number | null {
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandSep = decimalSep === "." ? "," : ".";
    normalized = raw.split(thousandSep).join("").replace(decimalSep, ".");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const groups = raw.split(sep);
    const thousands = groups.slice(1).every((g) => g.length === 3);
    normalized = thousands ? groups.join("") : groups.join(".");
  } else {
    normalized = raw;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function readAmounts(line: string): Amount[] {
  const out: Amount[] = [];
  let i = 0;
  while (i < line.length) {
    if (!isDigit(line[i]) || isWordChar(line.charAt(i - 1)) && !isDigit(line.charAt(i - 1))) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < line.length && (isDigit(line[i]) || ((line[i] === "." || line[i] === ",") && isDigit(line.charAt(i + 1))))) i += 1;
    let value = parseNumber(line.slice(start, i));
    let end = i;
    if (line[i] === "%") continue;
    const rest = line.slice(i, i + 5);
    if (rest.startsWith("k") && !isWordChar(line.charAt(i + 1))) {
      value = value === null ? null : value * 1000;
      end = i + 1;
    } else if (rest.startsWith(" mil") && !isWordChar(line.charAt(i + 4))) {
      value = value === null ? null : value * 1000;
      end = i + 4;
    }
    if (value !== null) out.push({ value, start, end, currency: null });
    i = end;
  }
  return out;
}

function markerAt(line: string, from: number, to: number): Currency | null {
  const window = line.slice(Math.max(0, from), Math.max(0, to));
  for (const [currency, marker] of CURRENCY_MARKERS) {
    for (const pos of findAll(window, marker)) {
      // Fronteira à esquerda do símbolo: "ar$" não pode ser lido como "r$" (geekhunter-03).
      const abs = Math.max(0, from) + pos;
      if (marker.endsWith("$") && isWordChar(line.charAt(abs - 1))) continue;
      return currency;
    }
  }
  return null;
}

function attachCurrencies(line: string, amounts: Amount[]): void {
  amounts.forEach((a, k) => {
    a.currency = markerAt(line, a.start - 5, a.start) ?? markerAt(line, a.end, a.end + 7);
    const prev = (k > 0 ? amounts.at(k - 1) : undefined);
    if (a.currency === null && prev !== undefined && prev.currency !== null) {
      const between = line.slice(prev.end, a.start).trim();
      if (CONNECTORS.includes(between)) a.currency = prev.currency;
    }
  });
  // "R$ 8.000 a 10.000": o segundo herda; "8.000 a R$ 10.000": o primeiro herda do segundo.
  amounts.forEach((a, k) => {
    const next = amounts.at(k + 1);
    if (a.currency === null && next !== undefined && next.currency !== null) {
      const between = line.slice(a.end, next.start).trim();
      if (CONNECTORS.some((c) => between === c || between.startsWith(c + " r$") || between.startsWith(c + " "))) {
        a.currency = next.currency;
      }
    }
  });
}

interface Candidate {
  readonly min: number;
  readonly max: number;
  readonly currency: Currency | null;
  readonly period: SalaryPeriod | null;
}

/** O período mais próximo depois do último valor ("USD 35-45 per hour, ... paid monthly" é por hora). */
function periodOf(line: string, after: number): SalaryPeriod | null {
  let best: { period: SalaryPeriod; distance: number } | null = null;
  for (const [period, alias] of PERIODS) {
    for (const pos of findAll(line, alias)) {
      const distance = pos >= after ? pos - after : 10_000 + (after - pos);
      if (best === null || distance < best.distance) best = { period, distance };
    }
  }
  return best?.period ?? null;
}

function candidateFromLine(raw: string): Candidate | null {
  const line = raw.split("bolsa-auxilio").join("bolsa").split("bolsa auxilio").join("bolsa");
  const salaryCue = containsAny(raw, SALARY_CUES) || line.includes("bolsa (");
  if (containsAny(line, BENEFIT_CUES)) return null;
  const amounts = readAmounts(raw);
  attachCurrencies(raw, amounts);
  const money = amounts.filter((a) => a.currency !== null || (salaryCue && a.value >= 500));
  if (money.length === 0) return null;
  if (!salaryCue && money.every((a) => a.currency === null)) return null;
  const period = periodOf(raw, money[Math.min(money.length, 2) - 1]?.end ?? 0);
  if (!salaryCue && period === null) return null;
  const values = money.slice(0, 2).map((a) => a.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const currency = money.find((a) => a.currency !== null)?.currency ?? null;
  // "até R$ X" → {min: null, max: X} no gabarito; aqui o protótipo mede só o intervalo [lo, hi].
  return { min, max, currency, period };
}

export interface SalaryResult {
  readonly signal: SalarySignal | null;
  readonly candidates: number;
}

const keyOf = (c: Candidate): string => [c.min, c.max, c.currency, c.period].join("|");

export function detectSalary(lines: readonly Line[]): SalaryResult {
  const candidates: Candidate[] = [];
  for (const line of lines) {
    const c = candidateFromLine(line.text);
    if (c !== null) candidates.push(c);
  }
  const distinct = [...new Map(candidates.map((c) => [keyOf(c), c])).values()];
  const first = distinct[0];
  if (first === undefined) return { signal: null, candidates: 0 };
  // ARS está no enum desde o ADR-002 §8.1: o sinal sai com a moeda própria e nunca vira BRL.
  const value: SalaryFacts = { min: first.min, max: first.max, currency: first.currency, period: first.period };
  const explicit = distinct.length === 1 && first.currency !== null && first.period !== null;
  return { signal: { value, strength: explicit ? "explicita" : "fraca" }, candidates: distinct.length };
}
