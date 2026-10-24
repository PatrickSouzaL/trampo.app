// CriteriaReader sobre o PostgREST do Supabase (ADR-018 D5; F1-DB-01 parte 2). Lê a linha do dono com o
// token dele (a RLS é a segunda barreira; o filtro por `user_id` é a primeira), abre a pretensão com o
// SalaryCipher e monta o UserCriteria. Entra no main.ts sempre embrulhado no CriteriaGuard (prazo e revalidação).
// Só lê: a escrita (CriteriaWriter) entra no commit 3 do ADR-021, sem stub até lá (ADR-021 §5.2).
//
// Falha de decifragem é `unavailable` (503), NUNCA `found: false` (409): quem perdeu a chave não pode ver
// "configure seus critérios" e sobrescrever o que tinha (critério 3 do [APPSEC]). O mesmo vale para `salary` em
// claro na coluna `criteria`, linha fora da forma ou mais de uma linha. Nunca rejeita.
import { UserCriteriaSchema } from "@trampo/contracts";
import { z } from "zod";

import type { CriteriaLookup, CriteriaReader } from "../../application/ports/criteria-repository.js";
import type { SalaryCipher } from "../crypto/salary-cipher.js";
import type { PostgrestUserClient } from "../supabase/postgrest-user-client.js";

/** As colunas do D2, e só elas: nada de `updated_at` nem do `user_id` (o filtro já é o dono). */
export const USER_CRITERIA_SELECT = "schema_version,criteria,salary_ciphertext";

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

export interface SupabaseCriteriaRepositoryDeps {
  readonly client: PostgrestUserClient;
  readonly cipher: SalaryCipher;
}

export function createSupabaseCriteriaRepository(deps: SupabaseCriteriaRepositoryDeps): CriteriaReader {
  const { client, cipher } = deps;
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
  };
}
