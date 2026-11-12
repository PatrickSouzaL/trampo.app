// F1-EXT-04 parte 2, 04b-2 (ADR-025 §6.4 D18 a D21): a lógica pura do envio no painel. O `ready.envio` é a fonte do
// portão da API; o `analysisControl` decide o que a área da análise oferece, e o redutor só aceita o clique que ela
// oferece; o "enviando" liga no clique aceito, desliga no terminal, na captura, na retirada do consentimento, na sessão
// que sai, na queda e no teto de 55 s. Os botões e o React são do E2E do painel.
import { ApiErrorSchema } from "@trampo/contracts/api";
import { containsUrlLike } from "@trampo/contracts/primitives";
import { describe, expect, test } from "vitest";

import { ANALYZE_STREAM_POLICY } from "../src/api/api-client";
import { AnalysisModeSchema, type AnalysisMode, type CaptureView, type SessaoView, type WorkerToPanel } from "../src/messaging/protocol";
import {
  ENTRANDO_TETO_MS,
  ENTRANDO_TIQUE_MS,
  ENVIANDO_TETO_MS,
  INITIAL_PANEL_STATE,
  SENDING_TIMEOUT_ERROR,
  analysisControl,
  parseWorkerMessage,
  reducePanel,
  type PanelAction,
  type PanelState,
} from "../src/panel/panel-state";
import { ANALYZE_LABELS, ERROR_TEXTS, SENDING_TEXT } from "../src/panel/texts";
import { REPORT, apiError, result, stage } from "./fixtures/stream";

const msg = (raw: unknown): PanelAction => {
  const message = parseWorkerMessage(raw);
  if (message === null) throw new Error(`fixture fora do contrato: ${JSON.stringify(raw)}`);
  return { type: "mensagem", message };
};
const run = (start: PanelState, ...actions: PanelAction[]): PanelState => actions.reduce(reducePanel, start);
const ready = (envio: boolean) => msg({ kind: "ready", protocolVersion: 1, envio } satisfies WorkerToPanel);
const captura = (c: CaptureView) => msg({ kind: "captura", captura: c } satisfies WorkerToPanel);
const consentimento = (dado: boolean) => msg({ kind: "consentimento", dado } satisfies WorkerToPanel);
const sessao = (view: SessaoView) => msg({ kind: "sessao", sessao: view } satisfies WorkerToPanel);
const analisar = (mode: AnalysisMode, agora = 1_000): PanelAction => ({ type: "analisar", mode, agora });
const tique = (agora: number): PanelAction => ({ type: "tique", agora });

const PRONTO: CaptureView = { estado: "pronto", origem: "pagina", caracteres: 900, truncado: false };
const DENTRO: SessaoView = { autenticado: true, erro: null };
const FORA: SessaoView = { autenticado: false, erro: null };

/** Tudo o que o botão exige: API, vaga pronta, consentimento e sessão. */
const livre = run(INITIAL_PANEL_STATE, ready(true), captura(PRONTO), consentimento(true), sessao(DENTRO));
const enviando = reducePanel(livre, analisar("auto", 1_000));

describe("ready.envio (D18)", () => {
  test("o ready é estrito: sem o campo, com outro tipo ou com chave extra é recusado", () => {
    expect(parseWorkerMessage({ kind: "ready", protocolVersion: 1, envio: true })).toStrictEqual({ kind: "ready", protocolVersion: 1, envio: true });
    expect(parseWorkerMessage({ kind: "ready", protocolVersion: 1, envio: false })).toStrictEqual({ kind: "ready", protocolVersion: 1, envio: false });
    for (const bad of [
      { kind: "ready", protocolVersion: 1 },
      { kind: "ready", protocolVersion: 1, envio: "true" },
      { kind: "ready", protocolVersion: 1, envio: 1 },
      { kind: "ready", protocolVersion: 1, envio: null },
      { kind: "ready", protocolVersion: 1, envio: true, origem: "https://api.trampo.test" },
      { kind: "ready", protocolVersion: 2, envio: true },
    ]) {
      expect(parseWorkerMessage(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("o estado começa sem API, o ready a preenche, e o Reconectar a zera", () => {
    expect(INITIAL_PANEL_STATE.api).toBe(false);
    expect(reducePanel(INITIAL_PANEL_STATE, ready(true))).toStrictEqual({ ...INITIAL_PANEL_STATE, conexao: "pronto", api: true });
    expect(reducePanel(INITIAL_PANEL_STATE, ready(false))).toStrictEqual({ ...INITIAL_PANEL_STATE, conexao: "pronto", api: false });
    const novo = run(livre, { type: "desconectou" }, { type: "reconectar" });
    expect(novo).toStrictEqual({ ...INITIAL_PANEL_STATE, geracao: 1 });
    expect(novo.api).toBe(false);
  });
});

describe("analysisControl (D19): o que a área da análise oferece", () => {
  test("com tudo pronto: Analisar vaga, modo auto, sem bloqueio", () => {
    expect(analysisControl(livre)).toStrictEqual({ mode: "auto", bloqueio: null });
  });

  test("com um relatório na tela: Reanalisar com IA, modo aprofundada", () => {
    expect(analysisControl(reducePanel(livre, msg(result(REPORT))))).toStrictEqual({ mode: "aprofundada", bloqueio: null });
  });

  test("depois de um erro: Analisar vaga de novo, modo auto", () => {
    expect(analysisControl(reducePanel(livre, msg(apiError("SERVICO_INDISPONIVEL"))))).toStrictEqual({ mode: "auto", bloqueio: null });
  });

  test("o bloqueio é o do portão: sem API e sem sessão, o botão existe, mas bloqueado", () => {
    expect(analysisControl(run(INITIAL_PANEL_STATE, ready(false), captura(PRONTO), consentimento(true), sessao(DENTRO)))).toStrictEqual({ mode: "auto", bloqueio: "sem_api" });
    expect(analysisControl(reducePanel(livre, sessao(FORA)))).toStrictEqual({ mode: "auto", bloqueio: "sem_sessao" });
    expect(analysisControl(run(INITIAL_PANEL_STATE, ready(true), captura(PRONTO), consentimento(true)))).toStrictEqual({ mode: "auto", bloqueio: "sem_sessao" });
  });

  test("sem consentimento: o aviso, também ao lado do relatório e do erro", () => {
    const sem = reducePanel(livre, consentimento(false));
    expect(analysisControl(sem)).toBe("aviso");
    expect(analysisControl(run(livre, msg(result(REPORT)), consentimento(false)))).toBe("aviso");
    expect(analysisControl(run(livre, msg(apiError("ERRO_INTERNO")), consentimento(false)))).toBe("aviso");
  });

  test.each([
    ["sem conexão pronta", reducePanel(livre, { type: "desconectou" })],
    ["conectando", { ...livre, conexao: "conectando" } satisfies PanelState],
    ["captura ociosa", reducePanel(livre, captura({ estado: "ocioso" }))],
    ["captura lendo", reducePanel(livre, captura({ estado: "lendo" }))],
    ["captura que falhou", reducePanel(livre, captura({ estado: "falhou", motivo: "erro" }))],
    ["consentimento ainda desconhecido", run(INITIAL_PANEL_STATE, ready(true), captura(PRONTO), sessao(DENTRO))],
    ["envio em curso", enviando],
    ["análise em andamento vinda de outro painel", reducePanel(livre, msg(stage("recebido", 0)))],
  ])("nada: %s", (_nome, state) => {
    expect(analysisControl(state)).toBeNull();
  });

  test("um rótulo por modo do contrato, e nenhum parece link", () => {
    expect(Object.keys(ANALYZE_LABELS).sort()).toStrictEqual([...AnalysisModeSchema.options].sort());
    expect(ANALYZE_LABELS).toStrictEqual({ auto: "Analisar vaga", aprofundada: "Reanalisar com IA" });
  });
});

describe("clique em Analisar (D19 e D20)", () => {
  test("o clique aceito liga o enviando com a hora do relógio injetado e não muda mais nada", () => {
    expect(enviando).toStrictEqual({ ...livre, enviandoDesde: 1_000 });
    expect(analysisControl(enviando)).toBeNull();
  });

  test("o Reanalisar aceito tira o relatório da tela; o clique depois do erro tira o erro", () => {
    const comRelatorio = reducePanel(livre, msg(result(REPORT)));
    expect(reducePanel(comRelatorio, analisar("aprofundada", 7))).toStrictEqual({ ...livre, enviandoDesde: 7 });
    const comErro = reducePanel(livre, msg(apiError("LIMITE_DE_TAXA", 30)));
    expect(reducePanel(comErro, analisar("auto", 8))).toStrictEqual({ ...livre, enviandoDesde: 8 });
  });

  test("o modo que a tela não oferece é ignorado", () => {
    expect(reducePanel(livre, analisar("aprofundada"))).toBe(livre);
    const comRelatorio = reducePanel(livre, msg(result(REPORT)));
    expect(reducePanel(comRelatorio, analisar("auto"))).toBe(comRelatorio);
  });

  test("um 2º clique com o envio em curso é ignorado e não reinicia o teto", () => {
    expect(reducePanel(enviando, analisar("auto", 9_000))).toBe(enviando);
    expect(reducePanel(enviando, analisar("aprofundada", 9_000))).toBe(enviando);
  });

  test.each([
    ["sem API", run(INITIAL_PANEL_STATE, ready(false), captura(PRONTO), consentimento(true), sessao(DENTRO))],
    ["sem sessão", reducePanel(livre, sessao(FORA))],
    ["sem consentimento", reducePanel(livre, consentimento(false))],
    ["consentimento desconhecido", run(INITIAL_PANEL_STATE, ready(true), captura(PRONTO), sessao(DENTRO))],
    ["sem vaga pronta", reducePanel(livre, captura({ estado: "lendo" }))],
    ["análise em andamento", reducePanel(livre, msg(stage("recebido", 0)))],
    ["depois da queda", reducePanel(livre, { type: "desconectou" })],
    ["antes do handshake", INITIAL_PANEL_STATE],
  ])("o clique que a tela não oferece é ignorado: %s", (_nome, state) => {
    for (const mode of AnalysisModeSchema.options) expect(reducePanel(state, analisar(mode))).toBe(state);
  });
});

describe("enviando (D20): quando desliga", () => {
  test("um stage não desliga: troca o texto pelo progresso", () => {
    const s = reducePanel(enviando, msg(stage("normalizando", 120)));
    expect(s).toStrictEqual({ ...enviando, analise: { estado: "andamento", etapa: "normalizando", elapsedMs: 120 } });
    expect(s.enviandoDesde).toBe(1_000);
    expect(analysisControl(s)).toBeNull();
  });

  test("o resultado desliga e devolve o Reanalisar", () => {
    const s = run(enviando, msg(stage("pontuando", 900)), msg(result(REPORT)));
    expect(s).toStrictEqual({ ...livre, analise: { estado: "concluida", report: REPORT } });
    expect(analysisControl(s)).toStrictEqual({ mode: "aprofundada", bloqueio: null });
  });

  test("o erro desliga e devolve o Analisar", () => {
    const s = reducePanel(enviando, msg(apiError("COTA_DIARIA_ESGOTADA")));
    expect(s.enviandoDesde).toBeNull();
    expect(s.analise).toMatchObject({ estado: "erro", error: { code: "COTA_DIARIA_ESGOTADA" } });
    expect(analysisControl(s)).toStrictEqual({ mode: "auto", bloqueio: null });
  });

  test("uma captura (a nova, ou o fim dela) desliga e limpa a análise", () => {
    for (const c of [{ estado: "lendo" }, PRONTO, { estado: "ocioso" }] as CaptureView[]) {
      const s = run(enviando, msg(stage("recebido", 0)), captura(c));
      expect(s, JSON.stringify(c)).toStrictEqual({ ...livre, captura: c });
    }
  });

  test("a retirada do consentimento desliga e tira o andamento da tela; o relatório concluído fica (D17)", () => {
    expect(run(enviando, msg(stage("recebido", 0)), consentimento(false))).toStrictEqual({ ...livre, consentimento: false });
    expect(reducePanel(enviando, consentimento(false))).toStrictEqual({ ...livre, consentimento: false });
    const comRelatorio = reducePanel(livre, msg(result(REPORT)));
    expect(reducePanel(comRelatorio, consentimento(false))).toStrictEqual({ ...comRelatorio, consentimento: false });
    const comErro = reducePanel(livre, msg(apiError("ERRO_INTERNO")));
    expect(reducePanel(comErro, consentimento(false))).toStrictEqual({ ...comErro, consentimento: false });
  });

  test("o consentimento confirmado de novo não mexe no envio em curso nem na análise", () => {
    expect(reducePanel(enviando, consentimento(true))).toStrictEqual(enviando);
    const andamento = reducePanel(enviando, msg(stage("recebido", 0)));
    expect(reducePanel(andamento, consentimento(true))).toStrictEqual(andamento);
  });

  test("a sessão que sai desliga, sem apagar o andamento; a sessão que segue aberta, não", () => {
    const andamento = reducePanel(enviando, msg(stage("recebido", 0)));
    expect(reducePanel(andamento, sessao(FORA))).toStrictEqual({ ...andamento, sessao: FORA, enviandoDesde: null });
    const transitorio: SessaoView = { autenticado: true, erro: "SERVICO_INDISPONIVEL" };
    expect(reducePanel(enviando, sessao(transitorio))).toStrictEqual({ ...enviando, sessao: transitorio });
    // O terminal da análise pedida antes do "Sair" ainda aparece (D17).
    expect(run(andamento, sessao(FORA), msg(result(REPORT))).analise).toStrictEqual({ estado: "concluida", report: REPORT });
  });

  test("um ready sem envio desliga; com envio, não", () => {
    expect(reducePanel(enviando, ready(false))).toStrictEqual({ ...enviando, api: false, enviandoDesde: null });
    expect(reducePanel(enviando, ready(true))).toStrictEqual(enviando);
  });

  test("as duas quedas desligam", () => {
    expect(reducePanel(enviando, { type: "desconectou" })).toStrictEqual({ ...livre, conexao: "desconectado", queda: "porta_fechada" });
    expect(reducePanel(enviando, { type: "recusada" })).toStrictEqual({ ...livre, conexao: "desconectado", queda: "resposta_invalida" });
  });

  test("o Reconectar depois da queda volta ao estado inicial, sem envio", () => {
    expect(run(enviando, { type: "desconectou" }, { type: "reconectar" }).enviandoDesde).toBeNull();
  });
});

describe("teto do enviando (D20)", () => {
  test("o teto é o prazo total do stream no SW mais 10 s, e o tique de 1 s cabe na folga", () => {
    expect(ENVIANDO_TETO_MS).toBe(55_000);
    expect(ENVIANDO_TETO_MS).toBe(ANALYZE_STREAM_POLICY.totalMs + 10_000);
    expect(ENTRANDO_TIQUE_MS).toBeLessThan(ENVIANDO_TETO_MS - ANALYZE_STREAM_POLICY.totalMs);
  });

  test("o tique desliga no teto, e não antes; o botão volta com o erro SERVICO_INDISPONIVEL do catálogo", () => {
    expect(reducePanel(enviando, tique(1_000))).toBe(enviando);
    expect(reducePanel(enviando, tique(1_000 + ENVIANDO_TETO_MS - 1))).toBe(enviando);
    const vencido = reducePanel(enviando, tique(1_000 + ENVIANDO_TETO_MS));
    expect(vencido).toStrictEqual({ ...livre, analise: { estado: "erro", error: SENDING_TIMEOUT_ERROR } });
    expect(analysisControl(vencido)).toStrictEqual({ mode: "auto", bloqueio: null });
  });

  test("o teto vale também com o progresso na tela (stages e depois silêncio)", () => {
    const andamento = reducePanel(enviando, msg(stage("extraindo_fatos", 2_000)));
    expect(reducePanel(andamento, tique(1_000 + ENVIANDO_TETO_MS))).toStrictEqual({ ...livre, analise: { estado: "erro", error: SENDING_TIMEOUT_ERROR } });
  });

  test("relógio que volta desliga (falha segura: o SW ignora o analisar com outro em curso)", () => {
    expect(reducePanel(enviando, tique(999)).enviandoDesde).toBeNull();
    expect(reducePanel(enviando, tique(Number.NaN)).enviandoDesde).toBeNull();
  });

  test("o erro local do teto é do contrato, sem pedido, e a tela mostra só o catálogo pelo código", () => {
    expect(ApiErrorSchema.safeParse(SENDING_TIMEOUT_ERROR).success).toBe(true);
    expect(SENDING_TIMEOUT_ERROR).toMatchObject({ code: "SERVICO_INDISPONIVEL", requestId: null, retryAfterSeconds: null });
    expect(Object.isFrozen(SENDING_TIMEOUT_ERROR)).toBe(true);
    expect(ERROR_TEXTS[SENDING_TIMEOUT_ERROR.code].titulo).not.toBe(SENDING_TIMEOUT_ERROR.message);
  });

  test("o terminal que chega depois do teto ainda vale e troca o erro local", () => {
    const vencido = reducePanel(enviando, tique(1_000 + ENVIANDO_TETO_MS));
    expect(reducePanel(vencido, msg(result(REPORT))).analise).toStrictEqual({ estado: "concluida", report: REPORT });
  });

  test("o tique sem envio não mexe na análise, e os dois tetos são independentes", () => {
    const comRelatorio = reducePanel(livre, msg(result(REPORT)));
    expect(reducePanel(comRelatorio, tique(10 * ENVIANDO_TETO_MS))).toBe(comRelatorio);
    // Entrando (sem sessão) e enviando nunca valem juntos pelo portão; o tique confere cada teto com o seu relógio.
    const entrando = run(INITIAL_PANEL_STATE, ready(true), captura(PRONTO), consentimento(true), sessao(FORA), { type: "entrar", agora: 1_000 });
    expect(reducePanel(entrando, tique(1_000 + ENVIANDO_TETO_MS))).toBe(entrando);
    expect(reducePanel(entrando, tique(1_000 + ENTRANDO_TETO_MS)).entrandoDesde).toBeNull();
    expect(reducePanel(enviando, tique(1_000 + ENVIANDO_TETO_MS)).entrandoDesde).toBeNull();
  });
});

describe("textos do envio (D21)", () => {
  test("o enviando antes do 1º stage, e nenhum texto novo parece link nem tem < ou >", () => {
    expect(SENDING_TEXT).toBe("Enviando a vaga ao Trampo…");
    for (const text of [SENDING_TEXT, ...Object.values(ANALYZE_LABELS), SENDING_TIMEOUT_ERROR.message]) {
      expect(containsUrlLike(text), text).toBe(false);
      expect(text, text).not.toMatch(/[<>]/);
      expect(text, text).not.toMatch(/github|google|@/i);
    }
  });
});
