// F1-EXT-05a, 05a-2 (ADR-004 D9 e §4.1): a sessão guardada é estrita, revalidada na leitura e só em
// storage.session. Valor adulterado é apagado e lido como ausente.
import { beforeEach, describe, expect, test } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

import { SESSION_STORAGE_KEY, type StoredSession, StoredSessionSchema, authSessionStore } from "../src/auth/session-schema";

const ENVELOPE = `r1.k1.${"A".repeat(16)}.${"B".repeat(20)}.${"C".repeat(22)}`;
const VALID: StoredSession = {
  v: 1,
  accessToken: "aaa.bbb.ccc",
  refreshToken: ENVELOPE,
  accessExpiresAt: 1_700_000_900_000,
  obtainedAt: 1_700_000_000_000,
};

async function plant(value: unknown): Promise<void> {
  await fakeBrowser.storage.session.set({ [SESSION_STORAGE_KEY]: value });
}

describe("sessão guardada (ADR-004 D9)", () => {
  beforeEach(() => fakeBrowser.reset());

  test("a chave é trampo/sessao/v1", () => {
    expect(SESSION_STORAGE_KEY).toBe("trampo/sessao/v1");
  });

  test("grava e lê só em storage.session; local e sync nunca são tocados", async () => {
    const store = authSessionStore();
    await store.set(VALID);
    expect(await store.get()).toEqual(VALID);
    expect(await fakeBrowser.storage.session.get(null)).toEqual({ [SESSION_STORAGE_KEY]: VALID });
    // eslint-disable-next-line no-restricted-syntax -- só leitura no fake, para provar que local ficou vazio
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
    // eslint-disable-next-line no-restricted-syntax -- só leitura no fake, para provar que sync ficou vazio
    expect(await fakeBrowser.storage.sync.get(null)).toEqual({});
  });

  test.each<[string, unknown]>([
    ["chave extra token", { ...VALID, token: "intruso" }],
    ["refresh cru no lugar do envelope", { ...VALID, refreshToken: "v1.refresh-cru-do-supabase" }],
    ["access token fora da forma de JWS", { ...VALID, accessToken: "aaa.bbb" }],
    ["versão 2", { ...VALID, v: 2 }],
    ["sem obtainedAt", { v: 1, accessToken: VALID.accessToken, refreshToken: ENVELOPE, accessExpiresAt: VALID.accessExpiresAt }],
    ["accessExpiresAt fracionário", { ...VALID, accessExpiresAt: VALID.obtainedAt + 500_000.5 }],
    ["obtainedAt fracionário", { ...VALID, obtainedAt: VALID.obtainedAt + 0.5 }],
    ["accessExpiresAt negativo", { ...VALID, accessExpiresAt: -1 }],
    ["obtainedAt zero", { ...VALID, obtainedAt: 0, accessExpiresAt: 900_000 }],
    ["vida de 999 ms", { ...VALID, accessExpiresAt: VALID.obtainedAt + 999 }],
    ["vida de 900.001 ms", { ...VALID, accessExpiresAt: VALID.obtainedAt + 900_001 }],
    ["vencimento antes da obtenção", { ...VALID, accessExpiresAt: VALID.obtainedAt - 1_000 }],
    ["valor que nem é objeto", "aaa.bbb.ccc"],
  ])("valor adulterado (%s) é apagado e lido como ausente", async (_caso, value) => {
    await plant(value);
    expect(await authSessionStore().get()).toBeUndefined();
    expect(await fakeBrowser.storage.session.get(null)).toEqual({});
  });

  test.each([1_000, 900_000])("vida de %i ms está dentro do contrato (expiresIn de 1 a 900 s)", async (lifetime) => {
    const value = { ...VALID, accessExpiresAt: VALID.obtainedAt + lifetime };
    await plant(value);
    expect(await authSessionStore().get()).toEqual(value);
  });

  test("não grava valor fora do schema", async () => {
    const store = authSessionStore();
    await expect(store.set({ ...VALID, refreshToken: "cru" })).rejects.toThrow();
    expect(await fakeBrowser.storage.session.get(null)).toEqual({});
  });

  test("remove apaga só a sessão", async () => {
    await fakeBrowser.storage.session.set({ outra: 1 });
    const store = authSessionStore();
    await store.set(VALID);
    await store.remove();
    expect(await fakeBrowser.storage.session.get(null)).toEqual({ outra: 1 });
  });

  test("a área é injetável, e a leitura usa a chave exata", async () => {
    const calls: unknown[] = [];
    const area = {
      get: async (key: unknown) => {
        calls.push(key);
        return { [SESSION_STORAGE_KEY]: VALID };
      },
      set: async () => undefined,
      remove: async () => undefined,
    };
    expect(await authSessionStore(area as never).get()).toEqual(VALID);
    expect(calls).toEqual([SESSION_STORAGE_KEY]);
  });

  test("o schema não aceita mais que as 5 chaves", () => {
    expect(Object.keys(StoredSessionSchema.parse(VALID)).sort()).toEqual(["accessExpiresAt", "accessToken", "obtainedAt", "refreshToken", "v"]);
  });
});
