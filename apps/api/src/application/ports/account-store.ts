// A conta do usuário no banco (ADR-029 D2 a D4): a exclusão pela função `delete_own_account` e as duas listas da
// exportação. O adapter em Supabase fica em infrastructure/persistence e entra sempre embrulhado no AccountService
// (prazo e revalidação). Como nos critérios, o dono vem do `sub` verificado, e o token só trafega: é o mesmo já
// verificado nesta requisição, levado ao PostgREST para a RLS e o `auth.uid()` valerem.
import type { AccountDeleteResult, ExportedAnalysis, ExportedFeedback } from "@trampo/contracts/account";

export interface AccountSubject {
  readonly userId: string;
  readonly accessToken: string;
}

/**
 * `done: false` é sempre `unavailable`: banco fora do ar, prazo, resposta fora das três palavras. NÃO prova que nada
 * foi apagado (a função pode ter terminado depois do prazo).
 */
export type AccountDeletion =
  | { readonly done: true; readonly result: AccountDeleteResult }
  | { readonly done: false; readonly unavailable: true };

/** As listas já cortadas no teto do contrato, da mais nova para a mais velha. `found: false` é sempre `unavailable`. */
export type AccountRecords =
  | {
      readonly found: true;
      readonly analyses: readonly ExportedAnalysis[];
      readonly analysesTruncated: boolean;
      readonly feedback: readonly ExportedFeedback[];
      readonly feedbackTruncated: boolean;
    }
  | { readonly found: false; readonly unavailable: true };

export interface AccountStore {
  /** Apaga a conta do dono do token. Nunca rejeita: qualquer falha é `unavailable`. */
  deleteOwn(subject: AccountSubject, signal?: AbortSignal): Promise<AccountDeletion>;
  /** As análises e as avaliações do dono. Nunca rejeita: qualquer falha é `unavailable`. */
  records(subject: AccountSubject, signal?: AbortSignal): Promise<AccountRecords>;
}
