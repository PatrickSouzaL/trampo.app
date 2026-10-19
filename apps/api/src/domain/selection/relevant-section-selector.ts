// Micro-payload do LLM (ADR-001 §5.5; ADR-006). Domínio puro: escolhe, por blocos, o que do texto
// normalizado vai ao provedor, dentro de um orçamento rígido em code points. Descarta contato (T12, F-04)
// e diretivas ao modelo (T2) antes do orçamento. Todas as regexes são lineares (SR-09).
import { JOB_TEXT_MAX_CHARS } from "@trampo/contracts/limits";

import type { NormalizedJobText } from "../normalization/job-text-normalizer.js";
import { countCodePoints, truncateWithinCeiling, type TruncateCodePoints } from "../text/code-points.js";

/** Componente `sel` do extractorVersion (ADR-001 §5.4). Mudou dicionário, regra ou faixa: incrementa. */
export const RELEVANT_SECTION_SELECTOR_VERSION = "sel1";

/** Orçamento padrão do payload (hipótese do ADR-001 §5.5, a calibrar no S-1). */
export const LLM_INPUT_MAX_CHARS = 6_000;
export const MIN_LLM_INPUT_CHARS = 1_000;

/** Faixa 1: cabeçalho da vaga (ADR-006 D4). */
export const HEADER_CHARS = 300;

/** Reticências U+2026: o NFKC da entrada as troca por três pontos, então a vaga não forja este marcador. */
export const OMISSION_MARKER = "[\u2026]";

/** Menor sobra que ainda recebe o prefixo de um bloco que não cabe inteiro. */
const MIN_PARTIAL_CHARS = 200;
/** Custo extra de cada bloco: o maior separador possível, quebra + marcador + quebra (5). */
const SEPARATOR_COST = 5;
/** Marcador + quebra no começo (4, coberto pelo custo do primeiro bloco) e no fim (4): sobram 3 a reservar. */
const EDGE_RESERVE = 3;

type SectionCategory = "cabecalho" | "relevante" | "boilerplate" | "contato";

export interface SelectionSignals {
  readonly totalBlocks: number;
  readonly selectedBlocks: number;
  readonly partialBlock: boolean;
  readonly headingsFound: number;
  readonly droppedContactBlocks: number;
  readonly droppedDirectiveBlocks: number;
  readonly omittedForBudgetBlocks: number;
}

export interface SelectedJobText {
  readonly text: string;
  readonly selectorVersion: typeof RELEVANT_SECTION_SELECTOR_VERSION;
  readonly budgetChars: number;
  readonly signals: SelectionSignals;
}

export interface RelevantSectionSelectorDeps {
  readonly truncateCodePoints: TruncateCodePoints;
  /** Orçamento em code points. Padrão: LLM_INPUT_MAX_CHARS. Fora de [1.000, 15.000]: RangeError. */
  readonly budgetChars?: number;
}

interface Block {
  readonly index: number;
  readonly text: string;
  readonly separatorBefore: string;
  readonly category: SectionCategory;
  readonly codePoints: number;
  readonly droppedAs: "contato" | "diretiva" | null;
  readonly alwaysKeep: boolean;
}

interface Chosen {
  readonly text: string;
  readonly partial: boolean;
}

// Dicionário v1 (ADR-006 D2), aplicado à chave sem acentos e em minúsculas. Título: começa com um termo
// e termina em até 40 caracteres ou num ":". Termos de pessoa só contam com ":" imediato, para que uma
// vaga DE recrutador ("Recrutador(a) Tech Pleno") não vire seção de contato.
const CONTACT_HEADING =
  /^(?:contatos?|contact|como (?:se )?candidatar|candidate-se|candidatura|como aplicar|how to apply|inscricoes|inscreva-se|equipe de contratacao|hiring team|meet the (?:hiring )?team)\b[^:\n]{0,40}(?::|$)|^(?:recrutador(?:a|\(a\))?|recruiter|hiring manager|talent acquisition|responsavel pela vaga) ?:/u;

const RELEVANT_HEADING =
  /^(?:requisitos?|pre-requisitos|requirements|qualificac(?:ao|oes)|qualifications|perfil|habilidades|skills|competencias|conhecimentos|experiencia|formacao|escolaridade|idiomas|stack|tecnologias|ferramentas|responsabilidades|responsibilities|atividades|atribuicoes|desafios|dia a dia|day to day|o que (?:voce|vc) (?:vai|ira|precisa|fara)|o que (?:esperamos|buscamos|procuramos|oferecemos)|what (?:you|we)(?: will|'ll)? (?:do|need|bring|look for|offer)|diferenciais|diferencial|desejaveis|desejavel|nice to have|beneficios|benefits|perks|remuneracao|salario|salary|compensation|faixa salarial|localizacao|local|location|modelo de (?:trabalho|contratacao|atuacao)|work model|regime|formato|jornada|carga horaria|horario|tipo de (?:contratacao|vaga|contrato)|contratacao|sobre a (?:vaga|oportunidade|posicao)|sobre o (?:cargo|papel|time)|descricao|job description|about the (?:role|job|position)|vaga|cargo|senioridade|nivel)\b[^:\n]{0,40}(?::|$)/u;

const BOILERPLATE_HEADING =
  /^(?:sobre (?:nos|a|o)|about (?:us|the company)|quem somos|who we are|nossa (?:historia|empresa|missao|cultura|essencia)|our (?:story|mission|culture|company|values)|missao|cultura|valores|diversidade|inclusao|diversity|equal opportunit(?:y|ies)|eeo|etapas|processo seletivo|hiring process|selection process|recruitment process|proximos passos|next steps)\b[^:\n]{0,40}(?::|$)/u;

/** Bloco de contato em qualquer seção (F-04): é onde ficam nomes de recrutadores. */
const CONTACT_TEXT =
  /fale com|falar com|entre em contato|entrar em contato|(?:envie|enviar|mande|mandar) (?:(?:o|seu|sua|seus) )?(?:curriculo|cv|portfolio)|send (?:us )?(?:your )?(?:resume|cv)|reach out to|contact us|\[email\]|\[telefone\]|whatsapp/u;

/**
 * Diretiva dirigida ao modelo (piso; a heurística completa é do F1-DOM-04). Sem termos de competência:
 * "system prompt", "prompt injection" e "LLM" sozinhos não descartam (controle negativo do ADR-001 §5.3).
 */
const MODEL_DIRECTIVE =
  /\b(?:ignor(?:e|em|ar)|desconsider(?:e|ar)|esqueca|disregard|forget) (?:(?:todas|all|as|the|any|os|suas|your|de) ){0,3}(?:instruc|instruct|previous|anteriores|above)|\b(?:revele|mostre|imprima|repita|reveal|show|print|repeat) (?:(?:o|a|the|seu|sua|your) )?(?:system prompt|prompt do sistema|instrucoes do sistema|system instructions)|\bse voce (?:e|for) (?:um |uma )?(?:ia|ai|llm|modelo de linguagem|robo)\b|\bif you are (?:an? )?(?:ai|llm|language model|bot)\b|\b(?:de|atribua|give|assign) (?:(?:a|uma|the) )?(?:nota|score|rating) (?:of )?(?:maxima|10|100|perfeita|perfect)\b/u;

/** Sinal explícito de salário: o bloco fica sempre (faixa 0). */
const SALARY =
  /r\$ ?\d|\b\d{1,3}(?:[.,]\d{1,3})? ?k\b|salario|remuneracao|salary|compensation|\b(?:usd|eur) ?\d|(?:us\$|€) ?\d|\/ ?mes\b|\b(?:por|ao) mes\b/u;

/** Sinal explícito de modelo de trabalho: o bloco fica sempre (faixa 0). */
const WORK_MODEL = /\b(?:remot[ao]|home ?office|hibrid[ao]|presencial|on-?site|remote|hybrid|teletrabalho|anywhere)\b/u;

const LIST_ITEM = /^(?:[-*•+›▪◦]|\d{1,3}[.)]) /u;
const HEADING_PREFIX = /^[#*•›▪◦+\-\d.) ]+/u;

/** Chave de comparação: sem acentos e em minúsculas. Nunca vai para a saída. */
function matchingKey(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function headingCategory(line: string): SectionCategory | null {
  const key = matchingKey(line).replace(HEADING_PREFIX, "");
  if (CONTACT_HEADING.test(key)) return "contato";
  if (RELEVANT_HEADING.test(key)) return "relevante";
  if (BOILERPLATE_HEADING.test(key)) return "boilerplate";
  return null;
}

/** Blocos: quebram em linha em branco, em título e em item de lista (ADR-006 D2). */
function segment(text: string): { readonly blocks: readonly Block[]; readonly headingsFound: number } {
  const drafts: { lines: string[]; separatorBefore: string; category: SectionCategory }[] = [];
  let category: SectionCategory = "cabecalho";
  let separator = "\n";
  let current: string[] | null = null;
  let headingsFound = 0;
  for (const line of text.split("\n")) {
    if (line === "") {
      current = null;
      separator = "\n\n";
      continue;
    }
    const heading = headingCategory(line);
    if (heading !== null) {
      category = heading;
      headingsFound += 1;
    }
    if (current === null || heading !== null || LIST_ITEM.test(line)) {
      current = [line];
      drafts.push({ lines: current, separatorBefore: separator, category });
      separator = "\n";
    } else {
      current.push(line);
    }
  }
  const blocks = drafts.map((draft, index): Block => {
    const blockText = draft.lines.join("\n");
    const key = matchingKey(blockText);
    const isContact = draft.category === "contato" || CONTACT_TEXT.test(key);
    return {
      index,
      text: blockText,
      separatorBefore: draft.separatorBefore,
      category: draft.category,
      codePoints: countCodePoints(blockText),
      droppedAs: isContact ? "contato" : MODEL_DIRECTIVE.test(key) ? "diretiva" : null,
      alwaysKeep: SALARY.test(key) || WORK_MODEL.test(key),
    };
  });
  return { blocks, headingsFound };
}

/** Blocos escolhidos na ordem original, com o separador original ou o marcador de omissão. */
function assemble(blocks: readonly Block[], chosen: ReadonlyMap<number, Chosen>): string {
  let text = "";
  let previous = -1;
  let previousPartial = false;
  for (const block of blocks) {
    const entry = chosen.get(block.index);
    if (entry === undefined) continue;
    if (previous === -1) {
      text += block.index > 0 ? `${OMISSION_MARKER}\n` : "";
    } else {
      text += block.index === previous + 1 && !previousPartial ? block.separatorBefore : `\n${OMISSION_MARKER}\n`;
    }
    text += entry.text;
    previous = block.index;
    previousPartial = entry.partial;
  }
  const omittedTail = previous !== -1 && (previous < blocks.length - 1 || previousPartial);
  return omittedTail ? `${text}\n${OMISSION_MARKER}` : text;
}

export class RelevantSectionSelector {
  readonly #truncate: TruncateCodePoints;
  readonly #budget: number;

  constructor(deps: RelevantSectionSelectorDeps) {
    const budget = deps.budgetChars ?? LLM_INPUT_MAX_CHARS;
    if (!Number.isInteger(budget) || budget < MIN_LLM_INPUT_CHARS || budget > JOB_TEXT_MAX_CHARS) {
      throw new RangeError(`budgetChars precisa ser inteiro em [${MIN_LLM_INPUT_CHARS}, ${JOB_TEXT_MAX_CHARS}].`);
    }
    this.#truncate = deps.truncateCodePoints;
    this.#budget = budget;
  }

  select(normalized: NormalizedJobText): SelectedJobText {
    const { blocks, headingsFound } = segment(normalized.text);
    const eligible = blocks.filter((block) => block.droppedAs === null);
    const chosen = this.#fill(eligible);
    const chosenValues = [...chosen.values()];
    return {
      text: assemble(blocks, chosen),
      selectorVersion: RELEVANT_SECTION_SELECTOR_VERSION,
      budgetChars: this.#budget,
      signals: {
        totalBlocks: blocks.length,
        selectedBlocks: chosen.size,
        partialBlock: chosenValues.some((entry) => entry.partial),
        headingsFound,
        droppedContactBlocks: blocks.filter((block) => block.droppedAs === "contato").length,
        droppedDirectiveBlocks: blocks.filter((block) => block.droppedAs === "diretiva").length,
        omittedForBudgetBlocks: eligible.length - chosen.size,
      },
    };
  }

  /** Faixas do ADR-006 D4: sinal explícito → cabeçalho (300) → relevante → não classificado → boilerplate. */
  #fill(eligible: readonly Block[]): Map<number, Chosen> {
    const chosen = new Map<number, Chosen>();
    let remaining = this.#budget - EDGE_RESERVE;
    const offer = (block: Block, allowance: number, allowPartial: boolean): number => {
      if (chosen.has(block.index)) return 0;
      const cost = block.codePoints + SEPARATOR_COST;
      if (cost <= allowance) {
        chosen.set(block.index, { text: block.text, partial: false });
        return cost;
      }
      if (!allowPartial || allowance < MIN_PARTIAL_CHARS) return 0;
      const text = truncateWithinCeiling(this.#truncate, block.text, allowance - SEPARATOR_COST).trimEnd();
      chosen.set(block.index, { text, partial: true });
      return countCodePoints(text) + SEPARATOR_COST;
    };
    const inCategory = (category: SectionCategory) => eligible.filter((block) => block.category === category);

    for (const block of eligible.filter((b) => b.alwaysKeep)) remaining -= offer(block, remaining, true);
    let header = Math.min(HEADER_CHARS, remaining);
    for (const block of inCategory("cabecalho")) {
      const cost = offer(block, header, false);
      header -= cost;
      remaining -= cost;
    }
    // O cabeçalho que não coube na faixa 1 é o "não classificado" (faixa 3).
    for (const category of ["relevante", "cabecalho", "boilerplate"] as const) {
      for (const block of inCategory(category)) remaining -= offer(block, remaining, true);
    }
    return chosen;
  }
}
