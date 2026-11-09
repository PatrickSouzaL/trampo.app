// F1-EXT-05a, 05a-4 (ADR-004 D3 passos 4 e 6, D10 B2): o adapter de produção da porta AuthCodeSource, o único
// arquivo com `browser.identity`. O redirectUri só sai na forma exata do chromiumapp.org, e o obtainRedirect
// nunca rejeita. O `browser.identity` do fake-browser do WXT não tem implementação: cada teste a programa.
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

import { webAuthFlowSource } from "../src/auth/web-auth-flow-source";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const REDIRECT = `https://${ID}.chromiumapp.org/auth`;
const AUTHORIZE = "https://projeto.supabase.test/auth/v1/authorize?provider=github";
const RETURNED = `${REDIRECT}?code=CANARIO-CODE-1234&st=estado`;

afterEach(() => {
  vi.restoreAllMocks();
  fakeBrowser.reset();
});

describe("redirectUri (D3 passo 4)", () => {
  test('pede o caminho "auth" ao navegador e devolve a URL exata', () => {
    const getRedirectURL = vi.spyOn(fakeBrowser.identity, "getRedirectURL").mockReturnValue(REDIRECT);
    expect(webAuthFlowSource().redirectUri()).toBe(REDIRECT);
    expect(getRedirectURL).toHaveBeenCalledExactlyOnceWith("auth");
  });

  test("lê o navegador a cada chamada: nada fica guardado no adapter", () => {
    const getRedirectURL = vi.spyOn(fakeBrowser.identity, "getRedirectURL").mockReturnValue(REDIRECT);
    const source = webAuthFlowSource();
    expect(getRedirectURL).not.toHaveBeenCalled();
    source.redirectUri();
    source.redirectUri();
    expect(getRedirectURL).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["ID curto", "https://abcdefghijklmnop.chromiumapp.org/auth"],
    ["ID longo", `https://${ID}a.chromiumapp.org/auth`],
    ["ID fora do alfabeto a-p", `https://${ID.slice(0, 31)}q.chromiumapp.org/auth`],
    ["ID em maiúsculas", `https://${ID.toUpperCase()}.chromiumapp.org/auth`],
    ["outro host", `https://${ID}.chromiumapp.org.evil.test/auth`],
    ["host colado ao ID", `https://${ID}-chromiumapp.org/auth`],
    ["ponto trocado antes do org", `https://${ID}.chromiumappXorg/auth`],
    ["URL dentro do caminho de outro host", `https://evil.test/https://${ID}.chromiumapp.org/auth`],
    ["subdomínio a mais", `https://x.${ID}.chromiumapp.org/auth`],
    ["http", `http://${ID}.chromiumapp.org/auth`],
    ["barra final", `${REDIRECT}/`],
    ["outro caminho", `https://${ID}.chromiumapp.org/outro`],
    ["raiz do host", `https://${ID}.chromiumapp.org/`],
    ["porta", `https://${ID}.chromiumapp.org:443/auth`],
    ["query", `${REDIRECT}?st=x`],
    ["fragmento", `${REDIRECT}#x`],
    ["quebra de linha no fim", `${REDIRECT}\n`],
    ["vazio", ""],
  ])("lança com %s, sem ecoar o valor (falha fechada: o login dá auth_sem_configuracao)", (_caso, value) => {
    vi.spyOn(fakeBrowser.identity, "getRedirectURL").mockReturnValue(value);
    let error: unknown;
    try {
      webAuthFlowSource().redirectUri();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("getRedirectURL fora da forma https://<id>.chromiumapp.org/auth");
  });
});

describe("obtainRedirect (D3 passo 6)", () => {
  test("abre o authorize em modo interativo, sem outra opção, e devolve a URL de retorno", async () => {
    const launch = vi.spyOn(fakeBrowser.identity, "launchWebAuthFlow").mockImplementation(async () => RETURNED);
    await expect(webAuthFlowSource().obtainRedirect({ authorizeUrl: AUTHORIZE, redirectUri: REDIRECT })).resolves.toStrictEqual({ ok: true, url: RETURNED });
    expect(launch).toHaveBeenCalledExactlyOnceWith({ url: AUTHORIZE, interactive: true });
    expect(Object.keys(launch.mock.calls[0]?.[0] ?? {})).toStrictEqual(["url", "interactive"]);
  });

  test("retorno sem URL dá { ok: false }", async () => {
    vi.spyOn(fakeBrowser.identity, "launchWebAuthFlow").mockResolvedValue(undefined);
    await expect(webAuthFlowSource().obtainRedirect({ authorizeUrl: AUTHORIZE, redirectUri: REDIRECT })).resolves.toStrictEqual({ ok: false });
  });

  test("janela fechada (rejeição) dá { ok: false }, sem ecoar a mensagem do navegador", async () => {
    vi.spyOn(fakeBrowser.identity, "launchWebAuthFlow").mockRejectedValue(new Error("The user did not approve access. CANARIO"));
    const result = await webAuthFlowSource().obtainRedirect({ authorizeUrl: AUTHORIZE, redirectUri: REDIRECT });
    expect(result).toStrictEqual({ ok: false });
    expect(JSON.stringify(result)).not.toContain("CANARIO");
  });

  test("lançamento síncrono do navegador também dá { ok: false }", async () => {
    vi.spyOn(fakeBrowser.identity, "launchWebAuthFlow").mockImplementation(() => {
      throw new Error("Function not implemented");
    });
    await expect(webAuthFlowSource().obtainRedirect({ authorizeUrl: AUTHORIZE, redirectUri: REDIRECT })).resolves.toStrictEqual({ ok: false });
  });
});
