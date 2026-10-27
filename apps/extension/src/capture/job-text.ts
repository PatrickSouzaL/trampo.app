// Higiene do texto da vaga no Service Worker, antes de guardar ou enviar (ADR-001 §5.0 passo 5; ADR-024 D3).
// Vale para o texto do extrator e para o texto colado: os dois são dado de página, nunca comando.
import { JOB_TEXT_MAX_CHARS } from "@trampo/contracts/limits";
import { truncateCodePoints } from "@trampo/contracts/primitives";

const LINE_BREAKS = /\r\n?/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// C0 (menos \t e \n), DEL e C1. Os invisíveis de formatação (Cf: zero-width, bidi, Unicode Tags) ficam:
// o servidor os remove e conta como sinal de injection (ADR-023 D5).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export interface CleanJobText {
  readonly text: string;
  /** O corte em JOB_TEXT_MAX_CHARS code points tirou algo. */
  readonly truncated: boolean;
}

/**
 * Remove os surrogates órfãos ANTES dos controles: assim, um controle entre duas metades soltas não
 * as junta num par válido (ASCII smuggling por Unicode Tags). Depois corta em code points, a unidade
 * do contrato (JobTextSchema).
 */
export function cleanJobText(raw: string): CleanJobText {
  const clean = raw.replace(LINE_BREAKS, "\n").replace(LONE_SURROGATE, "").replace(CONTROL, "").trim();
  const text = truncateCodePoints(clean, JOB_TEXT_MAX_CHARS).trimEnd();
  return { text, truncated: text.length < clean.length };
}

/** Tamanho em code points, a unidade de `z.string().min/max` no zod >= 4.5. */
export function countCodePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}
