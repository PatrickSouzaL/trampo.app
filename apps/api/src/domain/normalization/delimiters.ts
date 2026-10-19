// Neutralização de sequências que fecham o envelope do prompt (ADR-001 §5.2, item 6; ADR-005 D4,
// etapa 8; threat-model T1 e T2). As trocas usam caracteres estáveis no NFKC: o ponto fixo não as desfaz.

/** Todo "<" e ">": cobre "<<<", ">>>", "</vaga>" e qualquer formato de envelope escolhido no F1-LLM-01. */
const ANGLE_BRACKETS = /[<>]/gu;

/** Cercas de bloco de código em markdown. */
const CODE_FENCES = /`{3,}|~{3,}/gu;

/**
 * Marcador de papel no início de linha: "system:", "**Assistant**:", "› user:" (">" já neutralizado),
 * "Usuário:". O ":" vira " -", e a linha deixa de parecer uma troca de papéis.
 */
const ROLE_MARKER =
  /^([ #*›•\[(-]{0,8})(system|assistant|user|developer|tool|human|model|sistema|assistente|usu[aá]rio)([*)\]]{0,3}) ?:/gimu;

export function neutralizeDelimiters(text: string): { readonly text: string; readonly count: number } {
  let count = 0;
  const angles = text.replace(ANGLE_BRACKETS, (bracket) => {
    count += 1;
    return bracket === "<" ? "‹" : "›";
  });
  const fences = angles.replace(CODE_FENCES, () => {
    count += 1;
    return "'''";
  });
  const roles = fences.replace(ROLE_MARKER, (_match, prefix: string, role: string, suffix: string) => {
    count += 1;
    return `${prefix}${role}${suffix} -`;
  });
  return { text: roles, count };
}
