// S-4: contexto de cada linha (ADR-001 §5.3, "Diferencial"). Trabalha sobre o texto já dobrado.
import { containsAny, type Line } from "./text-tools.js";

export type MentionContext = "exigida" | "desejavel" | "empresa" | "beneficio" | "desconhecido";

/** Marcadores de diferencial (pt, en, es), já sem acento. */
export const NICE_MARKERS = [
  "diferencial", "diferenciais", "desejavel", "desejaveis", "plus", "nice to have", "nice-to-have",
  "bonus", "bonus points", "preferred", "preferencial", "sera um plus", "e um plus", "deseable", "deseables",
  "valorizado", "valorizados", "valorizamos", "seria otimo", "sera bem-vindo", "bem-vindo", "bem-vinda",
];

const REQUIRED_HEADINGS = [
  "requisitos", "requisito", "requirements", "qualificacoes", "qualifications", "o que buscamos",
  "o que esperamos", "o que procuramos", "pre-requisitos", "obrigatorio", "obrigatorios", "necessario",
  "o que voce precisa", "what you need", "must have", "must-have", "responsabilidades", "atividades",
  "o que voce vai fazer", "o que vais fazer", "seu dia a dia", "atribuicoes", "responsibilities",
  "what you will do", "you will", "requisitos obrigatorios", "conhecimentos", "competencias tecnicas",
  "habilidades", "skills", "stack", "tecnologias", "requerimientos", "responsabilidades y requisitos",
];

const COMPANY_HEADINGS = [
  "sobre a empresa", "sobre nos", "quem somos", "about us", "about the company", "a empresa",
  "conheca", "nossa historia", "sobre la empresa", "sobre o time", "sobre o produto", "nosso jeito",
];

const BENEFIT_HEADINGS = ["beneficios", "benefits", "o que oferecemos", "what we offer", "remuneracao e beneficios"];

/** Marcador de item seguido de espaço: "**Diferenciais:**" (negrito de Markdown) não é item. */
function isListItem(text: string): boolean {
  const t = text.trimStart();
  return ["- ", "• ", "* ", "· ", "✓ ", "– "].some((m) => t.startsWith(m));
}

/** Linha curta, sem pontuação final de frase e que não é item de lista: título de seção. */
export function isHeading(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 60 || isListItem(t)) return false;
  const last = t[t.length - 1];
  if (last === "." || last === ";" || last === ",") return false;
  return t.split(" ").length <= 7;
}

const NEUTRAL_HEADINGS = [
  "sobre a vaga", "sobre o cargo", "about the role", "sobre o desafio", "a vaga", "descricao da vaga",
  "job description", "contexto", "processo", "etapas", "como se candidatar", "remuneracao", "contrato",
  "informacoes adicionais", "local", "localizacao", "jornada",
];

/**
 * Tipo do título, ou `null` quando a linha curta não é título conhecido (ex.: "Kubernetes" numa lista
 * sem marcador). Linha curta desconhecida NÃO troca a seção: senão um item de "Diferenciais" sem hífen
 * viraria contexto neutro e a menção, explícita (T4).
 */
function headingKind(text: string): MentionContext | null {
  // Ordem: diferencial vence ("Requisitos desejáveis").
  if (containsAny(text, NICE_MARKERS)) return "desejavel";
  if (containsAny(text, BENEFIT_HEADINGS)) return "beneficio";
  if (containsAny(text, REQUIRED_HEADINGS)) return "exigida";
  if (containsAny(text, NEUTRAL_HEADINGS)) return "desconhecido";
  if (containsAny(text, COMPANY_HEADINGS)) return "empresa";
  return null;
}

export interface LineContext {
  readonly context: MentionContext;
  readonly heading: boolean;
}

/**
 * Contexto por linha:
 * 1. a própria linha tem marcador de diferencial → desejável;
 * 2. bloco em prosa (sem itens de lista) com marcador de diferencial → desejável;
 * 3. senão, o último título de seção visto.
 */
export function classifyLines(lines: readonly Line[]): LineContext[] {
  const out: LineContext[] = [];
  let section: MentionContext = "desconhecido";
  let blockStart = 0;
  const blockNice: boolean[] = [];
  // Pré-cálculo: bloco em prosa com marcador de diferencial.
  for (let i = 0; i <= lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.text.trim().length === 0) {
      const block = lines.slice(blockStart, i);
      const prose = block.length > 0 && !block.some((l) => isListItem(l.text) || (isHeading(l.text) && headingKind(l.text) !== null));
      const nice = prose && block.some((l) => containsAny(l.text, NICE_MARKERS));
      for (let j = blockStart; j < i; j += 1) blockNice[j] = nice;
      blockNice[i] = false;
      blockStart = i + 1;
    }
  }
  lines.forEach((line, i) => {
    const kind = isHeading(line.text) ? headingKind(line.text) : null;
    if (kind !== null) {
      section = kind;
      out.push({ context: section, heading: true });
      return;
    }
    if (containsAny(line.text, NICE_MARKERS) || blockNice[i] === true) {
      out.push({ context: "desejavel", heading: false });
      return;
    }
    out.push({ context: section, heading: false });
  });
  return out;
}
