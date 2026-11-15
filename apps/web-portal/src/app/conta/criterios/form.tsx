// O formulário de critérios (ADR-028 D5 e D7): HTML puro renderizado no servidor, sem hook e sem JS próprio. Os valores
// vêm prontos da DAL (o salvo, os padrões ou o rascunho) e só preenchem os campos; os textos vêm dos catálogos fixos.
// Formulário `POST` para a rota fixa: a pretensão nunca vai a URL.
import type { ReactNode } from "react";

import { FORM_OPTIONS, type CriteriaField, type FormValues } from "../../../server/criteria-form";
import { FIELD_LABELS, OPTION_LABELS } from "../../../server/criteria-labels";
import { CRITERIA_FIELD_ERRORS } from "../../../server/notices";

interface FormProps {
  readonly values: FormValues;
  readonly fields: readonly CriteriaField[];
}

const first = (values: FormValues, name: string): string => values[name]?.[0] ?? "";
const checked = (values: FormValues, name: string, option: string): boolean => values[name]?.includes(option) === true;

function Section({ field, fields, children }: { readonly field: CriteriaField; readonly fields: readonly CriteriaField[]; readonly children: ReactNode }) {
  const wrong = fields.includes(field);
  return (
    <fieldset data-secao={field} aria-invalid={wrong ? true : undefined} className="flex flex-col gap-3 rounded border px-4 py-3">
      <legend className="px-1 font-semibold">{FIELD_LABELS[field]}</legend>
      {wrong ? (
        <p data-erro={field} className="text-sm">
          {CRITERIA_FIELD_ERRORS[field]}
        </p>
      ) : null}
      {children}
    </fieldset>
  );
}

function Checks({ name, options, labels, values }: { readonly name: string; readonly options: readonly string[]; readonly labels?: Readonly<Record<string, string>>; readonly values: FormValues }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {options.map((option) => (
        <label key={option} className="flex items-center gap-1">
          <input type="checkbox" name={name} value={option} defaultChecked={checked(values, name, option)} />
          {labels?.[option] ?? option}
        </label>
      ))}
    </div>
  );
}

function Select({ name, label, options, labels, values, empty }: { readonly name: string; readonly label: string; readonly options: readonly string[]; readonly labels?: Readonly<Record<string, string>>; readonly values: FormValues; readonly empty?: string }) {
  return (
    <label className="flex items-center gap-2">
      <span>{label}</span>
      <select name={name} defaultValue={first(values, name)} className="rounded border px-2 py-1">
        {empty === undefined ? null : <option value="">{empty}</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {labels?.[option] ?? option}
          </option>
        ))}
      </select>
    </label>
  );
}

function Importance({ prefix, values }: { readonly prefix: string; readonly values: FormValues }) {
  return <Select name={`${prefix}.importance`} label="Importância" options={FORM_OPTIONS.importance} labels={OPTION_LABELS.importance} values={values} />;
}

function Enable({ prefix, values, label }: { readonly prefix: string; readonly values: FormValues; readonly label: string }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" name={`${prefix}.enabled`} value="on" defaultChecked={first(values, `${prefix}.enabled`) === "on"} />
      {label}
    </label>
  );
}

function Lines({ name, label, values, rows }: { readonly name: string; readonly label: string; readonly values: FormValues; readonly rows: number }) {
  return (
    <label className="flex flex-col gap-1">
      <span>{label}</span>
      <textarea name={name} rows={rows} defaultValue={first(values, name)} className="rounded border px-2 py-1" />
    </label>
  );
}

export function CriteriaForm({ values, fields }: FormProps) {
  return (
    <form method="post" action="/conta/criterios/salvar" className="flex flex-col gap-4">
      {/* O resumo dos erros: o nome do campo e o texto do catálogo, nunca o texto do Zod nem o valor recebido. */}
      {fields.length > 0 ? (
        <ul role="alert" className="text-sm">
          {fields.map((field) => (
            <li key={field} data-campo={field}>
              {CRITERIA_FIELD_ERRORS[field]}
            </li>
          ))}
        </ul>
      ) : null}

      <Section field="workModel" fields={fields}>
        <Checks name="workModel.accepted" options={FORM_OPTIONS.workModel} labels={OPTION_LABELS.workModel} values={values} />
        <Importance prefix="workModel" values={values} />
      </Section>

      <Section field="seniority" fields={fields}>
        <Checks name="seniority.accepted" options={FORM_OPTIONS.seniority} labels={OPTION_LABELS.seniority} values={values} />
        <Importance prefix="seniority" values={values} />
      </Section>

      <Section field="contractType" fields={fields}>
        <Checks name="contractType.accepted" options={FORM_OPTIONS.contractType} labels={OPTION_LABELS.contractType} values={values} />
        <Importance prefix="contractType" values={values} />
      </Section>

      <Section field="salary" fields={fields}>
        <Enable prefix="salary" values={values} label="Usar a pretensão salarial" />
        <label className="flex items-center gap-2">
          <span>Valor mínimo</span>
          <input type="text" inputMode="decimal" name="salary.minimum" maxLength={12} autoComplete="off" defaultValue={first(values, "salary.minimum")} className="rounded border px-2 py-1" />
        </label>
        <Select name="salary.currency" label="Moeda" options={FORM_OPTIONS.currency} labels={OPTION_LABELS.currency} values={values} />
        <Select name="salary.period" label="Período" options={FORM_OPTIONS.period} labels={OPTION_LABELS.period} values={values} />
        <Importance prefix="salary" values={values} />
      </Section>

      <Section field="location" fields={fields}>
        <Enable prefix="location" values={values} label="Usar a localização" />
        <Checks name="location.ufs" options={FORM_OPTIONS.ufs} values={values} />
        <Lines name="location.cities" label="Cidades (uma por linha)" values={values} rows={3} />
        <Importance prefix="location" values={values} />
      </Section>

      <Section field="stack" fields={fields}>
        <Lines name="stack.mustHave" label="Obrigatórias (uma por linha)" values={values} rows={4} />
        <Lines name="stack.niceToHave" label="Desejáveis (uma por linha)" values={values} rows={4} />
        <Lines name="stack.dealBreakers" label="Eliminatórias (uma por linha)" values={values} rows={3} />
        <Select name="stack.dealBreakerScope" label="Eliminatória vale" options={FORM_OPTIONS.scopes} labels={OPTION_LABELS.scopes} values={values} />
        <Select name="stack.niceToHaveWeight" label="Peso das desejáveis" options={FORM_OPTIONS.niceToHaveWeight} values={values} />
      </Section>

      <Section field="languages" fields={fields}>
        <Enable prefix="languages" values={values} label="Usar os idiomas" />
        {FORM_OPTIONS.languages.map((code) => (
          <Select key={code} name={`languages.level.${code}`} label={OPTION_LABELS.languages[code]} options={FORM_OPTIONS.levels} labels={OPTION_LABELS.levels} values={values} empty="Não exigir" />
        ))}
        <Importance prefix="languages" values={values} />
      </Section>

      <Section field="benefits" fields={fields}>
        <Enable prefix="benefits" values={values} label="Usar os benefícios" />
        <Checks name="benefits.desired" options={FORM_OPTIONS.benefits} labels={OPTION_LABELS.benefits} values={values} />
        <Importance prefix="benefits" values={values} />
      </Section>

      <Section field="redFlagTolerance" fields={fields}>
        {FORM_OPTIONS.signals.map((signal) => (
          <Select key={signal} name={`redFlagTolerance.${signal}`} label={OPTION_LABELS.signals[signal]} options={FORM_OPTIONS.tolerances} labels={OPTION_LABELS.tolerances} values={values} />
        ))}
      </Section>

      <Section field="notes" fields={fields}>
        <Lines name="notes" label="Até 500 caracteres. Não alimentam nenhuma regra nem vão para análise." values={values} rows={4} />
      </Section>

      <button type="submit" className="self-start rounded border px-4 py-2">
        Salvar critérios
      </button>
    </form>
  );
}
