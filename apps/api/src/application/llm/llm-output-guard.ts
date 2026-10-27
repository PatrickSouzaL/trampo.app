// Guarda de saída do LLM, E5 do funil (ADR-001 §5.5; contratos-zod §5.3; ADR-008).
//
// A saída do modelo é dado não confiável, como o texto da vaga (threat-model T1, T2, T6 e T17). Ordem fixa:
// teto em bytes → parse sem __proto__/constructor → pré-saneamento contado → JobFactsSchema estrito.
// Sem logger: a falha carrega só o motivo, e nenhum texto do LLM sai daqui (SR-12). Sem dado de perfil (D2).
import { type JobFacts, JobFactsSchema } from "@trampo/contracts/job-facts";
import { JOB_TITLE_MAX_CHARS } from "@trampo/contracts/limits";
import {
  INVISIBLE_OR_CONTROL,
  TECH_TAG_PATTERN,
  containsUrlLike,
  truncateCodePoints,
} from "@trampo/contracts/primitives";

/**
 * Entra no `extractorVersion` da chave de cache: mudar o saneamento muda os fatos (ADR-008 D2).
 * g2 (ADR-002 §8.1): ARS e `pressao_excessiva` no contrato; teto de `redFlagSignals` de 6 para 7.
 * g3 (ADR-008 §5): item fora do enum sai, `null` em campo de array vira `[]` e `location` sem nenhum campo vira `null`.
 * g4 (ADR-008 §6): o termo nas duas listas de stack fica só em `stackNiceToHave`.
 */
export const LLM_OUTPUT_GUARD_VERSION = "g4";

/** Teto da resposta bruta em bytes UTF-8, checado antes do parse (ADR-008 D3; calibrar no S-1). */
export const LLM_OUTPUT_MAX_BYTES = 8_192;

/** Tetos de texto livre do JobFactsSchema, em code points. Um teste compara com o JSON Schema do contrato. */
export const FREE_TEXT_MAX_CHARS = { title: JOB_TITLE_MAX_CHARS, city: 80 } as const;

/** Tetos de array do JobFactsSchema. Um teste compara com o `maxItems` do JSON Schema do contrato. */
export const ARRAY_MAX_ITEMS = {
  seniorityLevels: 3,
  workModels: 3,
  contractTypes: 5,
  stackRequired: 30,
  stackNiceToHave: 30,
  benefits: 15,
  languageRequirements: 5,
  redFlagSignals: 7,
} as const;

const ENUM_ARRAY_KEYS = ["seniorityLevels", "workModels", "contractTypes", "benefits", "redFlagSignals"] as const;
type EnumArrayKey = (typeof ENUM_ARRAY_KEYS)[number];

/** Valores aceitos em cada array de enum, lidos do próprio contrato: o que estiver fora sai (ADR-008 §5, G3-1). */
const ENUM_ARRAY_VALUES: Readonly<Record<EnumArrayKey, ReadonlySet<string>>> = {
  seniorityLevels: new Set(JobFactsSchema.shape.seniorityLevels.element.options),
  workModels: new Set(JobFactsSchema.shape.workModels.element.options),
  contractTypes: new Set(JobFactsSchema.shape.contractTypes.element.options),
  benefits: new Set(JobFactsSchema.shape.benefits.element.options),
  redFlagSignals: new Set(JobFactsSchema.shape.redFlagSignals.element.options),
};

const LOCATION_KEYS = ["city", "stateUf", "countryIso2"] as const;

export type LlmOutputRejection =
  | "resposta_grande_demais"
  | "json_invalido"
  | "poluicao_de_prototipo"
  | "schema_invalido";

/** O que o pré-saneamento mudou. Nada é silencioso (ADR-008 D5). */
export interface LlmOutputSanitization {
  /** Tokens de texto livre e tags removidos por parecerem URL, esquema ou e-mail. */
  readonly urlsRemoved: number;
  /** Invisíveis, controles, `<` e `>` removidos do texto livre, mais tags descartadas por contê-los. */
  readonly hiddenOrMarkupRemoved: number;
  /** Tags descartadas por estarem fora do TECH_TAG_PATTERN. */
  readonly malformedItemsRemoved: number;
  /** Strings fora do enum tiradas dos arrays de enum, sem virar outro valor (g3). Não é sinal de injection. */
  readonly offEnumItemsRemoved: number;
  /** `null` num campo de array que virou `[]`, e `location` sem nenhum campo que virou `null` (g3). */
  readonly absentValuesNormalized: number;
  /** Termos tirados do `stackRequired` por estarem também no `stackNiceToHave` (g4). Não é sinal de injection. */
  readonly stackOverlapsResolved: number;
  readonly duplicatesRemoved: number;
  /** Itens cortados acima do máximo do array. */
  readonly itemsCut: number;
  readonly textTruncated: boolean;
  /** URL, invisível ou marcação na saída: não vai ao cache e gera `possivel_prompt_injection` (contratos-zod §5.4). */
  readonly injectionSignal: boolean;
}

export type LlmOutputGuardResult =
  | { readonly ok: true; readonly facts: JobFacts; readonly sanitization: LlmOutputSanitization }
  | { readonly ok: false; readonly reason: LlmOutputRejection };

interface Tally {
  urlsRemoved: number;
  hiddenOrMarkupRemoved: number;
  malformedItemsRemoved: number;
  offEnumItemsRemoved: number;
  absentValuesNormalized: number;
  stackOverlapsResolved: number;
  duplicatesRemoved: number;
  itemsCut: number;
  textTruncated: boolean;
}

type JsonRecord = Record<string, unknown>;

const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor"]);
const WHITESPACE_RUN = /\s+/gu;
const SPACE_RUN = / {2,}/gu;
const INVISIBLE_OR_CONTROL_GLOBAL = new RegExp(INVISIBLE_OR_CONTROL.source, "gu");
const ANGLE_BRACKETS_GLOBAL = /[<>]/gu;
const ANGLE_BRACKET = /[<>]/u;
const UTF8 = new TextEncoder();

class PrototypeKeyError extends Error {
  override readonly name = "PrototypeKeyError";
}

export class LlmOutputGuard {
  /** Nunca lança. `raw` é `unknown` porque vem de fora: o que não for string é `json_invalido`. */
  inspect(raw: unknown): LlmOutputGuardResult {
    if (typeof raw !== "string") return { ok: false, reason: "json_invalido" };
    if (exceedsByteLimit(raw)) return { ok: false, reason: "resposta_grande_demais" };

    const json = parseJsonWithoutPrototypeKeys(raw);
    if (!json.ok) return json;
    const parsed = json.value;

    const tally: Tally = {
      urlsRemoved: 0,
      hiddenOrMarkupRemoved: 0,
      malformedItemsRemoved: 0,
      offEnumItemsRemoved: 0,
      absentValuesNormalized: 0,
      stackOverlapsResolved: 0,
      duplicatesRemoved: 0,
      itemsCut: 0,
      textTruncated: false,
    };
    if (isRecord(parsed)) sanitizeFacts(parsed, tally);

    const result = JobFactsSchema.safeParse(parsed);
    if (!result.success) return { ok: false, reason: "schema_invalido" };
    return {
      ok: true,
      facts: result.data,
      sanitization: { ...tally, injectionSignal: tally.urlsRemoved + tally.hiddenOrMarkupRemoved > 0 },
    };
  }
}

/**
 * `JSON.parse` que recusa `__proto__` e `constructor` em qualquer nível, inclusive escapados. Também é o parse
 * da leitura do JobFactsCache (ADR-015 D4). Nunca lança.
 */
export function parseJsonWithoutPrototypeKeys(
  raw: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "json_invalido" | "poluicao_de_prototipo" } {
  try {
    return { ok: true, value: JSON.parse(raw, rejectPrototypeKeys) };
  } catch (error) {
    return { ok: false, reason: error instanceof PrototypeKeyError ? "poluicao_de_prototipo" : "json_invalido" };
  }
}

/** Cada unidade UTF-16 custa ao menos 1 byte: acima do teto em unidades, nem precisa codificar. */
function exceedsByteLimit(raw: string): boolean {
  return raw.length > LLM_OUTPUT_MAX_BYTES || UTF8.encode(raw).length > LLM_OUTPUT_MAX_BYTES;
}

/** Reviver do JSON.parse: a chave chega decodificada, então "__proto__" também cai aqui. */
function rejectPrototypeKeys(key: string, value: unknown): unknown {
  if (PROTOTYPE_KEYS.has(key)) throw new PrototypeKeyError();
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Mexe só em valores do tipo esperado: o resto (inclusive chave ausente) fica para o Zod reprovar. A única troca de
 * forma é a da ausência (g3): `null` num campo de array, que o contrato já lê como "não informado", vira `[]`.
 */
function sanitizeFacts(facts: JsonRecord, tally: Tally): void {
  for (const key of Object.keys(ARRAY_MAX_ITEMS)) update(facts, key, (value) => emptyIfNull(value, tally));
  update(facts, "title", (value) =>
    typeof value === "string" ? sanitizeFreeText(value, FREE_TEXT_MAX_CHARS.title, tally) : value,
  );
  update(facts, "location", (value) => sanitizeLocation(value, tally));
  // O desejável vem antes: o exigido é saneado contra a lista final dele (g4, ADR-008 §6).
  update(facts, "stackNiceToHave", (value) => sanitizeTags(value, ARRAY_MAX_ITEMS.stackNiceToHave, NO_OVERLAP, tally));
  const desired = foldedTags(facts["stackNiceToHave"]);
  update(facts, "stackRequired", (value) => sanitizeTags(value, ARRAY_MAX_ITEMS.stackRequired, desired, tally));
  for (const key of ENUM_ARRAY_KEYS) {
    update(facts, key, (value) => sanitizeEnumArray(value, ENUM_ARRAY_VALUES[key], ARRAY_MAX_ITEMS[key], tally));
  }
  update(facts, "languageRequirements", (value) =>
    Array.isArray(value) ? cut(value, ARRAY_MAX_ITEMS.languageRequirements, tally) : value,
  );
}

function update(record: JsonRecord, key: string, change: (value: unknown) => unknown): void {
  record[key] = change(record[key]);
}

/** Só o `null` explícito: chave ausente não ganha valor padrão (ADR-008 D6). */
function emptyIfNull(value: unknown, tally: Tally): unknown {
  if (value !== null) return value;
  tally.absentValuesNormalized += 1;
  return [];
}

/**
 * Ordem (ADR-008 D5): `<>` sai antes da busca de URL ("javascript<:"), o corte vem antes dela ("x.cnz" → "x.cn")
 * e o NFKC final recompõe o que a remoção de um invisível separou. Vazio vira null ("não informado").
 */
function sanitizeFreeText(value: string, max: number, tally: Tally): string | null {
  const visible = value
    .toWellFormed()
    .normalize("NFKC")
    .replace(WHITESPACE_RUN, " ")
    .replace(INVISIBLE_OR_CONTROL_GLOBAL, () => {
      tally.hiddenOrMarkupRemoved += 1;
      return "";
    })
    .replace(ANGLE_BRACKETS_GLOBAL, () => {
      tally.hiddenOrMarkupRemoved += 1;
      return "";
    });
  const truncated = truncateCodePoints(visible, max);
  if (truncated !== visible) tally.textTruncated = true;
  const withoutUrls = truncated
    .split(" ")
    .filter((token) => {
      if (!containsUrlLike(token)) return true;
      tally.urlsRemoved += 1;
      return false;
    })
    .join(" ");
  const text = withoutUrls.replace(SPACE_RUN, " ").trim().normalize("NFKC");
  return text === "" ? null : text;
}

/** Sem nenhum campo, a localização é "não informada": vira null, venha do modelo assim ou da cidade esvaziada. */
function sanitizeLocation(value: unknown, tally: Tally): unknown {
  if (!isRecord(value)) return value;
  const city = value["city"];
  if (typeof city === "string") value["city"] = sanitizeFreeText(city, FREE_TEXT_MAX_CHARS.city, tally);
  if (!isEmptyLocation(value)) return value;
  tally.absentValuesNormalized += 1;
  return null;
}

/**
 * Exatamente as três chaves do contrato, todas null. Com chave a mais ou a menos, o objeto fica para o Zod reprovar:
 * virar null esconderia a chave extra (ADR-008 §5, G3-3). Chave ausente lê undefined, que não é null.
 */
function isEmptyLocation(location: JsonRecord): boolean {
  return Object.keys(location).length === LOCATION_KEYS.length && LOCATION_KEYS.every((key) => location[key] === null);
}

const NO_OVERLAP: ReadonlySet<string> = new Set();

/** Tags já saneadas, em minúsculas, como o `stacksAreDisjoint` do contrato compara. Fora de array: conjunto vazio. */
function foldedTags(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return NO_OVERLAP;
  return new Set((value as readonly unknown[]).filter((item) => typeof item === "string").map((tag) => tag.toLowerCase()));
}

/**
 * Tag ruim sai inteira: nunca se removem caracteres de dentro dela ("Node.js<x>" não vira "Node.jsx"). Tag boa que está
 * em `overlap` (o desejável final) sai antes da duplicata e do corte, e continua no desejável (g4, ADR-008 §6).
 */
function sanitizeTags(value: unknown, max: number, overlap: ReadonlySet<string>, tally: Tally): unknown {
  if (!Array.isArray(value)) return value;
  const kept: unknown[] = [];
  const seen = new Set<string>();
  for (const item of value as readonly unknown[]) {
    if (typeof item !== "string") {
      kept.push(item);
      continue;
    }
    const tag = item.toWellFormed().normalize("NFKC").trim();
    const folded = tag.toLowerCase();
    if (containsUrlLike(tag)) tally.urlsRemoved += 1;
    else if (INVISIBLE_OR_CONTROL.test(tag) || ANGLE_BRACKET.test(tag)) tally.hiddenOrMarkupRemoved += 1;
    else if (!TECH_TAG_PATTERN.test(tag)) tally.malformedItemsRemoved += 1;
    else if (overlap.has(folded)) tally.stackOverlapsResolved += 1;
    else if (seen.has(folded)) tally.duplicatesRemoved += 1;
    else {
      seen.add(folded);
      kept.push(tag);
    }
  }
  return cut(kept, max, tally);
}

/**
 * Arrays de enum: string fora do enum sai, comparada exatamente e nunca mapeada ("CLT" não vira "clt"); depois sai
 * a duplicata exata, e só então vem o corte. Item que não é string fica, para o Zod reprovar (ADR-008 §5, G3-1).
 */
function sanitizeEnumArray(value: unknown, allowed: ReadonlySet<string>, max: number, tally: Tally): unknown {
  if (!Array.isArray(value)) return value;
  const kept: unknown[] = [];
  const seen = new Set<string>();
  for (const item of value as readonly unknown[]) {
    if (typeof item === "string") {
      if (!allowed.has(item)) {
        tally.offEnumItemsRemoved += 1;
        continue;
      }
      if (seen.has(item)) {
        tally.duplicatesRemoved += 1;
        continue;
      }
      seen.add(item);
    }
    kept.push(item);
  }
  return cut(kept, max, tally);
}

function cut(items: readonly unknown[], max: number, tally: Tally): readonly unknown[] {
  if (items.length <= max) return items;
  tally.itemsCut += items.length - max;
  return items.slice(0, max);
}
