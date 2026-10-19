// T22: o único armazenamento é storage.session, revalidado com Zod na leitura.
import { beforeEach, describe, expect, test } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { z } from "zod";

import { sessionStore } from "../src/messaging/session-store";

const Schema = z.strictObject({ text: z.string().max(10), at: z.int() });

describe("sessionStore", () => {
  beforeEach(() => fakeBrowser.reset());

  test("grava e lê só em storage.session", async () => {
    const store = sessionStore("ultima", Schema);
    expect(await store.get()).toBeUndefined();
    await store.set({ text: "ok", at: 1 });
    expect(await store.get()).toEqual({ text: "ok", at: 1 });
    expect(await fakeBrowser.storage.session.get("ultima")).toEqual({ ultima: { text: "ok", at: 1 } });
    // eslint-disable-next-line no-restricted-syntax -- só leitura no fake, para provar que local ficou vazio
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
    // eslint-disable-next-line no-restricted-syntax -- só leitura no fake, para provar que sync ficou vazio
    expect(await fakeBrowser.storage.sync.get(null)).toEqual({});
  });

  test("valor adulterado ou fora do schema é apagado e lido como ausente", async () => {
    await fakeBrowser.storage.session.set({ ultima: { text: "x", at: 1, token: "intruso" } });
    const store = sessionStore("ultima", Schema);
    expect(await store.get()).toBeUndefined();
    expect(await fakeBrowser.storage.session.get("ultima")).toEqual({});
  });

  test("não grava valor inválido", async () => {
    const store = sessionStore("ultima", Schema);
    await expect(store.set({ text: "longo demais!", at: 1 })).rejects.toThrow();
    expect(await fakeBrowser.storage.session.get(null)).toEqual({});
  });

  test("remove apaga a chave", async () => {
    const store = sessionStore("ultima", Schema);
    await store.set({ text: "ok", at: 2 });
    await store.remove();
    expect(await store.get()).toBeUndefined();
  });
});
