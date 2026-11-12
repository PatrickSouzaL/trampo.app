// F1-EXT-05b, 05b-2 (ADR-004 D12 e §4.1; ADR-025 D3): o estado local da sessão no painel, em lógica pura e com
// relógio injetado. O "entrando" liga no clique e desliga na próxima `sessao` ou no teto; o texto da falha remota
// do logout só sai depois do clique em "Sair"; o "Reconectar" só sai da porta fechada; o "Analisar" só abre com
// API, consentimento e sessão. Os botões e o React são do 05b-3.
import { ApiErrorCodeSchema } from "@trampo/contracts/api";
import { containsUrlLike } from "@trampo/contracts/primitives";
import { describe, expect, test } from "vitest";

import { AUTH_SERVICE_POLICY } from "../src/auth/auth-service";
import { AUTH_PROVIDERS, AnalysisModeSchema, SessaoErroSchema, SessaoViewSchema, type SessaoView, type WorkerToPanel } from "../src/messaging/protocol";
import {
  ENTRANDO_TETO_MS,
  ENTRANDO_TIQUE_MS,
  INITIAL_PANEL_STATE,
  analyzeBlock,
  canReconnect,
  logoutUnconfirmed,
  ENVIANDO_TETO_MS,
  analysisControl,
  parseWorkerMessage,
  reducePanel,
  sessionActions,
  type BloqueioAnalise,
  type PanelAction,
  type PanelState,
} from "../src/panel/panel-state";
import {
  ANALYZE_BLOCKED_TEXTS,
  ERROR_TEXTS,
  LOGOUT_UNCONFIRMED_TEXT,
  SESSION_ACTION_LABELS,
  SESSION_TEXTS,
  SIGNING_IN_TEXT,
  SIGN_IN_LABELS,
  describeSession,
  type SessionText,
} from "../src/panel/texts";
import { REPORT, apiError, result, stage } from "./fixtures/stream";

const msg = (raw: WorkerToPanel): PanelAction => {
  const message = parseWorkerMessage(raw);
  if (message === null) throw new Error(`fixture fora do contrato: ${JSON.stringify(raw)}`);
  return { type: "mensagem", message };
};
const run = (start: PanelState, ...actions: PanelAction[]): PanelState => actions.reduce(reducePanel, start);
const sessao = (view: SessaoView) => msg({ kind: "sessao", sessao: view });
const entrar = (agora: number): PanelAction => ({ type: "entrar", agora });
const tique = (agora: number): PanelAction => ({ type: "tique", agora });
const SAIR: PanelAction = { type: "sair" };

const FORA: SessaoView = { autenticado: false, erro: null };
const DENTRO: SessaoView = { autenticado: true, erro: null };
const INDISPONIVEL: SessaoView = { autenticado: false, erro: "SERVICO_INDISPONIVEL" };

/** Handshake completo ([ready, captura, consentimento, sessao]) com a sessão dada. */
const pronto = (view: SessaoView, consentimento = true): PanelState =>
  run(INITIAL_PANEL_STATE, msg({ kind: "ready", protocolVersion: 1, envio: true }), msg({ kind: "captura", captura: { estado: "ocioso" } }), msg({ kind: "consentimento", dado: consentimento }), sessao(view));

/** Todas as SessaoView válidas: o produto de autenticado e erro que passa no schema (M-08). */
const VALID_VIEWS: SessaoView[] = [true, false].flatMap((autenticado) =>
  [null, ...SessaoErroSchema.options].flatMap((erro) => {
    const parsed = SessaoViewSchema.safeParse({ autenticado, erro });
    return parsed.success ? [parsed.data] : [];
  }),
);

describe("estado inicial da sessão", () => {
  test("sem entrando e sem pedido de saída; nada da sessão aparece antes do handshake", () => {
    expect(INITIAL_PANEL_STATE.entrandoDesde).toBeNull();
    expect(INITIAL_PANEL_STATE.pediuSair).toBe(false);
    expect(sessionActions(INITIAL_PANEL_STATE)).toStrictEqual([]);
    expect(describeSession(INITIAL_PANEL_STATE)).toBeNull();
  });

  test("conectado, mas sem a `sessao` do handshake: nenhum botão nem texto (como o consentimento null)", () => {
    const s = run(INITIAL_PANEL_STATE, msg({ kind: "ready", protocolVersion: 1, envio: true }), msg({ kind: "consentimento", dado: true }));
    expect(s.conexao).toBe("pronto");
    expect(sessionActions(s)).toStrictEqual([]);
    expect(describeSession(s)).toBeNull();
    expect(reducePanel(s, entrar(1))).toBe(s);
    expect(reducePanel(s, SAIR)).toBe(s);
  });
});

describe("entrando (ADR-004 D12: liga no clique e desliga na próxima sessao, teto de 310 s)", () => {
  test("o teto é o prazo do login no SW mais 10 s de folga", () => {
    expect(ENTRANDO_TETO_MS).toBe(310_000);
    expect(ENTRANDO_TETO_MS).toBe(AUTH_SERVICE_POLICY.loginDeadlineMs + 10_000);
  });

  test("o tique do App é de 1 s: o teto desliga com no máximo 1 s de atraso, dentro da folga de 10 s", () => {
    expect(ENTRANDO_TIQUE_MS).toBe(1_000);
    expect(ENTRANDO_TIQUE_MS).toBeLessThan(ENTRANDO_TETO_MS - AUTH_SERVICE_POLICY.loginDeadlineMs);
  });

  test("o clique em Entrar liga o entrando com a hora do relógio injetado e esconde os botões", () => {
    const s = reducePanel(pronto(FORA), entrar(5_000));
    expect(s).toStrictEqual({ ...pronto(FORA), entrandoDesde: 5_000 });
    expect(sessionActions(s)).toStrictEqual([]);
    expect(describeSession(s)).toBe(SIGNING_IN_TEXT);
  });

  test("a próxima sessao desliga o entrando, mesmo sem mudança (o SW sempre emite no fim da tentativa)", () => {
    for (const view of VALID_VIEWS) {
      const s = run(pronto(FORA), entrar(5_000), sessao(view));
      expect(s.entrandoDesde, JSON.stringify(view)).toBeNull();
      expect(s.sessao).toStrictEqual(view);
    }
    expect(sessionActions(run(pronto(FORA), entrar(5_000), sessao(FORA)))).toStrictEqual(["entrar"]);
  });

  test("o tique desliga o entrando no teto (310 s) e não antes", () => {
    const s = run(pronto(FORA), entrar(5_000));
    expect(reducePanel(s, tique(5_000))).toBe(s);
    expect(reducePanel(s, tique(5_000 + ENTRANDO_TETO_MS - 1))).toBe(s);
    const vencido = reducePanel(s, tique(5_000 + ENTRANDO_TETO_MS));
    expect(vencido).toStrictEqual({ ...s, entrandoDesde: null });
    expect(sessionActions(vencido)).toStrictEqual(["entrar"]);
    expect(reducePanel(s, tique(5_000 + 10 * ENTRANDO_TETO_MS)).entrandoDesde).toBeNull();
  });

  test("relógio que volta desliga o entrando (falha segura: o SW ignora o clique com fluxo pendente)", () => {
    const s = run(pronto(FORA), entrar(5_000));
    expect(reducePanel(s, tique(4_999)).entrandoDesde).toBeNull();
    expect(reducePanel(s, tique(Number.NaN)).entrandoDesde).toBeNull();
  });

  test("o tique sem entrando não muda nada", () => {
    const s = pronto(FORA);
    expect(reducePanel(s, tique(0))).toBe(s);
    expect(reducePanel(s, tique(5_000 + 10 * ENTRANDO_TETO_MS))).toBe(s);
    expect(reducePanel(s, tique(-1))).toBe(s);
  });

  test("um 2º clique durante o entrando não reinicia o teto", () => {
    const s = run(pronto(FORA), entrar(5_000));
    expect(reducePanel(s, entrar(9_000))).toBe(s);
  });

  test("Entrar só vale com a sessão fora: conectado, conectando ou depois da queda, o clique é ignorado", () => {
    const dentro = pronto(DENTRO);
    expect(sessionActions(dentro)).toStrictEqual(["sair"]);
    expect(reducePanel(dentro, entrar(1))).toBe(dentro);
    expect(reducePanel(INITIAL_PANEL_STATE, entrar(1))).toBe(INITIAL_PANEL_STATE);
    const caido = reducePanel(pronto(FORA), { type: "desconectou" });
    expect(sessionActions(caido)).toStrictEqual([]);
    expect(reducePanel(caido, entrar(1))).toBe(caido);
  });

  test("o entrando liga também depois de um erro (sessão fora com qualquer código)", () => {
    for (const view of VALID_VIEWS.filter((v) => !v.autenticado)) {
      expect(reducePanel(pronto(view), entrar(7)).entrandoDesde, JSON.stringify(view)).toBe(7);
    }
  });
});

describe("último clique em Sair (ADR-004 D11.5 e D12)", () => {
  test("Sair liga o pedido; o logout local e a falha remota depois dele mostram o texto e o Tentar sair de novo", () => {
    const pediu = reducePanel(pronto(DENTRO), SAIR);
    expect(pediu).toStrictEqual({ ...pronto(DENTRO), pediuSair: true });
    const local = reducePanel(pediu, sessao(FORA));
    expect(logoutUnconfirmed(local)).toBe(false);
    expect(describeSession(local)).toBe(SESSION_TEXTS.desconectado.nenhum);
    expect(sessionActions(local)).toStrictEqual(["entrar"]);
    const falhou = reducePanel(local, sessao(INDISPONIVEL));
    expect(logoutUnconfirmed(falhou)).toBe(true);
    expect(describeSession(falhou)).toBe(LOGOUT_UNCONFIRMED_TEXT);
    expect(sessionActions(falhou)).toStrictEqual(["tentar_sair", "entrar"]);
  });

  test("Sair com a sessão ainda autenticada, antes da resposta do SW, mantém o texto da sessão", () => {
    for (const view of VALID_VIEWS.filter((v) => v.autenticado)) {
      const s = reducePanel(pronto(view), SAIR);
      expect(s.pediuSair, JSON.stringify(view)).toBe(true);
      expect(logoutUnconfirmed(s), JSON.stringify(view)).toBe(false);
      expect(describeSession(s), JSON.stringify(view)).toBe(SESSION_TEXTS.conectado[view.erro ?? "nenhum"]);
      expect(sessionActions(s), JSON.stringify(view)).toStrictEqual(["sair"]);
    }
  });

  test("o texto da falha remota sai só depois do clique em Sair: sem o clique, ou depois de Entrar, é o texto geral", () => {
    const semClique = pronto(INDISPONIVEL);
    expect(logoutUnconfirmed(semClique)).toBe(false);
    expect(describeSession(semClique)).toBe(SESSION_TEXTS.desconectado.SERVICO_INDISPONIVEL);
    expect(sessionActions(semClique)).toStrictEqual(["entrar"]);
    // Troca 503 depois de "Entrar": a mesma SessaoView, outro texto.
    const troca = run(pronto(FORA), entrar(1), sessao(INDISPONIVEL));
    expect(logoutUnconfirmed(troca)).toBe(false);
    expect(describeSession(troca)).toBe(SESSION_TEXTS.desconectado.SERVICO_INDISPONIVEL);
  });

  test("depois do Sair, só o SERVICO_INDISPONIVEL é a falha remota: os outros códigos têm o texto geral", () => {
    const pediu = reducePanel(pronto(DENTRO), SAIR);
    for (const erro of ["NAO_AUTENTICADO", "LIMITE_DE_TAXA", "ERRO_INTERNO"] as const) {
      const s = reducePanel(pediu, sessao({ autenticado: false, erro }));
      expect(logoutUnconfirmed(s), erro).toBe(false);
      expect(describeSession(s), erro).toBe(SESSION_TEXTS.desconectado[erro]);
    }
  });

  test("Tentar sair de novo chega com o pedido já ligado e mantém o texto até a próxima resposta", () => {
    const falhou = run(pronto(DENTRO), SAIR, sessao(FORA), sessao(INDISPONIVEL));
    expect(falhou.pediuSair).toBe(true);
    const denovo = reducePanel(falhou, SAIR);
    expect(denovo).toBe(falhou);
    expect(logoutUnconfirmed(run(denovo, sessao(FORA), sessao(INDISPONIVEL)))).toBe(true);
  });

  test("Sair sem sessão e sem falha pendente é ignorado", () => {
    for (const s of [pronto(FORA), pronto(INDISPONIVEL), INITIAL_PANEL_STATE]) expect(reducePanel(s, SAIR)).toBe(s);
  });

  test("Entrar depois da falha do logout desliga o pedido de saída", () => {
    const falhou = run(pronto(DENTRO), SAIR, sessao(FORA), sessao(INDISPONIVEL));
    const s = reducePanel(falhou, entrar(3));
    expect(s).toStrictEqual({ ...falhou, entrandoDesde: 3, pediuSair: false });
    expect(logoutUnconfirmed(reducePanel(s, sessao(INDISPONIVEL)))).toBe(false);
  });

  test("uma sessão autenticada encerra o efeito do último Sair (login feito em outra janela)", () => {
    const pediu = run(pronto(DENTRO), SAIR, sessao(FORA));
    const s = run(pediu, sessao(DENTRO), sessao(INDISPONIVEL));
    expect(s.pediuSair).toBe(false);
    expect(describeSession(s)).toBe(SESSION_TEXTS.desconectado.SERVICO_INDISPONIVEL);
    expect(reducePanel(pediu, sessao({ autenticado: true, erro: "LIMITE_DE_TAXA" })).pediuSair).toBe(false);
  });

  test("uma sessão fora mantém o pedido de saída", () => {
    const pediu = run(pronto(DENTRO), SAIR);
    for (const view of VALID_VIEWS.filter((v) => !v.autenticado)) expect(reducePanel(pediu, sessao(view)).pediuSair, JSON.stringify(view)).toBe(true);
  });
});

describe("Reconectar (ADR-004 D12: só da porta fechada; resposta_invalida continua definitiva)", () => {
  test("só a porta fechada oferece Reconectar", () => {
    expect(canReconnect(reducePanel(pronto(FORA), { type: "desconectou" }))).toBe(true);
    expect(canReconnect(reducePanel(pronto(FORA), { type: "recusada" }))).toBe(false);
    expect(canReconnect(pronto(FORA))).toBe(false);
    expect(canReconnect(INITIAL_PANEL_STATE)).toBe(false);
  });

  test("Reconectar da porta fechada recomeça do estado inicial, com a porta da geração seguinte, e o handshake novo vale", () => {
    expect(INITIAL_PANEL_STATE.geracao).toBe(0);
    const caido = run(pronto(DENTRO), SAIR, { type: "desconectou" });
    const novo = reducePanel(caido, { type: "reconectar" });
    expect(novo).toStrictEqual({ ...INITIAL_PANEL_STATE, geracao: 1 });
    expect(run(novo, msg({ kind: "ready", protocolVersion: 1, envio: true }), sessao(DENTRO))).toMatchObject({ geracao: 1, conexao: "pronto", sessao: DENTRO, pediuSair: false });
    // Cada queda da porta seguida do clique abre a geração seguinte; a geração atravessa o handshake e a queda.
    const segunda = run(novo, msg({ kind: "ready", protocolVersion: 1, envio: true }), { type: "desconectou" });
    expect(segunda.geracao).toBe(1);
    expect(reducePanel(segunda, { type: "reconectar" })).toStrictEqual({ ...INITIAL_PANEL_STATE, geracao: 2 });
  });

  test("o entrando não sobrevive ao Reconectar", () => {
    const caido = run(pronto(FORA), entrar(9), { type: "desconectou" });
    expect(caido.entrandoDesde).toBe(9);
    expect(reducePanel(caido, { type: "reconectar" }).entrandoDesde).toBeNull();
  });

  test("sem Reconectar em resposta_invalida: a queda é definitiva", () => {
    const caido = reducePanel(pronto(FORA), { type: "recusada" });
    expect(reducePanel(caido, { type: "reconectar" })).toBe(caido);
  });

  test("Reconectar com a conexão viva é ignorado (só ação do usuário depois da queda, sem laço)", () => {
    for (const s of [INITIAL_PANEL_STATE, pronto(FORA)]) expect(reducePanel(s, { type: "reconectar" })).toBe(s);
  });

  test("depois da queda, nada além do Reconectar muda a tela: nem mensagem, nem clique, nem relógio", () => {
    for (const queda of [{ type: "desconectou" }, { type: "recusada" }] as const) {
      const caido = run(pronto(FORA), entrar(1), queda);
      const actions: PanelAction[] = [sessao(DENTRO), entrar(2), SAIR, tique(1 + ENTRANDO_TETO_MS), { type: "desconectou" }, { type: "recusada" }];
      for (const action of actions) expect(reducePanel(caido, action), `${queda.type} ${action.type}`).toBe(caido);
    }
  });
});

describe("portão do Analisar (ADR-004 D12; ADR-025 D2)", () => {
  const COMBOS: Array<[boolean, boolean | null, SessaoView | null, BloqueioAnalise | null]> = [
    [false, false, null, "sem_api"],
    [false, false, DENTRO, "sem_api"],
    [false, true, null, "sem_api"],
    [false, true, DENTRO, "sem_api"],
    [true, false, null, "sem_consentimento"],
    [true, false, DENTRO, "sem_consentimento"],
    [true, true, null, "sem_sessao"],
    [true, true, DENTRO, null],
  ];

  test.each(COMBOS)("api %s, consentimento %s, sessão %j: %s", (api, consentimento, view, esperado) => {
    expect(analyzeBlock(api, { consentimento, sessao: view })).toBe(esperado);
  });

  test("só a combinação completa habilita: as outras 7 bloqueiam", () => {
    expect(COMBOS.filter(([, , , b]) => b === null)).toHaveLength(1);
    expect(COMBOS.filter(([, , , b]) => b !== null)).toHaveLength(7);
  });

  test("consentimento ainda desconhecido (null) bloqueia", () => {
    expect(analyzeBlock(true, { consentimento: null, sessao: DENTRO })).toBe("sem_consentimento");
  });

  test("sessão é `autenticado: true`, com ou sem erro transitório; sessão fora, com qualquer código, bloqueia", () => {
    for (const view of VALID_VIEWS) {
      expect(analyzeBlock(true, { consentimento: true, sessao: view }), JSON.stringify(view)).toBe(view.autenticado ? null : "sem_sessao");
    }
  });

  test("cada motivo tem texto, e o da API é o aviso de hoje", () => {
    expect(Object.keys(ANALYZE_BLOCKED_TEXTS).sort()).toStrictEqual(["sem_api", "sem_consentimento", "sem_sessao"]);
    expect(ANALYZE_BLOCKED_TEXTS.sem_api).toBe("A ligação com o servidor do Trampo ainda não está ativa nesta versão.");
  });
});

describe("SESSION_TEXTS (ADR-004 D12)", () => {
  test("as SessaoView válidas são 3 com sessão e 5 sem, e o catálogo cobre exatamente cada uma", () => {
    expect(VALID_VIEWS).toHaveLength(8);
    const conectado = VALID_VIEWS.filter((v) => v.autenticado).map((v) => v.erro ?? "nenhum");
    const desconectado = VALID_VIEWS.filter((v) => !v.autenticado).map((v) => v.erro ?? "nenhum");
    expect(Object.keys(SESSION_TEXTS.conectado).sort()).toStrictEqual(conectado.sort());
    expect(Object.keys(SESSION_TEXTS.desconectado).sort()).toStrictEqual(desconectado.sort());
    expect(Object.keys(SESSION_TEXTS.desconectado).sort()).toStrictEqual(["nenhum", ...SessaoErroSchema.options].sort());
  });

  test("cada SessaoView válida mostra o texto do catálogo", () => {
    for (const view of VALID_VIEWS) {
      const esperado = view.autenticado ? SESSION_TEXTS.conectado[view.erro ?? "nenhum"] : SESSION_TEXTS.desconectado[view.erro ?? "nenhum"];
      expect(describeSession(pronto(view)), JSON.stringify(view)).toBe(esperado);
    }
  });

  test("os textos exatos do D12: sem sessão, conectado e o Sair sem confirmação", () => {
    expect(SESSION_TEXTS.desconectado.nenhum).toStrictEqual({ estado: "Entre com a sua conta do GitHub ou do Google para analisar vagas.", erro: null });
    expect(SESSION_TEXTS.conectado.nenhum).toStrictEqual({ estado: "Conectado à sua conta do Trampo.", erro: null });
    expect(LOGOUT_UNCONFIRMED_TEXT).toStrictEqual({
      estado: "Você saiu neste navegador, mas o servidor não confirmou o encerramento da sessão. Tente de novo.",
      erro: null,
    });
  });

  test("com sessão, o erro transitório vem junto do Conectado; sem sessão, junto do Entre", () => {
    for (const texto of Object.values(SESSION_TEXTS.conectado)) expect(texto.estado).toBe(SESSION_TEXTS.conectado.nenhum.estado);
    for (const texto of Object.values(SESSION_TEXTS.desconectado)) expect(texto.estado).toBe(SESSION_TEXTS.desconectado.nenhum.estado);
    expect(SESSION_TEXTS.conectado.SERVICO_INDISPONIVEL.erro).not.toBeNull();
    expect(SESSION_TEXTS.conectado.LIMITE_DE_TAXA.erro).not.toBeNull();
  });

  test("NAO_AUTENTICADO e SERVICO_INDISPONIVEL reaproveitam o ERROR_TEXTS", () => {
    expect(SESSION_TEXTS.desconectado.NAO_AUTENTICADO.erro).toBe(ERROR_TEXTS.NAO_AUTENTICADO);
    expect(SESSION_TEXTS.desconectado.SERVICO_INDISPONIVEL.erro).toBe(ERROR_TEXTS.SERVICO_INDISPONIVEL);
    expect(SESSION_TEXTS.conectado.SERVICO_INDISPONIVEL.erro).toBe(ERROR_TEXTS.SERVICO_INDISPONIVEL);
  });

  test("ERRO_INTERNO tem texto próprio, que não pede o código do pedido (a SessaoView não tem requestId)", () => {
    const erro = SESSION_TEXTS.desconectado.ERRO_INTERNO.erro;
    expect(erro).not.toBeNull();
    expect(erro).not.toBe(ERROR_TEXTS.ERRO_INTERNO);
    expect(`${erro?.titulo} ${erro?.acao}`).not.toMatch(/código|pedido/i);
  });

  test("LIMITE_DE_TAXA da sessão fala de tentativas, não de análises (emenda do 05b-2)", () => {
    expect(SESSION_TEXTS.desconectado.LIMITE_DE_TAXA.erro).toBe(SESSION_TEXTS.conectado.LIMITE_DE_TAXA.erro);
    const erro = SESSION_TEXTS.desconectado.LIMITE_DE_TAXA.erro;
    expect(erro).not.toBe(ERROR_TEXTS.LIMITE_DE_TAXA);
    expect(`${erro?.titulo} ${erro?.acao}`).not.toMatch(/análise/i);
  });

  test("conectado, nenhum texto mostra conta nem provedor (residual 'conta trocada', ADR-004 §3)", () => {
    const conectado: SessionText[] = [...Object.values(SESSION_TEXTS.conectado), LOGOUT_UNCONFIRMED_TEXT, SIGNING_IN_TEXT];
    for (const texto of conectado) {
      const linha = `${texto.estado} ${texto.erro?.titulo ?? ""} ${texto.erro?.acao ?? ""}`;
      expect(linha, linha).not.toMatch(/github|google|@/i);
    }
  });

  test("nenhum texto da sessão parece link nem tem < ou >", () => {
    const all: string[] = [...Object.values(SIGN_IN_LABELS), ...Object.values(SESSION_ACTION_LABELS), ...Object.values(ANALYZE_BLOCKED_TEXTS)];
    for (const texto of [...Object.values(SESSION_TEXTS.conectado), ...Object.values(SESSION_TEXTS.desconectado), LOGOUT_UNCONFIRMED_TEXT, SIGNING_IN_TEXT]) {
      all.push(texto.estado);
      if (texto.erro !== null) all.push(texto.erro.titulo, texto.erro.acao);
    }
    expect(all.length).toBeGreaterThan(20);
    for (const text of all) {
      expect(containsUrlLike(text), text).toBe(false);
      expect(text, text).not.toMatch(/[<>]/);
    }
  });

  test("o código de erro da sessão vem do catálogo do ADR-025: nenhum código privado", () => {
    for (const erro of SessaoErroSchema.options) expect(ApiErrorCodeSchema.options).toContain(erro);
  });
});

describe("rótulos dos botões da sessão (ADR-004 D12)", () => {
  test("um botão de entrar por provedor da lista, e os demais do D12", () => {
    expect(Object.keys(SIGN_IN_LABELS).sort()).toStrictEqual([...AUTH_PROVIDERS].sort());
    expect(SIGN_IN_LABELS).toStrictEqual({ github: "Entrar com GitHub", google: "Entrar com Google" });
    expect(SESSION_ACTION_LABELS).toStrictEqual({ sair: "Sair da conta", tentar_sair: "Tentar sair de novo", reconectar: "Reconectar" });
  });
});

describe("invariantes do redutor (todos os estados alcançáveis com as ações da sessão e do envio)", () => {
  const stream = (raw: unknown): PanelAction => msg(raw as WorkerToPanel);
  const ACTIONS: PanelAction[] = [
    ...VALID_VIEWS.map(sessao),
    entrar(10),
    SAIR,
    tique(10 + ENTRANDO_TETO_MS),
    tique(10 + ENVIANDO_TETO_MS),
    tique(0),
    // 04b-2 (ADR-025 §6.4): o clique nos dois modos e tudo o que liga, desliga ou muda o que a tela oferece.
    ...AnalysisModeSchema.options.map((mode): PanelAction => ({ type: "analisar", mode, agora: 10 })),
    msg({ kind: "ready", protocolVersion: 1, envio: false }),
    msg({ kind: "captura", captura: { estado: "pronto", origem: "pagina", caracteres: 900, truncado: false } }),
    msg({ kind: "captura", captura: { estado: "lendo" } }),
    msg({ kind: "consentimento", dado: true }),
    msg({ kind: "consentimento", dado: false }),
    stream(stage("recebido", 0)),
    stream(result(REPORT)),
    stream(apiError("SERVICO_INDISPONIVEL")),
    { type: "desconectou" },
    { type: "recusada" },
    { type: "reconectar" },
    msg({ kind: "ready", protocolVersion: 1, envio: true }),
  ];

  /**
   * Busca em largura até o ponto fixo: cada estado alcançável a partir do inicial e de cada handshake. A geração da
   * porta cresce a cada Reconectar e fica fora da chave; as outras invariantes não dependem dela.
   */
  let found: PanelState[] | undefined;
  const reachable = (): PanelState[] => (found ??= search());
  const search = (): PanelState[] => {
    const seen = new Map<string, PanelState>();
    const queue: PanelState[] = [INITIAL_PANEL_STATE, ...VALID_VIEWS.map((view) => pronto(view))];
    // A fila só cresce e é lida por índice: tirar do começo custaria a fila inteira a cada estado.
    for (let next = 0; next < queue.length; next += 1) {
      const s = queue[next] as PanelState;
      // O relatório é sempre o mesmo: só o estado da análise entra na chave (a busca fica rápida).
      const key = JSON.stringify({ ...s, geracao: 0, analise: s.analise.estado === "erro" ? s.analise.error.message : s.analise.estado });
      if (seen.has(key)) continue;
      seen.set(key, s);
      for (const action of ACTIONS) queue.push(reducePanel(s, action));
    }
    return [...seen.values()];
  };

  test("o entrando e o pedido de saída nunca valem juntos, e a queda só existe com a conexão desconectada", () => {
    const states = reachable();
    expect(states.filter((s) => s.entrandoDesde !== null && s.pediuSair)).toStrictEqual([]);
    expect(states.filter((s) => (s.queda !== null) !== (s.conexao === "desconectado"))).toStrictEqual([]);
    // A busca passa pelos estados que importam: entrando, pedido de saída, falha do logout e as duas quedas.
    expect(states.some((s) => s.entrandoDesde !== null)).toBe(true);
    expect(states.some((s) => logoutUnconfirmed(s))).toBe(true);
    expect(states.some((s) => s.queda === "porta_fechada")).toBe(true);
    expect(states.some((s) => s.queda === "resposta_invalida")).toBe(true);
  });

  test("o enviando só vale com conexão, API, consentimento, sessão e vaga pronta (ADR-025 §6.4 D20)", () => {
    const enviando = reachable().filter((s) => s.enviandoDesde !== null);
    expect(enviando.length).toBeGreaterThan(0);
    for (const s of enviando) {
      const label = JSON.stringify({ ...s, analise: s.analise.estado });
      expect(s.conexao, label).toBe("pronto");
      expect(s.api, label).toBe(true);
      expect(s.consentimento, label).toBe(true);
      expect(s.sessao?.autenticado, label).toBe(true);
      expect(s.captura.estado, label).toBe("pronto");
      expect(s.entrandoDesde, label).toBeNull();
      expect(s.analise.estado === "nenhuma" || s.analise.estado === "andamento", label).toBe(true);
    }
    // A busca passa pelo envio com o progresso na tela e pelo erro local do teto.
    expect(enviando.some((s) => s.analise.estado === "andamento")).toBe(true);
    expect(reachable().some((s) => s.analise.estado === "erro" && s.analise.error.requestId === null)).toBe(true);
  });

  test("só o clique que a tela oferece liga o enviando: nenhuma mensagem, tique nem outro clique", () => {
    let ligou = 0;
    for (const s of reachable()) {
      const controle = analysisControl(s);
      for (const action of ACTIONS) {
        const depois = reducePanel(s, action);
        if (s.enviandoDesde !== null || depois.enviandoDesde === null) continue;
        ligou += 1;
        const label = `${JSON.stringify({ ...s, analise: s.analise.estado })} ${action.type}`;
        expect(action.type, label).toBe("analisar");
        expect(controle !== null && controle !== "aviso" && controle.bloqueio === null && action.type === "analisar" && controle.mode === action.mode, label).toBe(true);
      }
    }
    expect(ligou).toBeGreaterThan(0);
  });

  test("a geração da porta só muda com o Reconectar aceito, e de 1 em 1: nenhuma mensagem, tique ou clique reabre a porta", () => {
    let reconexoes = 0;
    for (const s of reachable()) {
      for (const action of ACTIONS) {
        const aceito = action.type === "reconectar" && canReconnect(s);
        expect(reducePanel(s, action).geracao, `${JSON.stringify(s)} ${action.type}`).toBe(s.geracao + (aceito ? 1 : 0));
        if (aceito) reconexoes += 1;
      }
    }
    expect(reconexoes).toBeGreaterThan(0);
  });
});

describe("describeSession", () => {
  test("nada antes da conexão pronta ou da sessao do handshake, e nada depois da queda", () => {
    expect(describeSession(INITIAL_PANEL_STATE)).toBeNull();
    expect(describeSession(reducePanel(pronto(DENTRO), { type: "desconectou" }))).toBeNull();
    expect(describeSession(reducePanel(pronto(DENTRO), { type: "recusada" }))).toBeNull();
  });

  test("o entrando vence o texto da sessão e o da falha do logout", () => {
    expect(describeSession(run(pronto(FORA), entrar(1)))).toBe(SIGNING_IN_TEXT);
    expect(describeSession(run(pronto(DENTRO), SAIR, sessao(FORA), sessao(INDISPONIVEL), entrar(2)))).toBe(SIGNING_IN_TEXT);
  });
});
