// F1-EXT-05a, 05a-4 (ADR-004 D3 passo 2, D9 e D15): a composição da sessão no Service Worker. O config só existe
// com as duas origens válidas; o login roda de ponta a ponta com o adapter de produção (identity programada no
// fake-browser), o api-client real sobre um fetch global falso, o authSessionStore real e o crypto real do Node.
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

import { AUTH_SERVICE_POLICY, type AuthLogReason } from "../src/auth/auth-service";
import { SESSION_STORAGE_KEY } from "../src/auth/session-schema";
import { authConfigFrom, createWorkerAuth } from "../src/auth/worker-auth";
import type { SessaoView } from "../src/messaging/protocol";

const API = "https://api.trampo.test";
const SUPABASE = "https://projeto.supabase.test";
const ID = "abcdefghijklmnopabcdefghijklmnop";
const REDIRECT = `https://${ID}.chromiumapp.org/auth`;
const CODE = "CANARIO-CODE-1234";
const TOKEN = "CANARIO.TOKEN.um";
const ENVELOPE = `r1.k1.${"A".repeat(16)}.${"B".repeat(20)}.${"C".repeat(22)}`;
const T0 = 1_700_000_000_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fakeBrowser.reset();
});

describe("authConfigFrom (D3 passo 2)", () => {
  test("com as duas origens válidas, monta o api-client na origem da API e guarda a do Supabase", () => {
    const config = authConfigFrom({ apiOrigin: API, supabaseOrigin: SUPABASE });
    expect(config?.supabaseOrigin).toBe(SUPABASE);
    expect(typeof config?.api.post).toBe("function");
  });

  test.each([
    ["sem a API", { apiOrigin: undefined, supabaseOrigin: SUPABASE }],
    ["sem o Supabase", { apiOrigin: API, supabaseOrigin: undefined }],
    ["sem nenhuma", { apiOrigin: undefined, supabaseOrigin: undefined }],
    ["API vazia (o define do build sem a variável)", { apiOrigin: "", supabaseOrigin: SUPABASE }],
    ["Supabase vazio", { apiOrigin: API, supabaseOrigin: "" }],
    ["API em http", { apiOrigin: "http://api.trampo.test", supabaseOrigin: SUPABASE }],
    ["Supabase em http", { apiOrigin: API, supabaseOrigin: "http://projeto.supabase.test" }],
    ["API com caminho", { apiOrigin: `${API}/v1`, supabaseOrigin: SUPABASE }],
    ["Supabase com barra final", { apiOrigin: API, supabaseOrigin: `${SUPABASE}/` }],
    ["Supabase que não é URL", { apiOrigin: API, supabaseOrigin: "projeto.supabase.test" }],
  ])("%s: config ausente, sem lançar", (_caso, origins) => {
    expect(authConfigFrom(origins)).toBeUndefined();
  });
});

function recorder() {
  const views: SessaoView[] = [];
  const logs: AuthLogReason[] = [];
  return { views, logs, emit: (v: SessaoView) => views.push(v), log: (m: AuthLogReason) => logs.push(m) };
}

describe("createWorkerAuth", () => {
  test("sem as origens do build, o login dá ERRO_INTERNO com auth_sem_configuracao e não abre o IdP", async () => {
    const launch = vi.spyOn(fakeBrowser.identity, "launchWebAuthFlow");
    const r = recorder();
    await createWorkerAuth({ apiOrigin: "", supabaseOrigin: "" }, r).login("github");
    expect(r.views).toStrictEqual([{ autenticado: false, erro: "ERRO_INTERNO" }]);
    expect(r.logs).toStrictEqual(["auth_sem_configuracao"]);
    expect(launch).not.toHaveBeenCalled();
  });

  test("login de ponta a ponta: authorize no Supabase, troca na API e sessão no storage.session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    vi.spyOn(fakeBrowser.identity, "getRedirectURL").mockReturnValue(REDIRECT);
    const launch = vi.spyOn(fakeBrowser.identity, "launchWebAuthFlow").mockImplementation(async ({ url }) => {
      const redirectTo = new URL(new URL(url).searchParams.get("redirect_to") ?? "");
      return `${REDIRECT}?code=${CODE}&st=${redirectTo.searchParams.get("st") ?? ""}`;
    });
    const fetch = vi.fn(async (_input: string, _init: RequestInit) =>
      new Response(JSON.stringify({ schemaVersion: 1, accessToken: TOKEN, refreshToken: ENVELOPE, expiresIn: 900 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const r = recorder();

    await createWorkerAuth({ apiOrigin: API, supabaseOrigin: SUPABASE }, r).login("github");

    const authorize = new URL(launch.mock.calls[0]?.[0].url ?? "");
    expect(authorize.origin + authorize.pathname).toBe(`${SUPABASE}/auth/v1/authorize`);
    expect(authorize.searchParams.get("provider")).toBe("github");
    expect(launch.mock.calls[0]?.[0].interactive).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${API}/v1/auth/exchange`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ schemaVersion: 1, authCode: CODE });
    expect(await fakeBrowser.storage.session.get(SESSION_STORAGE_KEY)).toStrictEqual({
      [SESSION_STORAGE_KEY]: { v: 1, accessToken: TOKEN, refreshToken: ENVELOPE, obtainedAt: T0, accessExpiresAt: T0 + 900_000 },
    });
    expect(r.views).toStrictEqual([{ autenticado: true, erro: null }]);
    expect(r.logs).toStrictEqual([]);
  });

  test("o prazo de 5 min usa o setTimeout do Service Worker e libera o próximo clique", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.spyOn(fakeBrowser.identity, "getRedirectURL").mockReturnValue(REDIRECT);
    // O prazo é armado no mesmo tick em que a janela abre; o vi.waitFor avança o relógio falso a cada checagem.
    let openedAt = 0;
    const launch = vi.spyOn(fakeBrowser.identity, "launchWebAuthFlow").mockImplementation(() => {
      openedAt = Date.now();
      return new Promise(() => undefined);
    });
    const r = recorder();
    const auth = createWorkerAuth({ apiOrigin: API, supabaseOrigin: SUPABASE }, r);

    void auth.login("google");
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(openedAt + AUTH_SERVICE_POLICY.loginDeadlineMs - 1 - Date.now());
    expect(r.views).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.views).toStrictEqual([{ autenticado: false, erro: null }]);
    expect(r.logs).toStrictEqual(["auth_fluxo_cancelado"]);

    void auth.login("google");
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
  });

  test("redirectUri fora da forma do chromiumapp.org falha fechado, sem abrir o IdP", async () => {
    vi.spyOn(fakeBrowser.identity, "getRedirectURL").mockReturnValue("https://evil.test/auth");
    const launch = vi.spyOn(fakeBrowser.identity, "launchWebAuthFlow");
    const r = recorder();
    await createWorkerAuth({ apiOrigin: API, supabaseOrigin: SUPABASE }, r).login("github");
    expect(r.views).toStrictEqual([{ autenticado: false, erro: "ERRO_INTERNO" }]);
    expect(r.logs).toStrictEqual(["auth_sem_configuracao"]);
    expect(launch).not.toHaveBeenCalled();
  });
});
