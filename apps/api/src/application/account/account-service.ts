// Exportar e excluir a conta (ADR-029 D3 e D4; SR-16). Os dois casos de uso em volta do AccountStore, no molde do
// CriteriaGuard: a entrada é conferida antes de tocar na porta, a porta ganha um prazo (withDeadline) e a resposta é
// revalidada por schema estrito. Exceção, rejeição, demora ou resposta fora do contrato viram `indisponivel` (503).
//
// - Exclusão: `indisponivel` NÃO prova que nada foi apagado; sem nova tentativa aqui. `ja_excluida` conta como
//   `excluida` (repetir o pedido é seguro).
// - Exportação: falha fechada. Se os critérios ou as listas não vierem, não sai documento nenhum: nunca um arquivo
//   pela metade parecendo completo. O documento é reparseado pelo AccountExportSchema antes de sair.
// Nunca rejeita, e nada do `sub`, do token ou dos dados vai a log.
import {
  type AccountExport,
  AccountDeleteResultSchema,
  AccountExportSchema,
  ACCOUNT_SCHEMA_VERSION,
  ExportedAnalysisSchema,
  ExportedFeedbackSchema,
} from "@trampo/contracts/account";
import { ACCESS_TOKEN_MAX_CHARS, ACCOUNT_EXPORT_MAX_ROWS } from "@trampo/contracts/limits";
import { z } from "zod";

import type { AccountDeletion, AccountRecords, AccountStore, AccountSubject } from "../ports/account-store.js";
import type { Clock } from "../ports/clock.js";
import type { CriteriaLookup, CriteriaReader } from "../ports/criteria-repository.js";
import { withDeadline } from "../shared/with-deadline.js";

/** Hipóteses da Fase 1 (PostgREST na mesma região), calibradas no S-5. Mudam só por ADR. */
export const ACCOUNT_SERVICE_POLICY = {
  /** A exclusão apaga em cascata: mais folga que o 1 s dos critérios. O cliente HTTP da conta fica logo abaixo. */
  deleteTimeoutMs: 2_000,
  recordsTimeoutMs: 2_000,
  accessTokenMaxChars: ACCESS_TOKEN_MAX_CHARS,
} as const;

/** `excluida` cobre a repetição; `login_antigo` não apagou nada; `indisponivel` não prova nada. */
export type AccountDeleteOutcome = "excluida" | "login_antigo" | "indisponivel";
export type AccountExportOutcome = { readonly ok: true; readonly document: AccountExport } | { readonly ok: false };

export interface AccountServiceDeps {
  readonly store: AccountStore;
  /** O mesmo CriteriaGuard das rotas de critérios: ele já tem prazo e revalidação próprios. */
  readonly criteria: CriteriaReader;
  readonly clock: Clock;
  /** Relógio de parede, em milissegundos, para o `exportedAt`. */
  readonly now: () => number;
}

const SubjectSchema = z.strictObject({
  userId: z.uuid(),
  accessToken: z
    .string()
    .max(ACCOUNT_SERVICE_POLICY.accessTokenMaxChars)
    .regex(/^[\w-]+\.[\w-]+\.[\w-]+$/),
});

/** Só o sucesso tem forma: qualquer outra resposta da porta (inclusive a falha declarada) é `indisponivel`. */
const DeletionSchema = z.strictObject({ done: z.literal(true), result: AccountDeleteResultSchema });
const RecordsSchema = z.strictObject({
  found: z.literal(true),
  analyses: z.array(ExportedAnalysisSchema).max(ACCOUNT_EXPORT_MAX_ROWS),
  analysesTruncated: z.boolean(),
  feedback: z.array(ExportedFeedbackSchema).max(ACCOUNT_EXPORT_MAX_ROWS),
  feedbackTruncated: z.boolean(),
});

const DELETE_UNAVAILABLE: AccountDeletion = { done: false, unavailable: true };
const RECORDS_UNAVAILABLE: AccountRecords = { found: false, unavailable: true };
const CRITERIA_UNAVAILABLE: CriteriaLookup = { found: false, unavailable: true };
const EXPORT_UNAVAILABLE: AccountExportOutcome = { ok: false };

function revalidateDeletion(value: unknown): AccountDeletion {
  const parsed = DeletionSchema.safeParse(value);
  return parsed.success ? { done: true, result: parsed.data.result } : DELETE_UNAVAILABLE;
}

function revalidateRecords(value: unknown): AccountRecords {
  const parsed = RecordsSchema.safeParse(value);
  return parsed.success ? parsed.data : RECORDS_UNAVAILABLE;
}

export class AccountService {
  readonly #deps: AccountServiceDeps;

  constructor(deps: AccountServiceDeps) {
    this.#deps = deps;
  }

  /** Apaga a conta do dono do token. O `signal` de quem chama não entra: o prazo e o aborto são daqui. */
  async delete(subject: AccountSubject): Promise<AccountDeleteOutcome> {
    const input = SubjectSchema.safeParse(subject);
    if (!input.success) return "indisponivel";
    const { store, clock } = this.#deps;
    const deletion = await withDeadline(
      clock,
      ACCOUNT_SERVICE_POLICY.deleteTimeoutMs,
      (signal) => store.deleteOwn(input.data, signal).then(revalidateDeletion),
      DELETE_UNAVAILABLE,
    );
    if (!deletion.done) return "indisponivel";
    return deletion.result === "login_antigo" ? "login_antigo" : "excluida";
  }

  /** O documento da exportação, ou nada. */
  async export(subject: AccountSubject): Promise<AccountExportOutcome> {
    const input = SubjectSchema.safeParse(subject);
    if (!input.success) return EXPORT_UNAVAILABLE;
    const { store, criteria, clock, now } = this.#deps;
    const [lookup, records] = await Promise.all([
      // A porta dos critérios nunca rejeita (é o CriteriaGuard); se rejeitar ou lançar, é banco fora do ar.
      Promise.resolve()
        .then(() => criteria.load(input.data))
        .catch(() => CRITERIA_UNAVAILABLE),
      withDeadline(
        clock,
        ACCOUNT_SERVICE_POLICY.recordsTimeoutMs,
        (signal) => store.records(input.data, signal).then(revalidateRecords),
        RECORDS_UNAVAILABLE,
      ),
    ]);
    // "Não configurou" é `null` no arquivo; "indisponível" derruba a exportação inteira.
    if (!lookup.found && lookup.unavailable === true) return EXPORT_UNAVAILABLE;
    if (!records.found) return EXPORT_UNAVAILABLE;
    try {
      const document = AccountExportSchema.safeParse({
        schemaVersion: ACCOUNT_SCHEMA_VERSION,
        exportedAt: new Date(now()).toISOString(),
        criteria: lookup.found ? lookup.criteria : null,
        analyses: records.analyses,
        analysesTruncated: records.analysesTruncated,
        feedback: records.feedback,
        feedbackTruncated: records.feedbackTruncated,
      });
      return document.success ? { ok: true, document: document.data } : EXPORT_UNAVAILABLE;
    } catch {
      // Relógio inválido: `toISOString` lança.
      return EXPORT_UNAVAILABLE;
    }
  }
}
