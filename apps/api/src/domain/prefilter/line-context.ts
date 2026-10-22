// Contexto de cada linha (ADR-001 §5.3, "Diferencial"; ADR-016 D3), sobre o texto já dobrado.
import { containsAny, itemAt, type Line } from "./folding.js";

export type MentionContext = "exigida" | "desejavel" | "empresa" | "beneficio" | "desconhecido";

/** Marcadores de diferencial (pt, en e es), já dobrados. */
export const NICE_MARKERS: readonly string[] = [
  "diferencial", "diferenciais", "desejavel", "desejaveis", "plus", "nice to have", "nice-to-have",
  "bonus", "bonus points", "preferred", "preferencial", "sera um plus", "e um plus", "deseable", "deseables",
  "valorizado", "valorizados", "valorizamos", "seria otimo", "sera bem-vindo", "bem-vindo", "bem-vinda",
];

const REQUIRED_HEADINGS: readonly string[] = [
  "requisitos", "requisito", "requirements", "qualificacoes", "qualifications", "o que buscamos",
  "o que esperamos", "o que procuramos", "pre-requisitos", "obrigatorio", "obrigatorios", "necessario",
  "o que voce precisa", "what you need", "must have", "must-have", "responsabilidades", "atividades",
  "o que voce vai fazer", "o que vais fazer", "seu dia a dia", "atribuicoes", "responsibilities",
  "what you will do", "you will", "requisitos obrigatorios", "conhecimentos", "competencias tecnicas",
  "habilidades", "skills", "stack", "tecnologias", "requerimientos", "responsabilidades y requisitos",
];

const COMPANY_HEADINGS: readonly string[] = [
  "sobre a empresa", "sobre nos", "quem somos", "about us", "about the company", "a empresa",
  "conheca", "nossa historia", "sobre la empresa", "sobre o time", "sobre o produto", "nosso jeito",
];

const BENEFIT_HEADINGS: readonly string[] = ["beneficios", "benefits", "o que oferecemos", "what we offer", "remuneracao e beneficios"];

const NEUTRAL_HEADINGS: readonly string[] = [
  "sobre a vaga", "sobre o cargo", "about the role", "sobre o desafio", "a vaga", "descricao da vaga",
  "job description", "contexto", "processo", "etapas", "como se candidatar", "remuneracao", "contrato",
  "informacoes adicionais", "local", "localizacao", "jornada",
];

const LIST_MARKERS: readonly string[] = ["- ", "• ", "* ", "· ", "✓ ", "– "];
const HEADING_MAX_CHARS = 60;
const HEADING_MAX_WORDS = 7;

/** Marcador seguido de espaço: "**Diferenciais:**" (negrito de Markdown) não é item de lista (S-4). */
export function isListItem(text: string): boolean {
  const t = text.trimStart();
  return LIST_MARKERS.some((marker) => t.startsWith(marker));
}

/** Linha curta, sem pontuação final de frase e que não é item de lista. */
export function isHeading(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > HEADING_MAX_CHARS || isListItem(t)) return false;
  const last = t.charAt(t.length - 1);
  if (last === "." || last === ";" || last === ",") return false;
  return t.split(" ").length <= HEADING_MAX_WORDS;
}

/**
 * Tipo do título, ou `null` quando a linha curta não é título conhecido (ex.: "Kubernetes" numa lista sem
 * marcador). Linha curta desconhecida NÃO troca a seção: senão um item de "Diferenciais" sem hífen viraria
 * contexto neutro e a menção, explícita (T4). Ordem: o diferencial vence ("Requisitos desejáveis").
 */
export function headingKind(text: string): MentionContext | null {
  if (containsAny(text, NICE_MARKERS)) return "desejavel";
  if (containsAny(text, BENEFIT_HEADINGS)) return "beneficio";
  if (containsAny(text, REQUIRED_HEADINGS)) return "exigida";
  if (containsAny(text, NEUTRAL_HEADINGS)) return "desconhecido";
  return containsAny(text, COMPANY_HEADINGS) ? "empresa" : null;
}

/**
 * Contexto por linha:
 * 1. a própria linha é título conhecido → troca a seção;
 * 2. a linha tem marcador de diferencial, ou está num bloco em prosa (sem item de lista nem título conhecido)
 *    que tem → desejável;
 * 3. senão, a seção do último título visto.
 * Cada linha é examinada um número constante de vezes (SR-09).
 */
export function classifyLines(lines: readonly Line[]): MentionContext[] {
  // Cada linha é examinada uma vez; a linha em branco não tem título nem marcador (SR-09: 64 KiB de "\n").
  const facts: LineFacts[] = lines.map((line) =>
    line.text.trim() === ""
      ? BLANK
      : {
          blank: false,
          kind: isHeading(line.text) ? headingKind(line.text) : null,
          nice: containsAny(line.text, NICE_MARKERS),
          listItem: isListItem(line.text),
        },
  );
  // Bloco em prosa (entre linhas em branco, sem item de lista nem título conhecido) com marcador de diferencial.
  const proseNice: boolean[] = facts.map(() => false);
  let blockStart = 0;
  for (let i = 0; i <= facts.length; i += 1) {
    if (i < facts.length && !itemAt(facts, i).blank) continue;
    const block = facts.slice(blockStart, i);
    if (block.some((f) => f.nice) && block.every((f) => f.kind === null && !f.listItem)) proseNice.fill(true, blockStart, i);
    blockStart = i + 1;
  }
  let section: MentionContext = "desconhecido";
  return facts.map((f, i) => {
    if (f.kind !== null) {
      section = f.kind;
      return f.kind;
    }
    return f.nice || proseNice[i] === true ? "desejavel" : section;
  });
}

interface LineFacts {
  readonly blank: boolean;
  readonly kind: MentionContext | null;
  readonly nice: boolean;
  readonly listItem: boolean;
}

const BLANK: LineFacts = Object.freeze({ blank: true, kind: null, nice: false, listItem: false });
