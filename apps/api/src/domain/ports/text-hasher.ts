// Porta de hash do domínio (ADR-005 D1). O domínio não importa node:crypto: a implementação fica em
// infrastructure/crypto e chega por injeção, como Clock e IdGenerator.
export interface TextHasher {
  /** sha256 do texto codificado em UTF-8, em 64 dígitos hexadecimais minúsculos. */
  sha256Hex(text: string): string;
}
