// Máscara de PII e de URL (ADR-001 §5.2, item 4; ADR-005 D4, etapa 7; threat-model T12).
// Nomes de pessoas NÃO são mascarados (revisão M1.6, F-04): o resíduo está declarado em T12.
//
// Ordem: URLs primeiro (contêm "@" e dígitos), depois e-mail, hosts, CNPJ (mais longo), CPF e telefone.
// Todas as regexes são lineares, com quantificadores limitados e verificadas pelo eslint-plugin-regexp
// (SR-09). Elas usam `g` só aqui dentro: o `replace` zera o `lastIndex`, e nenhuma é exportada.

export interface MaskCounts {
  readonly email: number;
  readonly phone: number;
  readonly document: number;
  readonly link: number;
}

type MaskKind = keyof MaskCounts;

export const MASK_TOKENS: Readonly<Record<MaskKind, string>> = {
  email: "[email]",
  phone: "[telefone]",
  document: "[documento]",
  link: "[link]",
};

const MASKS: readonly (readonly [RegExp, MaskKind])[] = [
  // esquema://... (inclui credenciais e dígitos na própria URL)
  [/\b[a-z][a-z0-9+.-]{0,30}:\/\/\S*/giu, "link"],
  // esquemas sem "//", só quando colados no alvo: "Tel: (11)..." e "Data: 10/10" passam
  [/\b(?:javascript|data|vbscript|file|blob|mailto|tel):\S+/giu, "link"],
  // e-mail, inclusive sem TLD: um e-mail cortado no fim do texto ("joao@empre") também é PII
  [/[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,8}/gu, "email"],
  [/\bwww\d{0,3}\.\S+/giu, "link"],
  // host com caminho. Sem js, ts e net na lista: "Node.js/Express" e "ASP.NET/C#" são tecnologia
  [
    /\b(?:[a-z0-9-]{1,63}\.){1,8}(?:com|org|br|io|dev|app|ai|co|me|gov|edu|jobs|info|biz|xyz|top|click|link|online|site|live|shop|ly|gl|gd|to|cc|ru|cn|tk|ml|ga|cf|gq|zip|mov)\/\S*/giu,
    "link",
  ],
  // host nu só com TLD de risco (mesma lista do contrato, sem os que colidem com tecnologia)
  [
    /\b(?:[a-z0-9-]{1,63}\.){1,8}(?:com|org|br|info|biz|xyz|top|click|link|online|site|live|shop|me|ly|gl|gd|to|cc|ru|cn|tk|ml|ga|cf|gq|zip|mov)\b/giu,
    "link",
  ],
  // CNPJ numérico (com ou sem pontuação) e alfanumérico de 2026 (só formatado, para não pegar siglas)
  [
    /(?<![\p{L}\p{N}])(?:\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}|[A-Z\d]{2}\.[A-Z\d]{3}\.[A-Z\d]{3}\/[A-Z\d]{4}-\d{2})(?![\p{L}\p{N}])/gu,
    "document",
  ],
  // CPF (11 dígitos crus também: ambíguo com celular, e os dois são PII)
  [/(?<!\p{N})\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\p{N})/gu, "document"],
  // telefone BR com DDD: +55, (11), 9 opcional, 4+4 dígitos
  [/(?<!\p{N})(?:\+ ?55 ?)?(?:\(0?[1-9]\d\) ?|0?[1-9]\d[ .-]?)9? ?\d{4}[ .-]?\d{4}(?!\p{N})/gu, "phone"],
];

/** Troca cada ocorrência pelo token do tipo e conta as trocas. */
export function maskSensitiveData(text: string): { readonly text: string; readonly counts: MaskCounts } {
  const counts: Record<MaskKind, number> = { email: 0, phone: 0, document: 0, link: 0 };
  let masked = text;
  for (const [pattern, kind] of MASKS) {
    masked = masked.replace(pattern, () => {
      counts[kind] += 1;
      return MASK_TOKENS[kind];
    });
  }
  return { text: masked, counts };
}
