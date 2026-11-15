// Formulário de critérios (ADR-028 D7): campo a campo para o `UserCriteriaSchema` do contrato, lista fechada de nomes,
// padrões explícitos, normalização mínima e erros só com o nome do campo.
import { HTTP_BODY_MAX_BYTES } from "@trampo/contracts/limits";
import type { UserCriteria } from "@trampo/contracts/user-criteria";
import { describe, expect, it } from "vitest";

import {
  FORM_OPTIONS,
  checkFormPairs,
  criteriaToForm,
  defaultFormValues,
  formPairs,
  formToCriteria,
  readFormBody,
  type FormValues,
} from "../../src/server/criteria-form";
import { fullCriteria } from "../support/criteria-fixtures";

const URLENCODED = "application/x-www-form-urlencoded";

function streamOf(bytes: Uint8Array | string): ReadableStream<Uint8Array> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return new ReadableStream({
    start(controller) {
      // Em dois pedaços, como a rede entregaria.
      controller.enqueue(data.slice(0, Math.floor(data.length / 2)));
      controller.enqueue(data.slice(Math.floor(data.length / 2)));
      controller.close();
    },
  });
}

/** Os valores do formulário com algumas chaves trocadas (ausente = removida). */
function withValues(base: FormValues, changes: Record<string, readonly string[] | undefined>): FormValues {
  const next: Record<string, readonly string[]> = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

const fieldsOf = (values: FormValues): readonly string[] => {
  const result = formToCriteria(values);
  return result.ok ? [] : result.fields;
};

describe("opções (só os enums fechados do contrato)", () => {
  it("lidas dos schemas do @trampo/contracts", () => {
    expect(FORM_OPTIONS.workModel).toEqual(["remoto", "hibrido", "presencial"]);
    expect(FORM_OPTIONS.seniority).toEqual(["estagio", "junior", "pleno", "senior", "especialista", "lideranca"]);
    expect(FORM_OPTIONS.contractType).toEqual(["clt", "pj", "cooperado", "estagio", "temporario"]);
    expect(FORM_OPTIONS.currency).toEqual(["BRL", "USD", "EUR", "ARS"]);
    expect(FORM_OPTIONS.period).toEqual(["hora", "mes", "ano"]);
    expect(FORM_OPTIONS.ufs).toHaveLength(27);
    expect(FORM_OPTIONS.benefits).toHaveLength(15);
    expect(FORM_OPTIONS.languages).toEqual(["ingles", "espanhol", "frances", "alemao", "italiano", "mandarim", "japones", "portugues", "outro"]);
    expect(FORM_OPTIONS.levels).toEqual(["basico", "intermediario", "avancado", "fluente", "nativo"]);
    expect(FORM_OPTIONS.signals).toHaveLength(7);
    expect(FORM_OPTIONS.tolerances).toEqual(["ignorar", "alertar", "penalizar", "eliminatorio"]);
    expect(FORM_OPTIONS.scopes).toEqual(["somente_obrigatoria", "qualquer_mencao"]);
    expect(FORM_OPTIONS.importance).toEqual(["eliminatorio", "obrigatorio", "ponderado_1", "ponderado_2", "ponderado_3", "ponderado_4", "ponderado_5", "ignorar"]);
    expect(FORM_OPTIONS.niceToHaveWeight).toEqual(["0", "1", "2", "3", "4", "5"]);
  });
});

describe("ida e volta e padrões", () => {
  it("UserCriteria → formulário → UserCriteria: o mesmo valor", () => {
    expect(formToCriteria(criteriaToForm(fullCriteria()))).toEqual({ ok: true, criteria: fullCriteria() });
  });

  it("padrões explícitos para quem nunca salvou: tudo aceito e ignorado, seções opcionais desligadas, sinais em alertar", () => {
    expect(criteriaToForm(null)).toEqual(defaultFormValues());
    const result = formToCriteria(defaultFormValues());
    expect(result.ok).toBe(true);
    const criteria = (result as { criteria: UserCriteria }).criteria;
    expect(criteria.workModel).toEqual({ accepted: ["remoto", "hibrido", "presencial"], importance: { level: "ignorar" } });
    expect(criteria.seniority.accepted).toHaveLength(6);
    expect(criteria.contractType.accepted).toHaveLength(5);
    expect([criteria.salary, criteria.location, criteria.languages, criteria.benefits, criteria.notes]).toEqual([null, null, null, null, null]);
    expect(criteria.stack).toEqual({ mustHave: [], niceToHave: [], dealBreakers: [], dealBreakerScope: "somente_obrigatoria", niceToHaveWeight: 1 });
    expect(new Set(Object.values(criteria.redFlagTolerance))).toEqual(new Set(["alertar"]));
    expect(Object.keys(criteria.redFlagTolerance)).toHaveLength(7);
  });

  it("formPairs e checkFormPairs: os pares do rascunho voltam aos mesmos valores", () => {
    for (const values of [criteriaToForm(fullCriteria()), defaultFormValues()]) expect(checkFormPairs(formPairs(values))).toEqual(values);
    // As caixas desmarcadas não mandam par nenhum, como no navegador.
    expect(formPairs(defaultFormValues()).some(([name]) => name === "salary.enabled" || name === "benefits.desired")).toBe(false);
  });
});

describe("campo a campo (ADR-028 D7)", () => {
  const base = criteriaToForm(fullCriteria());

  it.each([
    ["eliminatorio", { level: "eliminatorio" }],
    ["obrigatorio", { level: "obrigatorio" }],
    ["ponderado_1", { level: "ponderado", weight: 1 }],
    ["ponderado_5", { level: "ponderado", weight: 5 }],
    ["ignorar", { level: "ignorar" }],
  ])("importância %s", (option, importance) => {
    const result = formToCriteria(withValues(base, { "workModel.importance": [option] }));
    expect(result.ok && result.criteria.workModel.importance).toEqual(importance);
  });

  it.each(["ponderado_0", "ponderado_6", "ponderado", "ponderado_1.5", "PONDERADO_1", ""])("importância fora da lista (%s): erro só no campo", (option) => {
    expect(fieldsOf(withValues(base, { "seniority.importance": [option] }))).toEqual(["seniority"]);
  });

  it("modelo de trabalho sem nenhuma opção: erro no campo", () => {
    expect(fieldsOf(withValues(base, { "workModel.accepted": undefined }))).toEqual(["workModel"]);
    expect(fieldsOf(withValues(base, { "contractType.accepted": ["clt", "freela"] }))).toEqual(["contractType"]);
  });

  it.each([
    ["9000", 9_000],
    ["9000,5", 9_000.5],
    ["9000.25", 9_000.25],
    ["10000000", 10_000_000],
  ])("pretensão %s vira %d", (text, value) => {
    const result = formToCriteria(withValues(base, { "salary.minimum": [text] }));
    expect(result.ok && result.criteria.salary?.minimum).toBe(value);
  });

  it.each(["", "0", "-5", "9.000", "1e5", "9000,555", "10000001", "R$ 9000", " 9000", "Infinity"])("pretensão %j: erro em salary", (text) => {
    expect(fieldsOf(withValues(base, { "salary.minimum": [text] }))).toEqual(["salary"]);
  });

  it("campo de uma seção ligada que não veio: o schema decide (pretensão sem valor dá erro; idioma sem nível fica de fora)", () => {
    expect(fieldsOf(withValues(base, { "salary.minimum": undefined }))).toEqual(["salary"]);
    const result = formToCriteria(withValues(base, { "languages.level.espanhol": undefined }));
    expect(result.ok && result.criteria.languages?.proficiencies).toEqual([{ language: "ingles", level: "avancado" }]);
  });

  it("seções opcionais desligadas viram null, mesmo com os campos preenchidos", () => {
    const off = withValues(base, { "salary.enabled": undefined, "location.enabled": undefined, "languages.enabled": undefined, "benefits.enabled": undefined });
    const result = formToCriteria(off);
    expect(result.ok && [result.criteria.salary, result.criteria.location, result.criteria.languages, result.criteria.benefits]).toEqual([null, null, null, null]);
  });

  it("listas por linha: CRLF, espaços e linhas vazias", () => {
    const result = formToCriteria(withValues(base, { "location.cities": ["  Curitiba \r\n\r\nSão Paulo\r\n "], "stack.mustHave": ["TypeScript\r\n\r\n  Node.js  "] }));
    expect(result.ok && result.criteria.location?.acceptedCities).toEqual(["Curitiba", "São Paulo"]);
    expect(result.ok && result.criteria.stack.mustHave).toEqual(["TypeScript", "Node.js"]);
  });

  it("localização ligada sem estado nem cidade: erro em location", () => {
    expect(fieldsOf(withValues(base, { "location.ufs": undefined, "location.cities": [""] }))).toEqual(["location"]);
  });

  it("stack: a mesma tecnologia em duas listas, link e lista longa dão erro em stack", () => {
    expect(fieldsOf(withValues(base, { "stack.dealBreakers": ["typescript"] }))).toEqual(["stack"]);
    expect(fieldsOf(withValues(base, { "stack.niceToHave": ["https://evil.example/x"] }))).toEqual(["stack"]);
    expect(fieldsOf(withValues(base, { "stack.mustHave": [Array.from({ length: 16 }, (_, i) => `Tec${i}`).join("\n")] }))).toEqual(["stack"]);
    expect(fieldsOf(withValues(base, { "stack.niceToHaveWeight": ["6"] }))).toEqual(["stack"]);
    expect(fieldsOf(withValues(base, { "stack.dealBreakerScope": ["sempre"] }))).toEqual(["stack"]);
  });

  it("idiomas: o nível escolhido vira proficiência; mais de 8 dá erro", () => {
    const one = formToCriteria(withValues(base, { "languages.level.ingles": ["fluente"], "languages.level.espanhol": [""] }));
    expect(one.ok && one.criteria.languages?.proficiencies).toEqual([{ language: "ingles", level: "fluente" }]);
    const all = Object.fromEntries(FORM_OPTIONS.languages.map((code) => [`languages.level.${code}`, ["basico"]]));
    expect(fieldsOf(withValues(base, all))).toEqual(["languages"]);
    expect(fieldsOf(withValues(base, { "languages.level.ingles": ["mestre"] }))).toEqual(["languages"]);
  });

  it("benefícios ligados sem nenhum: erro em benefits", () => {
    expect(fieldsOf(withValues(base, { "benefits.desired": undefined }))).toEqual(["benefits"]);
  });

  it("sinal de alerta faltando ou fora da lista: erro em redFlagTolerance", () => {
    expect(fieldsOf(withValues(base, { "redFlagTolerance.linguagem_vaga": undefined }))).toEqual(["redFlagTolerance"]);
    expect(fieldsOf(withValues(base, { "redFlagTolerance.salario_omitido": ["talvez"] }))).toEqual(["redFlagTolerance"]);
  });

  it("observações: CRLF vira LF, vazio vira null, marcação e link dão erro", () => {
    const crlf = formToCriteria(withValues(base, { notes: ["linha 1\r\nlinha 2"] }));
    expect(crlf.ok && crlf.criteria.notes).toBe("linha 1\nlinha 2");
    const empty = formToCriteria(withValues(base, { notes: ["  \r\n "] }));
    expect(empty.ok && empty.criteria.notes).toBeNull();
    expect(fieldsOf(withValues(base, { notes: ["<b>oi</b>"] }))).toEqual(["notes"]);
    expect(fieldsOf(withValues(base, { notes: ["veja www.exemplo.com.br"] }))).toEqual(["notes"]);
    expect(fieldsOf(withValues(base, { notes: ["x".repeat(501)] }))).toEqual(["notes"]);
  });

  it("vários campos errados: cada nome uma vez, na ordem do contrato", () => {
    expect(fieldsOf(withValues(base, { notes: ["<x>"], "salary.minimum": ["0"], "workModel.accepted": undefined, "workModel.importance": ["?"] }))).toEqual(["workModel", "salary", "notes"]);
  });

  it("acima do teto de 12.288 bytes: o erro vai para o campo geral 'criterios'", () => {
    const big = (i: number) => `${"𝐀".repeat(38)}${String(i).padStart(2, "0")}`;
    const values = withValues(base, {
      "stack.mustHave": [Array.from({ length: 15 }, (_, i) => big(i)).join("\n")],
      "stack.niceToHave": [Array.from({ length: 30 }, (_, i) => big(i + 20)).join("\n")],
      "stack.dealBreakers": [Array.from({ length: 15 }, (_, i) => big(i + 60)).join("\n")],
      "location.cities": [Array.from({ length: 10 }, (_, i) => `${"𝐁".repeat(79)}${i}`).join("\n")],
      notes: ["𝐂".repeat(500)],
    });
    expect(fieldsOf(values)).toEqual(["criterios"]);
  });

  it("o erro nunca traz o texto do Zod nem o valor recebido", () => {
    const result = formToCriteria(withValues(base, { notes: ["CANARIO-NOTA <script>"], "salary.minimum": ["CANARIO-SALARIO"] }));
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/CANARIO|Invalid|expected|marcacao_html_proibida|too_big/i);
  });
});

describe("checkFormPairs (lista fechada de nomes)", () => {
  const pairs = formPairs(criteriaToForm(fullCriteria()));

  it("nome desconhecido, inclusive um idioma ou sinal fora do contrato: recusado", () => {
    for (const name of ["userId", "user_id", "schemaVersion", "languages.level.klingon", "redFlagTolerance.sono", "$ACTION_ID_x", "__proto__"]) {
      expect(checkFormPairs([...pairs, [name, "x"]]), name).toBeNull();
    }
  });

  it("campo de valor único repetido: recusado; lista de marcação repetida: aceita", () => {
    expect(checkFormPairs([...pairs, ["salary.minimum", "1"]])).toBeNull();
    expect(checkFormPairs([...pairs, ["notes", "outra"]])).toBeNull();
    const ok = checkFormPairs([...pairs, ["workModel.accepted", "presencial"]]);
    expect(ok?.["workModel.accepted"]).toEqual(["remoto", "hibrido", "presencial"]);
  });

  it("a caixa de 'usar este critério' só vale com 'on'", () => {
    expect(checkFormPairs([...pairs.filter(([name]) => name !== "salary.enabled"), ["salary.enabled", "true"]])).toBeNull();
  });

  it("sem par nenhum: valores vazios (o schema decide depois)", () => {
    expect(checkFormPairs([])).toEqual({});
    expect(formToCriteria({}).ok).toBe(false);
  });
});

describe("readFormBody (ADR-028 D6 passo 2)", () => {
  it("urlencoded, com charset utf-8 opcional: os pares, com + e % decodificados", async () => {
    for (const type of [URLENCODED, `${URLENCODED}; charset=utf-8`, `${URLENCODED};charset=UTF-8`, "Application/X-WWW-Form-Urlencoded"]) {
      expect(await readFormBody(type, streamOf("notes=a+b%0D%0Ac&workModel.accepted=remoto&workModel.accepted=hibrido")), type).toEqual([
        ["notes", "a b\r\nc"],
        ["workModel.accepted", "remoto"],
        ["workModel.accepted", "hibrido"],
      ]);
    }
  });

  it.each([null, "multipart/form-data; boundary=x", "application/json", "text/plain", `${URLENCODED}; charset=latin1`, `${URLENCODED}; boundary=x`])("tipo %s: recusado", async (type) => {
    expect(await readFormBody(type, streamOf("notes=x"))).toBeNull();
  });

  it("sem corpo, acima do teto ou com UTF-8 inválido: recusado", async () => {
    expect(await readFormBody(URLENCODED, null)).toBeNull();
    expect(await readFormBody(URLENCODED, streamOf(`notes=${"x".repeat(HTTP_BODY_MAX_BYTES)}`))).toBeNull();
    expect(await readFormBody(URLENCODED, streamOf(new Uint8Array([0x6e, 0x3d, 0xff])))).toBeNull();
  });

  it("no teto exato: aceito", async () => {
    const body = `notes=${"x".repeat(HTTP_BODY_MAX_BYTES - "notes=".length)}`;
    expect((await readFormBody(URLENCODED, streamOf(body)))?.[0]?.[1]).toHaveLength(HTTP_BODY_MAX_BYTES - 6);
  });

  it("stream que falha no meio: recusado", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket fechado"));
      },
    });
    expect(await readFormBody(URLENCODED, broken)).toBeNull();
  });
});
