// F1-DOM-04 (ADR-016 D2, D3 e D6): dobra e casamento com fronteira, contexto de linha, TechDictionary e
// menções de stack (negação, diferencial, ambíguos, mistura de scripts e sobreposição de aliases).
import { TechTagSchema } from "@trampo/contracts";
import { describe, expect, test } from "vitest";

import {
  LOOK_AROUND_CHARS,
  containsAny,
  findAll,
  fold,
  isWordChar,
  itemAt,
  lineAt,
  perLine,
  splitLines,
  textAfter,
  textBefore,
  tokens,
} from "../../src/domain/prefilter/folding.js";
import { classifyLines, headingKind, isHeading, isListItem } from "../../src/domain/prefilter/line-context.js";
import { clauseBefore, detectStack, guessLanguage, isExplicitMention, type TextLanguage } from "../../src/domain/prefilter/stack-mentions.js";
import {
  DICTIONARY_ALIASES,
  DICTIONARY_TERMS,
  TECH_DICTIONARY_VERSION,
  parseDictionaryRow,
} from "../../src/domain/prefilter/tech-dictionary.js";
import { signalsOf } from "./fakes/pre-filter-harness.js";

describe("dobra (T15, mitigação 3)", () => {
  test("minúsculas, sem acento, e o İ turco sem ponto combinante", () => {
    expect(fold("Experiência SÊNIOR em AÇÃO İ").text).toBe("experiencia senior em acao i");
  });

  test("confundíveis cirílicos e gregos viram latim e as posições ficam marcadas", () => {
    const out = fold("РНР e jаvа e αβ");
    expect(out.text).toBe("php e java e ab");
    expect([...out.confusableAt].sort((a, b) => a - b)).toEqual([0, 1, 2, 7, 9, 13, 14]);
  });

  test("texto sem confundível não marca posição", () => {
    expect(fold("php").confusableAt.size).toBe(0);
  });
});

describe("casamento com fronteira", () => {
  test.each([
    ["a", true], ["z", true], ["0", true], ["9", true], ["é", true], ["ж", true], ["ß", true], ["日", true], ["٣", true],
    ["", false], [" ", false], ["-", false], ["`", false], ["{", false], ["/", false], [":", false], ["@", false], ["A", false],
    ["“", false], ["‹", false], ["€", false], [" ", false], ["\uD83D", false],
  ])("isWordChar(%j) = %s", (ch, expected) => {
    expect(isWordChar(ch)).toBe(expected);
  });

  test("fronteira de palavra nas duas pontas", () => {
    expect(findAll("java javascript java, xjava java", "java")).toEqual([0, 16, 28]);
    expect(findAll("javajava", "java")).toEqual([]);
  });

  test("pontuação não ASCII é fronteira: aspas curvas e o ‹ do < neutralizado", () => {
    expect(findAll("“java” ‹java› «java»", "java")).toEqual([1, 8, 15]);
  });

  test("ponta que não é letra nem dígito dispensa fronteira", () => {
    expect(findAll("c#, xc#y", "c#")).toEqual([0]);
    expect(findAll("pl/sql", "/sql")).toEqual([2]);
    expect(findAll("node.js.", "node.js")).toEqual([0]);
  });

  test("agulha vazia não gira para sempre: nenhuma ocorrência", () => {
    expect(findAll("abc", "")).toEqual([]);
  });

  test("containsAny e tokens", () => {
    expect(containsAny("vaga remota", ["hibrido", "remota"])).toBe(true);
    expect(containsAny("vaga remota", ["hibrido"])).toBe(false);
    expect(tokens("")).toEqual([]);
    expect(tokens("c# e node.js!")).toEqual(["c", "e", "node", "js"]);
  });
});

describe("linhas e janelas", () => {
  test("splitLines guarda início e índice; texto vazio tem uma linha", () => {
    expect(splitLines("ab\n\ncd")).toEqual([
      { text: "ab", start: 0, index: 0 },
      { text: "", start: 3, index: 1 },
      { text: "cd", start: 4, index: 2 },
    ]);
    expect(splitLines("")).toEqual([{ text: "", start: 0, index: 0 }]);
  });

  test("lineAt acha a linha de cada posição, inclusive a quebra", () => {
    const lines = splitLines("ab\n\ncd\ne");
    expect([0, 1, 2, 3, 4, 6, 7].map((pos) => lineAt(lines, pos).index)).toEqual([0, 0, 0, 1, 2, 2, 3]);
  });

  test("itemAt falha fechado fora do intervalo", () => {
    expect(itemAt(["a"], 0)).toBe("a");
    expect(() => itemAt(["a"], 1)).toThrow(RangeError);
  });

  test("textBefore limita a janela e descarta a palavra cortada no começo", () => {
    const line = splitLines(`${"x".repeat(100)} canao java`)[0] as ReturnType<typeof splitLines>[number];
    const pos = line.text.indexOf("java");
    expect(textBefore(line, pos)).toBe(" canao ");
    const exact = splitLines(`${"y".repeat(10)} ${"z".repeat(LOOK_AROUND_CHARS - 1)} java`)[0] as ReturnType<typeof splitLines>[number];
    expect(textBefore(exact, exact.text.indexOf("java"))).toBe(` ${"z".repeat(LOOK_AROUND_CHARS - 1)} `.slice(-LOOK_AROUND_CHARS));
    expect(textBefore(splitLines("ab java")[0] as ReturnType<typeof splitLines>[number], 3)).toBe("ab ");
  });

  test("textBefore nunca devolve um pedaço de palavra que vire negador", () => {
    const line = splitLines(`${"a".repeat(LOOK_AROUND_CHARS - 2)}nao java`)[0] as ReturnType<typeof splitLines>[number];
    expect(textBefore(line, line.text.indexOf("java"))).toBe(" ");
  });

  test("textAfter limita a janela", () => {
    const line = splitLines(`java ${"b".repeat(200)}`)[0] as ReturnType<typeof splitLines>[number];
    expect(textAfter(line, 4)).toHaveLength(LOOK_AROUND_CHARS);
  });

  test("perLine calcula uma vez por linha", () => {
    const lines = splitLines("a\nb");
    let calls = 0;
    const memo = perLine((text) => {
      calls += 1;
      return text === "a";
    });
    expect([memo(lines[0] as never), memo(lines[0] as never), memo(lines[1] as never), memo(lines[1] as never)]).toEqual([true, true, false, false]);
    expect(calls).toBe(2);
  });
});

describe("contexto de linha (ADR-016 D3)", () => {
  test.each([
    ["- item", true], ["• item", true], ["* item", true], ["· item", true], ["✓ item", true], ["– item", true], ["  - recuado", true],
    ["**diferenciais:**", false], ["-sem espaço", false], ["texto", false],
  ])("isListItem(%j) = %s", (text, expected) => {
    expect(isListItem(text)).toBe(expected);
  });

  test.each([
    ["requisitos:", true], ["", false], ["   ", false], ["x".repeat(61), false], ["x".repeat(60), true], ["- requisitos", false],
    ["fim de frase.", false], ["lista;", false], ["virgula,", false], ["um dois tres quatro cinco seis sete", true],
    ["um dois tres quatro cinco seis sete oito", false],
  ])("isHeading(%j) = %s", (text, expected) => {
    expect(isHeading(text)).toBe(expected);
  });

  test.each([
    ["requisitos desejaveis", "desejavel"], ["beneficios", "beneficio"], ["requisitos", "exigida"],
    ["sobre a vaga", "desconhecido"], ["sobre a empresa", "empresa"], ["kubernetes", null],
  ] as const)("headingKind(%j) = %s", (text, expected) => {
    expect(headingKind(text)).toBe(expected);
  });

  test("seções, diferencial na linha, prosa com diferencial e linha curta desconhecida", () => {
    const lines = splitLines(
      [
        "texto inicial",
        "requisitos",
        "- java",
        "kubernetes",
        "- docker e um plus",
        "",
        "conhecer go sera um plus para o time.",
        "e tambem rust.",
        "",
        "sobre a empresa",
        "- somos legais",
        "beneficios",
        "- plano",
      ].join("\n"),
    );
    expect(classifyLines(lines)).toEqual([
      "desconhecido",
      "exigida",
      "exigida",
      "exigida",
      "desejavel",
      "exigida",
      "desejavel",
      "desejavel",
      "exigida",
      "empresa",
      "empresa",
      "beneficio",
      "beneficio",
    ]);
  });

  test("bloco com item de lista ou título não é prosa: só a linha com o marcador é diferencial", () => {
    const lines = splitLines(["- java", "docker e um plus para o time.", "rust"].join("\n"));
    expect(classifyLines(lines)).toEqual(["desconhecido", "desejavel", "desconhecido"]);
    const titled = splitLines(["requisitos", "docker e um plus para o time.", "rust"].join("\n"));
    expect(classifyLines(titled)).toEqual(["exigida", "desejavel", "exigida"]);
    // Linha curta com marcador de diferencial é título: troca a seção (como no S-4).
    expect(classifyLines(splitLines(["- java", "docker e um plus", "rust"].join("\n")))).toEqual(["desconhecido", "desejavel", "desejavel"]);
  });
});

describe("TechDictionary td1 (ADR-016 D6)", () => {
  test("versão e conjunto fechado de canônicos", () => {
    expect(TECH_DICTIONARY_VERSION).toBe("td1");
    expect(DICTIONARY_TERMS.size).toBe(new Set(DICTIONARY_ALIASES.map((a) => a.canonical)).size);
    expect(DICTIONARY_TERMS.size).toBeGreaterThanOrEqual(220);
    for (const term of ["Node.js", "C#", "C++", ".NET", "Go", "R", "SAP S/4HANA", "PL/SQL"]) expect(DICTIONARY_TERMS.has(term), term).toBe(true);
  });

  test("todo canônico vale no TechTagSchema do contrato", () => {
    const invalid = [...DICTIONARY_TERMS].filter((t) => !TechTagSchema.safeParse(t).success);
    expect(invalid).toEqual([]);
  });

  test("todo alias já está dobrado, aparado e não vazio; nenhum alias aponta para dois canônicos", () => {
    const owner = new Map<string, string>();
    const clash: string[] = [];
    for (const { alias, canonical } of DICTIONARY_ALIASES) {
      expect(fold(alias).text, alias).toBe(alias);
      expect(alias.trim(), alias).toBe(alias);
      expect(alias.length, canonical).toBeGreaterThan(0);
      const prev = owner.get(alias);
      if (prev !== undefined && prev !== canonical) clash.push(alias);
      owner.set(alias, canonical);
    }
    expect(clash).toEqual([]);
  });

  test("aliases mais longos primeiro", () => {
    const lengths = DICTIONARY_ALIASES.map((a) => a.alias.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  test.each(["", "Java", "Java|", "|java", "Java||jvm"])("linha inválida falha fechado: %j", (row) => {
    expect(() => parseDictionaryRow(row)).toThrow(RangeError);
  });

  test("linha válida", () => {
    expect(parseDictionaryRow("Go|golang|go lang")).toEqual([
      { canonical: "Go", alias: "golang", ambiguous: null },
      { canonical: "Go", alias: "go lang", ambiguous: null },
    ]);
  });
});

const lang = (text: string): TextLanguage => guessLanguage(fold(text).text);
const mentions = (raw: string) => signalsOf(raw).stackMentions;
const strengthOf = (raw: string, term: string) => mentions(raw).find((m) => m.term === term)?.strength ?? "ausente";

describe("menções de stack (ADR-016 D6)", () => {
  test("idioma por palavras vazias; empate e texto vazio ficam com pt", () => {
    expect(lang("")).toBe("pt");
    expect(lang("experiencia com java para uma vaga")).toBe("pt");
    expect(lang("the experience with our team and you")).toBe("en");
    expect(lang("los requisitos con experiencia y el equipo")).toBe("es");
    expect(lang("the de")).toBe("pt");
  });

  test.each([
    ["requisito. sem", " sem"],
    ["node.js e", "node.js e"],
    ["fim.", ""],
    ["a; b: c! d? e (f) g", " g"],
    ["sem quebra", "sem quebra"],
  ])("clauseBefore(%j) = %j", (before, expected) => {
    expect(clauseBefore(before)).toBe(expected);
  });

  test("menção simples é explícita; nada fora do dicionário sai", () => {
    expect(mentions("Requisitos:\n- Java\n- Spring Boot\n- Cloudera")).toEqual([
      { term: "Java", strength: "explicita" },
      { term: "Spring Boot", strength: "explicita" },
    ]);
  });

  test("negação antes do termo, dentro da janela de 4 tokens e na mesma oração", () => {
    expect(strengthOf("Vaga sem PHP.", "PHP")).toBe("fraca");
    expect(strengthOf("Não usamos mais o PHP aqui.", "PHP")).toBe("fraca");
    expect(strengthOf("Não usamos mais nada do PHP.", "PHP")).toBe("explicita");
    expect(strengthOf("Sem frescura. PHP é obrigatório.", "PHP")).toBe("explicita");
  });

  test("negação por idioma: 'no' só em inglês e espanhol", () => {
    expect(strengthOf("Experiência no React para uma vaga de você", "React")).toBe("explicita");
    expect(strengthOf("We need no PHP for the team and you", "PHP")).toBe("fraca");
    expect(strengthOf("Buscamos experiencia y el equipo sin PHP con los datos", "PHP")).toBe("fraca");
  });

  test.each([
    "PHP não é necessário",
    "PHP: não é obrigatório",
    "PHP, - não é requisito",
    "PHP is not required",
    "PHP not required",
  ])("negação depois do termo: %j", (raw) => {
    expect(strengthOf(raw, "PHP")).toBe("fraca");
  });

  test("negação depois do termo só logo em seguida", () => {
    expect(strengthOf("PHP e outras coisas não é necessário", "PHP")).toBe("explicita");
  });

  test("contexto: diferencial, empresa e benefício dão menção fraca", () => {
    expect(strengthOf("Diferenciais\n- Docker", "Docker")).toBe("fraca");
    expect(strengthOf("Sobre a empresa\n- Usamos Docker", "Docker")).toBe("fraca");
    expect(strengthOf("Benefícios\n- Curso de Docker", "Docker")).toBe("fraca");
    expect(strengthOf("Sobre a vaga\n- Docker", "Docker")).toBe("explicita");
  });

  test("explícita vence fraca do mesmo termo; a ordem é por code unit, sem locale", () => {
    expect(mentions("Diferenciais\n- Docker\n\nRequisitos\n- Docker\n- AWS\n- Ansible")).toEqual([
      { term: "AWS", strength: "explicita" },
      { term: "Ansible", strength: "explicita" },
      { term: "Docker", strength: "explicita" },
    ]);
    expect(mentions("Requisitos\n- Docker\n\nDiferenciais\n- Docker")).toEqual([{ term: "Docker", strength: "explicita" }]);
  });

  test("ambíguo sem qualificador é fraco; frase ou pista na linha qualificam", () => {
    expect(strengthOf("Requisitos\n- Go", "Go")).toBe("fraca");
    expect(strengthOf("Requisitos\n- Linguagem Go", "Go")).toBe("explicita");
    expect(strengthOf("Requisitos\n- Go e Golang", "Go")).toBe("explicita");
    expect(strengthOf("Requisitos\n- Swift com Xcode", "Swift")).toBe("explicita");
    expect(strengthOf("Requisitos\n- ERP Senior", "Senior")).toBe("explicita");
  });

  test("a frase só qualifica a ocorrência que está dentro dela", () => {
    const folded = fold("linguagem go\nlet go");
    const lines = splitLines(folded.text);
    const out = detectStack(folded, lines, classifyLines(lines), "en");
    expect(out.details.filter((d) => d.canonical === "Go").map((d) => d.ambiguousUnqualified)).toEqual([false, true]);
    expect(out.mentions).toEqual([{ term: "Go", strength: "explicita" }]);
  });

  test("mistura de scripts (T15, mitigação 4): confundível dentro do termo nunca dá explícita", () => {
    expect(mentions("Requisitos\n- РНР")).toEqual([{ term: "PHP", strength: "fraca" }]);
    expect(strengthOf("Requisitos\n- jаvа", "Java")).toBe("fraca");
    expect(strengthOf("Requisitos\n- Java (о time)", "Java")).toBe("explicita");
  });

  test("alias mais longo cobre o trecho: 'spring boot' não dá 'Spring', 'sql server' não dá 'SQL'", () => {
    expect(mentions("Requisitos\n- Spring Boot\n- SQL Server").map((m) => m.term)).toEqual(["SQL Server", "Spring Boot"]);
    expect(mentions("Requisitos\n- Spring Framework\n- SQL").map((m) => m.term)).toEqual(["SQL", "Spring"]);
  });

  test("isExplicitMention exige as quatro condições", () => {
    const ok = { canonical: "Java", context: "exigida", negated: false, ambiguousUnqualified: false, mixedScript: false } as const;
    expect(isExplicitMention(ok)).toBe(true);
    expect(isExplicitMention({ ...ok, context: "desconhecido" })).toBe(true);
    expect(isExplicitMention({ ...ok, negated: true })).toBe(false);
    expect(isExplicitMention({ ...ok, ambiguousUnqualified: true })).toBe(false);
    expect(isExplicitMention({ ...ok, mixedScript: true })).toBe(false);
    expect(isExplicitMention({ ...ok, context: "desejavel" })).toBe(false);
    expect(isExplicitMention({ ...ok, context: "empresa" })).toBe(false);
    expect(isExplicitMention({ ...ok, context: "beneficio" })).toBe(false);
  });
});
