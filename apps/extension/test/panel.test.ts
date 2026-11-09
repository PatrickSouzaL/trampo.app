// F1-EXT-04 parte 1 (ADR-025 D3 e D4): o estado do painel muda só com mensagens do contrato, a queda é
// definitiva, e cada enum do contrato tem texto. O React em si é provado no E2E de produção. F1-EXT-05b, 05b-1
// (ADR-004 D12): a SessaoView chega no fim do handshake e a cada mudança.
import { AnalysisReportSchema, AnalysisWarningSchema, DecisionPathSchema, DimensionOutcomeSchema, ScoreDimensionSchema, VerdictSchema } from "@trampo/contracts/analysis-report";
import { AnalysisStageSchema, ApiErrorCodeSchema } from "@trampo/contracts/api";
import { containsUrlLike } from "@trampo/contracts/primitives";
import { describe, expect, test } from "vitest";

import type { CaptureView, SessaoView, WorkerToPanel } from "../src/messaging/protocol";
import { INITIAL_PANEL_STATE, parseWorkerMessage, reducePanel, type PanelAction, type PanelState } from "../src/panel/panel-state";
import {
  DECISION_PATH_LABELS,
  DIMENSION_LABELS,
  ERROR_TEXTS,
  OUTCOME_LABELS,
  SESSION_ACTION_LABELS,
  STAGE_LABELS,
  STAGE_ORDER,
  VERDICT_LABELS,
  WARNING_LABELS,
  describeCapture,
  describeConnection,
  describeStage,
  formatPoints,
  formatRetry,
  formatSeconds,
} from "../src/panel/texts";
import { HOSTILE_REPORTS, REPORT, apiError, result, stage } from "./fixtures/stream";

const msg = (raw: unknown): PanelAction => {
  const message = parseWorkerMessage(raw);
  if (message === null) throw new Error(`fixture fora do contrato: ${JSON.stringify(raw)}`);
  return { type: "mensagem", message };
};
const run = (...actions: PanelAction[]): PanelState => actions.reduce(reducePanel, INITIAL_PANEL_STATE);
const ready = msg({ kind: "ready", protocolVersion: 1 });
const captura = (c: CaptureView) => msg({ kind: "captura", captura: c } satisfies WorkerToPanel);
const pronto: CaptureView = { estado: "pronto", origem: "pagina", caracteres: 900, truncado: false };
const sessao = (view: SessaoView) => msg({ kind: "sessao", sessao: view } satisfies WorkerToPanel);

describe("fixtures do stream", () => {
  test("o relatório de fixture é válido no contrato, e cada hostil é recusado", () => {
    expect(AnalysisReportSchema.safeParse(REPORT).success).toBe(true);
    for (const [label, report] of HOSTILE_REPORTS) {
      expect(AnalysisReportSchema.safeParse(report).success, label).toBe(false);
      expect(parseWorkerMessage(result(report)), label).toBeNull();
    }
  });
});

describe("reducePanel", () => {
  test("começa conectando, na porta da geração 0, sem captura, sem consentimento nem sessão conhecidos e sem análise", () => {
    expect(INITIAL_PANEL_STATE).toStrictEqual({
      geracao: 0,
      conexao: "conectando",
      queda: null,
      captura: { estado: "ocioso" },
      consentimento: null,
      sessao: null,
      entrandoDesde: null,
      pediuSair: false,
      analise: { estado: "nenhuma" },
    });
  });

  test("handshake [ready, captura, consentimento, sessao]: a sessão vem por último e muda a cada emissão", () => {
    const s = run(ready, captura(pronto), msg({ kind: "consentimento", dado: true }), sessao({ autenticado: false, erro: null }));
    expect(s).toStrictEqual({ ...INITIAL_PANEL_STATE, conexao: "pronto", captura: pronto, consentimento: true, sessao: { autenticado: false, erro: null } });
    const logado = reducePanel(s, sessao({ autenticado: true, erro: null }));
    expect(logado.sessao).toStrictEqual({ autenticado: true, erro: null });
    expect(reducePanel(logado, sessao({ autenticado: true, erro: "SERVICO_INDISPONIVEL" })).sessao).toStrictEqual({ autenticado: true, erro: "SERVICO_INDISPONIVEL" });
  });

  test("a sessão não mexe na captura, no consentimento nem na análise mostrada", () => {
    const antes = run(ready, captura(pronto), msg({ kind: "consentimento", dado: true }), msg(result(REPORT)));
    const depois = reducePanel(antes, sessao({ autenticado: false, erro: "NAO_AUTENTICADO" }));
    expect(depois).toStrictEqual({ ...antes, sessao: { autenticado: false, erro: "NAO_AUTENTICADO" } });
  });

  test("ready conecta; captura e consentimento vêm do Service Worker", () => {
    const s = run(ready, captura(pronto), msg({ kind: "consentimento", dado: false }));
    expect(s).toEqual({ ...INITIAL_PANEL_STATE, conexao: "pronto", captura: pronto, consentimento: false });
    expect(reducePanel(s, msg({ kind: "consentimento", dado: true })).consentimento).toBe(true);
  });

  test("estágios, resultado e erro do stream viram a análise mostrada", () => {
    const andamento = run(ready, captura(pronto), msg(stage("extraindo_fatos", 1200)));
    expect(andamento.analise).toEqual({ estado: "andamento", etapa: "extraindo_fatos", elapsedMs: 1200 });
    const concluida = reducePanel(andamento, msg(result(REPORT)));
    expect(concluida.analise).toEqual({ estado: "concluida", report: REPORT });
    const erro = reducePanel(concluida, msg(apiError("LIMITE_DE_TAXA", 30)));
    expect(erro.analise).toMatchObject({ estado: "erro", error: { code: "LIMITE_DE_TAXA", retryAfterSeconds: 30 } });
  });

  test("captura nova tira da tela a análise da vaga anterior", () => {
    const s = run(ready, captura(pronto), msg(result(REPORT)), captura({ estado: "lendo" }));
    expect(s.analise).toEqual({ estado: "nenhuma" });
    expect(s.captura).toEqual({ estado: "lendo" });
  });

  test("mensagem recusada derruba a conexão por resposta inválida e apaga a análise", () => {
    const s = run(ready, captura(pronto), msg(result(REPORT)), { type: "recusada" });
    expect(s).toMatchObject({ conexao: "desconectado", queda: "resposta_invalida", analise: { estado: "nenhuma" }, captura: pronto });
  });

  test("porta fechada derruba a conexão e mantém o que já estava na tela", () => {
    const s = run(ready, msg(result(REPORT)), { type: "desconectou" });
    expect(s).toMatchObject({ conexao: "desconectado", queda: "porta_fechada", analise: { estado: "concluida" } });
  });

  test("depois da queda nada mais muda a tela, nem a queda seguinte", () => {
    const caida = run(ready, { type: "recusada" });
    for (const action of [ready, msg(result(REPORT)), captura(pronto), sessao({ autenticado: true, erro: null }), { type: "desconectou" } as const]) {
      expect(reducePanel(caida, action)).toBe(caida);
    }
  });
});

describe("parseWorkerMessage", () => {
  test("devolve a mensagem do contrato e null para o resto", () => {
    expect(parseWorkerMessage({ kind: "ready", protocolVersion: 1 })).toEqual({ kind: "ready", protocolVersion: 1 });
    expect(parseWorkerMessage({ kind: "stream", event: { type: "stage", stage: "pontuando", elapsedMs: -1 } })).toBeNull();
    expect(parseWorkerMessage({ kind: "captura", captura: { estado: "pronto", origem: "pagina", caracteres: 1, truncado: false, texto: "vaga" } })).toBeNull();
  });

  test("sessão com token, e-mail ou incoerente é recusada, e o App derruba a porta (D10 B6)", () => {
    expect(parseWorkerMessage({ kind: "sessao", sessao: { autenticado: true, erro: null } })).toStrictEqual({ kind: "sessao", sessao: { autenticado: true, erro: null } });
    expect(parseWorkerMessage({ kind: "sessao", sessao: { autenticado: true, erro: null, token: "CANARIO" } })).toBeNull();
    expect(parseWorkerMessage({ kind: "sessao", sessao: { autenticado: true, erro: null, email: "pessoa@exemplo.com" } })).toBeNull();
    expect(parseWorkerMessage({ kind: "sessao", sessao: { autenticado: true, erro: "NAO_AUTENTICADO" } })).toBeNull();
  });
});

describe("textos do painel", () => {
  test("conexão: um texto por estado e por motivo da queda", () => {
    expect(describeConnection({ conexao: "conectando", queda: null })).toBe("Conectando ao Trampo…");
    expect(describeConnection({ conexao: "pronto", queda: null })).toMatch(/^Pronto\./);
    expect(describeConnection({ conexao: "desconectado", queda: "resposta_invalida" })).toMatch(/paramos por segurança/);
  });

  test("a queda da porta manda clicar no botão Reconectar, pelo rótulo do botão (05b-3); a resposta inválida, não", () => {
    expect(describeConnection({ conexao: "desconectado", queda: "porta_fechada" })).toBe(
      `A conexão com o Trampo caiu. Clique em ${SESSION_ACTION_LABELS.reconectar} para continuar.`,
    );
    expect(describeConnection({ conexao: "desconectado", queda: "resposta_invalida" })).not.toContain(SESSION_ACTION_LABELS.reconectar);
    for (const queda of ["porta_fechada", "resposta_invalida"] as const) {
      const text = describeConnection({ conexao: "desconectado", queda });
      expect(containsUrlLike(text), text).toBe(false);
      expect(text, text).not.toMatch(/[<>]/);
    }
  });

  test("captura: cada estado e cada motivo", () => {
    expect(describeCapture({ estado: "ocioso" })).toBeNull();
    expect(describeCapture({ estado: "lendo" })).toBe("Lendo a vaga…");
    expect(describeCapture(pronto)).toBe("Vaga lida da página: 900 caracteres.");
    expect(describeCapture({ estado: "pronto", origem: "texto_colado", caracteres: 15_000, truncado: true })).toBe("Vaga colada: 15000 caracteres. O texto foi cortado no limite.");
    expect(describeCapture({ estado: "falhou", motivo: "sem_acesso" })).toMatch(/não pode ler esta página/);
    expect(describeCapture({ estado: "falhou", motivo: "texto_insuficiente" })).toMatch(/^Não encontramos/);
    expect(describeCapture({ estado: "falhou", motivo: "erro" })).toMatch(/^Não foi possível ler/);
  });

  test("os catálogos cobrem exatamente cada valor dos enums do contrato", () => {
    const pairs: Array<[readonly string[], object]> = [
      [AnalysisStageSchema.options, STAGE_LABELS],
      [VerdictSchema.options, VERDICT_LABELS],
      [ScoreDimensionSchema.options, DIMENSION_LABELS],
      [DimensionOutcomeSchema.options, OUTCOME_LABELS],
      [AnalysisWarningSchema.options, WARNING_LABELS],
      [DecisionPathSchema.options, DECISION_PATH_LABELS],
      [ApiErrorCodeSchema.options, ERROR_TEXTS],
    ];
    for (const [options, catalog] of pairs) expect(Object.keys(catalog).sort()).toEqual([...options].sort());
    expect([...STAGE_ORDER].sort()).toEqual([...AnalysisStageSchema.options].sort());
  });

  test("nenhum texto do catálogo parece link (a defesa vale também para o que é nosso)", () => {
    const all = [STAGE_LABELS, VERDICT_LABELS, DIMENSION_LABELS, OUTCOME_LABELS, WARNING_LABELS, DECISION_PATH_LABELS].flatMap((c) => Object.values(c) as string[]);
    for (const { titulo, acao } of Object.values(ERROR_TEXTS)) all.push(titulo, acao);
    for (const text of all) {
      expect(containsUrlLike(text), text).toBe(false);
      expect(text, text).not.toMatch(/[<>]/);
    }
  });

  test("estágio: posição no funil, rótulo e tempo", () => {
    expect(describeStage("recebido", 0)).toBe("Etapa 1 de 6: Pedido recebido (0,0 s)");
    expect(describeStage("pontuando", 2450)).toBe("Etapa 6 de 6: Calculando a nota (2,5 s)");
    expect(describeStage("extraindo_fatos", 120_000)).toBe("Etapa 5 de 6: Lendo os fatos da vaga com IA (120,0 s)");
  });

  test("retryAfterSeconds vira um prazo legível, no singular e no plural", () => {
    expect(formatRetry(null)).toBeNull();
    expect(formatRetry(0)).toBe("Tente de novo em 0 segundos.");
    expect(formatRetry(1)).toBe("Tente de novo em 1 segundo.");
    expect(formatRetry(59)).toBe("Tente de novo em 59 segundos.");
    expect(formatRetry(60)).toBe("Tente de novo em 1 minuto.");
    expect(formatRetry(61)).toBe("Tente de novo em 2 minutos.");
    expect(formatRetry(3599)).toBe("Tente de novo em 60 minutos.");
    expect(formatRetry(3600)).toBe("Tente de novo em 1 hora.");
    expect(formatRetry(3601)).toBe("Tente de novo em 2 horas.");
    expect(formatRetry(86_400)).toBe("Tente de novo em 24 horas.");
  });

  test("pontos com sinal", () => {
    expect(formatPoints(30)).toBe("+30");
    expect(formatPoints(1)).toBe("+1");
    expect(formatPoints(0)).toBe("0");
    expect(formatPoints(-7)).toBe("-7");
  });

  test("segundos com vírgula decimal", () => {
    expect(formatSeconds(50)).toBe("0,1 s");
    expect(formatSeconds(1000)).toBe("1,0 s");
  });
});
