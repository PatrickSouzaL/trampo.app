// Contagem e corte em code points, a unidade de JOB_TEXT_MAX_CHARS (ADR-005 D3; ADR-006 D6).
import type { truncateCodePoints } from "@trampo/contracts/primitives";

/** A função do contrato, a mesma da borda e da extensão, injetada (o módulo dela importa zod). */
export type TruncateCodePoints = typeof truncateCodePoints;

/** Uma dependência injetada violou o próprio contrato. O domínio falha fechado. */
export class DependencyContractError extends Error {
  override readonly name = "DependencyContractError";
}

const ASTRAL = /[\u{10000}-\u{10FFFF}]/gu;

/** Tamanho em code points de um texto bem formado. */
export function countCodePoints(text: string): number {
  return text.replace(ASTRAL, "_").length;
}

/** Corta com a função injetada e confere o teto: uma composição errada não fura o limite. */
export function truncateWithinCeiling(truncate: TruncateCodePoints, text: string, max: number): string {
  const cut = truncate(text, max);
  if (countCodePoints(cut) > max) {
    throw new DependencyContractError("truncateCodePoints devolveu mais code points que o teto.");
  }
  return cut;
}
