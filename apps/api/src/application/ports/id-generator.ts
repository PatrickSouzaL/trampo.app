// Identificadores gerados no servidor (ADR-017 D1). O AnalyzeJob confere o formato: um id fora do padrão é
// defeito do adapter, não um relatório com id inválido.
export interface IdGenerator {
  /** UUID (RFC 9562). */
  uuid(): string;
}
