import { INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE, URL_LIKE_PATTERNS } from '@trampo/contracts';

/*
 * Verificações de texto dos casos versionados (golden-dataset-spec gd1, §7 e §9).
 * Regex lineares (SR-09) e sem as flags `g`/`y`, exceto `EMOJI_JOINERS`, que só é usada em `replace`
 * (que zera o `lastIndex`). Os achados devolvem só o TIPO,
 * nunca o trecho: o relatório do teste não pode reimprimir dado pessoal.
 */

export type PiiKind = 'email' | 'telefone' | 'cpf' | 'cnpj' | 'url';

const PII_PATTERNS: ReadonlyArray<readonly [PiiKind, RegExp]> = [
  ['email', /[a-z0-9._%+-]@[a-z0-9-]{1,63}\.[a-z]/i],
  // Celular e fixo brasileiros, com ou sem DDD/+55: "(11) 91234-5678", "11 3456 7890", "+55 11 91234.5678".
  ['telefone', /(?:\+55[\s-]?)?\(?\b\d{2}\)?[\s-]?9?\d{4}[\s.-]\d{4}\b/],
  ['cpf', /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/],
  ['cnpj', /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/],
  // Os padrões de URL do contrato (sem os TLDs que colidem com nome de tecnologia) e "@perfil".
  ...URL_LIKE_PATTERNS.map((p) => ['url', p] as const),
  ['url', /(?:^|\s)@[a-z0-9_.]{3,30}\b/im],
];

export function findPii(text: string): PiiKind[] {
  const kinds = new Set<PiiKind>();
  for (const [kind, pattern] of PII_PATTERNS) if (pattern.test(text)) kinds.add(kind);
  return [...kinds];
}

/**
 * Sequências de emoji legítimas usam ZWJ (U+200D) e o seletor VS16 (U+FE0F), que estão no conjunto de
 * invisíveis do contrato. Fora de `injection_oculta`, só essas posições são toleradas.
 */
const EMOJI_JOINERS =
  /(?<=\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])\u{FE0F}|(?<=\p{Extended_Pictographic}|\u{FE0F}|[\u{1F3FB}-\u{1F3FF}])\u{200D}(?=\p{Extended_Pictographic})|(?<=[0-9#*])\u{FE0F}(?=\u{20E3})/gu;

export function hasForbiddenInvisible(text: string): boolean {
  // Fim de linha do Windows (core.autocrlf) e tabulação são formatação, não ocultação.
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\t', ' ').replace(EMOJI_JOINERS, '');
  return INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE.test(normalized);
}

/** Sobra do cabeçalho YAML do arquivo bruto (HITL-003), que não pode ir para o caso. */
export function hasRawHeaderLeftover(text: string): boolean {
  return /^(?:suspeita_injection|coletada_em|salario_anunciado|contrato_anunciado|modelo_anunciado|senioridade_anunciada|plataforma):/m.test(
    text,
  );
}

export function countCodePoints(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}
