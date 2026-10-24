// Critérios do usuário (ADR-017 D1; ADR-018 D6; ADR-021 D5). O adapter em Supabase é do F1-DB-01 parte 2,
// embrulhado pelo CriteriaGuard (prazo e revalidação). Quem lê é a rota de análise, num preHandler antes da cota
// (ADR-017 D6): o AnalyzeJob recebe os critérios prontos e nunca vê o userId nem o token (minimização). A porta
// é partida em leitura e escrita (ADR-021 §5.2): quem só lê não recebe o poder de gravar.
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

/** `saved: false` é sempre `unavailable` (503): banco fora do ar, prazo, cifra que falha ou resposta fora do contrato. */
export type CriteriaSave = { readonly saved: true } | { readonly saved: false; readonly unavailable: true };

export interface CriteriaReader {
  /** Nunca rejeita: qualquer falha é `unavailable`. O `signal` aborta a chamada que perdeu o prazo. */
  load(subject: CriteriaSubject, signal?: AbortSignal): Promise<CriteriaLookup>;
}

export interface CriteriaWriter {
  /** Substitui os critérios do dono. Nunca rejeita: qualquer falha é `unavailable`. */
  save(subject: CriteriaSubject, criteria: UserCriteria, signal?: AbortSignal): Promise<CriteriaSave>;
}

export interface CriteriaRepository extends CriteriaReader, CriteriaWriter {}
