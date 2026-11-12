// F1-EXT-05a, 05a-3 (ADR-004 D3, D11, D12 e §4.1; M-03 a M-06): login com um fluxo por vez, prazo de 5 min e
// verifier apagado depois do envio; renovação preguiçosa com single-flight e geração; logout local primeiro.
// Relógio, api-client e AuthCodeSource falsos; a sessão vai ao authSessionStore real, sobre o storage falso.
// F1-EXT-07 (revisão adversarial de auth, E-02 e E-03): o 401 atrasado de outra sessão não renova nem apaga a sessão
// atual, e a sessão que a troca criou depois de um "Sair" é encerrada no servidor em melhor esforço.
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

import type { ApiCall, ApiClient, ApiResult } from "../src/api/api-client";
import type { AuthCodeRequest, AuthCodeResult, AuthCodeSource } from "../src/auth/auth-code-source";
import { AUTH_LOG_REASONS, AUTH_SERVICE_POLICY, type AuthLogReason, createAuthService } from "../src/auth/auth-service";
import { s256Challenge } from "../src/auth/pkce";
import { SESSION_STORAGE_KEY, type StoredSession, authSessionStore } from "../src/auth/session-schema";
import type { SessaoView } from "../src/messaging/protocol";

const SUPABASE = "https://projeto.supabase.test";
const REDIRECT = "https://idextensao.chromiumapp.org/auth";
const CODE = "CANARIO-CODE-1234";
const T0 = 1_700_000_000_000;
const TOKEN_1 = "CANARIO.TOKEN.um";
const TOKEN_2 = "CANARIO.TOKEN.dois";
const TOKEN_3 = "CANARIO.TOKEN.tres";
const ENVELOPE_1 = `r1.k1.${"A".repeat(16)}.${"B".repeat(20)}.${"C".repeat(22)}`;
const ENVELOPE_2 = `r1.k1.${"D".repeat(16)}.${"E".repeat(20)}.${"F".repeat(22)}`;
const MIN = 60_000;
const { loginDeadlineMs: DEADLINE, retryDelayMs: RETRY } = AUTH_SERVICE_POLICY;

const NAO_LOGADO: SessaoView = { autenticado: false, erro: null };
const AUTENTICADO: SessaoView = { autenticado: true, erro: null };
const ERRO_INTERNO: SessaoView = { autenticado: false, erro: "ERRO_INTERNO" };

// --- respostas do api-client falso ---------------------------------------------------------------------
const http = (status: number, body = ""): ApiResult => ({ ok: true, status, body });
const sessionBody = (accessToken = TOKEN_2, expiresIn = 900, refreshToken = ENVELOPE_2): string =>
  JSON.stringify({ schemaVersion: 1, accessToken, refreshToken, expiresIn });
const apiError = (code: string): string => JSON.stringify({ code, message: "Mensagem.", requestId: null, retryAfterSeconds: null });
const OK_SESSION = http(200, sessionBody());
const UNAUTHORIZED = http(401, apiError("NAO_AUTENTICADO"));
const SEM_RESPOSTA: ApiResult = { ok: false, reason: "sem_resposta" };
const ILEGIVEL: ApiResult = { ok: false, reason: "resposta_ilegivel" };
const RECUSADO: ApiResult = { ok: false, reason: "pedido_recusado" };

function session(accessToken = TOKEN_1, obtainedAt = T0, lifeMs = 900_000, refreshToken = ENVELOPE_1): StoredSession {
  return { v: 1, accessToken, refreshToken, obtainedAt, accessExpiresAt: obtainedAt + lifeMs };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Esvazia as microtarefas (o storage falso também é assíncrono). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Relógio e timers manuais: nada avança sem o teste mandar. */
function manualClock(start = T0) {
  let now = start;
  const timers: Array<{ readonly at: number; readonly callback: () => void }> = [];
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      timers.push({ at: now + ms, callback });
    },
    async advance(ms: number) {
      const target = now + ms;
      await flush();
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (next === undefined || next.at > target) break;
        timers.shift();
        now = next.at;
        next.callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

/** api-client falso: cada chamada consome a próxima resposta programada, imediata ou segurada. */
function fakeApi() {
  const calls: ApiCall[] = [];
  const replies: Array<(call: ApiCall) => Promise<ApiResult>> = [];
  const api: Pick<ApiClient, "post"> = {
    post: (call) => {
      calls.push(call);
      const next = replies.shift();
      if (next === undefined) return Promise.reject(new Error("chamada sem resposta programada"));
      return next(call);
    },
  };
  return {
    api,
    calls,
    reply(...results: ApiResult[]) {
      for (const result of results) replies.push(() => Promise.resolve(result));
    },
    hold() {
      const d = deferred<ApiResult>();
      replies.push(() => d.promise);
      return d;
    },
    onCall(handler: (call: ApiCall) => ApiResult) {
      replies.push((call) => Promise.resolve(handler(call)));
    },
    paths: () => calls.map((c) => c.path),
  };
}

const stateOf = (request: AuthCodeRequest): string => {
  const redirectTo = new URL(request.authorizeUrl).searchParams.get("redirect_to") ?? "";
  return new URL(redirectTo).searchParams.get("st") ?? "";
};
const goodReturn = (request: AuthCodeRequest): string => `${REDIRECT}?code=${CODE}&st=${stateOf(request)}`;

/** AuthCodeSource falso: por padrão devolve o retorno certo do pedido recebido. */
function fakeSource() {
  const requests: AuthCodeRequest[] = [];
  const answers: Array<(request: AuthCodeRequest) => Promise<AuthCodeResult>> = [];
  const source: AuthCodeSource = {
    redirectUri: () => REDIRECT,
    obtainRedirect: (request) => {
      requests.push(request);
      const answer = answers.shift() ?? ((r: AuthCodeRequest) => Promise.resolve<AuthCodeResult>({ ok: true, url: goodReturn(r) }));
      return answer(request);
    },
  };
  return {
    source,
    requests,
    answer(answer: (request: AuthCodeRequest) => AuthCodeResult) {
      answers.push((request) => Promise.resolve(answer(request)));
    },
    hold() {
      const d = deferred<AuthCodeResult>();
      answers.push(() => d.promise);
      return d;
    },
  };
}

/**
 * Crypto determinístico: o `subtle` real do Node resolve fora das microtarefas e deixaria os testes de corrida
 * dependentes do agendador. Cada chamada de entropia devolve bytes novos, e o SHA-256 é o do `node:crypto`.
 */
function countingCrypto(): NonNullable<Parameters<typeof createAuthService>[0]["crypto"]> {
  let counter = 0;
  return {
    getRandomValues: (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (counter * 31 + i * 7) % 256;
      counter += 1;
      return bytes;
    },
    subtle: { digest: (_algorithm: AlgorithmIdentifier, data: BufferSource) => Promise.resolve(createHash("sha256").update(data as Uint8Array).digest().buffer) },
  };
}

const allLogs: unknown[][] = [];

interface SetupOptions {
  readonly config?: false;
  readonly supabaseOrigin?: string;
  readonly crypto?: Parameters<typeof createAuthService>[0]["crypto"];
  readonly store?: Parameters<typeof createAuthService>[0]["store"];
  readonly emitThrowsOnce?: true;
}

function setup(options: SetupOptions = {}) {
  const clock = manualClock();
  const api = fakeApi();
  const idp = fakeSource();
  const emitted: SessaoView[] = [];
  const logs: AuthLogReason[] = [];
  const service = createAuthService({
    store: options.store ?? authSessionStore(),
    config: options.config === false ? undefined : { api: api.api, supabaseOrigin: options.supabaseOrigin ?? SUPABASE },
    codeSource: idp.source,
    now: clock.now,
    setTimer: clock.setTimer,
    emit: (view) => {
      emitted.push(view);
      if (options.emitThrowsOnce === true && emitted.length === 1) throw new Error("porta do painel caiu");
    },
    log: (...args: unknown[]) => {
      allLogs.push(args);
      logs.push(args[0] as AuthLogReason);
    },
    crypto: options.crypto ?? countingCrypto(),
  });
  return { service, clock, api, idp, emitted, logs };
}

const stored = async (): Promise<unknown> => (await fakeBrowser.storage.session.get(SESSION_STORAGE_KEY))[SESSION_STORAGE_KEY];
const plant = (value: unknown): Promise<void> => fakeBrowser.storage.session.set({ [SESSION_STORAGE_KEY]: value });

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  // Logs só da lista fechada do D3, um argumento por chamada: nunca código, verifier, state, token ou URL (T23).
  for (const args of allLogs) {
    expect(args).toHaveLength(1);
    expect(AUTH_LOG_REASONS).toContain(args[0]);
  }
  allLogs.length = 0;
});

// ==========================================================================================================
describe("política fixa (ADR-004 D3, D11.1 e D11.3)", () => {
  test("prazo do login de 5 min, limiar de renovação de 60 s e nova tentativa em 2 s", () => {
    expect(AUTH_SERVICE_POLICY).toStrictEqual({ loginDeadlineMs: 300_000, renewThresholdMs: 60_000, retryDelayMs: 2_000 });
    expect(Object.isFrozen(AUTH_SERVICE_POLICY)).toBe(true);
  });
});

describe("SessaoView (ADR-004 D12, só o tipo até a F1-EXT-05b)", () => {
  test("a união recusa sessão autenticada com NAO_AUTENTICADO ou ERRO_INTERNO, e nenhum campo é texto livre", () => {
    // @ts-expect-error -- autenticado com NAO_AUTENTICADO é contraditório (o refine do D12)
    const contraditoria: SessaoView = { autenticado: true, erro: "NAO_AUTENTICADO" };
    // @ts-expect-error -- ERRO_INTERNO só existe sem sessão
    const interna: SessaoView = { autenticado: true, erro: "ERRO_INTERNO" };
    // @ts-expect-error -- chave extra não cabe no tipo
    const comToken: SessaoView = { autenticado: false, erro: null, token: "x" };
    expect([contraditoria, interna, comToken]).toHaveLength(3);
    expectTypeOf<SessaoView["erro"]>().toEqualTypeOf<"NAO_AUTENTICADO" | "SERVICO_INDISPONIVEL" | "LIMITE_DE_TAXA" | "ERRO_INTERNO" | null>();
    expectTypeOf<keyof SessaoView>().toEqualTypeOf<"autenticado" | "erro">();
  });
});

describe("D12: cada linha do SW na tabela vira um teste nomeado (CA-14)", () => {
  test("D12 | Handshake com sessão local válida → { true, null } | mantém", async () => {
    const { service, emitted } = setup();
    await plant(session());
    expect(await service.view()).toStrictEqual(AUTENTICADO);
    expect(await stored()).toStrictEqual(session());
    expect(emitted).toStrictEqual([]);
  });

  test("D12 | Handshake sem sessão, ou valor adulterado (o sessionStore apaga) → { false, null } | vazio", async () => {
    const { service } = setup();
    expect(await service.view()).toStrictEqual(NAO_LOGADO);
    await plant({ ...session(), token: "intruso" });
    expect(await service.view()).toStrictEqual(NAO_LOGADO);
    expect(await stored()).toBeUndefined();
  });

  test("D12 | Login concluído → { true, null } | grava", async () => {
    const { service, api, emitted, logs } = setup();
    api.reply(OK_SESSION);
    await service.login("github");
    expect(emitted).toStrictEqual([AUTENTICADO]);
    expect(await stored()).toStrictEqual({ v: 1, accessToken: TOKEN_2, refreshToken: ENVELOPE_2, obtainedAt: T0, accessExpiresAt: T0 + 900_000 });
    expect(logs).toStrictEqual([]);
  });

  test("D12 | Promessa do launchWebAuthFlow rejeitada (janela fechada ou outra falha do navegador) → { false, null } | sem mudança", async () => {
    const { service, idp, api, emitted, logs } = setup();
    idp.answer(() => ({ ok: false }));
    await service.login("github");
    expect(emitted).toStrictEqual([NAO_LOGADO]);
    expect(logs).toStrictEqual(["auth_fluxo_cancelado"]);
    expect(api.calls).toStrictEqual([]);
    expect(await stored()).toBeUndefined();
  });

  test("D12 | Prazo de 5 min sem retorno → { false, null } | sem mudança", async () => {
    const { service, idp, api, clock, emitted, logs } = setup();
    idp.hold();
    void service.login("github");
    await clock.advance(DEADLINE - 1);
    expect(emitted).toStrictEqual([]);
    await clock.advance(1);
    expect(emitted).toStrictEqual([NAO_LOGADO]);
    expect(logs).toStrictEqual(["auth_fluxo_cancelado"]);
    expect(api.calls).toStrictEqual([]);
    expect(await stored()).toBeUndefined();
  });

  test("D12 | error ou error_code no retorno (negado no IdP) → { false, null } | sem mudança", async () => {
    for (const query of ["error=access_denied&error_description=CANARIO-IDP", "error_code=CANARIO-IDP", "st=x#error=CANARIO-IDP"]) {
      fakeBrowser.reset();
      const { service, idp, api, emitted, logs } = setup();
      idp.answer(() => ({ ok: true, url: `${REDIRECT}?${query}` }));
      await service.login("google");
      expect(emitted).toStrictEqual([NAO_LOGADO]);
      expect(logs).toStrictEqual(["auth_fluxo_cancelado"]);
      expect(api.calls).toStrictEqual([]);
      expect(await stored()).toBeUndefined();
    }
  });

  test.each<[string, (request: AuthCodeRequest) => string]>([
    ["outro host", (r) => goodReturn(r).replace("idextensao", "outro")],
    ["outro caminho", (r) => goodReturn(r).replace("/auth?", "/outro?")],
    ["raiz do host", (r) => goodReturn(r).replace("/auth?", "/?")],
    ["fragmento com token", (r) => `${goodReturn(r)}#access_token=CANARIO.TOKEN.x`],
    ["parâmetro extra", (r) => `${goodReturn(r)}&extra=1`],
    ["parâmetro repetido", (r) => `${goodReturn(r)}&code=${CODE}`],
    ["st divergente", () => `${REDIRECT}?code=${CODE}&st=outro-state`],
    ["code fora do formato", (r) => `${REDIRECT}?code=curto&st=${stateOf(r)}`],
  ])("D12 | Retorno adulterado (%s) → { false, ERRO_INTERNO } | sem mudança", async (_nome, url) => {
    const { service, idp, api, emitted, logs } = setup();
    idp.answer((request) => ({ ok: true, url: url(request) }));
    await service.login("github");
    expect(emitted).toStrictEqual([ERRO_INTERNO]);
    expect(logs).toStrictEqual(["auth_retorno_recusado"]);
    expect(api.calls).toStrictEqual([]);
    expect(await stored()).toBeUndefined();
  });

  test("D12 | Troca 401 (código inválido, verifier errado, reuso) → { false, ERRO_INTERNO } | sem mudança", async () => {
    const { service, api, emitted, logs } = setup();
    api.reply(UNAUTHORIZED);
    await service.login("github");
    expect(emitted).toStrictEqual([ERRO_INTERNO]);
    expect(logs).toStrictEqual(["auth_troca_recusada"]);
    expect(await stored()).toBeUndefined();
  });

  test("D12 | Troca 429 → { false, LIMITE_DE_TAXA } | sem mudança", async () => {
    const { service, api, emitted, logs } = setup();
    api.reply(http(429, apiError("LIMITE_DE_TAXA")));
    await service.login("github");
    expect(emitted).toStrictEqual([{ autenticado: false, erro: "LIMITE_DE_TAXA" }]);
    expect(logs).toStrictEqual(["auth_indisponivel"]);
    expect(await stored()).toBeUndefined();
  });

  test.each<[string, ApiResult]>([
    ["503", http(503, apiError("SERVICO_INDISPONIVEL"))],
    ["502 do proxy", http(502, "<html>")],
    ["rede", SEM_RESPOSTA],
    ["prazo depois do status", ILEGIVEL],
  ])("D12 | Troca 503, rede ou prazo (%s) → { false, SERVICO_INDISPONIVEL } | sem mudança", async (_nome, result) => {
    const { service, api, emitted, logs } = setup();
    api.reply(result);
    await service.login("github");
    expect(emitted).toStrictEqual([{ autenticado: false, erro: "SERVICO_INDISPONIVEL" }]);
    expect(logs).toStrictEqual(["auth_indisponivel"]);
    expect(api.calls).toHaveLength(1);
    expect(await stored()).toBeUndefined();
  });

  test("D12 | Build sem origem da API ou do Supabase → { false, ERRO_INTERNO } | sem mudança", async () => {
    const { service, idp, emitted, logs } = setup({ config: false });
    await service.login("github");
    expect(emitted).toStrictEqual([ERRO_INTERNO]);
    expect(logs).toStrictEqual(["auth_sem_configuracao"]);
    expect(idp.requests).toStrictEqual([]);
    expect(await stored()).toBeUndefined();
  });

  test("D12 | Renovação 200 depois de falha transitória → { true, null } | grava", async () => {
    const { service, api, clock, emitted } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    api.reply(http(503));
    expect(await service.accessToken()).toBe(TOKEN_1);
    expect(emitted).toStrictEqual([{ autenticado: true, erro: "SERVICO_INDISPONIVEL" }]);
    await clock.advance(1_000);
    api.reply(OK_SESSION);
    expect(await service.accessToken()).toBe(TOKEN_2);
    expect(emitted).toStrictEqual([{ autenticado: true, erro: "SERVICO_INDISPONIVEL" }, AUTENTICADO]);
    expect(await stored()).toStrictEqual(session(TOKEN_2, T0 + 1_000, 900_000, ENVELOPE_2));
  });

  test("D12 | Renovação 401 → { false, NAO_AUTENTICADO } | apaga", async () => {
    const { service, api, emitted, logs } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    api.reply(UNAUTHORIZED);
    expect(await service.accessToken()).toBeUndefined();
    expect(emitted).toStrictEqual([{ autenticado: false, erro: "NAO_AUTENTICADO" }]);
    expect(logs).toStrictEqual(["auth_renovacao_recusada"]);
    expect(await stored()).toBeUndefined();
  });

  test("D12 | Segundo 401 na análise → { false, NAO_AUTENTICADO } | apaga", async () => {
    const { service, api, emitted, logs } = setup();
    await plant(session());
    expect(await service.onUnauthorized(2, TOKEN_1)).toBeUndefined();
    expect(api.calls).toStrictEqual([]);
    expect(emitted).toStrictEqual([{ autenticado: false, erro: "NAO_AUTENTICADO" }]);
    expect(logs).toStrictEqual(["auth_renovacao_recusada"]);
    expect(await stored()).toBeUndefined();
  });

  test.each<[string, ApiResult[], SessaoView]>([
    ["503", [http(503, apiError("SERVICO_INDISPONIVEL"))], { autenticado: true, erro: "SERVICO_INDISPONIVEL" }],
    ["429", [http(429, apiError("LIMITE_DE_TAXA"))], { autenticado: true, erro: "LIMITE_DE_TAXA" }],
    ["rede, depois da nova tentativa", [SEM_RESPOSTA, SEM_RESPOSTA], { autenticado: true, erro: "SERVICO_INDISPONIVEL" }],
  ])("D12 | Renovação 503, 429 ou rede (%s) → { true, SERVICO_INDISPONIVEL } ou { true, LIMITE_DE_TAXA } | mantém", async (_nome, results, view) => {
    const { service, api, clock, emitted, logs } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    api.reply(...results);
    const token = service.accessToken();
    await clock.advance(RETRY);
    expect(await token).toBe(TOKEN_1);
    expect(api.calls).toHaveLength(results.length);
    expect(emitted).toStrictEqual([view]);
    expect(logs).toStrictEqual(["auth_indisponivel"]);
    expect(await stored()).toStrictEqual(session(TOKEN_1, T0, MIN));
    expect(await service.view()).toStrictEqual(view);
  });

  test("D12 | \"Sair\" → { false, null } | apaga antes da rede", async () => {
    const { service, api, emitted, logs } = setup();
    await plant(session());
    let storedAtCall: unknown = "não chamou";
    api.onCall(() => {
      void stored().then((value) => (storedAtCall = value));
      return http(204);
    });
    const done = service.logout();
    await flush();
    expect(emitted).toStrictEqual([NAO_LOGADO]);
    await done;
    expect(storedAtCall).toBeUndefined();
    expect(api.calls).toStrictEqual([{ path: "/v1/auth/logout", body: { schemaVersion: 1 }, accessToken: TOKEN_1 }]);
    expect(emitted).toStrictEqual([NAO_LOGADO]);
    expect(logs).toStrictEqual([]);
  });

  test("D12 | \"Sair\" com falha remota, depois da repetição automática → { false, SERVICO_INDISPONIVEL } | já vazio", async () => {
    const { service, api, clock, emitted, logs } = setup();
    await plant(session());
    api.reply(http(503), SEM_RESPOSTA);
    const done = service.logout();
    await clock.advance(RETRY - 1);
    expect(api.calls).toHaveLength(1);
    await clock.advance(1);
    await done;
    expect(api.paths()).toStrictEqual(["/v1/auth/logout", "/v1/auth/logout"]);
    expect(emitted).toStrictEqual([NAO_LOGADO, { autenticado: false, erro: "SERVICO_INDISPONIVEL" }]);
    expect(logs).toStrictEqual(["auth_logout_remoto_falhou"]);
    expect(await stored()).toBeUndefined();
  });
});

// ==========================================================================================================
describe("login (ADR-004 D3)", () => {
  test("PKCE S256: o challenge da URL é o do verifier enviado, e o retorno vai à troca sem Bearer", async () => {
    const { service, idp, api } = setup();
    api.reply(OK_SESSION);
    await service.login("google");
    expect(idp.requests).toHaveLength(1);
    const request = idp.requests[0]!;
    expect(request.redirectUri).toBe(REDIRECT);
    const url = new URL(request.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${SUPABASE}/auth/v1/authorize`);
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
    expect(stateOf(request)).toMatch(/^[\w-]{22}$/);
    expect(api.calls).toHaveLength(1);
    const call = api.calls[0]!;
    expect(Object.keys(call)).toStrictEqual(["path", "body"]);
    expect(call.path).toBe("/v1/auth/exchange");
    const body = call.body as { schemaVersion: number; authCode: string; codeVerifier: string };
    expect(body).toStrictEqual({ schemaVersion: 1, authCode: CODE, codeVerifier: expect.stringMatching(/^[\w-]{43}$/) as unknown as string });
    expect(url.searchParams.get("code_challenge")).toBe(await s256Challenge(body.codeVerifier));
  });

  test("um fluxo por vez: o segundo clique durante o fluxo é ignorado, e só o fim do fluxo emite", async () => {
    const { service, idp, api, emitted } = setup();
    const held = idp.hold();
    void service.login("github");
    await flush();
    await service.login("google");
    await service.login("github");
    expect(idp.requests).toHaveLength(1);
    expect(emitted).toStrictEqual([]);
    api.reply(OK_SESSION);
    held.resolve({ ok: true, url: goodReturn(idp.requests[0]!) });
    await flush();
    expect(emitted).toStrictEqual([AUTENTICADO]);
  });

  test("com sessão local, o clique é ignorado e emite a sessão atual", async () => {
    const { service, idp, emitted } = setup();
    await plant(session());
    await service.login("github");
    expect(idp.requests).toStrictEqual([]);
    expect(emitted).toStrictEqual([AUTENTICADO]);
  });

  test("depois de uma tentativa que falhou, o próximo clique abre outro fluxo com state e verifier novos", async () => {
    const { service, idp, api } = setup();
    api.reply(http(503), OK_SESSION);
    await service.login("github");
    await service.login("github");
    expect(idp.requests).toHaveLength(2);
    expect(stateOf(idp.requests[0]!)).not.toBe(stateOf(idp.requests[1]!));
    const verifiers = api.calls.map((c) => (c.body as { codeVerifier: string }).codeVerifier);
    expect(verifiers[0]).not.toBe(verifiers[1]);
    expect(await stored()).toMatchObject({ accessToken: TOKEN_2 });
  });

  test("M-03: retorno que chega depois do prazo é recusado sem POST /v1/auth/exchange, e o prazo libera o próximo clique", async () => {
    const { service, idp, api, clock, emitted } = setup();
    const late = idp.hold();
    void service.login("github");
    await clock.advance(DEADLINE);
    expect(emitted).toStrictEqual([NAO_LOGADO]);
    const second = idp.hold();
    void service.login("github");
    await flush();
    expect(idp.requests).toHaveLength(2);
    // O 1º retorno chega com o state certo do 1º fluxo, mas o verifier dele já foi apagado.
    late.resolve({ ok: true, url: goodReturn(idp.requests[0]!) });
    await flush();
    expect(api.calls).toStrictEqual([]);
    expect(emitted).toStrictEqual([NAO_LOGADO]);
    // O 2º fluxo segue dono da vez.
    api.reply(OK_SESSION);
    second.resolve({ ok: true, url: goodReturn(idp.requests[1]!) });
    await flush();
    expect(emitted).toStrictEqual([NAO_LOGADO, AUTENTICADO]);
  });

  test("M-03: retorno que chega depois do prazo, sem outro clique, não vai à troca", async () => {
    const { service, idp, api, clock, emitted, logs } = setup();
    const late = idp.hold();
    void service.login("github");
    await clock.advance(DEADLINE);
    late.resolve({ ok: true, url: goodReturn(idp.requests[0]!) });
    await flush();
    expect(api.calls).toStrictEqual([]);
    expect(emitted).toStrictEqual([NAO_LOGADO]);
    expect(logs).toStrictEqual(["auth_fluxo_cancelado"]);
  });

  test("M-03: segundo retorno com o state do fluxo anterior é recusado sem POST /v1/auth/exchange", async () => {
    const { service, idp, api, emitted } = setup();
    api.reply(http(503));
    await service.login("github");
    const first = idp.requests[0]!;
    idp.answer(() => ({ ok: true, url: goodReturn(first) }));
    await service.login("github");
    expect(api.calls).toHaveLength(1);
    expect(emitted).toStrictEqual([{ autenticado: false, erro: "SERVICO_INDISPONIVEL" }, ERRO_INTERNO]);
  });

  test("M-03: o verifier é apagado logo depois do envio: com a troca em voo, o prazo não encerra o fluxo nem libera outro", async () => {
    const { service, idp, api, clock, emitted, logs } = setup();
    const exchange = api.hold();
    void service.login("github");
    await clock.advance(DEADLINE);
    expect(api.calls).toHaveLength(1);
    expect(emitted).toStrictEqual([]);
    expect(logs).toStrictEqual([]);
    await service.login("github");
    expect(idp.requests).toHaveLength(1);
    exchange.resolve(OK_SESSION);
    await flush();
    expect(emitted).toStrictEqual([AUTENTICADO]);
    expect(await stored()).toMatchObject({ accessToken: TOKEN_2 });
  });

  test("M-03: depois de uma troca que falhou, o prazo não emite nem registra nada", async () => {
    const { service, api, clock, emitted, logs } = setup();
    api.reply(UNAUTHORIZED);
    await service.login("github");
    await clock.advance(DEADLINE);
    expect(emitted).toStrictEqual([ERRO_INTERNO]);
    expect(logs).toStrictEqual(["auth_troca_recusada"]);
  });

  test("\"Sair\" durante o login: o código não vai à API", async () => {
    const { service, idp, api, emitted } = setup();
    const held = idp.hold();
    void service.login("github");
    await flush();
    await service.logout();
    held.resolve({ ok: true, url: goodReturn(idp.requests[0]!) });
    await flush();
    expect(api.calls).toStrictEqual([]);
    expect(emitted).toStrictEqual([NAO_LOGADO, NAO_LOGADO]);
    expect(await stored()).toBeUndefined();
  });

  test("M-04 (login e \"Sair\"): \"Sair\" com a troca em voo descarta a sessão que chega", async () => {
    const { service, api, emitted } = setup();
    const exchange = api.hold();
    void service.login("github");
    await flush();
    await service.logout();
    api.reply(http(204));
    exchange.resolve(OK_SESSION);
    await flush();
    expect(await stored()).toBeUndefined();
    expect(emitted).toStrictEqual([NAO_LOGADO, NAO_LOGADO]);
  });

  // --- F1-EXT-07, E-03: a sessão que a troca criou depois do "Sair" não fica órfã no servidor ---
  /** "Sair" com a troca em voo; a troca responde `exchanged` e o logout da sessão órfã, se sair, recebe `revoked`. */
  async function logoutDuringExchange(exchanged: ApiResult, revoked?: ApiResult) {
    const env = setup();
    const exchange = env.api.hold();
    void env.service.login("github");
    await flush();
    await env.service.logout();
    if (revoked !== undefined) env.api.reply(revoked);
    exchange.resolve(exchanged);
    await flush();
    return env;
  }

  test("E-03: \"Sair\" com a troca em voo: a sessão que chega é encerrada no servidor com o access recebido, sem gravar nem emitir", async () => {
    const { api, emitted, logs } = await logoutDuringExchange(OK_SESSION, http(204));
    expect(api.paths()).toStrictEqual(["/v1/auth/exchange", "/v1/auth/logout"]);
    expect(api.calls[1]).toStrictEqual({ path: "/v1/auth/logout", body: { schemaVersion: 1 }, accessToken: TOKEN_2 });
    expect(await stored()).toBeUndefined();
    expect(emitted).toStrictEqual([NAO_LOGADO, NAO_LOGADO]);
    expect(logs).toStrictEqual([]);
  });

  test("E-03: o logout da sessão órfã corre em segundo plano: o fluxo fecha na hora e o próximo clique já abre outro", async () => {
    const { service, api, idp, emitted } = setup();
    const exchange = api.hold();
    void service.login("github");
    await flush();
    await service.logout();
    const revoke = api.hold();
    exchange.resolve(OK_SESSION);
    await flush();
    // O logout remoto ainda não respondeu, e o painel já viu o fim do fluxo.
    expect(api.paths()).toStrictEqual(["/v1/auth/exchange", "/v1/auth/logout"]);
    expect(emitted).toStrictEqual([NAO_LOGADO, NAO_LOGADO]);
    api.reply(http(200, sessionBody(TOKEN_3)));
    await service.login("github");
    expect(idp.requests).toHaveLength(2);
    expect(await stored()).toMatchObject({ accessToken: TOKEN_3 });
    // A resposta tardia do logout da órfã não toca a sessão nova.
    revoke.resolve(http(503));
    await flush();
    expect(await stored()).toMatchObject({ accessToken: TOKEN_3 });
    expect(emitted).toStrictEqual([NAO_LOGADO, NAO_LOGADO, AUTENTICADO]);
  });

  test("E-03: o 401 do logout da sessão órfã conta como encerrada (nada a registrar)", async () => {
    const { api, logs } = await logoutDuringExchange(OK_SESSION, http(401, apiError("NAO_AUTENTICADO")));
    expect(api.calls).toHaveLength(2);
    expect(logs).toStrictEqual([]);
  });

  test.each<[string, ApiResult]>([
    ["503", http(503)],
    ["429", http(429)],
    ["200 (fora do contrato do logout)", http(200)],
    ["sem resposta", SEM_RESPOSTA],
  ])("E-03: logout da sessão órfã com %s: uma tentativa só, o motivo no log, nada no painel e nada gravado", async (_caso, revoked) => {
    const { clock, api, emitted, logs } = await logoutDuringExchange(OK_SESSION, revoked);
    await clock.advance(RETRY * 2);
    expect(api.paths()).toStrictEqual(["/v1/auth/exchange", "/v1/auth/logout"]);
    expect(logs).toStrictEqual(["auth_logout_remoto_falhou"]);
    expect(emitted).toStrictEqual([NAO_LOGADO, NAO_LOGADO]);
    expect(await stored()).toBeUndefined();
  });

  test("E-03: cliente que rejeita (fora do contrato) no logout da sessão órfã: nada escapa, nada é gravado nem emitido", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { api, emitted, logs } = await logoutDuringExchange(OK_SESSION);
      await flush();
      expect(api.calls).toHaveLength(2);
      expect(emitted).toStrictEqual([NAO_LOGADO, NAO_LOGADO]);
      expect(logs).toStrictEqual([]);
      expect(await stored()).toBeUndefined();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  test("E-03: sem sessão criada (a troca falhou depois do \"Sair\"), nenhum logout sai", async () => {
    const { api, logs } = await logoutDuringExchange(UNAUTHORIZED);
    expect(api.paths()).toStrictEqual(["/v1/auth/exchange"]);
    expect(logs).toStrictEqual(["auth_troca_recusada"]);
  });

  test("E-03: o login que conclui não chama o logout", async () => {
    const { service, api } = setup();
    api.reply(OK_SESSION);
    await service.login("github");
    expect(api.paths()).toStrictEqual(["/v1/auth/exchange"]);
    expect(await stored()).toMatchObject({ accessToken: TOKEN_2 });
  });

  test.each<[string, ApiResult]>([
    ["401 sem o ApiError da API", http(401, "<html>")],
    ["401 com outro código", http(401, apiError("PROIBIDO"))],
    ["400", http(400, apiError("PAYLOAD_INVALIDO"))],
    ["403 de origem", http(403, apiError("PROIBIDO"))],
    ["200 fora do contrato", http(200, JSON.stringify({ schemaVersion: 1, accessToken: TOKEN_2 }))],
    ["200 que não é JSON", http(200, "ok")],
    ["pedido recusado pelo api-client", RECUSADO],
  ])("troca com %s → { false, ERRO_INTERNO }", async (_nome, result) => {
    const { service, api, emitted, logs } = setup();
    api.reply(result);
    await service.login("github");
    expect(emitted).toStrictEqual([ERRO_INTERNO]);
    expect(logs).toStrictEqual(["auth_troca_recusada"]);
    expect(await stored()).toBeUndefined();
  });

  test.each<[string, SetupOptions]>([
    ["sem crypto.subtle", { crypto: { getRandomValues: (b: Uint8Array) => b, subtle: undefined } }],
    ["origem do Supabase fora da forma", { supabaseOrigin: "http://projeto.supabase.test" }],
  ])("ambiente sem o que o login precisa (%s) → { false, ERRO_INTERNO }, sem abrir o IdP", async (_nome, options) => {
    const { service, idp, emitted, logs } = setup(options);
    await service.login("github");
    expect(idp.requests).toStrictEqual([]);
    expect(emitted).toStrictEqual([ERRO_INTERNO]);
    expect(logs).toStrictEqual(["auth_sem_configuracao"]);
  });

  test("storage que falha fecha a tentativa com ERRO_INTERNO e não trava o próximo clique", async () => {
    const real = authSessionStore();
    const get = vi.fn(real.get).mockRejectedValueOnce(new Error("storage"));
    const { service, idp, api, emitted } = setup({ store: { ...real, get } });
    await service.login("github");
    expect(emitted).toStrictEqual([ERRO_INTERNO]);
    api.reply(OK_SESSION);
    await service.login("github");
    expect(idp.requests).toHaveLength(1);
    expect(emitted).toStrictEqual([ERRO_INTERNO, AUTENTICADO]);
  });

  test("callback do painel que lança: o login não rejeita, não emite duas vezes e não trava o próximo clique", async () => {
    const { service, idp, api, emitted } = setup({ emitThrowsOnce: true });
    idp.answer(() => ({ ok: false }));
    await expect(service.login("github")).resolves.toBeUndefined();
    expect(emitted).toStrictEqual([NAO_LOGADO]);
    api.reply(OK_SESSION);
    await service.login("github");
    expect(emitted).toStrictEqual([NAO_LOGADO, AUTENTICADO]);
  });

  test("nada do retorno, do código, do verifier ou do token chega ao painel ou ao log", async () => {
    const { service, idp, api, emitted, logs } = setup();
    idp.answer(() => ({ ok: true, url: `${REDIRECT}?error=CANARIO-IDP&error_description=CANARIO-IDP` }));
    await service.login("github");
    api.reply(OK_SESSION);
    await service.login("github");
    const visible = JSON.stringify({ emitted, logs });
    expect(visible).not.toMatch(/CANARIO|chromiumapp|r1\./);
    for (const view of emitted) expect(Object.keys(view).sort()).toStrictEqual(["autenticado", "erro"]);
  });
});

// ==========================================================================================================
describe("renovação (ADR-004 D11.1 a D11.3)", () => {
  test.each<[string, number, boolean]>([
    ["61 s de vida: usa o token sem renovar", 61_000, false],
    ["60 s de vida: renova antes de usar", 60_000, true],
    ["59 s de vida: renova antes de usar (M-05)", 59_000, true],
    ["vencido: renova antes de usar", 1_000, true],
  ])("%s", async (_nome, remaining, renews) => {
    const { service, api, clock } = setup();
    await plant(session(TOKEN_1, T0, 120_000));
    await clock.advance(120_000 - remaining);
    api.reply(OK_SESSION);
    expect(await service.accessToken()).toBe(renews ? TOKEN_2 : TOKEN_1);
    expect(api.calls).toHaveLength(renews ? 1 : 0);
  });

  test("a renovação manda só o envelope, sem Bearer, e grava o vencimento pelo expiresIn", async () => {
    const { service, api, clock } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    await clock.advance(5_000);
    api.reply(http(200, sessionBody(TOKEN_2, 300)));
    expect(await service.accessToken()).toBe(TOKEN_2);
    expect(api.calls).toStrictEqual([{ path: "/v1/auth/refresh", body: { schemaVersion: 1, refreshToken: ENVELOPE_1 } }]);
    expect(await stored()).toStrictEqual(session(TOKEN_2, T0 + 5_000, 300_000, ENVELOPE_2));
  });

  test("M-04: 5 chamadas simultâneas com o token vencido fazem exatamente 1 renovação", async () => {
    const { service, api } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    const held = api.hold();
    const tokens = Promise.all([1, 2, 3, 4, 5].map(() => service.accessToken()));
    await flush();
    held.resolve(OK_SESSION);
    expect(await tokens).toStrictEqual([TOKEN_2, TOKEN_2, TOKEN_2, TOKEN_2, TOKEN_2]);
    expect(api.calls).toHaveLength(1);
  });

  test("M-05: sem resposta HTTP, uma única nova tentativa, sequencial, 2 s depois", async () => {
    const { service, api, clock, emitted } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    api.reply(SEM_RESPOSTA, OK_SESSION);
    const token = service.accessToken();
    await clock.advance(RETRY - 1);
    expect(api.calls).toHaveLength(1);
    await clock.advance(1);
    expect(await token).toBe(TOKEN_2);
    expect(api.calls).toHaveLength(2);
    expect(emitted).toStrictEqual([]);
  });

  test.each<[string, ApiResult]>([
    ["503", http(503)],
    ["429", http(429)],
    ["corpo ilegível depois do status", ILEGIVEL],
    ["200 fora do contrato", http(200, "{}")],
    ["401 sem o ApiError da API", http(401, "")],
  ])("M-05: nenhuma nova tentativa depois de resposta HTTP (%s), e a sessão fica", async (_nome, result) => {
    const { service, api, clock } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    api.reply(result);
    const token = service.accessToken();
    await clock.advance(RETRY * 2);
    expect(await token).toBe(TOKEN_1);
    expect(api.calls).toHaveLength(1);
    expect(await stored()).toStrictEqual(session(TOKEN_1, T0, MIN));
  });

  test("falha transitória com o token já vencido: a sessão fica, mas nenhum token sai", async () => {
    const { service, api, clock } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    await clock.advance(MIN);
    api.reply(http(503));
    expect(await service.accessToken()).toBeUndefined();
    expect(await stored()).toStrictEqual(session(TOKEN_1, T0, MIN));
  });

  test("com sessão degradada, o clique em Entrar emite o estado atual", async () => {
    const { service, api, emitted } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    api.reply(http(429));
    await service.accessToken();
    await service.login("github");
    expect(emitted).toStrictEqual([
      { autenticado: true, erro: "LIMITE_DE_TAXA" },
      { autenticado: true, erro: "LIMITE_DE_TAXA" },
    ]);
  });

  test("M-04 (\"Sair\"): \"Sair\" durante uma renovação pendente deixa o storage vazio quando ela resolve", async () => {
    const { service, api, emitted } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    const held = api.hold();
    const token = service.accessToken();
    await flush();
    // O logout renova só em memória (o access tem menos de 60 s) e encerra no servidor.
    api.reply(http(200, sessionBody(TOKEN_3)), http(204));
    await service.logout();
    held.resolve(OK_SESSION);
    expect(await token).toBeUndefined();
    expect(await stored()).toBeUndefined();
    expect(emitted).toStrictEqual([NAO_LOGADO]);
  });

  test("M-04 (401): o segundo 401 da análise durante uma renovação pendente deixa o storage vazio", async () => {
    const { service, api } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    const held = api.hold();
    const token = service.accessToken();
    await flush();
    await service.onUnauthorized(2, TOKEN_1);
    held.resolve(OK_SESSION);
    expect(await token).toBeUndefined();
    expect(await stored()).toBeUndefined();
  });

  test("M-04 (login): uma renovação da sessão anterior não sobrescreve a sessão de um login novo", async () => {
    const { service, api } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    const held = api.hold();
    const token = service.accessToken();
    await flush();
    // A sessão some sem "Sair" (valor adulterado apagado pelo sessionStore, por exemplo), e o usuário entra de novo.
    await fakeBrowser.storage.session.remove(SESSION_STORAGE_KEY);
    api.reply(http(200, sessionBody(TOKEN_3)));
    await service.login("github");
    held.resolve(OK_SESSION);
    expect(await token).toBe(TOKEN_3);
    expect(await stored()).toMatchObject({ accessToken: TOKEN_3 });
  });

  test("uma renovação 401 da sessão anterior não apaga a sessão de um login novo", async () => {
    const { service, api, emitted } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    const held = api.hold();
    void service.accessToken();
    await flush();
    await fakeBrowser.storage.session.remove(SESSION_STORAGE_KEY);
    api.reply(http(200, sessionBody(TOKEN_3)));
    await service.login("github");
    held.resolve(UNAUTHORIZED);
    await flush();
    expect(await stored()).toMatchObject({ accessToken: TOKEN_3 });
    expect(emitted).toStrictEqual([AUTENTICADO]);
  });

  test("o single-flight é por geração: depois de um login novo, a renovação velha não é reaproveitada", async () => {
    const { service, api, clock } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    const old = api.hold();
    void service.accessToken();
    await flush();
    await fakeBrowser.storage.session.remove(SESSION_STORAGE_KEY);
    api.reply(OK_SESSION);
    await service.login("github");
    await clock.advance(900_000);
    const fresh = api.hold();
    const token = service.accessToken();
    await flush();
    expect(api.paths()).toStrictEqual(["/v1/auth/refresh", "/v1/auth/exchange", "/v1/auth/refresh"]);
    // A velha resolve primeiro e não derruba o single-flight da nova.
    old.resolve(http(200, sessionBody(TOKEN_1)));
    await flush();
    const joined = service.accessToken();
    fresh.resolve(http(200, sessionBody(TOKEN_3)));
    expect(await token).toBe(TOKEN_3);
    expect(await joined).toBe(TOKEN_3);
    expect(api.calls).toHaveLength(3);
  });

  test("a renovação velha que resolve por último não apaga o single-flight já encerrado", async () => {
    const { service, api, clock } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    const old = api.hold();
    void service.accessToken();
    await flush();
    await fakeBrowser.storage.session.remove(SESSION_STORAGE_KEY);
    api.reply(OK_SESSION);
    await service.login("github");
    await clock.advance(900_000);
    api.reply(http(200, sessionBody(TOKEN_3)));
    expect(await service.accessToken()).toBe(TOKEN_3);
    old.resolve(OK_SESSION);
    await flush();
    expect(await stored()).toMatchObject({ accessToken: TOKEN_3 });
  });

  test("sem sessão ou sem configuração, nenhum token e nenhuma rede", async () => {
    const semSessao = setup();
    expect(await semSessao.service.accessToken()).toBeUndefined();
    expect(await semSessao.service.onUnauthorized(1, TOKEN_1)).toBeUndefined();
    await plant(session());
    const semConfig = setup({ config: false });
    expect(await semConfig.service.accessToken()).toBeUndefined();
    expect(await semConfig.service.onUnauthorized(1, TOKEN_1)).toBeUndefined();
    expect(semSessao.api.calls).toStrictEqual([]);
  });

  test("storage que falha: accessToken e onUnauthorized não rejeitam, e view dá ERRO_INTERNO", async () => {
    const real = authSessionStore();
    const get = vi.fn(() => Promise.reject(new Error("storage")));
    const { service } = setup({ store: { ...real, get } });
    expect(await service.accessToken()).toBeUndefined();
    expect(await service.onUnauthorized(1, TOKEN_1)).toBeUndefined();
    expect(await service.view()).toStrictEqual(ERRO_INTERNO);
  });
});

// ==========================================================================================================
describe("onUnauthorized (ADR-004 D11.4)", () => {
  test("1º 401: uma renovação, mesmo com o token ainda válido, e o token novo volta para o reenvio", async () => {
    const { service, api } = setup();
    await plant(session());
    api.reply(OK_SESSION);
    expect(await service.onUnauthorized(1, TOKEN_1)).toBe(TOKEN_2);
    expect(api.paths()).toStrictEqual(["/v1/auth/refresh"]);
    expect(await stored()).toMatchObject({ accessToken: TOKEN_2 });
  });

  test("1º 401 durante uma renovação em voo: junta-se a ela (single-flight)", async () => {
    const { service, api } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    const held = api.hold();
    const token = service.accessToken();
    await flush();
    const retried = service.onUnauthorized(1, TOKEN_1);
    held.resolve(OK_SESSION);
    expect(await token).toBe(TOKEN_2);
    expect(await retried).toBe(TOKEN_2);
    expect(api.calls).toHaveLength(1);
  });

  test("1º 401 com a renovação recusada: nenhum token, e a sessão é apagada", async () => {
    const { service, api } = setup();
    await plant(session());
    api.reply(UNAUTHORIZED);
    expect(await service.onUnauthorized(1, TOKEN_1)).toBeUndefined();
    expect(await stored()).toBeUndefined();
  });

  // --- F1-EXT-07, E-02: o 401 vale só para a sessão do token que o levou ---
  /** Sessão A gravada; "Sair" (204) e login novo, que grava a sessão B com o TOKEN_3. */
  async function sessionReplacedByNewLogin(env: ReturnType<typeof setup>): Promise<void> {
    env.api.reply(http(204));
    await env.service.logout();
    env.api.reply(http(200, sessionBody(TOKEN_3)));
    await env.service.login("github");
    expect(await stored()).toMatchObject({ accessToken: TOKEN_3 });
    env.api.calls.length = 0;
    env.emitted.length = 0;
  }

  test("E-02: o 2º 401 de uma sessão anterior não apaga a sessão de um login novo", async () => {
    const env = setup();
    await plant(session());
    await sessionReplacedByNewLogin(env);
    expect(await env.service.onUnauthorized(2, TOKEN_1)).toBeUndefined();
    expect(await stored()).toMatchObject({ accessToken: TOKEN_3 });
    expect(env.api.calls).toStrictEqual([]);
    expect(env.emitted).toStrictEqual([]);
    expect(env.logs).toStrictEqual([]);
  });

  test("E-02: o 1º 401 de uma sessão anterior não renova a sessão nova nem recebe o token dela", async () => {
    const env = setup();
    await plant(session());
    await sessionReplacedByNewLogin(env);
    expect(await env.service.onUnauthorized(1, TOKEN_1)).toBeUndefined();
    expect(env.api.calls).toStrictEqual([]);
    expect(await stored()).toMatchObject({ accessToken: TOKEN_3 });
  });

  test("E-02: token renovado numa sessão anterior não recebe o token da sessão nova (a troca vale só na geração dela)", async () => {
    const env = setup();
    await plant(session());
    env.api.reply(OK_SESSION);
    expect(await env.service.onUnauthorized(1, TOKEN_1)).toBe(TOKEN_2);
    await sessionReplacedByNewLogin(env);
    expect(await env.service.onUnauthorized(1, TOKEN_1)).toBeUndefined();
    expect(await env.service.onUnauthorized(1, TOKEN_2)).toBeUndefined();
    expect(env.api.calls).toStrictEqual([]);
    expect(await stored()).toMatchObject({ accessToken: TOKEN_3 });
  });

  test("E-02: 1º 401 atrasado da mesma sessão, já renovada: o token atual volta sem outra renovação", async () => {
    const { service, api } = setup();
    await plant(session());
    api.reply(OK_SESSION);
    expect(await service.onUnauthorized(1, TOKEN_1)).toBe(TOKEN_2);
    expect(await service.onUnauthorized(1, TOKEN_1)).toBe(TOKEN_2);
    expect(api.paths()).toStrictEqual(["/v1/auth/refresh"]);
    expect(await stored()).toMatchObject({ accessToken: TOKEN_2 });
  });

  test("E-02: a renovação preguiçosa também registra o token trocado", async () => {
    const { service, api } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    api.reply(OK_SESSION);
    expect(await service.accessToken()).toBe(TOKEN_2);
    expect(await service.onUnauthorized(1, TOKEN_1)).toBe(TOKEN_2);
    expect(api.calls).toHaveLength(1);
  });

  test("E-02: 2º 401 atrasado, com o token já trocado pela renovação, não apaga a sessão", async () => {
    const { service, api, emitted, logs } = setup();
    await plant(session());
    api.reply(OK_SESSION);
    expect(await service.onUnauthorized(1, TOKEN_1)).toBe(TOKEN_2);
    expect(await service.onUnauthorized(2, TOKEN_1)).toBeUndefined();
    expect(await stored()).toMatchObject({ accessToken: TOKEN_2 });
    expect(emitted).toStrictEqual([]);
    expect(logs).toStrictEqual([]);
    // O 2º 401 do token atual segue apagando.
    expect(await service.onUnauthorized(2, TOKEN_2)).toBeUndefined();
    expect(await stored()).toBeUndefined();
    expect(emitted).toStrictEqual([{ autenticado: false, erro: "NAO_AUTENTICADO" }]);
  });

  test.each<[string, boolean]>([
    ["sem renovação nenhuma", false],
    ["depois de uma renovação", true],
  ])("E-02: token que a sessão nunca teve (%s): nenhum token, nenhuma rede e a sessão fica", async (_caso, renewFirst) => {
    const { service, api, emitted } = setup();
    await plant(session());
    if (renewFirst) {
      api.reply(OK_SESSION);
      await service.onUnauthorized(1, TOKEN_1);
    }
    const before = api.calls.length;
    for (const tentativa of [1, 2] as const) expect(await service.onUnauthorized(tentativa, TOKEN_3)).toBeUndefined();
    expect(api.calls).toHaveLength(before);
    expect(await stored()).toMatchObject({ accessToken: renewFirst ? TOKEN_2 : TOKEN_1 });
    expect(emitted).toStrictEqual([]);
  });

  test("E-02: o token trocado não vale depois que a sessão caiu por 401 e outra entrou", async () => {
    const { service, api } = setup();
    await plant(session());
    api.reply(OK_SESSION);
    expect(await service.onUnauthorized(1, TOKEN_1)).toBe(TOKEN_2);
    // A sessão cai pelo 2º 401 (sem "Sair"), e o login seguinte grava outra.
    await service.onUnauthorized(2, TOKEN_2);
    api.reply(http(200, sessionBody(TOKEN_3)));
    await service.login("github");
    api.calls.length = 0;
    expect(await service.onUnauthorized(1, TOKEN_1)).toBeUndefined();
    expect(api.calls).toStrictEqual([]);
  });
});

// ==========================================================================================================
describe("logout (ADR-004 D11.5)", () => {
  test("204 ou 401 encerram sem nova chamada", async () => {
    for (const status of [204, 401]) {
      fakeBrowser.reset();
      const { service, api, emitted, logs } = setup();
      await plant(session());
      api.reply(http(status));
      await service.logout();
      expect(api.calls).toHaveLength(1);
      expect(emitted).toStrictEqual([NAO_LOGADO]);
      expect(logs).toStrictEqual([]);
    }
  });

  test("uma falha e depois sucesso: a repetição automática encerra sem emitir erro", async () => {
    const { service, api, clock, emitted } = setup();
    await plant(session());
    api.reply(http(503), http(204));
    const done = service.logout();
    await clock.advance(RETRY);
    await done;
    expect(api.paths()).toStrictEqual(["/v1/auth/logout", "/v1/auth/logout"]);
    expect(emitted).toStrictEqual([NAO_LOGADO]);
  });

  test("access com menos de 60 s: renova só em memória e usa o token novo, sem gravar", async () => {
    const { service, api } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    api.reply(OK_SESSION, http(204));
    await service.logout();
    expect(api.calls).toStrictEqual([
      { path: "/v1/auth/refresh", body: { schemaVersion: 1, refreshToken: ENVELOPE_1 } },
      { path: "/v1/auth/logout", body: { schemaVersion: 1 }, accessToken: TOKEN_2 },
    ]);
    expect(await stored()).toBeUndefined();
  });

  test("renovação do logout com 401: a sessão já morreu no servidor, e a parte remota é pulada", async () => {
    const { service, api, emitted } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    api.reply(UNAUTHORIZED);
    await service.logout();
    expect(api.paths()).toStrictEqual(["/v1/auth/refresh"]);
    expect(emitted).toStrictEqual([NAO_LOGADO]);
  });

  test("\"Tentar sair de novo\" usa a sessão guardada em memória, já renovada, e depois a esquece", async () => {
    const { service, api, clock, emitted } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    // 1ª rodada: renova (TOKEN_2) e o logout falha; 2ª: o token novo ainda vale, e o logout falha de novo.
    api.reply(OK_SESSION, http(503), http(503));
    const done = service.logout();
    await clock.advance(RETRY);
    await done;
    expect(emitted).toStrictEqual([NAO_LOGADO, { autenticado: false, erro: "SERVICO_INDISPONIVEL" }]);
    api.reply(http(204));
    await service.logout();
    expect(api.calls.at(-1)).toStrictEqual({ path: "/v1/auth/logout", body: { schemaVersion: 1 }, accessToken: TOKEN_2 });
    await service.logout();
    expect(api.calls).toHaveLength(4);
    expect(emitted).toStrictEqual([NAO_LOGADO, { autenticado: false, erro: "SERVICO_INDISPONIVEL" }, NAO_LOGADO, NAO_LOGADO]);
  });

  test("renovação do logout com 503 conta como falha remota", async () => {
    const { service, api, clock, emitted } = setup();
    await plant(session(TOKEN_1, T0, MIN));
    api.reply(http(503), http(503));
    const done = service.logout();
    await clock.advance(RETRY);
    await done;
    expect(api.paths()).toStrictEqual(["/v1/auth/refresh", "/v1/auth/refresh"]);
    expect(emitted.at(-1)).toStrictEqual({ autenticado: false, erro: "SERVICO_INDISPONIVEL" });
  });

  test("sem sessão, ou sem configuração, só o local", async () => {
    const semSessao = setup();
    await semSessao.service.logout();
    expect(semSessao.emitted).toStrictEqual([NAO_LOGADO]);
    await plant(session());
    const semConfig = setup({ config: false });
    await semConfig.service.logout();
    expect(semConfig.emitted).toStrictEqual([NAO_LOGADO]);
    expect(await stored()).toBeUndefined();
    expect(semSessao.api.calls).toStrictEqual([]);
  });

  test("storage que falha: emite ERRO_INTERNO, sem rede", async () => {
    const real = authSessionStore();
    const remove = vi.fn(() => Promise.reject(new Error("storage")));
    await plant(session());
    const { service, api, emitted } = setup({ store: { ...real, remove } });
    await service.logout();
    expect(emitted).toStrictEqual([ERRO_INTERNO]);
    expect(api.calls).toStrictEqual([]);
  });

  test("cliente que rejeita (fora do contrato): o local já está vazio e o painel vê a falha remota", async () => {
    const { service, emitted } = setup();
    await plant(session());
    // Nenhuma resposta programada: o api-client falso rejeita.
    await service.logout();
    expect(emitted).toStrictEqual([NAO_LOGADO, { autenticado: false, erro: "SERVICO_INDISPONIVEL" }]);
    expect(await stored()).toBeUndefined();
  });
});
