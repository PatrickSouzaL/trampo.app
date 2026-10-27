// LlmOutputGuard (E5): saídas maliciosas do LLM, tetos e saneamento contado (ADR-008).
import { JobFactsSchema } from "@trampo/contracts/job-facts";
import { containsUrlLike } from "@trampo/contracts/primitives";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  ARRAY_MAX_ITEMS,
  FREE_TEXT_MAX_CHARS,
  LLM_OUTPUT_GUARD_VERSION,
  LLM_OUTPUT_MAX_BYTES,
  LlmOutputGuard,
  type LlmOutputGuardResult,
  type LlmOutputSanitization,
} from "../../src/application/index.js";
import { bestOfThree } from "../domain/timing.js";

const guard = new LlmOutputGuard();

function validFacts(): Record<string, unknown> {
  return {
    title: "Desenvolvedor Backend Pleno",
    seniorityLevels: ["pleno"],
    yearsExperienceMin: 3,
    workModels: ["remoto"],
    location: { city: "São Paulo", stateUf: "SP", countryIso2: "BR" },
    salary: { min: 8000, max: 12000, currency: "BRL", period: "mes" },
    contractTypes: ["clt"],
    stackRequired: ["TypeScript", "Node.js"],
    stackNiceToHave: ["Kubernetes"],
    benefits: ["plano_saude"],
    languageRequirements: [{ language: "ingles", level: "intermediario", required: false }],
    redFlagSignals: [],
    extractionConfidence: 0.8,
  };
}

function inspectWith(overrides: Record<string, unknown>): LlmOutputGuardResult {
  return guard.inspect(JSON.stringify({ ...validFacts(), ...overrides }));
}

const CLEAN: LlmOutputSanitization = {
  urlsRemoved: 0,
  hiddenOrMarkupRemoved: 0,
  malformedItemsRemoved: 0,
  offEnumItemsRemoved: 0,
  absentValuesNormalized: 0,
  stackOverlapsResolved: 0,
  duplicatesRemoved: 0,
  itemsCut: 0,
  textTruncated: false,
  injectionSignal: false,
};

function expectOk(result: LlmOutputGuardResult) {
  if (!result.ok) throw new Error(`esperava ok, veio ${result.reason}`);
  return result;
}

function expectRejected(result: LlmOutputGuardResult, reason: string): void {
  expect(result).toStrictEqual({ ok: false, reason });
}

describe("LlmOutputGuard: caminho feliz", () => {
  test("saída válida passa intacta, sem saneamento", () => {
    const result = expectOk(guard.inspect(JSON.stringify(validFacts())));
    expect(result.facts).toStrictEqual(validFacts());
    expect(result.sanitization).toStrictEqual(CLEAN);
  });

  test("versão g4 (entra no extractorVersion do cache)", () => {
    expect(LLM_OUTPUT_GUARD_VERSION).toBe("g4");
  });

  test("os fatos devolvidos são objetos com protótipo padrão, construídos pelo Zod", () => {
    const result = expectOk(guard.inspect(JSON.stringify(validFacts())));
    expect(Object.getPrototypeOf(result.facts)).toBe(Object.prototype);
  });

  test("uma saída realista e cheia cabe com folga nos 8 KiB", () => {
    const tags = (prefix: string) => Array.from({ length: 30 }, (_, i) => `${prefix}Framework${i}`);
    const full = {
      ...validFacts(),
      title: "Pessoa Desenvolvedora Full Stack Sênior com foco em plataformas de pagamento e alta disponibilidade",
      seniorityLevels: ["pleno", "senior", "especialista"],
      workModels: ["remoto", "hibrido", "presencial"],
      contractTypes: ["clt", "pj", "cooperado", "estagio", "temporario"],
      stackRequired: tags("Req"),
      stackNiceToHave: tags("Nice"),
      benefits: JobFactsSchema.shape.benefits.element.options,
      languageRequirements: ["ingles", "espanhol", "frances", "alemao", "italiano"].map((language) => ({
        language,
        level: "avancado",
        required: true,
      })),
      redFlagSignals: ["salario_omitido", "escopo_excessivo"],
    };
    const raw = JSON.stringify(full, null, 2);
    expect(new TextEncoder().encode(raw).length).toBeLessThan(LLM_OUTPUT_MAX_BYTES / 2);
    expect(expectOk(guard.inspect(raw)).sanitization).toStrictEqual(CLEAN);
  });
});

describe("LlmOutputGuard: teto em bytes antes do parse", () => {
  test("um byte acima do teto é recusado mesmo sendo JSON válido", () => {
    const base = JSON.stringify(validFacts());
    const padded = base + " ".repeat(LLM_OUTPUT_MAX_BYTES - new TextEncoder().encode(base).length);
    expect(new TextEncoder().encode(padded).length).toBe(LLM_OUTPUT_MAX_BYTES);
    expect(guard.inspect(padded).ok).toBe(true);
    expectRejected(guard.inspect(`${padded} `), "resposta_grande_demais");
  });

  test("o teto é em bytes UTF-8, não em unidades UTF-16", () => {
    // 2.731 × "€" (3 bytes) = 8.193 bytes em só 2.733 unidades.
    const raw = JSON.stringify("€".repeat(2_731));
    expect(raw.length).toBeLessThan(LLM_OUTPUT_MAX_BYTES);
    expectRejected(guard.inspect(raw), "resposta_grande_demais");
  });

  test("JSON gigante (1 MiB) é recusado sem parse", () => {
    expectRejected(guard.inspect(`[${"1,".repeat(524_288)}1]`), "resposta_grande_demais");
  });
});

describe("LlmOutputGuard: parse seguro", () => {
  test.each([
    ["vazia", ""],
    ["truncada", JSON.stringify(validFacts()).slice(0, -10)],
    ["cerca de markdown", `\`\`\`json\n${JSON.stringify(validFacts())}\n\`\`\``],
    ["vírgula sobrando", '{"title": "x",}'],
    ["BOM", `﻿${JSON.stringify(validFacts())}`],
    ["NaN literal", '{"extractionConfidence": NaN}'],
    ["comentário", "// nota\n{}"],
    ["aspas simples", "{'title': 'x'}"],
  ])("resposta %s → json_invalido", (_name, raw) => {
    expectRejected(guard.inspect(raw), "json_invalido");
  });

  test.each([null, undefined, 42, {}, ["{}"], new Uint8Array([123, 125])])(
    "entrada não textual (%s) → json_invalido, sem lançar",
    (raw) => {
      expectRejected(guard.inspect(raw), "json_invalido");
    },
  );

  test.each([
    ["__proto__ na raiz", '{"__proto__": {"polluted": true}}'],
    ["__proto__ aninhado", '{"location": {"__proto__": {"polluted": true}}}'],
    ["__proto__ escapado", '{"\\u005f_proto__": {"polluted": true}}'],
    ["__proto__ dentro de array", '{"languageRequirements": [{"__proto__": {"x": 1}}]}'],
    ["constructor.prototype", '{"constructor": {"prototype": {"polluted": true}}}'],
    ["constructor sozinho", '{"title": "x", "constructor": 1}'],
  ])("%s → poluicao_de_prototipo", (_name, raw) => {
    expectRejected(guard.inspect(raw), "poluicao_de_prototipo");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("aninhamento profundo até o teto não lança (o estouro de pilha do reviver vira falha)", () => {
    const depth = LLM_OUTPUT_MAX_BYTES / 2;
    for (const raw of [`${"[".repeat(depth)}${"]".repeat(depth)}`, `${'{"a":'.repeat(1_600)}1${"}".repeat(1_600)}`]) {
      expect(guard.inspect(raw).ok).toBe(false);
    }
  });
});

describe("LlmOutputGuard: JobFactsSchema estrito, sem coerção", () => {
  test.each([
    ["chave extra", { score: 100 }],
    ["chave extra de veredito", { verdict: "aceitar" }],
    ["title numérico", { title: 42 }],
    ["anos como string", { yearsExperienceMin: "3" }],
    ["anos fracionários", { yearsExperienceMin: 2.5 }],
    ["confiança como string NaN", { extractionConfidence: "NaN" }],
    ["confiança acima de 1", { extractionConfidence: 1.01 }],
    ["confiança booleana", { extractionConfidence: true }],
    ["salário 1e308", { salary: { min: 1e308, max: null, currency: "BRL", period: "mes" } }],
    ["salário negativo", { salary: { min: -1, max: null, currency: "BRL", period: "mes" } }],
    ["salário min > max", { salary: { min: 9000, max: 8000, currency: "BRL", period: "mes" } }],
    ["moeda fora do enum (o g3 não mexe em salário)", { salary: { min: 9000, max: null, currency: "ARG", period: "mes" } }],
    ["período fora do enum", { salary: { min: 9000, max: null, currency: "BRL", period: "semana" } }],
    ["confiança null", { extractionConfidence: null }],
    ["null dentro de array de enum", { benefits: [null] }],
    ["idioma fora do enum (objeto, não enum)", { languageRequirements: [{ language: "russo", level: null, required: true }] }],
    ["array no lugar de objeto", { location: ["São Paulo"] }],
    ["string no lugar de array", { stackRequired: "TypeScript" }],
    ["objeto dentro de tags", { stackRequired: [{ name: "TypeScript" }] }],
    ["número dentro de enum array", { seniorityLevels: [1] }],
    ["redFlag como objeto", { redFlagSignals: { a: 1 } }],
    ["idiomas como string", { languageRequirements: "ingles" }],
    ["idioma repetido", { languageRequirements: [
      { language: "ingles", level: null, required: true },
      { language: "ingles", level: "fluente", required: false },
    ] }],
    ["UF fora do enum", { location: { city: null, stateUf: "XX", countryIso2: null } }],
  ])("%s → schema_invalido", (_name, overrides) => {
    expectRejected(inspectWith(overrides), "schema_invalido");
  });

  test("1e400 vira Infinity no parse e o schema recusa", () => {
    const raw = JSON.stringify(validFacts()).replace('"yearsExperienceMin":3', '"yearsExperienceMin":1e400');
    expect(raw).toContain("1e400");
    expectRejected(guard.inspect(raw), "schema_invalido");
  });

  test.each(["salary", "benefits", "languageRequirements", "location"])("chave %s faltando não ganha valor padrão", (key) => {
    const facts = validFacts();
    delete facts[key];
    expectRejected(guard.inspect(JSON.stringify(facts)), "schema_invalido");
  });

  test.each([["null", "null"], ["array", "[]"], ["número", "1"], ["string", '"fatos"']])(
    "raiz %s → schema_invalido",
    (_name, raw) => {
      expectRejected(guard.inspect(raw), "schema_invalido");
    },
  );

  test("a falha carrega só o motivo: nada da resposta volta", () => {
    const result = inspectWith({ title: "x", leak: "SEGREDO-DO-LLM" });
    expect(Object.keys(result)).toStrictEqual(["ok", "reason"]);
    expect(JSON.stringify(result)).not.toContain("SEGREDO");
  });
});

describe("LlmOutputGuard: texto livre sem URL", () => {
  test.each([
    ["https", "Dev Backend https://evil.example/candidatar", "Dev Backend"],
    ["www", "Dev Backend www.vagas-falsas.net agora", "Dev Backend agora"],
    ["encurtador", "Dev Backend bit.ly/abc", "Dev Backend"],
    ["domínio nu", "Dev Backend golpe.com", "Dev Backend"],
    ["javascript:", "Dev javascript:alert(1) Backend", "Dev Backend"],
    ["data:", "Dev data:text/html;base64,PHN2Zz4= Backend", "Dev Backend"],
    ["e-mail", "Dev Backend rh@empresa.com.br", "Dev Backend"],
    ["markdown", "Dev [clique](aqui) Backend", "Dev Backend"],
    ["javascript em largura total (NFKC)", "Dev ｊａｖａｓｃｒｉｐｔ：alert(1) Backend", "Dev Backend"],
    ["URL escondida com invisível no meio", "Dev java​script:alert(1)", "Dev"],
    ["URL formada ao remover < >", "Dev javascript<:alert(1)", "Dev"],
  ])("title com %s: token removido e contado", (_name, title, expected) => {
    const result = expectOk(inspectWith({ title }));
    expect(result.facts.title).toBe(expected);
    expect(result.sanitization.urlsRemoved).toBeGreaterThan(0);
    expect(result.sanitization.injectionSignal).toBe(true);
  });

  test("nomes de tecnologia com ponto passam (Node.js, Socket.io, ASP.NET)", () => {
    const result = expectOk(inspectWith({ title: "Dev Node.js, Socket.io e ASP.NET" }));
    expect(result.facts.title).toBe("Dev Node.js, Socket.io e ASP.NET");
    expect(result.sanitization).toStrictEqual(CLEAN);
  });

  test("title que só tinha URL vira null (não informado)", () => {
    const result = expectOk(inspectWith({ title: "https://evil.example" }));
    expect(result.facts.title).toBeNull();
    expect(result.sanitization.urlsRemoved).toBe(1);
  });

  test("invisíveis, bidi e Unicode Tags saem e são contados", () => {
    const title = "Dev​ Back‮end\u{E0041}\u{E0042} Pleno\u0000";
    const result = expectOk(inspectWith({ title }));
    expect(result.facts.title).toBe("Dev Backend Pleno");
    expect(result.sanitization.hiddenOrMarkupRemoved).toBe(5);
    expect(result.sanitization.injectionSignal).toBe(true);
  });

  test("< e > saem do texto e contam como marcação", () => {
    const result = expectOk(inspectWith({ title: "<b>Dev</b> Backend" }));
    expect(result.facts.title).toBe("bDev/b Backend");
    expect(result.sanitization.hiddenOrMarkupRemoved).toBe(4);
  });

  test("quebras de linha, TAB e espaços Unicode viram um espaço só", () => {
    const result = expectOk(inspectWith({ title: "  Dev\n\nBackend\tPleno  Sênior  " }));
    expect(result.facts.title).toBe("Dev Backend Pleno Sênior");
    expect(result.sanitization).toStrictEqual(CLEAN);
  });

  test("NFKC no começo (largura total) e no fim (recompõe o que o invisível separou)", () => {
    const result = expectOk(inspectWith({ title: "Ｄｅｖ Cafe​́" }));
    expect(result.facts.title).toBe("Dev Café");
    expect(result.facts.title).toBe(result.facts.title?.normalize("NFKC"));
  });

  test("corta no teto do title e marca o truncamento", () => {
    const result = expectOk(inspectWith({ title: "a".repeat(FREE_TEXT_MAX_CHARS.title + 50) }));
    expect(result.facts.title).toBe("a".repeat(FREE_TEXT_MAX_CHARS.title));
    expect(result.sanitization.textTruncated).toBe(true);
    expect(result.sanitization.injectionSignal).toBe(false);
  });

  test("o corte acontece antes da busca de URL: corte que forma domínio é pego", () => {
    // Inteiro, "golpe.cnz" não parece URL; cortado no teto, "golpe.cn" parece.
    const title = `${"a".repeat(FREE_TEXT_MAX_CHARS.title - 9)} golpe.cnz`;
    expect(containsUrlLike(title)).toBe(false);
    const result = expectOk(inspectWith({ title }));
    expect(result.facts.title).toBe("a".repeat(FREE_TEXT_MAX_CHARS.title - 9));
    expect(result.sanitization).toMatchObject({ textTruncated: true, urlsRemoved: 1 });
  });

  test("teto em code points: emoji conta 1", () => {
    const result = expectOk(inspectWith({ title: "🚀".repeat(FREE_TEXT_MAX_CHARS.title) }));
    expect(result.sanitization.textTruncated).toBe(false);
  });
});

describe("LlmOutputGuard: localização", () => {
  test("cidade com URL perde o token e mantém o resto", () => {
    const result = expectOk(inspectWith({ location: { city: "Campinas bit.ly/x", stateUf: "SP", countryIso2: "BR" } }));
    expect(result.facts.location).toStrictEqual({ city: "Campinas", stateUf: "SP", countryIso2: "BR" });
    expect(result.sanitization.urlsRemoved).toBe(1);
  });

  test("cidade esvaziada com UF presente vira city null", () => {
    const result = expectOk(inspectWith({ location: { city: "www.golpe.io", stateUf: "SP", countryIso2: null } }));
    expect(result.facts.location).toStrictEqual({ city: null, stateUf: "SP", countryIso2: null });
  });

  test("cidade esvaziada sem UF nem país: a localização inteira vira null, contada uma vez", () => {
    const result = expectOk(inspectWith({ location: { city: "https://x.example", stateUf: null, countryIso2: null } }));
    expect(result.facts.location).toBeNull();
    expect(result.sanitization).toStrictEqual({
      ...CLEAN,
      urlsRemoved: 1,
      absentValuesNormalized: 1,
      injectionSignal: true,
    });
  });

  test("g3: os três campos nulos vindos do modelo viram location null, sem sinal de injection", () => {
    const result = expectOk(inspectWith({ location: { city: null, stateUf: null, countryIso2: null } }));
    expect(result.facts.location).toBeNull();
    expect(result.sanitization).toStrictEqual({ ...CLEAN, absentValuesNormalized: 1 });
  });

  test("g3: cidade em branco sem UF nem país também vira location null", () => {
    const result = expectOk(inspectWith({ location: { city: " \n ", stateUf: null, countryIso2: null } }));
    expect(result.facts.location).toBeNull();
    expect(result.sanitization).toStrictEqual({ ...CLEAN, absentValuesNormalized: 1 });
  });

  test.each([
    ["chave extra com os três nulos", { city: null, stateUf: null, countryIso2: null, bairro: null }],
    ["chave extra com a cidade esvaziada", { city: "https://x.example", stateUf: null, countryIso2: null, extra: 1 }],
    ["faltando o país", { city: null, stateUf: null }],
    ["objeto vazio", {}],
    ["chave com o nome errado (country)", { city: null, stateUf: null, country: null }],
  ])("g3: %s não vira null; o Zod reprova a forma", (_name, location) => {
    expectRejected(inspectWith({ location }), "schema_invalido");
  });

  test("corta a cidade no teto de 80", () => {
    const result = expectOk(inspectWith({ location: { city: "b".repeat(100), stateUf: null, countryIso2: null } }));
    expect(result.facts.location?.city).toBe("b".repeat(FREE_TEXT_MAX_CHARS.city));
  });

  test("localização null e cidade null passam sem saneamento", () => {
    expect(expectOk(inspectWith({ location: null })).sanitization).toStrictEqual(CLEAN);
    const noCity = expectOk(inspectWith({ location: { city: null, stateUf: "RJ", countryIso2: "BR" } }));
    expect(noCity.sanitization).toStrictEqual(CLEAN);
  });

  test("cidade com tipo errado não é convertida", () => {
    expectRejected(inspectWith({ location: { city: 123, stateUf: "SP", countryIso2: "BR" } }), "schema_invalido");
  });
});

describe("LlmOutputGuard: tags de tecnologia", () => {
  test("tag com URL, invisível, marcação ou fora do padrão sai inteira, e cada uma é contada", () => {
    const result = expectOk(
      inspectWith({
        stackRequired: ["TypeScript", "evil.com/x", "javascript:alert(1)", "React​", "Node.js<x>", "Rust!", "Go"],
        stackNiceToHave: [],
      }),
    );
    expect(result.facts.stackRequired).toStrictEqual(["TypeScript", "Go"]);
    expect(result.sanitization).toMatchObject({
      urlsRemoved: 2,
      hiddenOrMarkupRemoved: 2,
      malformedItemsRemoved: 1,
      injectionSignal: true,
    });
  });

  test("NFKC e aparo nas tags; duplicata sem diferenciar caixa sai (fica a primeira)", () => {
    const result = expectOk(inspectWith({ stackRequired: [" Ｒｅａｃｔ ", "react", "REACT", "C#"], stackNiceToHave: [] }));
    expect(result.facts.stackRequired).toStrictEqual(["React", "C#"]);
    expect(result.sanitization).toMatchObject({ duplicatesRemoved: 2, injectionSignal: false });
  });

  test("corta as tags no máximo do schema e conta o corte", () => {
    const tags = Array.from({ length: 45 }, (_, i) => `Lib${i}`);
    const result = expectOk(inspectWith({ stackRequired: tags, stackNiceToHave: [] }));
    expect(result.facts.stackRequired).toStrictEqual(tags.slice(0, ARRAY_MAX_ITEMS.stackRequired));
    expect(result.sanitization).toMatchObject({ itemsCut: 15, injectionSignal: false });
  });

  test("array enorme de tags é recusado pelo teto em bytes antes de qualquer trabalho", () => {
    const tags = Array.from({ length: 5_000 }, (_, i) => `T${i}`);
    expectRejected(inspectWith({ stackRequired: tags }), "resposta_grande_demais");
  });

  test("surrogate órfão na tag vira U+FFFD e a tag sai como malformada", () => {
    const raw = JSON.stringify({ ...validFacts(), stackNiceToHave: ["Kubernetes"] }).replace(
      '"Kubernetes"',
      '"Kube\\ud800"',
    );
    const result = expectOk(guard.inspect(raw));
    expect(result.facts.stackNiceToHave).toStrictEqual([]);
    expect(result.sanitization.malformedItemsRemoved).toBe(1);
  });
});

describe("LlmOutputGuard: arrays de enum e idiomas", () => {
  test("duplicata exata sai e o corte vale no máximo do schema", () => {
    const result = expectOk(
      inspectWith({ seniorityLevels: ["pleno", "pleno", "junior", "senior", "especialista"], redFlagSignals: ["linguagem_vaga", "linguagem_vaga"] }),
    );
    expect(result.facts.seniorityLevels).toStrictEqual(["pleno", "junior", "senior"]);
    expect(result.facts.redFlagSignals).toStrictEqual(["linguagem_vaga"]);
    expect(result.sanitization).toMatchObject({ duplicatesRemoved: 2, itemsCut: 1, injectionSignal: false });
  });

  test("idiomas: corta em 5", () => {
    const languages = ["ingles", "espanhol", "frances", "alemao", "italiano", "mandarim", "japones"];
    const result = expectOk(
      inspectWith({ languageRequirements: languages.map((language) => ({ language, level: null, required: false })) }),
    );
    expect(result.facts.languageRequirements.map((l) => l.language)).toStrictEqual(languages.slice(0, 5));
    expect(result.sanitization.itemsCut).toBe(2);
  });
});

const ENUM_ARRAY_KEYS = ["seniorityLevels", "workModels", "contractTypes", "benefits", "redFlagSignals"] as const;

function field(result: { readonly facts: unknown }, key: string): unknown {
  return (result.facts as Record<string, unknown>)[key];
}

describe("LlmOutputGuard g3: item fora do enum sai, sem virar outro valor", () => {
  test("os benefícios do diagnóstico do S-1 saem e não são mapeados (vale_transporte, auxilio_refeicao, gympass)", () => {
    const result = expectOk(inspectWith({ benefits: ["plano_saude", "vale_transporte", "auxilio_refeicao", "gympass"] }));
    expect(result.facts.benefits).toStrictEqual(["plano_saude"]);
    expect(result.sanitization).toStrictEqual({ ...CLEAN, offEnumItemsRemoved: 3 });
  });

  // Cada campo recebe um valor válido em OUTRO enum: prova que cada um usa a própria lista do contrato.
  test.each([
    ["seniorityLevels", ["pleno", "hibrido"], ["pleno"]],
    ["workModels", ["remoto", "pleno"], ["remoto"]],
    ["contractTypes", ["clt", "remoto"], ["clt"]],
    ["benefits", ["outro", "clt"], ["outro"]],
    ["redFlagSignals", ["linguagem_vaga", "plano_saude"], ["linguagem_vaga"]],
  ])("%s usa a própria lista do contrato", (key, input, expected) => {
    const result = expectOk(inspectWith({ [key]: input }));
    expect(field(result, key)).toStrictEqual(expected);
    expect(result.sanitization).toStrictEqual({ ...CLEAN, offEnumItemsRemoved: 1 });
  });

  test("todo valor do contrato passa intacto, em cada campo de enum", () => {
    for (const key of ENUM_ARRAY_KEYS) {
      for (const value of JobFactsSchema.shape[key].element.options) {
        const result = expectOk(inspectWith({ [key]: [value] }));
        expect(field(result, key)).toStrictEqual([value]);
        expect(result.sanitization).toStrictEqual(CLEAN);
      }
    }
  });

  test("comparação exata: caixa, espaço e largura total não são normalizados", () => {
    const result = expectOk(inspectWith({ contractTypes: ["CLT", " clt", "ｃｌｔ", "Pj"], workModels: ["Remoto"] }));
    expect(result.facts.contractTypes).toStrictEqual([]);
    expect(result.facts.workModels).toStrictEqual([]);
    expect(result.sanitization).toStrictEqual({ ...CLEAN, offEnumItemsRemoved: 5 });
  });

  test("nomes de propriedade do protótipo e a string vazia saem como qualquer valor fora do enum", () => {
    const result = expectOk(inspectWith({ benefits: ["__proto__", "constructor", "toString", "hasOwnProperty", ""] }));
    expect(result.facts.benefits).toStrictEqual([]);
    expect(result.sanitization).toStrictEqual({ ...CLEAN, offEnumItemsRemoved: 5 });
  });

  test("a remoção vem antes da duplicata e do corte: o item removido não ocupa vaga", () => {
    const all = JobFactsSchema.shape.benefits.element.options;
    expect(all).toHaveLength(ARRAY_MAX_ITEMS.benefits);
    const result = expectOk(inspectWith({ benefits: ["vale_transporte", "gympass", ...all, "outro"] }));
    expect(result.facts.benefits).toStrictEqual(all);
    expect(result.sanitization).toStrictEqual({ ...CLEAN, offEnumItemsRemoved: 2, duplicatesRemoved: 1 });
  });

  test("valor fora do enum repetido conta como fora do enum, não como duplicata", () => {
    const result = expectOk(inspectWith({ contractTypes: ["tempo_integral", "tempo_integral", "pj"] }));
    expect(result.facts.contractTypes).toStrictEqual(["pj"]);
    expect(result.sanitization).toStrictEqual({ ...CLEAN, offEnumItemsRemoved: 2 });
  });

  test("os contadores novos não acendem o sinal de injection; URL no título continua acendendo", () => {
    const quiet = expectOk(inspectWith({ benefits: ["vale_transporte"], languageRequirements: null }));
    expect(quiet.sanitization).toStrictEqual({ ...CLEAN, offEnumItemsRemoved: 1, absentValuesNormalized: 1 });
    const loud = expectOk(inspectWith({ title: "Dev https://x.example", benefits: ["vale_transporte"] }));
    expect(loud.sanitization).toStrictEqual({ ...CLEAN, urlsRemoved: 1, offEnumItemsRemoved: 1, injectionSignal: true });
  });
});

describe("LlmOutputGuard g3: null num campo de array vira []", () => {
  test.each(Object.keys(ARRAY_MAX_ITEMS))("%s: null vira [], contado e sem sinal de injection", (key) => {
    const result = expectOk(inspectWith({ [key]: null }));
    expect(field(result, key)).toStrictEqual([]);
    expect(result.sanitization).toStrictEqual({ ...CLEAN, absentValuesNormalized: 1 });
  });

  test("os 8 campos de array nulos de uma vez contam 8", () => {
    const nulls = Object.fromEntries(Object.keys(ARRAY_MAX_ITEMS).map((key) => [key, null]));
    const result = expectOk(inspectWith(nulls));
    expect(result.sanitization).toStrictEqual({ ...CLEAN, absentValuesNormalized: 8 });
  });

  test("os três achados do diagnóstico do S-1, juntos, passam (fatos sintéticos)", () => {
    const result = expectOk(
      inspectWith({
        benefits: ["plano_saude", "vale_transporte"],
        languageRequirements: null,
        location: { city: null, stateUf: null, countryIso2: null },
      }),
    );
    expect(result.facts).toMatchObject({ benefits: ["plano_saude"], languageRequirements: [], location: null });
    expect(result.sanitization).toStrictEqual({ ...CLEAN, offEnumItemsRemoved: 1, absentValuesNormalized: 2 });
  });

  test("null fora dos campos de array não é trocado: title, anos, location e salary continuam null", () => {
    const result = expectOk(inspectWith({ title: null, yearsExperienceMin: null, location: null, salary: null }));
    expect(result.facts).toMatchObject({ title: null, yearsExperienceMin: null, location: null, salary: null });
    expect(result.sanitization).toStrictEqual(CLEAN);
  });
});

describe("LlmOutputGuard g4: termo nas duas listas de stack fica só no desejável", () => {
  test("sai do exigido, fica no desejável e é contado, sem diferenciar caixa e sem sinal de injection", () => {
    const result = expectOk(inspectWith({ stackRequired: ["TypeScript", "Node.js"], stackNiceToHave: ["typescript"] }));
    expect(result.facts.stackRequired).toStrictEqual(["Node.js"]);
    expect(result.facts.stackNiceToHave).toStrictEqual(["typescript"]);
    expect(result.sanitization).toStrictEqual({ ...CLEAN, stackOverlapsResolved: 1 });
  });

  test("as 3 recusas do aceite do p2 (sobreposição), com fatos sintéticos, passam no guard", () => {
    const result = expectOk(
      inspectWith({
        stackRequired: ["Python", "SQL", "Airflow", "AWS"],
        stackNiceToHave: ["Airflow", "aws", "Databricks", "sql"],
      }),
    );
    expect(result.facts.stackRequired).toStrictEqual(["Python"]);
    expect(result.facts.stackNiceToHave).toStrictEqual(["Airflow", "aws", "Databricks", "sql"]);
    expect(result.sanitization).toStrictEqual({ ...CLEAN, stackOverlapsResolved: 3 });
  });

  test("compara com o desejável já saneado: NFKC e aparo nos dois lados", () => {
    const result = expectOk(inspectWith({ stackRequired: [" Ｒｅａｃｔ ", "Go"], stackNiceToHave: ["react "] }));
    expect(result.facts.stackRequired).toStrictEqual(["Go"]);
    expect(result.facts.stackNiceToHave).toStrictEqual(["react"]);
    expect(result.sanitization).toStrictEqual({ ...CLEAN, stackOverlapsResolved: 1 });
  });

  test("tag do desejável que o saneamento removeu não tira nada do exigido", () => {
    const result = expectOk(inspectWith({ stackRequired: ["Go"], stackNiceToHave: ["Go<x>", "Go!"] }));
    expect(result.facts.stackRequired).toStrictEqual(["Go"]);
    expect(result.facts.stackNiceToHave).toStrictEqual([]);
    expect(result.sanitization).toStrictEqual({
      ...CLEAN,
      hiddenOrMarkupRemoved: 1,
      malformedItemsRemoved: 1,
      injectionSignal: true,
    });
  });

  test("termo cortado do desejável continua no exigido: nunca some das duas listas", () => {
    const nice = Array.from({ length: 31 }, (_, i) => `Nice${i}`);
    const result = expectOk(inspectWith({ stackRequired: ["Nice30", "Nice0"], stackNiceToHave: nice }));
    expect(result.facts.stackNiceToHave).toStrictEqual(nice.slice(0, ARRAY_MAX_ITEMS.stackNiceToHave));
    expect(result.facts.stackRequired).toStrictEqual(["Nice30"]);
    expect(result.sanitization).toStrictEqual({ ...CLEAN, stackOverlapsResolved: 1, itemsCut: 1 });
  });

  test("checagens de URL, marcação e formato vêm antes: cada uma conta no próprio contador", () => {
    const result = expectOk(inspectWith({ stackRequired: ["go.com/x", "Go<x>", "Go!", "Go"], stackNiceToHave: ["go"] }));
    expect(result.facts.stackRequired).toStrictEqual([]);
    expect(result.sanitization).toStrictEqual({
      ...CLEAN,
      urlsRemoved: 1,
      hiddenOrMarkupRemoved: 1,
      malformedItemsRemoved: 1,
      stackOverlapsResolved: 1,
      injectionSignal: true,
    });
  });

  test("a sobreposição vem antes da duplicata e do corte: o termo removido não ocupa vaga", () => {
    const required = ["Go", "go", ...Array.from({ length: 30 }, (_, i) => `Req${i}`)];
    const result = expectOk(inspectWith({ stackRequired: required, stackNiceToHave: ["GO"] }));
    expect(result.facts.stackRequired).toStrictEqual(required.slice(2));
    expect(result.sanitization).toStrictEqual({ ...CLEAN, stackOverlapsResolved: 2 });
  });

  test("desejável que não é array não tira nada do exigido, e o Zod reprova o tipo", () => {
    expectRejected(inspectWith({ stackRequired: ["Go"], stackNiceToHave: "Go" }), "schema_invalido");
    expectRejected(inspectWith({ stackRequired: ["Go"], stackNiceToHave: { Go: 1 } }), "schema_invalido");
    // Objeto sem conversão para primitivo: o guard nunca lança.
    const hostile = { toString: 1, valueOf: 1 };
    expectRejected(inspectWith({ stackRequired: ["Go"], stackNiceToHave: hostile }), "schema_invalido");
  });

  test("tag exigida malformada que só casa em minúsculas continua malformada, não sobreposição", () => {
    // "İ".toLowerCase() é "i" + U+0307: a forma em minúsculas do termo válido reprova no TECH_TAG_PATTERN.
    const result = expectOk(inspectWith({ stackRequired: ["i̇os", "Go"], stackNiceToHave: ["İOS"] }));
    expect(result.facts.stackRequired).toStrictEqual(["Go"]);
    expect(result.facts.stackNiceToHave).toStrictEqual(["İOS"]);
    expect(result.sanitization).toStrictEqual({ ...CLEAN, malformedItemsRemoved: 1 });
  });

  test("item do desejável que não é string não entra na comparação, e o Zod reprova", () => {
    expectRejected(inspectWith({ stackRequired: ["Go"], stackNiceToHave: ["Go", 1] }), "schema_invalido");
  });

  test("o desejável nunca perde item por causa do exigido", () => {
    const result = expectOk(inspectWith({ stackRequired: ["Kotlin", "Java"], stackNiceToHave: ["JAVA", "Kotlin"] }));
    expect(result.facts.stackNiceToHave).toStrictEqual(["JAVA", "Kotlin"]);
    expect(result.facts.stackRequired).toStrictEqual([]);
  });

  test("nomes de propriedade do protótipo nas duas listas: comparação por Set, nada poluído", () => {
    const result = expectOk(inspectWith({ stackRequired: ["constructor", "toString"], stackNiceToHave: ["toString"] }));
    expect(result.facts.stackRequired).toStrictEqual(["constructor"]);
    expect(result.sanitization).toStrictEqual({ ...CLEAN, stackOverlapsResolved: 1 });
  });

  test("o contador não acende o sinal de injection; URL no título continua acendendo", () => {
    const loud = expectOk(inspectWith({ title: "Dev https://x.example", stackNiceToHave: ["TypeScript"] }));
    expect(loud.sanitization).toStrictEqual({ ...CLEAN, urlsRemoved: 1, stackOverlapsResolved: 1, injectionSignal: true });
  });
});

describe("LlmOutputGuard: tetos espelham o contrato", () => {
  const jsonSchema = z.toJSONSchema(JobFactsSchema, { io: "output" }) as {
    properties: Record<string, { maxItems?: number; maxLength?: number; anyOf?: { maxLength?: number; properties?: Record<string, { anyOf?: { maxLength?: number }[] }> }[] }>;
  };

  test("ARRAY_MAX_ITEMS = maxItems de cada array do JobFactsSchema", () => {
    const fromSchema = Object.fromEntries(
      Object.entries(jsonSchema.properties)
        .filter(([, property]) => property.maxItems !== undefined)
        .map(([key, property]) => [key, property.maxItems]),
    );
    expect(fromSchema).toStrictEqual(ARRAY_MAX_ITEMS);
  });

  test("FREE_TEXT_MAX_CHARS = maxLength de title e de location.city", () => {
    const title = jsonSchema.properties["title"]?.anyOf?.find((variant) => variant.maxLength !== undefined);
    const location = jsonSchema.properties["location"]?.anyOf?.find((variant) => variant.properties !== undefined);
    const city = location?.properties?.["city"]?.anyOf?.find((variant) => variant.maxLength !== undefined);
    expect({ title: title?.maxLength, city: city?.maxLength }).toStrictEqual(FREE_TEXT_MAX_CHARS);
  });
});

describe("LlmOutputGuard: custo linear (SR-09)", () => {
  test("8 KiB patológicos num título levam menos de 200 ms", () => {
    const hostile = "a.".repeat(1_000) + "ｗｗｗ".repeat(200) + "​<".repeat(300);
    const raw = JSON.stringify({ ...validFacts(), title: hostile });
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(LLM_OUTPUT_MAX_BYTES);
    const { result, elapsedMs } = bestOfThree(() => guard.inspect(raw));
    expect(result.ok).toBe(true);
    expect(elapsedMs).toBeLessThan(200);
  });
});
