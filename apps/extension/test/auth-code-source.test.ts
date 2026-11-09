// F1-EXT-05a, 05a-3 (ADR-004 D3): a porta do retorno do IdP nunca rejeita, e o auth-service impõe isso do
// lado de quem chama. Só `{ ok: true, url: <string> }` passa; o resto vira `{ ok: false }`, sem ecoar nada.
import { describe, expect, test } from "vitest";

import { type AuthCodeSource, obtainRedirectSafely } from "../src/auth/auth-code-source";

const REQUEST = { authorizeUrl: "https://projeto.supabase.test/auth/v1/authorize?provider=github", redirectUri: "https://id.chromiumapp.org/auth" };

function sourceOf(obtainRedirect: () => unknown): AuthCodeSource {
  return { redirectUri: () => REQUEST.redirectUri, obtainRedirect: obtainRedirect as AuthCodeSource["obtainRedirect"] };
}

describe("obtainRedirectSafely (ADR-004 D3, porta que nunca rejeita)", () => {
  test("repassa o pedido ao adapter e devolve só ok e url", async () => {
    const received: unknown[] = [];
    const source = sourceOf((...args: unknown[]) => {
      received.push(...args);
      return Promise.resolve({ ok: true, url: "https://id.chromiumapp.org/auth?code=x", extra: "CANARIO" });
    });
    expect(await obtainRedirectSafely(source, REQUEST)).toStrictEqual({ ok: true, url: "https://id.chromiumapp.org/auth?code=x" });
    expect(received).toStrictEqual([REQUEST]);
  });

  test("{ ok: false } do adapter passa como está", async () => {
    expect(await obtainRedirectSafely(sourceOf(() => Promise.resolve({ ok: false })), REQUEST)).toStrictEqual({ ok: false });
  });

  test.each<[string, () => unknown]>([
    ["promessa rejeitada (janela fechada)", () => Promise.reject(new Error("The user did not approve access. CANARIO"))],
    ["lançamento síncrono", () => {
      throw new Error("CANARIO");
    }],
    ["undefined", () => Promise.resolve(undefined)],
    ["null", () => Promise.resolve(null)],
    ["string", () => Promise.resolve("https://id.chromiumapp.org/auth?code=x")],
    ["ok true sem url", () => Promise.resolve({ ok: true })],
    ["ok true com url não string", () => Promise.resolve({ ok: true, url: new URL("https://id.chromiumapp.org/auth") })],
    ["ok \"true\" em texto", () => Promise.resolve({ ok: "true", url: "https://id.chromiumapp.org/auth" })],
    ["getter que lança", () => Promise.resolve(Object.defineProperty({ ok: true }, "url", { get: () => { throw new Error("CANARIO"); } }))],
  ])("%s vira { ok: false }", async (_nome, obtainRedirect) => {
    expect(await obtainRedirectSafely(sourceOf(obtainRedirect), REQUEST)).toStrictEqual({ ok: false });
  });
});
