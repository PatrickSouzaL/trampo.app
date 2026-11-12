// F1-EXT-04 parte 2, 04b-1 (ADR-025 §6 D10 e D11; ADR-004 D11.1 e D11.4): o envio da vaga no Service Worker. Portões
// antes de qualquer rede (o consentimento antes do accessToken), o pedido do contrato, o repasse do stream, o 401 com o
// token capturado no envio e um reenvio só, o erro sintetizado só com texto do catálogo e a captura que cancela.
import { type AnalysisStreamEvent, AnalysisStreamEventSchema, type AnalyzeJobRequestInput, ApiErrorSchema } from "@trampo/contracts/api";
import { describe, expect, test, vi } from "vitest";

import type { AnalyzeCall, AnalyzeResult, StreamControl } from "../src/api/api-client";
import { ANALYSIS_LOG_REASONS, LOCAL_ERROR_MESSAGES, type AnalysisServiceDeps, createAnalysisService } from "../src/api/analysis-service";
import type { CapturedJob } from "../src/capture/capture";
import type { WorkerToPanel } from "../src/messaging/protocol";
import type { PanelPort } from "../src/messaging/worker-port";
import { REPORT } from "./fixtures/stream";

const TOKEN = "tok.um.aaa";
const RENOVADO = "tok.dois.bbb";
const ID = "6f1c2a52-3b7e-4c1d-9a55-0d6b3f4e8a11";
const OUTRO_ID = "0b1c2a52-3b7e-4c1d-9a55-0d6b3f4e8a99";
const TEXTO = "CANARIO-VAGA texto da vaga ".repeat(12);
const JOB: CapturedJob = { tabId: 7, capturedAt: 1, platform: "gupy", extractorVersion: "gp1", text: TEXTO, truncated: true };

type Event = AnalysisStreamEvent;
const STAGE: Event = { type: "stage", stage: "recebido", elapsedMs: 0 };
const STAGE2: Event = { type: "stage", stage: "pontuando", elapsedMs: 900 };
const RESULT: Event = { type: "result", report: REPORT };
const apiError = (code: string, requestId: string | null = ID) => ({ code, message: "Mensagem do servidor.", requestId, retryAfterSeconds: null });
const frame = (event: Event): string => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const local = (code: keyof typeof LOCAL_ERROR_MESSAGES, requestId: string | null): Event => ({
  type: "error",
  error: { code, message: LOCAL_ERROR_MESSAGES[code], requestId, retryAfterSeconds: null },
});

/** Um passo do roteiro da API falsa: o texto que o "servidor" manda e o fim, ou uma resposta fora do stream. */
type Script = { readonly sse: readonly string[]; readonly fim?: "completo" | "queda" | "ilegivel" } | AnalyzeResult;

function fakePort() {
  const received: WorkerToPanel[] = [];
  const onDisconnect: Array<() => void> = [];
  const port = {
    name: "p",
    postMessage: vi.fn((m: WorkerToPanel) => void received.push(m)),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: (l: () => void) => void onDisconnect.push(l) },
  } satisfies PanelPort;
  return { port, received, events: () => received.map((m) => (m.kind === "stream" ? m.event : m)), drop: () => onDisconnect.forEach((l) => l()) };
}

function setup(scripts: Script[] = [{ sse: [frame(STAGE), frame(RESULT)] }], over: Partial<AnalysisServiceDeps> = {}) {
  const calls: AnalyzeCall[] = [];
  const controls: StreamControl[][] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const queue = [...scripts];
  const analyze = vi.fn(async (call: AnalyzeCall, onText: (text: string) => StreamControl, signal?: AbortSignal): Promise<AnalyzeResult> => {
    calls.push(structuredClone(call));
    signals.push(signal);
    const step = queue.shift() ?? { sse: [] };
    if (!("sse" in step)) return step;
    const seen: StreamControl[] = [];
    controls.push(seen);
    for (const text of step.sse) {
      const control = onText(text);
      seen.push(control);
      if (control === "parar") return { ok: true, stream: true, fim: "parado" };
    }
    return { ok: true, stream: true, fim: step.fim ?? "completo" };
  });
  const logs: string[] = [];
  const deps: AnalysisServiceDeps = {
    api: { analyze },
    auth: { accessToken: vi.fn(async () => TOKEN), onUnauthorized: vi.fn(async (tentativa: 1 | 2) => (tentativa === 1 ? RENOVADO : undefined)) },
    consent: { isGranted: vi.fn(async () => true) },
    job: vi.fn(async () => JOB),
    randomUUID: vi.fn(() => ID),
    log: (motivo) => void logs.push(motivo),
    ...over,
  };
  const service = createAnalysisService(deps);
  const panel = fakePort();
  service.attach(panel.port);
  return { service, deps, calls, controls, signals, analyze, logs, panel, events: panel.events };
}

const expectedBody = (mode: "auto" | "aprofundada", job: CapturedJob = JOB): AnalyzeJobRequestInput => ({
  schemaVersion: 1,
  requestId: ID,
  source: { platform: job.platform, extractorVersion: job.extractorVersion },
  job: { titleHint: null, text: job.text, clientTruncated: job.truncated },
  mode,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("portões, antes de qualquer rede (D10)", () => {
  test("sem api: ERRO_INTERNO sem requestId, e nem o consentimento é lido", async () => {
    const { service, deps, events, logs } = setup([], { api: undefined });
    await service.analyze("auto");
    expect(events()).toEqual([local("ERRO_INTERNO", null)]);
    expect(deps.consent.isGranted).not.toHaveBeenCalled();
    expect(deps.auth.accessToken).not.toHaveBeenCalled();
    expect(logs).toEqual(["analise_sem_api"]);
  });

  test("sem consentimento: ERRO_INTERNO, sem accessToken (que pode renovar pela rede) e sem envio", async () => {
    const { service, deps, events, analyze, logs } = setup([], { consent: { isGranted: vi.fn(async () => false) } });
    await service.analyze("auto");
    expect(events()).toEqual([local("ERRO_INTERNO", null)]);
    expect(deps.auth.accessToken).not.toHaveBeenCalled();
    expect(deps.job).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(logs).toEqual(["analise_sem_consentimento"]);
  });

  test("sem vaga pronta: ERRO_INTERNO, sem accessToken", async () => {
    const { service, deps, events, analyze, logs } = setup([], { job: vi.fn(async () => undefined) });
    await service.analyze("auto");
    expect(events()).toEqual([local("ERRO_INTERNO", null)]);
    expect(deps.auth.accessToken).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(logs).toEqual(["analise_sem_vaga"]);
  });

  test("sem token: SERVICO_INDISPONIVEL (nunca NAO_AUTENTICADO, T30), sem envio", async () => {
    const accessToken = vi.fn(async () => undefined);
    const { service, deps, events, analyze, logs } = setup([], { auth: { accessToken, onUnauthorized: vi.fn() } });
    await service.analyze("auto");
    expect(events()).toEqual([local("SERVICO_INDISPONIVEL", null)]);
    expect(analyze).not.toHaveBeenCalled();
    expect(deps.auth.onUnauthorized).not.toHaveBeenCalled();
    expect(logs).toEqual(["analise_sem_token"]);
  });

  test("ordem: consentimento, vaga, token, consentimento de novo e só então o envio", async () => {
    const { service, deps, analyze } = setup();
    await service.analyze("auto");
    const order = [deps.consent.isGranted, deps.job, deps.auth.accessToken, analyze].map((fn) => vi.mocked(fn).mock.invocationCallOrder);
    expect(order[0]).toHaveLength(2);
    const [firstConsent, secondConsent] = order[0] as number[];
    expect(firstConsent).toBeLessThan(order[1]?.[0] as number);
    expect(order[1]?.[0]).toBeLessThan(order[2]?.[0] as number);
    expect(order[2]?.[0]).toBeLessThan(secondConsent as number);
    expect(secondConsent).toBeLessThan(order[3]?.[0] as number);
  });

  test("consentimento retirado durante o accessToken: nada sai", async () => {
    const isGranted = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const { service, events, analyze, logs } = setup([], { consent: { isGranted } });
    await service.analyze("auto");
    expect(analyze).not.toHaveBeenCalled();
    expect(events()).toEqual([local("ERRO_INTERNO", null)]);
    expect(logs).toEqual(["analise_sem_consentimento"]);
  });
});

describe("pedido (D10)", () => {
  test.each(["auto", "aprofundada"] as const)("%s: o corpo do contrato, sem URL nem perfil, com o token do accessToken", async (mode) => {
    const { service, calls } = setup();
    await service.analyze(mode);
    expect(calls).toEqual([{ body: expectedBody(mode), accessToken: TOKEN }]);
  });

  test("texto colado: a plataforma e a versão do colado", async () => {
    const colado: CapturedJob = { ...JOB, tabId: null, platform: "texto_colado", extractorVersion: "colado-1", truncated: false };
    const { service, calls } = setup(undefined, { job: vi.fn(async () => colado) });
    await service.analyze("auto");
    expect(calls[0]?.body).toEqual(expectedBody("auto", colado));
  });

  test("cada análise tem um requestId novo", async () => {
    const randomUUID = vi.fn().mockReturnValueOnce(ID).mockReturnValueOnce(OUTRO_ID);
    const { service, calls } = setup([{ sse: [frame(RESULT)] }, { sse: [frame(RESULT)] }], { randomUUID });
    await service.analyze("auto");
    await service.analyze("aprofundada");
    expect(calls.map((c) => c.body.requestId)).toEqual([ID, OUTRO_ID]);
  });
});

describe("stream (D8 e D10)", () => {
  test("stages na ordem e o resultado no fim, um terminal só", async () => {
    const { service, events, logs } = setup([{ sse: [frame(STAGE), frame(STAGE2), frame(RESULT)] }]);
    await service.analyze("auto");
    expect(events()).toEqual([STAGE, STAGE2, RESULT]);
    expect(logs).toEqual([]);
  });

  test("o stage chega ao painel antes do fim do stream", async () => {
    const gate = deferred<void>();
    let seenAtStage: number | undefined;
    const { service, panel } = setup([], {
      api: {
        analyze: async (_call, onText) => {
          onText(frame(STAGE));
          seenAtStage = panel.received.length;
          await gate.promise;
          onText(frame(RESULT));
          return { ok: true, stream: true, fim: "completo" };
        },
      },
    });
    const running = service.analyze("auto");
    await vi.waitFor(() => expect(seenAtStage).toBe(1));
    gate.resolve();
    await running;
    expect(panel.events()).toEqual([STAGE, RESULT]);
  });

  test("violação do leitor: o fetch é parado, e o painel recebe ERRO_INTERNO com o requestId", async () => {
    const { service, events, controls, logs } = setup([{ sse: [frame(STAGE), ": lixo\n", frame(RESULT)] }]);
    await service.analyze("auto");
    expect(controls[0]).toEqual(["seguir", "parar"]);
    expect(events()).toEqual([STAGE, local("ERRO_INTERNO", ID)]);
    expect(logs).toEqual(["analise_violacao"]);
  });

  test.each([
    ["stream sem terminal", { sse: [frame(STAGE)] }, "SERVICO_INDISPONIVEL", "analise_indisponivel"],
    ["queda no meio", { sse: [frame(STAGE)], fim: "queda" }, "SERVICO_INDISPONIVEL", "analise_indisponivel"],
    ["queda depois do terminal", { sse: [frame(STAGE), frame(RESULT)], fim: "queda" }, "SERVICO_INDISPONIVEL", "analise_indisponivel"],
    ["stream ilegível", { sse: [frame(STAGE)], fim: "ilegivel" }, "ERRO_INTERNO", "analise_violacao"],
    ["sem resposta", { ok: false, reason: "sem_resposta" }, "SERVICO_INDISPONIVEL", "analise_indisponivel"],
    ["resposta ilegível", { ok: false, reason: "resposta_ilegivel" }, "ERRO_INTERNO", "analise_violacao"],
    ["pedido recusado", { ok: false, reason: "pedido_recusado" }, "ERRO_INTERNO", "analise_violacao"],
    ["cancelado sem ninguém ter cancelado", { ok: false, reason: "cancelado" }, "ERRO_INTERNO", "analise_violacao"],
  ] as const)("%s: %s", async (_nome, script, code, motivo) => {
    const { service, events, logs } = setup([script as Script]);
    await service.analyze("auto");
    const all = events();
    expect(all.at(-1)).toEqual(local(code, ID));
    expect(all.filter((e) => "type" in e && e.type !== "stage")).toHaveLength(1);
    expect(logs).toEqual([motivo]);
  });

  test("cliente que não para depois da violação e diz completo: ERRO_INTERNO, nada depois do stage", async () => {
    const analyze = vi.fn(async (_call: AnalyzeCall, onText: (t: string) => StreamControl): Promise<AnalyzeResult> => {
      for (const text of [frame(STAGE), "id: 1\n", frame(STAGE2), frame(RESULT)]) onText(text);
      return { ok: true, stream: true, fim: "completo" };
    });
    const { service, events, logs } = setup([], { api: { analyze } });
    await service.analyze("auto");
    expect(events()).toEqual([STAGE, local("ERRO_INTERNO", ID)]);
    expect(logs).toEqual(["analise_violacao"]);
  });

  test.each([
    ["requestId do pedido", ID, true],
    ["requestId nulo", null, true],
    ["requestId de outro pedido", OUTRO_ID, false],
  ])("erro do servidor no stream com %s", async (_nome, requestId, passes) => {
    const error = { type: "error", error: { ...apiError("SERVICO_INDISPONIVEL", requestId), retryAfterSeconds: 30 } } as Event;
    const { service, events } = setup([{ sse: [frame(error)] }]);
    await service.analyze("auto");
    expect(events()).toEqual([passes ? error : local("ERRO_INTERNO", ID)]);
  });
});

describe("status antes do stream (D10)", () => {
  const status = (s: number, body: unknown): AnalyzeResult => ({ ok: true, stream: false, status: s, body: typeof body === "string" ? body : JSON.stringify(body) });

  test.each([
    [409, "CRITERIOS_NAO_CONFIGURADOS", ID],
    [429, "COTA_DIARIA_ESGOTADA", null],
    [413, "PAYLOAD_GRANDE_DEMAIS", ID],
    [401, "PROIBIDO", ID],
  ])("%i com o ApiError válido: vai ao painel como veio", async (s, code, requestId) => {
    const error = apiError(code, requestId);
    const { service, events, deps, logs } = setup([status(s, error)]);
    await service.analyze("auto");
    expect(events()).toEqual([{ type: "error", error }]);
    expect(deps.auth.onUnauthorized).not.toHaveBeenCalled();
    expect(logs).toEqual(["analise_erro_servidor"]);
  });

  test.each([
    [429, "texto", "LIMITE_DE_TAXA"],
    [503, "", "SERVICO_INDISPONIVEL"],
    [500, "{}", "SERVICO_INDISPONIVEL"],
    [400, "<html>", "ERRO_INTERNO"],
    [404, apiError("PAYLOAD_INVALIDO", OUTRO_ID), "ERRO_INTERNO"],
    [401, "", "SERVICO_INDISPONIVEL"],
    [401, { error: "invalid" }, "SERVICO_INDISPONIVEL"],
    [401, apiError("NAO_AUTENTICADO", OUTRO_ID), "SERVICO_INDISPONIVEL"],
  ])("%i com corpo fora do contrato: o código sai do status", async (s, body, code) => {
    const { service, events, deps, logs } = setup([status(s, body)]);
    await service.analyze("auto");
    expect(events()).toEqual([local(code as keyof typeof LOCAL_ERROR_MESSAGES, ID)]);
    expect(deps.auth.onUnauthorized).not.toHaveBeenCalled();
    expect(logs).toEqual(["analise_violacao"]);
  });

  test("o painel nunca recebe o message do servidor fora do ApiError validado", async () => {
    const { service, panel } = setup([status(503, "CANARIO-SERVIDOR")]);
    await service.analyze("auto");
    expect(JSON.stringify(panel.received)).not.toContain("CANARIO-SERVIDOR");
  });
});

describe("401 da análise (ADR-004 D11.4, Emenda da F1-EXT-07)", () => {
  const unauthorized: AnalyzeResult = { ok: true, stream: false, status: 401, body: JSON.stringify(apiError("NAO_AUTENTICADO", ID)) };

  test("uma renovação com o token do envio e um reenvio do mesmo pedido com o token novo", async () => {
    const randomUUID = vi.fn().mockReturnValueOnce(ID).mockReturnValue(OUTRO_ID);
    const { service, calls, deps, events } = setup([unauthorized, { sse: [frame(STAGE), frame(RESULT)] }], { randomUUID });
    await service.analyze("auto");
    expect(deps.auth.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(deps.auth.onUnauthorized).toHaveBeenCalledWith(1, TOKEN);
    expect(calls).toEqual([
      { body: expectedBody("auto"), accessToken: TOKEN },
      { body: expectedBody("auto"), accessToken: RENOVADO },
    ]);
    expect(deps.auth.accessToken).toHaveBeenCalledTimes(1);
    expect(events()).toEqual([STAGE, RESULT]);
  });

  test("NAO_AUTENTICADO com outro status não é o 401 da sessão: vai ao painel, sem renovação", async () => {
    const error = apiError("NAO_AUTENTICADO", ID);
    const { service, deps, events, calls } = setup([{ ok: true, stream: false, status: 403, body: JSON.stringify(error) }]);
    await service.analyze("auto");
    expect(deps.auth.onUnauthorized).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(events()).toEqual([{ type: "error", error }]);
  });

  test("cancelada com o 1º envio em voo, que volta 401: nem renovação, nem reenvio", async () => {
    const answer = deferred<AnalyzeResult>();
    const analyze = vi.fn(() => answer.promise);
    const { service, deps, events } = setup([], { api: { analyze } });
    const running = service.analyze("auto");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    service.cancel();
    answer.resolve(unauthorized);
    await running;
    expect(deps.auth.onUnauthorized).not.toHaveBeenCalled();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(events()).toEqual([]);
  });

  test("o 401 com ApiError sem requestId também é o da sessão", async () => {
    const semId: AnalyzeResult = { ok: true, stream: false, status: 401, body: JSON.stringify(apiError("NAO_AUTENTICADO", null)) };
    const { service, deps } = setup([semId, { sse: [frame(RESULT)] }]);
    await service.analyze("auto");
    expect(deps.auth.onUnauthorized).toHaveBeenCalledWith(1, TOKEN);
  });

  test("sem token novo: NAO_AUTENTICADO, sem reenvio", async () => {
    const onUnauthorized = vi.fn(async () => undefined);
    const { service, calls, events, logs } = setup([unauthorized], { auth: { accessToken: vi.fn(async () => TOKEN), onUnauthorized } });
    await service.analyze("auto");
    expect(calls).toHaveLength(1);
    expect(events()).toEqual([local("NAO_AUTENTICADO", ID)]);
    expect(logs).toEqual(["analise_recusada"]);
  });

  test("2º 401: onUnauthorized(2) com o token do reenvio, NAO_AUTENTICADO e nunca um 3º envio", async () => {
    const { service, calls, deps, events, logs } = setup([unauthorized, unauthorized, { sse: [frame(RESULT)] }]);
    await service.analyze("auto");
    expect(calls).toHaveLength(2);
    expect(vi.mocked(deps.auth.onUnauthorized).mock.calls).toEqual([
      [1, TOKEN],
      [2, RENOVADO],
    ]);
    expect(events()).toEqual([local("NAO_AUTENTICADO", ID)]);
    expect(logs).toEqual(["analise_recusada"]);
  });

  test("o reenvio confere o consentimento de novo: retirado, nada sai", async () => {
    const isGranted = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    const { service, calls, events, logs } = setup([unauthorized, { sse: [frame(RESULT)] }], { consent: { isGranted } });
    await service.analyze("auto");
    expect(calls).toHaveLength(1);
    expect(events()).toEqual([local("ERRO_INTERNO", ID)]);
    expect(logs).toEqual(["analise_sem_consentimento"]);
  });

  test("captura que muda durante a renovação: sem reenvio e sem nada no painel", async () => {
    const renewal = deferred<string | undefined>();
    const onUnauthorized = vi.fn(() => renewal.promise);
    const { service, calls, events } = setup([unauthorized, { sse: [frame(RESULT)] }], { auth: { accessToken: vi.fn(async () => TOKEN), onUnauthorized } });
    const running = service.analyze("auto");
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
    service.cancel();
    renewal.resolve(RENOVADO);
    await running;
    expect(calls).toHaveLength(1);
    expect(events()).toEqual([]);
  });
});

describe("cancelamento e concorrência (D10)", () => {
  test("um analisar com outro em curso é ignorado", async () => {
    const gate = deferred<void>();
    const analyze = vi.fn(async (_call: AnalyzeCall, onText: (t: string) => StreamControl): Promise<AnalyzeResult> => {
      await gate.promise;
      onText(frame(RESULT));
      return { ok: true, stream: true, fim: "completo" };
    });
    const { service, logs, events } = setup([], { api: { analyze } });
    const first = service.analyze("auto");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    await service.analyze("aprofundada");
    expect(logs).toEqual(["analise_em_curso"]);
    gate.resolve();
    await first;
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(events()).toEqual([RESULT]);
  });

  test("cancelada no meio do stream: nada mais chega ao painel, o fetch é parado, e uma nova análise já pode começar", async () => {
    const gates = [deferred<void>(), deferred<void>()];
    const controls: StreamControl[] = [];
    let n = 0;
    const analyze = vi.fn(async (_call: AnalyzeCall, onText: (t: string) => StreamControl): Promise<AnalyzeResult> => {
      const mine = n;
      n += 1;
      controls.push(onText(frame(STAGE)));
      await gates[mine]?.promise;
      const control = onText(frame(RESULT));
      controls.push(control);
      return { ok: true, stream: true, fim: control === "parar" ? "parado" : "completo" };
    });
    const { service, events, logs } = setup([], { api: { analyze } });
    const first = service.analyze("auto");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    service.cancel();
    const second = service.analyze("aprofundada");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
    gates[0]?.resolve();
    await first;
    // A antiga terminou, mas a nova segue em curso: um 3º pedido é ignorado.
    await service.analyze("auto");
    expect(logs).toEqual(["analise_em_curso"]);
    gates[1]?.resolve();
    await second;
    expect(controls).toEqual(["seguir", "seguir", "parar", "seguir"]);
    expect(events()).toEqual([STAGE, STAGE, RESULT]);
  });

  test("cancelada durante a leitura da vaga (que some): nada no painel, e a próxima análise roda", async () => {
    const vaga = deferred<CapturedJob | undefined>();
    const job = vi.fn().mockReturnValueOnce(vaga.promise).mockResolvedValue(JOB);
    const { service, events, logs } = setup([{ sse: [frame(RESULT)] }], { job });
    const running = service.analyze("auto");
    await vi.waitFor(() => expect(job).toHaveBeenCalled());
    service.cancel();
    vaga.resolve(undefined);
    await running;
    expect(events()).toEqual([]);
    expect(logs).toEqual([]);
    await service.analyze("auto");
    expect(events()).toEqual([RESULT]);
  });

  test("cancelada durante o accessToken: nada sai", async () => {
    const token = deferred<string | undefined>();
    const { service, analyze, events } = setup([], { auth: { accessToken: vi.fn(() => token.promise), onUnauthorized: vi.fn() } });
    const running = service.analyze("auto");
    await vi.waitFor(() => expect(token).toBeDefined());
    await Promise.resolve();
    service.cancel();
    token.resolve(TOKEN);
    await running;
    expect(analyze).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
  });

  test("cancelada depois do envio, antes do status: nada no painel", async () => {
    const answer = deferred<AnalyzeResult>();
    const { service, events } = setup([], { api: { analyze: vi.fn(() => answer.promise) } });
    const running = service.analyze("auto");
    await vi.waitFor(() => expect(events).toBeDefined());
    await Promise.resolve();
    await Promise.resolve();
    service.cancel();
    answer.resolve({ ok: false, reason: "sem_resposta" });
    await running;
    expect(events()).toEqual([]);
  });

  test("cancelar sem análise em curso não faz nada", async () => {
    const { service, events } = setup();
    service.cancel();
    await service.analyze("auto");
    expect(events()).toEqual([STAGE, RESULT]);
  });

  test("dependência que lança: ERRO_INTERNO, nunca rejeita, e a próxima análise roda", async () => {
    const isGranted = vi.fn().mockRejectedValueOnce(new Error("storage")).mockResolvedValue(true);
    const { service, events, logs } = setup([{ sse: [frame(RESULT)] }], { consent: { isGranted } });
    await expect(service.analyze("auto")).resolves.toBeUndefined();
    await service.analyze("auto");
    expect(events()).toEqual([local("ERRO_INTERNO", null), RESULT]);
    expect(logs).toEqual(["analise_falha_interna"]);
  });
});

describe("cancelamento imediato (ADR-025 §6.3 D16)", () => {
  const unauthorized: AnalyzeResult = { ok: true, stream: false, status: 401, body: JSON.stringify(apiError("NAO_AUTENTICADO", ID)) };

  /** Uma API que fica em silêncio até o abort de quem chama, como o `api-client` de verdade. */
  function silentApi() {
    const signals: AbortSignal[] = [];
    const analyze = vi.fn(
      (_call: AnalyzeCall, _onText: (t: string) => StreamControl, signal?: AbortSignal): Promise<AnalyzeResult> =>
        new Promise((resolve) => {
          if (signal === undefined) return;
          signals.push(signal);
          signal.addEventListener("abort", () => resolve({ ok: false, reason: "cancelado" }));
        }),
    );
    return { analyze, signals };
  }

  test("o envio leva um sinal vivo, e o cancel o aborta na hora, sem esperar o próximo pedaço", async () => {
    const { analyze, signals } = silentApi();
    const { service, events, logs } = setup([], { api: { analyze } });
    const running = service.analyze("auto");
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);
    service.cancel();
    expect(signals[0]?.aborted).toBe(true);
    await running;
    expect(events()).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("cada análise tem o seu sinal: a nova não nasce abortada, e o cancel de antes não a atinge", async () => {
    const { analyze, signals } = silentApi();
    const { service } = setup([], { api: { analyze } });
    const first = service.analyze("auto");
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    service.cancel();
    await first;
    const second = service.analyze("aprofundada");
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1]?.aborted).toBe(false);
    service.cancel();
    expect(signals[1]?.aborted).toBe(true);
    await second;
  });

  test("o reenvio do 401 leva o mesmo sinal do envio", async () => {
    const { service, signals } = setup([unauthorized, { sse: [frame(RESULT)] }]);
    await service.analyze("auto");
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(signals[0]);
    expect(signals[0]?.aborted).toBe(false);
  });

  test("cancelada com o reenvio em voo: o mesmo sinal cai, e nada chega ao painel", async () => {
    const silent = silentApi();
    const analyze = vi.fn().mockResolvedValueOnce(unauthorized).mockImplementation(silent.analyze);
    const { service, events } = setup([], { api: { analyze } });
    const running = service.analyze("auto");
    await vi.waitFor(() => expect(silent.signals).toHaveLength(1));
    service.cancel();
    expect(silent.signals[0]?.aborted).toBe(true);
    await running;
    expect(events()).toEqual([]);
  });

  test("cancelar duas vezes, ou depois do fim, não lança nem muda a análise seguinte", async () => {
    const { service, events } = setup([{ sse: [frame(RESULT)] }, { sse: [frame(STAGE), frame(RESULT)] }]);
    await service.analyze("auto");
    service.cancel();
    service.cancel();
    await service.analyze("auto");
    expect(events()).toEqual([RESULT, STAGE, RESULT]);
  });
});

describe("repasse ao painel (D10 e D11)", () => {
  test("o attach só registra a porta: nada sai no handshake", () => {
    const { panel } = setup();
    expect(panel.received).toEqual([]);
  });

  test("todas as portas recebem; a que caiu sai", async () => {
    const { service, panel } = setup([{ sse: [frame(RESULT)] }, { sse: [frame(RESULT)] }]);
    const other = fakePort();
    service.attach(other.port);
    await service.analyze("auto");
    other.drop();
    await service.analyze("auto");
    expect(panel.events()).toEqual([RESULT, RESULT]);
    expect(other.events()).toEqual([RESULT]);
  });

  test("os textos do SW passam no contrato, não são o message do servidor e não têm link", () => {
    for (const [code, message] of Object.entries(LOCAL_ERROR_MESSAGES)) {
      expect(ApiErrorSchema.safeParse({ code, message, requestId: null, retryAfterSeconds: null }).success).toBe(true);
      expect(AnalysisStreamEventSchema.safeParse(local(code as keyof typeof LOCAL_ERROR_MESSAGES, ID)).success).toBe(true);
      expect(message).not.toMatch(/https?:|www\.|[<>]/);
    }
    expect(Object.keys(LOCAL_ERROR_MESSAGES).sort()).toEqual(["ERRO_INTERNO", "LIMITE_DE_TAXA", "NAO_AUTENTICADO", "SERVICO_INDISPONIVEL"]);
  });

  test("o log leva só motivos da lista fechada, nunca token, texto ou requestId", async () => {
    const { service, logs } = setup([{ ok: true, stream: false, status: 500, body: TEXTO }]);
    await service.analyze("auto");
    for (const motivo of logs) expect(ANALYSIS_LOG_REASONS).toContain(motivo);
    expect(JSON.stringify(logs)).not.toMatch(/CANARIO|tok\.|6f1c2a52/);
    expect(ANALYSIS_LOG_REASONS).toEqual([
      "analise_sem_api",
      "analise_sem_consentimento",
      "analise_sem_vaga",
      "analise_sem_token",
      "analise_em_curso",
      "analise_recusada",
      "analise_indisponivel",
      "analise_violacao",
      "analise_erro_servidor",
      "analise_falha_interna",
    ]);
  });
});
