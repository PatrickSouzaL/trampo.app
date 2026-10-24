// CriteriaRepository sobre o PostgREST do Supabase (ADR-018 D5; ADR-021 D5 e D6). Lê e grava a linha do dono
// com o token dele (a RLS é a segunda barreira; o `user_id` do `sub` verificado é a primeira). Na leitura, abre a
// pretensão com o SalaryCipher e monta o UserCriteria; na escrita, cifra a pretensão antes de ela sair do processo
// e grava por um único upsert com as colunas explícitas. Entra no main.ts sempre embrulhado no CriteriaGuard.
//
// Falha de decifragem é `unavailable` (503), NUNCA `found: false` (409): quem perdeu a chave não pode ver
// "configure seus critérios" e sobrescrever o que tinha (critério 3 do [APPSEC]). O mesmo vale para `salary` em
// claro na coluna `criteria`, linha fora da forma ou mais de uma linha. Nunca rejeita.
import { UserCriteriaSchema } from "@trampo/contracts";
import { z } from "zod";

import type { CriteriaLookup, CriteriaRepository, CriteriaSave } from "../../application/ports/criteria-repository.js";
import type { SalaryCipher } from "../crypto/salary-cipher.js";
import type { PostgrestUserClient, PostgrestWritableColumns } from "../supabase/postgrest-user-client.js";

/** As colunas do D2, e só elas: nada de `updated_at` nem do `user_id` (o filtro já é o dono). */
export const USER_CRITERIA_SELECT = "schema_version,criteria,salary_ciphertext";

/**
 * As colunas da escrita (ADR-021 D4), e só elas, na ordem da URL (`columns=`). O `user_id` vem do `sub`, nunca do
 * corpo da rota.
 */
export const USER_CRITERIA_COLUMNS = [
  "user_id",
  "schema_version",
  "criteria",
  "salary_ciphertext",
  "updated_at",
] as const satisfies readonly PostgrestWritableColumns["user_criteria"][];

/** 0 ou 1 linha (o `user_id` é a chave primária). Duas linhas é resposta fora do contrato. */
const RowsSchema = z
  .array(
    z.strictObject({
      schema_version: z.literal(1),
      criteria: z.record(z.string(), z.unknown()),
      salary_ciphertext: z.string(),
    }),
  )
  .max(1);

/**
 * Chaves que não podem estar na coluna `criteria`: a pretensão mora só no cifrado (o `check` do banco também a
 * recusa), e a versão mora só na coluna `schema_version`. Nenhuma das duas é sobrescrita em silêncio.
 */
const RESERVED_KEYS = ["salary", "schemaVersion"] as const;

const UNAVAILABLE: CriteriaLookup = { found: false, unavailable: true };
const NOT_CONFIGURED: CriteriaLookup = { found: false };
const SAVED: CriteriaSave = { saved: true };
const SAVE_UNAVAILABLE: CriteriaSave = { saved: false, unavailable: true };

export interface SupabaseCriteriaRepositoryDeps {
  readonly client: PostgrestUserClient;
  readonly cipher: SalaryCipher;
  /**
   * Relógio do `updated_at`. No ramo de update do upsert, o `default now()` do banco não roda, e é este valor que
   * renova a coluna. Ela é só informativa: nada decide por ela (ADR-018 §3.3).
   */
  readonly now: () => number;
}

export function createSupabaseCriteriaRepository(deps: SupabaseCriteriaRepositoryDeps): CriteriaRepository {
  const { client, cipher, now } = deps;
  return {
    async load(subject, signal) {
      const query = { select: USER_CRITERIA_SELECT, user_id: `eq.${subject.userId}` };
      const read = await client.select("user_criteria", query, subject.accessToken, signal);
      if (!read.ok) return UNAVAILABLE;
      const rows = RowsSchema.safeParse(read.value);
      if (!rows.success) return UNAVAILABLE;
      const [row] = rows.data;
      if (row === undefined) return NOT_CONFIGURED;
      if (RESERVED_KEYS.some((key) => Object.hasOwn(row.criteria, key))) return UNAVAILABLE;
      // O AAD liga o cifrado ao dono: a linha de outro usuário (se as duas barreiras falhassem) não abre.
      const salary = cipher.open(subject.userId, row.salary_ciphertext);
      if (!salary.ok) return UNAVAILABLE;
      const criteria = UserCriteriaSchema.safeParse({
        ...row.criteria,
        schemaVersion: row.schema_version,
        salary: salary.salary,
      });
      return criteria.success ? { found: true, criteria: criteria.data } : UNAVAILABLE;
    },

    async save(subject, criteria, signal) {
      let row: Record<(typeof USER_CRITERIA_COLUMNS)[number], unknown>;
      try {
        // A pretensão sai do processo só dentro do envelope, com o AAD do dono (ADR-021 D6). Cifra sempre, inclusive
        // o `null`. A SalarySealError (dono ou pretensão fora do contrato) e um relógio inválido viram `unavailable`.
        const { salary, schemaVersion, ...column } = criteria;
        row = {
          user_id: subject.userId,
          schema_version: schemaVersion,
          // As chaves que o banco e a leitura recusam (RESERVED_KEYS) ficam fora da coluna.
          criteria: column,
          salary_ciphertext: cipher.seal(subject.userId, salary),
          updated_at: new Date(now()).toISOString(),
        };
      } catch {
        return SAVE_UNAVAILABLE;
      }
      const upsert = { columns: USER_CRITERIA_COLUMNS, onConflict: "user_id", row } as const;
      const write = await client.upsert("user_criteria", upsert, subject.accessToken, signal);
      return write.ok ? SAVED : SAVE_UNAVAILABLE;
    },
  };
}
