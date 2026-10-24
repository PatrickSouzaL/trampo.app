// F1-API-05 commit 6 (ADR-021 D10 e §3, critérios 2 e 9): a escrita dos critérios contra o Supabase local do
// runner, pelo adapter real da API e pelo PostgREST e o Postgres reais. Prova o SR-15 da escrita com a primeira
// barreira furada de propósito (a RLS recusa o user_id de outro dono), o status de sucesso do upsert, o perfil
// válido mais pesado no check de 16 KiB, duas gravações concorrentes do mesmo dono e a vírgula codificada do
// `columns=`. Roda só no job db do CI, pelo `pnpm --filter @trampo/api test:db`, em série com o rls.db.test.ts.
import { randomBytes } from "node:crypto";

import { USER_CRITERIA_MAX_JSON_BYTES, userCriteriaJsonBytes, type UserCriteria } from "@trampo/contracts";
import { beforeAll, describe, expect, test } from "vitest";

import type { CriteriaSubject } from "../../src/application/ports/criteria-repository.js";
import { createSalaryCipher, parseSalaryKeyring } from "../../src/infrastructure/crypto/salary-cipher.js";
import {
  USER_CRITERIA_COLUMNS,
  createSupabaseCriteriaRepository,
} from "../../src/infrastructure/persistence/supabase-criteria-repository.js";
import { POSTGREST_CLIENT_POLICY, createPostgrestUserClient } from "../../src/infrastructure/supabase/postgrest-user-client.js";
import { criteria, stack as stackOf, weighted } from "../domain/fakes/scoring-fixtures.js";
import { CRITERIA_SIZE_SQL } from "./support/catalog-sql.js";
import { heaviestCriteria } from "./support/heaviest-criteria.js";
import { parseLocalStackEnv, type LocalStack } from "./support/local-stack-env.js";
import { PostgrestErrorSchema, psqlJson, rest, signUp, upsert, type RestResponse, type StackUser } from "./support/local-stack.js";

const stack: LocalStack = parseLocalStackEnv(process.env);
// Chave gerada no teste: nenhum anel real entra no runner.
const cipher = createSalaryCipher(parseSalaryKeyring(`k1:${randomBytes(32).toString("base64url")}`, "k1"));
const client = createPostgrestUserClient({ url: stack.apiUrl, publishableKey: stack.publishableKey });
const repository = createSupabaseCriteriaRepository({ now: () => Date.now(), client, cipher });

/** Dois documentos que diferem em toda coluna, inclusive na pretensão: uma mistura não passaria por nenhum deles. */
const FIRST: UserCriteria = criteria({
  workModel: { accepted: ["remoto"], importance: weighted(5) },
  salary: { minimum: 9_000, currency: "BRL", period: "mes", importance: weighted(3) },
  stack: stackOf({ mustHave: ["TypeScript"] }),
  notes: "primeiro documento",
});
const SECOND: UserCriteria = criteria({
  workModel: { accepted: ["hibrido", "presencial"], importance: weighted(2) },
  salary: null,
  stack: stackOf({ mustHave: ["Go"], dealBreakers: ["PHP"] }),
  notes: "segundo documento",
});

const subject = (owner: StackUser): CriteriaSubject => ({ userId: owner.userId, accessToken: owner.accessToken });

/** A query do adapter, com a vírgula do `columns=` como o URLSearchParams a escreve (`%2C`). */
const ADAPTER_QUERY = new URLSearchParams({ on_conflict: "user_id", columns: USER_CRITERIA_COLUMNS.join(",") }).toString();

/** A linha que o adapter grava, com as 5 colunas do D5, montada à mão para o upsert cru e para o cliente direto. */
function row(owner: StackUser, value: UserCriteria = FIRST): Record<(typeof USER_CRITERIA_COLUMNS)[number], unknown> {
  const { salary, schemaVersion, ...column } = value;
  return {
    user_id: owner.userId,
    schema_version: schemaVersion,
    criteria: column,
    salary_ciphertext: cipher.seal(owner.userId, salary),
    updated_at: new Date().toISOString(),
  };
}

/** A linha inteira como o dono a vê (cifrado e `updated_at` incluídos), para provar que nada mudou. */
const rawRowOf = (owner: StackUser): Promise<RestResponse> => rest(stack, "GET", `user_criteria?user_id=eq.${owner.userId}`, owner);

function expectPgError(response: RestResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  expect(PostgrestErrorSchema.parse(response.body).code).toBe(code);
}

describe("SR-15 da escrita: a RLS segura o user_id de outro dono (critério 2)", () => {
  let a: StackUser;
  let b: StackUser;

  beforeAll(async () => {
    a = await signUp(stack);
    b = await signUp(stack);
  });

  test("A grava pelo adapter real, e a leitura devolve o mesmo documento", async () => {
    await expect(repository.save(subject(a), FIRST)).resolves.toEqual({ saved: true });
    await expect(repository.load(subject(a))).resolves.toEqual({ found: true, criteria: FIRST });
  });

  test("inserção: o adapter e o cliente de A com o user_id de B são recusados, e B continua sem linha", async () => {
    // A primeira barreira furada de propósito: o dono vem de B, o token é de A.
    await expect(repository.save({ userId: b.userId, accessToken: a.accessToken }, SECOND)).resolves.toEqual({
      saved: false,
      unavailable: true,
    });
    const direct = await client.upsert(
      "user_criteria",
      { columns: USER_CRITERIA_COLUMNS, onConflict: "user_id", row: row(b, SECOND) },
      a.accessToken,
    );
    expect(direct).toEqual({ ok: false });
    // O mesmo pedido, cru: quem recusa é a RLS (42501 no with check do insert), não outra coisa.
    expectPgError(await upsert(stack, `user_criteria?${ADAPTER_QUERY}`, a, row(b, SECOND)), 403, "42501");
    expect(await rawRowOf(b)).toEqual({ status: 200, body: [] });
    await expect(repository.load(subject(b))).resolves.toEqual({ found: false });
  });

  test("insert puro (sem ON CONFLICT nem RETURNING) com o user_id de B: o with check do insert recusa sozinho", async () => {
    // No upsert e no insert com RETURNING, o Postgres também cobra a policy de SELECT da linha nova. Aqui nenhuma
    // das duas entra, e só a policy de insert separa A da linha de B.
    expectPgError(await upsert(stack, "user_criteria", a, row(b, SECOND), "return=minimal"), 403, "42501");
    expect(await rawRowOf(b)).toEqual({ status: 200, body: [] });
  });

  test("sobrescrita: com a linha de B gravada, o mesmo ataque é recusado e a linha de B fica intacta", async () => {
    await expect(repository.save(subject(b), SECOND)).resolves.toEqual({ saved: true });
    const before = await rawRowOf(b);
    expect(before).toEqual({ status: 200, body: [expect.objectContaining({ user_id: b.userId })] });

    await expect(repository.save({ userId: b.userId, accessToken: a.accessToken }, FIRST)).resolves.toEqual({
      saved: false,
      unavailable: true,
    });
    const direct = await client.upsert(
      "user_criteria",
      { columns: USER_CRITERIA_COLUMNS, onConflict: "user_id", row: row(b, FIRST) },
      a.accessToken,
    );
    expect(direct).toEqual({ ok: false });
    expectPgError(await upsert(stack, `user_criteria?${ADAPTER_QUERY}`, a, row(b, FIRST)), 403, "42501");

    // Byte a byte: critérios, cifrado e updated_at.
    expect(await rawRowOf(b)).toEqual(before);
    await expect(repository.load(subject(b))).resolves.toEqual({ found: true, criteria: SECOND });
    // E a linha de A também não mudou.
    await expect(repository.load(subject(a))).resolves.toEqual({ found: true, criteria: FIRST });
  });

  test("anon continua sem acesso: o upsert sem token é recusado", async () => {
    expectPgError(await upsert(stack, `user_criteria?${ADAPTER_QUERY}`, null, row(b, FIRST)), 401, "42501");
    await expect(repository.load(subject(b))).resolves.toEqual({ found: true, criteria: SECOND });
  });
});

describe("o upsert real (D5)", () => {
  let c: StackUser;

  beforeAll(async () => {
    c = await signUp(stack);
  });

  test("o sucesso é 201 na inserção e 200 na atualização, sem corpo, e são os status fixados no cliente", async () => {
    const inserted = await upsert(stack, `user_criteria?${ADAPTER_QUERY}`, c, row(c, FIRST));
    expect(inserted).toEqual({ status: 201, body: null });
    const updated = await upsert(stack, `user_criteria?${ADAPTER_QUERY}`, c, row(c, SECOND));
    expect(updated).toEqual({ status: 200, body: null });
    expect(POSTGREST_CLIENT_POLICY.upsertSuccessStatuses).toEqual([201, 200]);
    await expect(repository.load(subject(c))).resolves.toEqual({ found: true, criteria: SECOND });
  });

  test("a vírgula codificada (%2C) do columns= é lida como lista: a chave fora da lista é ignorada", async () => {
    expect(ADAPTER_QUERY).toContain("columns=user_id%2Cschema_version%2Ccriteria%2Csalary_ciphertext%2Cupdated_at");
    const intruder = { ...row(c, FIRST), intruso: "fora da lista" };
    const encoded = await upsert(stack, `user_criteria?${ADAPTER_QUERY}`, c, intruder);
    expect(encoded).toEqual({ status: 200, body: null });
    // A vírgula crua dá o mesmo resultado.
    const plain = await upsert(stack, `user_criteria?on_conflict=user_id&columns=${USER_CRITERIA_COLUMNS.join(",")}`, c, intruder);
    expect(plain).toEqual({ status: 200, body: null });
    // Controle: sem o columns=, a mesma chave derruba a escrita. Então foi a lista que a deixou de fora.
    const unlisted = await upsert(stack, "user_criteria?on_conflict=user_id", c, intruder);
    expect(unlisted.status).toBe(400);
    expect(PostgrestErrorSchema.parse(unlisted.body).code).toBe("PGRST204");
    await expect(repository.load(subject(c))).resolves.toEqual({ found: true, criteria: FIRST });
  });

  test("o cliente da API grava pelo mesmo caminho, nos dois ramos", async () => {
    const fresh = await signUp(stack);
    for (const [owner, value] of [
      [fresh, FIRST], // inserção (201)
      [fresh, SECOND], // atualização (200)
      [c, SECOND], // atualização da linha que já existia
    ] as const) {
      const written = await client.upsert(
        "user_criteria",
        { columns: USER_CRITERIA_COLUMNS, onConflict: "user_id", row: row(owner, value) },
        owner.accessToken,
      );
      expect(written).toEqual({ ok: true });
      await expect(repository.load(subject(owner))).resolves.toEqual({ found: true, criteria: value });
    }
  });
});

describe("o perfil válido mais pesado cabe no check de 16 KiB (critério 9)", () => {
  test("12.288 bytes de JSON em ideogramas de 4 bytes: gravado, lido igual e medido no banco", async () => {
    const heaviest = heaviestCriteria();
    expect(userCriteriaJsonBytes(heaviest)).toBe(USER_CRITERIA_MAX_JSON_BYTES);
    const d = await signUp(stack);

    await expect(repository.save(subject(d), heaviest)).resolves.toEqual({ saved: true });
    await expect(repository.load(subject(d))).resolves.toEqual({ found: true, criteria: heaviest });

    const size = psqlJson(stack, CRITERIA_SIZE_SQL, { uid: d.userId }) as { stored: number; plain: number };
    // O check mede a coluna sem compressão: o pior caso fica perto do teto do contrato e abaixo do check.
    expect(size.plain).toBeGreaterThan(12_000);
    expect(size.plain).toBeLessThanOrEqual(16_384);
    // E o TOAST não o encolheu de forma relevante: a folga até o check não vem de compressão.
    expect(size.stored * 10).toBeGreaterThanOrEqual(size.plain * 9);
  });
});

describe("duas gravações concorrentes do mesmo dono (D7)", () => {
  const ROUNDS = 5;

  test.each(Array.from({ length: ROUNDS }, (_, round) => [round + 1]))(
    "rodada %d: na inserção e na atualização, um dos dois documentos inteiro, nunca uma mistura",
    async () => {
      const owner = await signUp(stack);
      // A primeira corrida é entre duas inserções (sem linha ainda): o ON CONFLICT não deixa nenhuma dar erro de
      // chave duplicada. A segunda é entre duas atualizações da linha que ficou.
      for (let race = 0; race < 2; race += 1) {
        const results = await Promise.all([repository.save(subject(owner), FIRST), repository.save(subject(owner), SECOND)]);
        expect(results).toEqual([{ saved: true }, { saved: true }]);
        // A pretensão (no cifrado) e o resto (na coluna) vêm da mesma gravação, ou o documento não bateria.
        expect([
          { found: true, criteria: FIRST },
          { found: true, criteria: SECOND },
        ]).toContainEqual(await repository.load(subject(owner)));
      }
    },
  );
});
