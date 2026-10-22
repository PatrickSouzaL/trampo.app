// Detector de salário (ADR-001 §5.3; ADR-002 §5.9; ADR-016 D5). Varredura manual de caracteres, sem regex.
// `R$` exige fronteira à esquerda: "AR$" (peso argentino) e "US$" contêm "R$" e "$" (geekhunter-03).
import type { Currency, SalaryFacts, SalaryPeriod } from "@trampo/contracts";
import { SALARY_MAX } from "@trampo/contracts/limits";
import type { SalarySignal } from "../ports/deterministic-signals.js";
import { containsAny, findAll, isWordChar, type Line } from "./folding.js";

/** Marcadores já dobrados. A ordem importa: os mais longos primeiro. */
const CURRENCY_MARKERS: readonly (readonly [Currency, string])[] = [
  ["ARS", "ar$"], ["USD", "us$"], ["USD", "usd"], ["BRL", "r$"], ["BRL", "brl"], ["BRL", "reais"],
  ["EUR", "eur"], ["EUR", "euros"], ["EUR", "€"], ["ARS", "ars"], ["ARS", "pesos"],
];

const SALARY_CUES: readonly string[] = [
  "salario", "salarial", "salarios", "remuneracao", "bolsa-auxilio", "bolsa auxilio", "compensation", "salary",
  "pay range", "sueldo", "remuneracion", "vencimento", "base pay", "rate",
];
const BENEFIT_CUES: readonly string[] = [
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

/** O que liga dois valores de uma faixa ("R$ 8.000 a 10.000"): o segundo herda a moeda do primeiro. */
const CONNECTORS: readonly string[] = ["-", "–", "a", "ate", "e", "to", "y", "/"];
/** Sem moeda, só um valor com pista de salário e a partir disto é dinheiro (evita "2 anos", "40 horas"). */
const MIN_UNMARKED_AMOUNT = 500;
const MARKER_BEFORE_CHARS = 5;
const MARKER_AFTER_CHARS = 7;
const PERIOD_BEFORE_PENALTY = 10_000;
const DIGIT = /[0-9]/u;

interface Amount {
  readonly value: number;
  readonly start: number;
  readonly end: number;
}

interface PricedAmount extends Amount {
  readonly currency: Currency | null;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/** "3.800.000,00" → 3800000; "8.000" → 8000; "12,5" → 12.5; "5,000.00" → 5000. Não finito → null. */
export function parseAmount(raw: string): number | null {
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandSep = decimalSep === "." ? "," : ".";
    normalized = raw.split(thousandSep).join("").replace(decimalSep, ".");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const groups = raw.split(lastDot >= 0 ? "." : ",");
    normalized = groups.slice(1).every((g) => g.length === 3) ? groups.join("") : groups.join(".");
  } else {
    normalized = raw;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Números da linha, com "k" e "mil"; número colado em letra ("ec2", "h264") e percentual não contam. */
export function readAmounts(line: string): Amount[] {
  const out: Amount[] = [];
  let i = 0;
  while (i < line.length) {
    if (!isDigit(line.charAt(i))) {
      i += 1;
      continue;
    }
    const start = i;
    const glued = isWordChar(line.charAt(i - 1));
    while (isDigit(line.charAt(i)) || ((line.charAt(i) === "." || line.charAt(i) === ",") && isDigit(line.charAt(i + 1)))) i += 1;
    if (glued || line.charAt(i) === "%") continue;
    let value = parseAmount(line.slice(start, i));
    let end = i;
    if (line.charAt(i) === "k" && !isWordChar(line.charAt(i + 1))) {
      end = i + 1;
      value = value === null ? null : value * 1000;
    } else if (line.startsWith(" mil", i) && !isWordChar(line.charAt(i + 4))) {
      end = i + 4;
      value = value === null ? null : value * 1000;
    }
    if (value !== null) out.push({ value, start, end });
    i = end;
  }
  return out;
}

function markerIn(line: string, from: number, to: number): Currency | null {
  const start = Math.max(0, from);
  const window = line.slice(start, Math.max(start, to));
  for (const [currency, marker] of CURRENCY_MARKERS) {
    for (const pos of findAll(window, marker)) {
      // Fronteira à esquerda do símbolo, na linha inteira: "ar$" não pode ser lido como "r$".
      if (marker.endsWith("$") && isWordChar(line.charAt(start + pos - 1))) continue;
      return currency;
    }
  }
  return null;
}

/** Moeda de cada valor: marcador perto dele, ou herdada do vizinho da faixa (nas duas direções). */
export function priceAmounts(line: string, amounts: readonly Amount[]): PricedAmount[] {
  const priced: PricedAmount[] = amounts.map((a) => ({
    ...a,
    currency: markerIn(line, a.start - MARKER_BEFORE_CHARS, a.start) ?? markerIn(line, a.end, a.end + MARKER_AFTER_CHARS),
  }));
  // "R$ 8.000 a 10.000": o segundo herda do primeiro.
  for (let k = 1; k < priced.length; k += 1) {
    const prev = priced[k - 1] as PricedAmount;
    const a = priced[k] as PricedAmount;
    if (a.currency === null && prev.currency !== null && CONNECTORS.includes(line.slice(prev.end, a.start).trim())) {
      priced[k] = { ...a, currency: prev.currency };
    }
  }
  // "8.000 a R$ 10.000": o primeiro herda do segundo.
  for (let k = 1; k < priced.length; k += 1) {
    const a = priced[k - 1] as PricedAmount;
    const next = priced[k] as PricedAmount;
    const between = line.slice(a.end, next.start).trim();
    if (a.currency === null && next.currency !== null && CONNECTORS.some((c) => between === c || between.startsWith(`${c} `))) {
      priced[k - 1] = { ...a, currency: next.currency };
    }
  }
  return priced;
}

/** O período mais próximo depois do último valor ("USD 35-45 per hour, … paid monthly" é por hora). */
export function periodOf(line: string, after: number): SalaryPeriod | null {
  let best: { period: SalaryPeriod; distance: number } | null = null;
  for (const [period, alias] of PERIODS) {
    for (const pos of findAll(line, alias)) {
      const distance = pos >= after ? pos - after : PERIOD_BEFORE_PENALTY + (after - pos);
      if (best === null || distance < best.distance) best = { period, distance };
    }
  }
  return best === null ? null : best.period;
}

/** Candidato de salário numa linha já dobrada, ou null. */
export function salaryCandidate(raw: string): SalaryFacts | null {
  // Linha sem dígito não tem valor: sai antes das pistas (SR-09 em textos com dezenas de milhares de linhas).
  if (!DIGIT.test(raw)) return null;
  const line = raw.split("bolsa-auxilio").join("bolsa").split("bolsa auxilio").join("bolsa");
  if (containsAny(line, BENEFIT_CUES)) return null;
  const salaryCue = containsAny(raw, SALARY_CUES) || line.includes("bolsa (");
  // Sem pista de salário, só valor com moeda; com pista, também o valor sem moeda a partir de 500.
  const money = priceAmounts(raw, readAmounts(raw)).filter((a) => a.currency !== null || (salaryCue && a.value >= MIN_UNMARKED_AMOUNT));
  const pair = money.slice(0, 2);
  const last = pair.at(-1);
  if (last === undefined) return null;
  const period = periodOf(raw, last.end);
  if (!salaryCue && period === null) return null;
  const values = pair.map((a) => a.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // ADR-016 D5: valor fora do contrato (SALARY_MAX) descarta o candidato inteiro.
  if (max > SALARY_MAX) return null;
  const currency = pair.find((a) => a.currency !== null)?.currency ?? null;
  return { min, max, currency, period };
}

const keyOf = (c: SalaryFacts): string => [c.min, c.max, c.currency, c.period].join("|");

/**
 * Explícito só com um candidato distinto, com moeda e com período. ARS sai como ARS e nunca vira BRL
 * (ADR-002 §8.1). O valor sempre vale no SalaryFactsSchema: min ≤ max, não negativo, até SALARY_MAX.
 */
export function detectSalary(lines: readonly Line[]): SalarySignal | null {
  const distinct = new Map<string, SalaryFacts>();
  for (const line of lines) {
    const candidate = salaryCandidate(line.text);
    if (candidate !== null && !distinct.has(keyOf(candidate))) distinct.set(keyOf(candidate), candidate);
  }
  const [first] = distinct.values();
  if (first === undefined) return null;
  const explicit = distinct.size === 1 && first.currency !== null && first.period !== null;
  return { value: first, strength: explicit ? "explicita" : "fraca" };
}
