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

  test("versão g2 (entra no extractorVersion do cache)", () => {
    expect(LLM_OUTPUT_GUARD_VERSION).toBe("g2");
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
    ["enum desconhecido", { workModels: ["metaverso"] }],
    ["enum em caixa alta", { contractTypes: ["CLT"] }],
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
    ["stack obrigatória e desejável sobrepostas", { stackNiceToHave: ["typescript"] }],
    ["UF fora do enum", { location: { city: null, stateUf: "XX", countryIso2: null } }],
  ])("%s → schema_invalido", (_name, overrides) => {
    expectRejected(inspectWith(overrides), "schema_invalido");
  });

  test("1e400 vira Infinity no parse e o schema recusa", () => {
    const raw = JSON.stringify(validFacts()).replace('"yearsExperienceMin":3', '"yearsExperienceMin":1e400');
    expect(raw).toContain("1e400");
    expectRejected(guard.inspect(raw), "schema_invalido");
  });

  test("chave faltando não ganha valor padrão", () => {
    const facts = validFacts();
    delete facts["salary"];
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

  test("cidade esvaziada sem UF nem país: a localização inteira vira null", () => {
    const result = expectOk(inspectWith({ location: { city: "https://x.example", stateUf: null, countryIso2: null } }));
    expect(result.facts.location).toBeNull();
    expect(result.sanitization.injectionSignal).toBe(true);
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
