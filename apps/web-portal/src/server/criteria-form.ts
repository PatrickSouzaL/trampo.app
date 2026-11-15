// O formulário de critérios do portal (ADR-028 D7), campo a campo para o `UserCriteriaSchema` do `@trampo/contracts`.
//
// - Opções só dos enums fechados do contrato, lidas dos próprios schemas (nenhuma lista copiada aqui).
// - Lista fechada de nomes de campo: nome desconhecido ou campo único repetido recusa o formulário inteiro.
// - Normalização mínima (CRLF, linhas aparadas e vazias fora, observação vazia como `null`); o schema decide o resto.
// - O erro sai só como o primeiro segmento do caminho do Zod (o nome do campo do contrato): nunca o texto do Zod nem o
//   valor recebido. O texto mostrado vem do catálogo `CRITERIA_FIELD_ERRORS` (notices.ts).
// - As tecnologias e as cidades são marcas validadas pelo contrato (`TechTag`, `safeText(80)`), uma por linha; o único
//   texto livre é a observação, que não alimenta regra (contrato e Blueprint §3).
import { HTTP_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import {
  BenefitsCriterionSchema,
  ContractTypeCriterionSchema,
  LanguageProficiencySchema,
  LocationCriterionSchema,
  RedFlagToleranceSchema,
  SalaryCriterionSchema,
  SeniorityCriterionSchema,
  StackCriterionSchema,
  USER_CRITERIA_SCHEMA_VERSION,
  UserCriteriaSchema,
  WorkModelCriterionSchema,
  type CriterionImportance,
  type UserCriteria,
} from "@trampo/contracts/user-criteria";

import { decodeUtf8, readCapped } from "./http";

/** Os valores do formulário por nome de campo, como o navegador os manda (caixa desmarcada não manda nada). */
export type FormValues = Readonly<Record<string, readonly string[]>>;

/** Os campos do contrato que podem ter erro, na ordem do contrato; `criterios` é o documento inteiro (o teto). */
export const CRITERIA_FIELDS = [
  "workModel",
  "seniority",
  "contractType",
  "salary",
  "location",
  "stack",
  "languages",
  "benefits",
  "redFlagTolerance",
  "notes",
  "criterios",
] as const;
export type CriteriaField = (typeof CRITERIA_FIELDS)[number];

const WEIGHTS = ["1", "2", "3", "4", "5"] as const;

export const FORM_OPTIONS = Object.freeze({
  workModel: WorkModelCriterionSchema.shape.accepted.element.options,
  seniority: SeniorityCriterionSchema.shape.accepted.element.options,
  contractType: ContractTypeCriterionSchema.shape.accepted.element.options,
  currency: SalaryCriterionSchema.shape.currency.options,
  period: SalaryCriterionSchema.shape.period.options,
  ufs: LocationCriterionSchema.shape.acceptedUfs.element.options,
  benefits: BenefitsCriterionSchema.shape.desired.element.options,
  languages: LanguageProficiencySchema.shape.language.options,
  levels: LanguageProficiencySchema.shape.level.options,
  signals: UserCriteriaSchema.shape.redFlagTolerance.keyType.options,
  tolerances: RedFlagToleranceSchema.options,
  scopes: StackCriterionSchema.shape.dealBreakerScope.options,
  /** A importância num `<select>` só (ADR-028 D7). */
  importance: ["eliminatorio", "obrigatorio", ...WEIGHTS.map((weight) => `ponderado_${weight}`), "ignorar"],
  niceToHaveWeight: ["0", ...WEIGHTS],
});

/** As caixas de marcação que podem vir mais de uma vez. */
const MULTI_FIELDS: ReadonlySet<string> = new Set(["workModel.accepted", "seniority.accepted", "contractType.accepted", "location.ufs", "benefits.desired"]);
/** As caixas "usar este critério": só valem com `on`. */
const ENABLE_FIELDS: ReadonlySet<string> = new Set(["salary.enabled", "location.enabled", "languages.enabled", "benefits.enabled"]);

/** Todos os nomes, na ordem canônica (a do rascunho e a da página). */
export const FIELD_ORDER: readonly string[] = Object.freeze([
  "workModel.accepted",
  "workModel.importance",
  "seniority.accepted",
  "seniority.importance",
  "contractType.accepted",
  "contractType.importance",
  "salary.enabled",
  "salary.minimum",
  "salary.currency",
  "salary.period",
  "salary.importance",
  "location.enabled",
  "location.ufs",
  "location.cities",
  "location.importance",
  "stack.mustHave",
  "stack.niceToHave",
  "stack.dealBreakers",
  "stack.dealBreakerScope",
  "stack.niceToHaveWeight",
  "languages.enabled",
  ...FORM_OPTIONS.languages.map((code) => `languages.level.${code}`),
  "languages.importance",
  "benefits.enabled",
  "benefits.desired",
  "benefits.importance",
  ...FORM_OPTIONS.signals.map((signal) => `redFlagTolerance.${signal}`),
  "notes",
]);
const FIELD_SET: ReadonlySet<string> = new Set(FIELD_ORDER);
const ERROR_FIELDS: ReadonlySet<string> = new Set(CRITERIA_FIELDS);

const FORM_TYPE = /^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i;
const DECIMAL = /^(\d{1,8})(?:[.,](\d{1,2}))?$/;
const WEIGHTED = /^ponderado_([1-5])$/;

function importanceOption(importance: CriterionImportance): string {
  return importance.level === "ponderado" ? `ponderado_${importance.weight}` : importance.level;
}

/** O formulário de um `UserCriteria`, como o navegador o mandaria; `null` dá os padrões explícitos (ADR-028 D7). */
export function criteriaToForm(criteria: UserCriteria | null): FormValues {
  const values: Record<string, readonly string[]> = {};
  const set = (name: string, list: readonly string[]): void => {
    if (list.length > 0) values[name] = list;
  };
  const section = <T extends { readonly importance: CriterionImportance }>(prefix: string, value: T | null | undefined): void => {
    if (value !== null && value !== undefined) set(`${prefix}.enabled`, ["on"]);
    set(`${prefix}.importance`, [value === null || value === undefined ? "ignorar" : importanceOption(value.importance)]);
  };

  set("workModel.accepted", criteria?.workModel.accepted ?? FORM_OPTIONS.workModel);
  set("workModel.importance", [criteria === null ? "ignorar" : importanceOption(criteria.workModel.importance)]);
  set("seniority.accepted", criteria?.seniority.accepted ?? FORM_OPTIONS.seniority);
  set("seniority.importance", [criteria === null ? "ignorar" : importanceOption(criteria.seniority.importance)]);
  set("contractType.accepted", criteria?.contractType.accepted ?? FORM_OPTIONS.contractType);
  set("contractType.importance", [criteria === null ? "ignorar" : importanceOption(criteria.contractType.importance)]);

  const salary = criteria?.salary ?? null;
  section("salary", salary);
  set("salary.minimum", [salary === null ? "" : String(salary.minimum)]);
  set("salary.currency", [salary?.currency ?? "BRL"]);
  set("salary.period", [salary?.period ?? "mes"]);

  const location = criteria?.location ?? null;
  section("location", location);
  set("location.ufs", location?.acceptedUfs ?? []);
  set("location.cities", [(location?.acceptedCities ?? []).join("\n")]);

  const stack = criteria?.stack;
  set("stack.mustHave", [(stack?.mustHave ?? []).join("\n")]);
  set("stack.niceToHave", [(stack?.niceToHave ?? []).join("\n")]);
  set("stack.dealBreakers", [(stack?.dealBreakers ?? []).join("\n")]);
  set("stack.dealBreakerScope", [stack?.dealBreakerScope ?? "somente_obrigatoria"]);
  set("stack.niceToHaveWeight", [String(stack?.niceToHaveWeight ?? 1)]);

  const languages = criteria?.languages ?? null;
  section("languages", languages);
  for (const code of FORM_OPTIONS.languages) {
    set(`languages.level.${code}`, [languages?.proficiencies.find((item) => item.language === code)?.level ?? ""]);
  }

  const benefits = criteria?.benefits ?? null;
  section("benefits", benefits);
  set("benefits.desired", benefits?.desired ?? []);

  for (const signal of FORM_OPTIONS.signals) set(`redFlagTolerance.${signal}`, [criteria?.redFlagTolerance[signal] ?? "alertar"]);
  set("notes", [criteria?.notes ?? ""]);
  return Object.fromEntries(FIELD_ORDER.filter((name) => name in values).map((name) => [name, values[name] as readonly string[]]));
}

/** Os padrões de quem nunca salvou. */
export function defaultFormValues(): FormValues {
  return criteriaToForm(null);
}

/** Os pares na ordem canônica (o conteúdo do rascunho, ADR-028 D8). */
export function formPairs(values: FormValues): Array<[string, string]> {
  return FIELD_ORDER.flatMap((name) => (values[name] ?? []).map((value): [string, string] => [name, value]));
}

/** A lista fechada de nomes (ADR-028 D6 passo 3): `null` com nome desconhecido, campo único repetido ou caixa sem `on`. */
export function checkFormPairs(pairs: ReadonlyArray<readonly [string, string]>): FormValues | null {
  const collected = new Map<string, string[]>();
  for (const [name, value] of pairs) {
    if (!FIELD_SET.has(name)) return null;
    if (ENABLE_FIELDS.has(name) && value !== "on") return null;
    const list = collected.get(name);
    if (list === undefined) collected.set(name, [value]);
    else if (MULTI_FIELDS.has(name)) list.push(value);
    else return null;
  }
  return Object.fromEntries(FIELD_ORDER.filter((name) => collected.has(name)).map((name) => [name, collected.get(name) as readonly string[]]));
}

/**
 * O corpo do formulário (ADR-028 D6 passo 2): `application/x-www-form-urlencoded` (com `charset=utf-8` opcional), até
 * `HTTP_BODY_MAX_BYTES` e UTF-8 estrito. `null` em qualquer desvio, sem ler além do teto.
 */
export async function readFormBody(contentType: string | null, body: ReadableStream<Uint8Array> | null): Promise<Array<[string, string]> | null> {
  if (contentType === null || !FORM_TYPE.test(contentType.trim()) || body === null) return null;
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(body, HTTP_BODY_MAX_BYTES);
  } catch {
    // Conexão que caiu no meio do corpo.
    return null;
  }
  const text = bytes === null ? null : decodeUtf8(bytes);
  return text === null ? null : [...new URLSearchParams(text)];
}

/** O formulário como `UserCriteria`, ou os nomes dos campos com erro, na ordem do contrato. */
export function formToCriteria(values: FormValues): { readonly ok: true; readonly criteria: UserCriteria } | { readonly ok: false; readonly fields: CriteriaField[] } {
  const one = (name: string): string | undefined => values[name]?.[0];
  const many = (name: string): string[] => [...(values[name] ?? [])];
  const enabled = (prefix: string): boolean => one(`${prefix}.enabled`) === "on";
  const lines = (name: string): string[] =>
    (one(name) ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  const importance = (name: string): unknown => {
    const option = one(name) ?? "";
    if (option === "eliminatorio" || option === "obrigatorio" || option === "ignorar") return { level: option };
    const weighted = WEIGHTED.exec(option);
    return weighted === null ? undefined : { level: "ponderado", weight: Number(weighted[1]) };
  };
  const decimal = (text: string | undefined): number => {
    const match = DECIMAL.exec(text ?? "");
    return match === null ? Number.NaN : Number(`${match[1]}.${match[2] ?? "0"}`);
  };
  const notes = (one("notes") ?? "").replace(/\r\n?/g, "\n").trim();

  const candidate = {
    schemaVersion: USER_CRITERIA_SCHEMA_VERSION,
    workModel: { accepted: many("workModel.accepted"), importance: importance("workModel.importance") },
    seniority: { accepted: many("seniority.accepted"), importance: importance("seniority.importance") },
    contractType: { accepted: many("contractType.accepted"), importance: importance("contractType.importance") },
    salary: enabled("salary")
      ? { minimum: decimal(one("salary.minimum")), currency: one("salary.currency"), period: one("salary.period"), importance: importance("salary.importance") }
      : null,
    location: enabled("location") ? { acceptedUfs: many("location.ufs"), acceptedCities: lines("location.cities"), importance: importance("location.importance") } : null,
    stack: {
      mustHave: lines("stack.mustHave"),
      niceToHave: lines("stack.niceToHave"),
      dealBreakers: lines("stack.dealBreakers"),
      dealBreakerScope: one("stack.dealBreakerScope"),
      niceToHaveWeight: /^[0-5]$/.test(one("stack.niceToHaveWeight") ?? "") ? Number(one("stack.niceToHaveWeight")) : Number.NaN,
    },
    languages: enabled("languages")
      ? {
          proficiencies: FORM_OPTIONS.languages.flatMap((code) => {
            const level = one(`languages.level.${code}`) ?? "";
            return level === "" ? [] : [{ language: code, level }];
          }),
          importance: importance("languages.importance"),
        }
      : null,
    benefits: enabled("benefits") ? { desired: many("benefits.desired"), importance: importance("benefits.importance") } : null,
    redFlagTolerance: Object.fromEntries(FORM_OPTIONS.signals.map((signal) => [signal, one(`redFlagTolerance.${signal}`)])),
    notes: notes === "" ? null : notes,
  };

  const parsed = UserCriteriaSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, criteria: parsed.data };
  const found = new Set(
    parsed.error.issues.map((issue) => {
      const head = issue.path[0];
      return typeof head === "string" && ERROR_FIELDS.has(head) ? head : "criterios";
    }),
  );
  return { ok: false, fields: CRITERIA_FIELDS.filter((field) => found.has(field)) };
}
