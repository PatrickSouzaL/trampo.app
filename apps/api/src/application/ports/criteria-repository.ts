// Critérios do usuário (ADR-017 D1; ADR-018 D6). O adapter em Supabase é do F1-DB-01 parte 2, embrulhado pelo
// CriteriaGuard (prazo e revalidação). Quem chama é a rota, num preHandler antes da cota (ADR-017 D6): o
// AnalyzeJob recebe os critérios prontos e nunca vê o userId nem o token (minimização).
import type { UserCriteria } from "@trampo/contracts";

/**
 * `found: false` sem `unavailable`: o usuário não configurou (409 `CRITERIOS_NAO_CONFIGURADOS`).
 * `unavailable: true`: banco fora do ar, prazo estourado, cifra que não abre ou resposta fora do contrato
 * (503, falha fechado).
 */
export type CriteriaLookup =
  | { readonly found: true; readonly criteria: UserCriteria }
  | { readonly found: false; readonly unavailable?: false }
  | { readonly found: false; readonly unavailable: true };

/**
 * Dono dos critérios. `userId` é o `sub` verificado (ADR-013), e `accessToken` é o mesmo token já verificado
 * nesta requisição: o adapter o leva ao PostgREST para que a RLS valha como segunda barreira (ADR-018 D5).
 * O token só trafega: ninguém o guarda nem o loga.
 */
export interface CriteriaSubject {
  readonly userId: string;
  readonly accessToken: string;
}

export interface CriteriaRepository {
  /** Nunca rejeita: qualquer falha é `unavailable`. O `signal` aborta a chamada que perdeu o prazo. */
  load(subject: CriteriaSubject, signal?: AbortSignal): Promise<CriteriaLookup>;
}
