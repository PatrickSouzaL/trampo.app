// AccountStore sobre o PostgREST do Supabase (ADR-029 D2 a D4). A exclusão chama a função `delete_own_account` por
// RPC com o token do dono: sem service_role e sem chave secret, a função só apaga a conta do `sub` do próprio JWT. As
// duas listas da exportação saem por `select` com colunas explícitas, o filtro pelo dono (a RLS é a segunda barreira),
// da mais nova para a mais velha. Entra no compose-app sempre embrulhado no AccountService. Nunca rejeita, e nenhuma
// linha fora da forma passa.
//
// Paginação (ADR-031 D5, §7.3): páginas de 1.000 linhas (o `max_rows` do PostgREST) por cursor de chave composta, do
// mais novo para o mais velho, com o filtro `or` na borda exata: `(k.lt."v",and(k.eq."v",id.lt.<id>))`. O cursor leva o
// valor CRU que o Postgres devolveu (em microssegundos), nunca a data convertida do contrato (em milissegundos), que
// pularia linhas do mesmo milissegundo. Até 10 páginas por lista; depois, uma sonda de 1 linha só liga a marca de
// corte. Qualquer página que falha, ou sai da forma, derruba a lista inteira: nunca um arquivo pela metade.
import { AccountDeleteResultSchema, type ExportedAnalysis, type ExportedFeedback } from "@trampo/contracts/account";
import { DecisionPathSchema, VerdictSchema } from "@trampo/contracts/analysis-report";
import { ACCOUNT_EXPORT_MAX_ROWS } from "@trampo/contracts/limits";
import { z } from "zod";

import type { AccountDeletion, AccountRecords, AccountStore, AccountSubject } from "../../application/ports/account-store.js";
import type { PostgrestUserClient } from "../supabase/postgrest-user-client.js";

export const ACCOUNT_DELETE_FUNCTION = "delete_own_account";
/** As colunas de cada lista, e só elas: nada do `user_id`. */
export const ANALYSES_SELECT = "id,created_at,decision_path,verdict,score";
export const FEEDBACK_SELECT = "analysis_id,agreement,reason,updated_at";
/** O tamanho da página: o `max_rows` do PostgREST do Supabase (ADR-031 D5). */
export const ACCOUNT_EXPORT_PAGE_ROWS = 1_000;
/** Páginas por lista até o teto do contrato. */
const MAX_PAGES = Math.ceil(ACCOUNT_EXPORT_MAX_ROWS / ACCOUNT_EXPORT_PAGE_ROWS);

/** O `timestamptz` como o PostgREST o escreve (com fuso), convertido depois para o ISO em UTC do contrato. */
const Timestamp = z.iso.datetime({ offset: true });

const AnalysisRowsSchema = z
  .array(
    z.strictObject({
      id: z.uuid(),
      created_at: Timestamp,
      decision_path: DecisionPathSchema,
      verdict: VerdictSchema,
      score: z.int().min(0).max(100),
    }),
  )
  .max(ACCOUNT_EXPORT_PAGE_ROWS);

const FeedbackRowsSchema = z
  .array(
    z.strictObject({
      analysis_id: z.uuid(),
      agreement: z.enum(["concordo", "discordo"]),
      reason: z.enum(["nota_alta_demais", "nota_baixa_demais", "fato_extraido_errado", "veredito_errado", "outro"]).nullable(),
      updated_at: Timestamp,
    }),
  )
  .max(ACCOUNT_EXPORT_PAGE_ROWS);

/** O cursor: o valor cru da chave e o id da última linha da página anterior (os dois já validados pelo schema). */
interface Cursor {
  readonly key: string;
  readonly id: string;
}

/** Uma lista paginada: a tabela, as colunas, as chaves do cursor, o schema de uma página e a conversão de cada linha. */
interface ListSpec<Row, Out> {
  readonly table: "analyses" | "analysis_feedback";
  readonly select: string;
  readonly keyColumn: string;
  readonly idColumn: string;
  readonly rows: z.ZodType<Row[]>;
  readonly cursorOf: (row: Row) => Cursor;
  readonly toOut: (row: Row) => Out;
}

type ListRead<Out> = { readonly rows: readonly Out[]; readonly truncated: boolean } | null;

const ANALYSES_LIST: ListSpec<z.infer<typeof AnalysisRowsSchema>[number], ExportedAnalysis> = {
  table: "analyses",
  select: ANALYSES_SELECT,
  keyColumn: "created_at",
  idColumn: "id",
  rows: AnalysisRowsSchema,
  cursorOf: (row) => ({ key: row.created_at, id: row.id }),
  toOut: (row) => ({ id: row.id, createdAt: utc(row.created_at), decisionPath: row.decision_path, verdict: row.verdict, score: row.score }),
};

const FEEDBACK_LIST: ListSpec<z.infer<typeof FeedbackRowsSchema>[number], ExportedFeedback> = {
  table: "analysis_feedback",
  select: FEEDBACK_SELECT,
  keyColumn: "updated_at",
  idColumn: "analysis_id",
  rows: FeedbackRowsSchema,
  cursorOf: (row) => ({ key: row.updated_at, id: row.analysis_id }),
  toOut: (row) => ({ analysisId: row.analysis_id, agreement: row.agreement, reason: row.reason, updatedAt: utc(row.updated_at) }),
};

const DELETE_UNAVAILABLE: AccountDeletion = { done: false, unavailable: true };
const RECORDS_UNAVAILABLE: AccountRecords = { found: false, unavailable: true };

function utc(timestamp: string): string {
  return new Date(timestamp).toISOString();
}

export interface SupabaseAccountStoreDeps {
  /** Cliente de usuário próprio da conta: prazo e teto de leitura maiores que os dos critérios (ADR-029 D3 e D4). */
  readonly client: PostgrestUserClient;
}

export function createSupabaseAccountStore(deps: SupabaseAccountStoreDeps): AccountStore {
  const { client } = deps;

  /** Uma página: `limit` linhas depois do cursor, ou `null` se a leitura falha ou sai da forma. */
  const page = async <Row, Out>(spec: ListSpec<Row, Out>, subject: AccountSubject, cursor: Cursor | null, limit: number, signal: AbortSignal | undefined): Promise<Row[] | null> => {
    const query: Record<string, string> = {
      select: spec.select,
      user_id: `eq.${subject.userId}`,
      order: `${spec.keyColumn}.desc,${spec.idColumn}.desc`,
      limit: String(limit),
    };
    // A borda exata da chave composta, do mais novo para o mais velho. O valor da chave é citado (tem `.`, `:` e `+`).
    if (cursor !== null) query["or"] = `(${spec.keyColumn}.lt."${cursor.key}",and(${spec.keyColumn}.eq."${cursor.key}",${spec.idColumn}.lt.${cursor.id}))`;
    const read = await client.select(spec.table, query, subject.accessToken, signal);
    if (!read.ok) return null;
    const parsed = spec.rows.safeParse(read.value);
    return parsed.success ? parsed.data : null;
  };

  /** A lista inteira, página por página, até o teto do contrato; `null` se qualquer página falha. */
  const readAll = async <Row, Out>(spec: ListSpec<Row, Out>, subject: AccountSubject, signal: AbortSignal | undefined): Promise<ListRead<Out>> => {
    const rows: Out[] = [];
    let cursor: Cursor | null = null;
    for (let index = 0; index < MAX_PAGES; index += 1) {
      const current = await page(spec, subject, cursor, ACCOUNT_EXPORT_PAGE_ROWS, signal);
      if (current === null) return null;
      for (const row of current) rows.push(spec.toOut(row));
      const last = current.at(-1);
      if (current.length < ACCOUNT_EXPORT_PAGE_ROWS || last === undefined) return { rows, truncated: false };
      cursor = spec.cursorOf(last);
    }
    // O teto cheio: uma linha a mais só diz se houve corte, e nunca sai.
    const probe = await page(spec, subject, cursor, 1, signal);
    return probe === null ? null : { rows, truncated: probe.length > 0 };
  };

  return {
    async deleteOwn(subject, signal) {
      const called = await client.rpc(ACCOUNT_DELETE_FUNCTION, subject.accessToken, signal);
      if (!called.ok) return DELETE_UNAVAILABLE;
      const result = AccountDeleteResultSchema.safeParse(called.value);
      return result.success ? { done: true, result: result.data } : DELETE_UNAVAILABLE;
    },

    async records(subject, signal) {
      // As duas listas em paralelo; dentro de cada uma, as páginas em série (o cursor vem da página anterior).
      const [analyses, feedback] = await Promise.all([readAll(ANALYSES_LIST, subject, signal), readAll(FEEDBACK_LIST, subject, signal)]);
      if (analyses === null || feedback === null) return RECORDS_UNAVAILABLE;
      return {
        found: true,
        analyses: analyses.rows,
        analysesTruncated: analyses.truncated,
        feedback: feedback.rows,
        feedbackTruncated: feedback.truncated,
      };
    },
  };
}
