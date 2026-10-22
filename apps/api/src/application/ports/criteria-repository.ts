// Critérios do usuário (ADR-017 D1). O adapter em Supabase é do F1-DB-01; até lá só há um fake nos testes.
// Quem chama é a rota, num preHandler antes da cota (ADR-017 D6): o AnalyzeJob recebe os critérios prontos e
// nunca vê o userId (minimização).
import type { UserCriteria } from "@trampo/contracts";

/**
 * `found: false` sem `unavailable`: o usuário não configurou (409 `CRITERIOS_NAO_CONFIGURADOS`).
 * `unavailable: true`: banco fora do ar ou resposta fora do contrato (503, falha fechado).
 */
export type CriteriaLookup =
  | { readonly found: true; readonly criteria: UserCriteria }
  | { readonly found: false; readonly unavailable?: false }
  | { readonly found: false; readonly unavailable: true };

export interface CriteriaRepository {
  /** `userId` do JWT (ADR-013). Nunca rejeita: qualquer falha é `unavailable`. */
  load(userId: string): Promise<CriteriaLookup>;
}
