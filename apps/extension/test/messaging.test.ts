// SR-10: o Service Worker rejeita porta ou mensagem de outra origem ou com forma inválida. ADR-004 D10 B6 e D12
// (F1-EXT-05b): a SessaoView só tem um booleano e um código do catálogo, e o painel só pede "entrar" e "sair".
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { z } from "zod";

import {
  AUTH_PROVIDERS,
  CONSENT_VERSION,
  PANEL_PORT_NAME,
  PASTE_MAX_UTF16,
  PanelToWorkerSchema,
  SessaoErroSchema,
  type SessaoView,
  SessaoViewSchema,
  WorkerToPanelSchema,
  toSessaoView,
  type WorkerToPanel,
} from "../src/messaging/protocol";
import { checkPanelPort, handlePanelConnection, type PanelPort, type RejectReason } from "../src/messaging/worker-port";

const ID = "oniojmpioahjchcadecjkmekigalfack";
const BASE = `chrome-extension://${ID}/`;
const PANEL_URL = `chrome-extension://${ID}/sidepanel.html`;

type Sender = PanelPort["sender"];

function fakePort(name: string, sender: Sender) {
  const listeners: Array<(m: unknown) => void> = [];
  const port = {
    name,
    sender,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
    onDisconnect: { addListener: vi.fn() },
  } satisfies PanelPort;
  const deliver = (m: unknown) => listeners.forEach((l) => l(m));
  return { port, deliver, listeners };
}

function hooks(logRejection: (r: RejectReason) => void) {
  return {
    runtimeId: ID,
    extensionBaseUrl: BASE,
    logRejection,
    onReady: vi.fn(),
    onPaste: vi.fn(),
    onConsent: vi.fn(),
    onRevoke: vi.fn(),
    onLogin: vi.fn(),
    onLogout: vi.fn(),
    onAnalyze: vi.fn(),
  };
}

function connect(name: string, sender: Sender) {
  const rejections: RejectReason[] = [];
  const fp = fakePort(name, sender);
  const ctx = hooks((r) => rejections.push(r));
  handlePanelConnection(fp.port, ctx);
  return { ...fp, rejections, ctx };
}

describe("checkPanelPort", () => {
  test("aceita só a página de painel da própria extensão, com o nome de porta fixo", () => {
    expect(checkPanelPort({ name: PANEL_PORT_NAME, sender: { id: ID, url: PANEL_URL } }, ID, BASE)).toEqual({ trusted: true });
    // O painel aberto numa aba continua sendo código da extensão (tab não é critério).
    expect(checkPanelPort({ name: PANEL_PORT_NAME, sender: { id: ID, url: `${PANEL_URL}?x=1#y` } }, ID, BASE)).toEqual({ trusted: true });
  });

  const cases: Array<[string, string, Sender, RejectReason]> = [
    ["nome de porta errado", "outra-porta", { id: ID, url: PANEL_URL }, "nome_de_porta"],
    ["nome de porta parecido", `${PANEL_PORT_NAME} `, { id: ID, url: PANEL_URL }, "nome_de_porta"],
    ["sem remetente", PANEL_PORT_NAME, undefined, "sem_remetente"],
    ["remetente sem url", PANEL_PORT_NAME, { id: ID }, "sem_remetente"],
    ["outra extensão", PANEL_PORT_NAME, { id: "a".repeat(32), url: `chrome-extension://${"a".repeat(32)}/sidepanel.html` }, "extensao_diferente"],
    ["id certo, url de outra extensão", PANEL_PORT_NAME, { id: ID, url: `chrome-extension://${"b".repeat(32)}/sidepanel.html` }, "origem_diferente"],
    // Content script: tem tab e a url é a da página web; é dado de página, nunca comando.
    ["content script numa página web", PANEL_PORT_NAME, { id: ID, url: "https://www.linkedin.com/jobs/view/1/" }, "origem_diferente"],
    ["página web imitando o caminho", PANEL_PORT_NAME, { id: ID, url: "https://evil.example/sidepanel.html" }, "origem_diferente"],
    ["url malformada", PANEL_PORT_NAME, { id: ID, url: "::::" }, "origem_diferente"],
    ["outra página da extensão", PANEL_PORT_NAME, { id: ID, url: `chrome-extension://${ID}/background.js` }, "pagina_diferente"],
    ["caminho parecido", PANEL_PORT_NAME, { id: ID, url: `chrome-extension://${ID}/sidepanel.html/../x.html` }, "pagina_diferente"],
  ];
  test.each(cases)("rejeita: %s", (_label, name, sender, reason) => {
    expect(checkPanelPort({ name, sender }, ID, BASE)).toEqual({ trusted: false, reason });
  });
});

describe("handlePanelConnection", () => {
  test("hello válido recebe ready e a porta passa a receber a captura", () => {
    const c = connect(PANEL_PORT_NAME, { id: ID, url: PANEL_URL });
    expect(c.ctx.onReady).not.toHaveBeenCalled();
    c.deliver({ kind: "hello", protocolVersion: 1 });
    expect(c.port.postMessage).toHaveBeenCalledWith({ kind: "ready", protocolVersion: 1 });
    expect(c.ctx.onReady).toHaveBeenCalledExactlyOnceWith(c.port);
    expect(c.ctx.onPaste).not.toHaveBeenCalled();
    expect(c.port.disconnect).not.toHaveBeenCalled();
    expect(c.rejections).toEqual([]);
  });

  test("texto colado chega ao Service Worker sem resposta direta", () => {
    const c = connect(PANEL_PORT_NAME, { id: ID, url: PANEL_URL });
    c.deliver({ kind: "colar", texto: "Vaga colada" });
    expect(c.ctx.onPaste).toHaveBeenCalledExactlyOnceWith("Vaga colada");
    expect(c.ctx.onReady).not.toHaveBeenCalled();
    expect(c.port.postMessage).not.toHaveBeenCalled();
    expect(c.port.disconnect).not.toHaveBeenCalled();
  });

  test("consentir (versão vigente) e revogar chegam ao Service Worker sem resposta direta", () => {
    const c = connect(PANEL_PORT_NAME, { id: ID, url: PANEL_URL });
    c.deliver({ kind: "consentir", versao: CONSENT_VERSION });
    expect(c.ctx.onConsent).toHaveBeenCalledOnce();
    expect(c.ctx.onRevoke).not.toHaveBeenCalled();
    c.deliver({ kind: "revogar" });
    expect(c.ctx.onRevoke).toHaveBeenCalledOnce();
    expect(c.ctx.onConsent).toHaveBeenCalledOnce();
    expect(c.ctx.onPaste).not.toHaveBeenCalled();
    expect(c.ctx.onReady).not.toHaveBeenCalled();
    expect(c.port.postMessage).not.toHaveBeenCalled();
    expect(c.port.disconnect).not.toHaveBeenCalled();
  });

  test.each(AUTH_PROVIDERS)("entrar com %s chega ao Service Worker só com o provedor, sem resposta direta", (provedor) => {
    const c = connect(PANEL_PORT_NAME, { id: ID, url: PANEL_URL });
    c.deliver({ kind: "entrar", provedor });
    expect(c.ctx.onLogin).toHaveBeenCalledExactlyOnceWith(provedor);
    expect(c.ctx.onLogout).not.toHaveBeenCalled();
    expect(c.ctx.onReady).not.toHaveBeenCalled();
    expect(c.port.postMessage).not.toHaveBeenCalled();
    expect(c.port.disconnect).not.toHaveBeenCalled();
  });

  test.each(["auto", "aprofundada"] as const)("analisar (%s) chega ao Service Worker só com o modo, sem resposta direta (ADR-025 §6 D12)", (mode) => {
    const c = connect(PANEL_PORT_NAME, { id: ID, url: PANEL_URL });
    c.deliver({ kind: "analisar", mode });
    expect(c.ctx.onAnalyze).toHaveBeenCalledExactlyOnceWith(mode);
    expect(c.ctx.onLogin).not.toHaveBeenCalled();
    expect(c.ctx.onReady).not.toHaveBeenCalled();
    expect(c.port.postMessage).not.toHaveBeenCalled();
    expect(c.port.disconnect).not.toHaveBeenCalled();
  });

  test("sair chega ao Service Worker sem resposta direta", () => {
    const c = connect(PANEL_PORT_NAME, { id: ID, url: PANEL_URL });
    c.deliver({ kind: "sair" });
    expect(c.ctx.onLogout).toHaveBeenCalledOnce();
    expect(c.ctx.onLogin).not.toHaveBeenCalled();
    expect(c.ctx.onRevoke).not.toHaveBeenCalled();
    expect(c.port.postMessage).not.toHaveBeenCalled();
    expect(c.port.disconnect).not.toHaveBeenCalled();
  });

  test("porta não confiável nunca entrega texto colado", () => {
    const c = connect(PANEL_PORT_NAME, { id: ID, url: "https://evil.example/sidepanel.html" });
    expect(c.listeners).toHaveLength(0);
    expect(c.ctx.onPaste).not.toHaveBeenCalled();
    expect(c.ctx.onReady).not.toHaveBeenCalled();
  });

  test("porta não confiável é desconectada antes de qualquer mensagem", () => {
    const c = connect(PANEL_PORT_NAME, { id: ID, url: "https://www.linkedin.com/jobs/view/1/" });
    expect(c.port.disconnect).toHaveBeenCalledOnce();
    expect(c.listeners).toHaveLength(0);
    expect(c.rejections).toEqual(["origem_diferente"]);
  });

  const invalid: Array<[string, unknown]> = [
    ["chave extra", { kind: "hello", protocolVersion: 1, token: "x" }],
    ["versão errada", { kind: "hello", protocolVersion: 2 }],
    ["tipo desconhecido", { kind: "analyze", url: "https://x" }],
    ["sem kind", { protocolVersion: 1 }],
    ["string", "hello"],
    ["null", null],
    ["__proto__", JSON.parse('{"kind":"hello","protocolVersion":1,"__proto__":{"x":1}}')],
    ["colar acima do teto", { kind: "colar", texto: "a".repeat(PASTE_MAX_UTF16 + 1) }],
    ["colar com chave extra", { kind: "colar", texto: "x", tabId: 1 }],
    ["colar sem texto", { kind: "colar" }],
    ["colar com texto não string", { kind: "colar", texto: ["x"] }],
    // Um aviso antigo (ou inventado) não vale como consentimento (ADR-025 D2).
    ["consentir com outra versão", { kind: "consentir", versao: "aviso-0" }],
    ["consentir sem versão", { kind: "consentir" }],
    ["consentir com chave extra", { kind: "consentir", versao: CONSENT_VERSION, escopo: "tudo" }],
    ["revogar com chave extra", { kind: "revogar", motivo: "x" }],
    // Sessão (ADR-004 §4.1, "protocol"): o painel só escolhe um provedor da lista; nada de URL, token ou e-mail.
    ["entrar com chave extra", { kind: "entrar", provedor: "github", redirectTo: "https://evil.example/" }],
    ["entrar com provedor desconhecido", { kind: "entrar", provedor: "facebook" }],
    ["entrar com provedor em outra caixa", { kind: "entrar", provedor: "GitHub" }],
    ["entrar sem provedor", { kind: "entrar" }],
    ["sair com payload", { kind: "sair", escopo: "local" }],
    ["sessao vinda do painel", { kind: "sessao", sessao: { autenticado: true, erro: null } }],
    // Envio (ADR-025 §6 D12): só o modo do contrato; texto, requestId, plataforma e token são do SW.
    ["analisar sem modo", { kind: "analisar" }],
    ["analisar com modo desconhecido", { kind: "analisar", mode: "turbo" }],
    ["analisar com modo em outra caixa", { kind: "analisar", mode: "Auto" }],
    ["analisar com texto", { kind: "analisar", mode: "auto", texto: "vaga" }],
    ["analisar com requestId", { kind: "analisar", mode: "auto", requestId: "6f1c2a52-3b7e-4c1d-9a55-0d6b3f4e8a11" }],
    ["analisar com token", { kind: "analisar", mode: "auto", accessToken: "a.b.c" }],
    ["stream vindo do painel", { kind: "stream", event: { type: "stage", stage: "recebido", elapsedMs: 0 } }],
  ];
  test.each(invalid)("mensagem inválida (%s) derruba a porta sem resposta", (_label, msg) => {
    const c = connect(PANEL_PORT_NAME, { id: ID, url: PANEL_URL });
    c.deliver(msg);
    expect(c.port.postMessage).not.toHaveBeenCalled();
    expect(c.port.disconnect).toHaveBeenCalledOnce();
    expect(c.rejections).toEqual(["forma_invalida"]);
    expect(c.ctx.onPaste).not.toHaveBeenCalled();
    expect(c.ctx.onReady).not.toHaveBeenCalled();
    expect(c.ctx.onConsent).not.toHaveBeenCalled();
    expect(c.ctx.onRevoke).not.toHaveBeenCalled();
    expect(c.ctx.onLogin).not.toHaveBeenCalled();
    expect(c.ctx.onLogout).not.toHaveBeenCalled();
    expect(c.ctx.onAnalyze).not.toHaveBeenCalled();
  });

  test("o log de recusa recebe só o motivo, nunca o conteúdo", () => {
    const log = vi.fn();
    const { port, deliver } = fakePort(PANEL_PORT_NAME, { id: ID, url: PANEL_URL });
    handlePanelConnection(port, hooks(log));
    deliver({ kind: "hello", protocolVersion: 1, segredo: "texto da vaga" });
    expect(log).toHaveBeenCalledWith("forma_invalida");
    expect(JSON.stringify(log.mock.calls)).not.toContain("texto da vaga");
  });
});

describe("PanelToWorkerSchema", () => {
  test("o teto do texto colado é exato, em UTF-16", () => {
    expect(PanelToWorkerSchema.safeParse({ kind: "colar", texto: "a".repeat(PASTE_MAX_UTF16) }).success).toBe(true);
    expect(PanelToWorkerSchema.safeParse({ kind: "colar", texto: "a".repeat(PASTE_MAX_UTF16 + 1) }).success).toBe(false);
    expect(PASTE_MAX_UTF16).toBe(30_000);
  });
});

describe("WorkerToPanelSchema (revalidação no painel)", () => {
  test("aceita as visões da captura, que não têm o texto da vaga", () => {
    const views = [
      { estado: "ocioso" },
      { estado: "lendo" },
      { estado: "pronto", origem: "pagina", caracteres: 15_000, truncado: true },
      { estado: "pronto", origem: "texto_colado", caracteres: 0, truncado: false },
      { estado: "falhou", motivo: "sem_acesso" },
      { estado: "falhou", motivo: "texto_insuficiente" },
      { estado: "falhou", motivo: "erro" },
    ];
    for (const captura of views) expect(WorkerToPanelSchema.safeParse({ kind: "captura", captura }).success).toBe(true);
  });

  test("rejeita captura com texto, contagem fora da faixa ou motivo desconhecido", () => {
    const bad = [
      { estado: "pronto", origem: "pagina", caracteres: 10, truncado: false, texto: "vaga" },
      { estado: "pronto", origem: "pagina", caracteres: 15_001, truncado: false },
      { estado: "pronto", origem: "pagina", caracteres: -1, truncado: false },
      { estado: "pronto", origem: "pagina", caracteres: 1.5, truncado: false },
      { estado: "pronto", origem: "linkedin", caracteres: 1, truncado: false },
      { estado: "falhou", motivo: "Cannot access https://vaga" },
      { estado: "ocioso", url: "https://x" },
      { estado: "desconhecido" },
    ];
    for (const captura of bad) expect(WorkerToPanelSchema.safeParse({ kind: "captura", captura }).success).toBe(false);
  });

  test("aceita ready, consentimento e eventos de stream do contrato público", () => {
    expect(WorkerToPanelSchema.safeParse({ kind: "ready", protocolVersion: 1 }).success).toBe(true);
    expect(WorkerToPanelSchema.safeParse({ kind: "consentimento", dado: true }).success).toBe(true);
    expect(WorkerToPanelSchema.safeParse({ kind: "consentimento", dado: "sim" }).success).toBe(false);
    expect(WorkerToPanelSchema.safeParse({ kind: "consentimento", dado: false, versao: CONSENT_VERSION }).success).toBe(false);
    const stage = { type: "stage", stage: "extraindo_fatos", elapsedMs: 900 };
    expect(WorkerToPanelSchema.safeParse({ kind: "stream", event: stage }).success).toBe(true);
  });

  test("rejeita evento fora do contrato, HTML e chave extra", () => {
    expect(WorkerToPanelSchema.safeParse({ kind: "stream", event: { type: "debug", stack: "x" } }).success).toBe(false);
    const htmlError = { type: "error", error: { code: "ERRO_INTERNO", message: "<img src=x onerror=1>", requestId: null, retryAfterSeconds: null } };
    expect(WorkerToPanelSchema.safeParse({ kind: "stream", event: htmlError }).success).toBe(false);
    expect(WorkerToPanelSchema.safeParse({ kind: "ready", protocolVersion: 1, html: "<b>" }).success).toBe(false);
    expect(WorkerToPanelSchema.safeParse({ kind: "render", html: "<b>" }).success).toBe(false);
  });
});

/** As 10 combinações de `{ autenticado, erro }`; só `{ true, NAO_AUTENTICADO }` e `{ true, ERRO_INTERNO }` são incoerentes. */
const COMBINACOES = [true, false].flatMap((autenticado) => [null, ...SessaoErroSchema.options].map((erro) => ({ autenticado, erro })));
const INCOERENTES = [
  { autenticado: true, erro: "NAO_AUTENTICADO" },
  { autenticado: true, erro: "ERRO_INTERNO" },
];
const COERENTES = COMBINACOES.filter((c) => !INCOERENTES.some((i) => i.autenticado === c.autenticado && i.erro === c.erro));

describe("SessaoView (ADR-004 D10 B6 e D12)", () => {
  test("os erros são os 4 códigos do catálogo do D12, nenhum privado", () => {
    expect(SessaoErroSchema.options).toStrictEqual(["NAO_AUTENTICADO", "SERVICO_INDISPONIVEL", "LIMITE_DE_TAXA", "ERRO_INTERNO"]);
  });

  test("aceita as 8 combinações coerentes, dentro e fora da mensagem sessao", () => {
    expect(COERENTES).toHaveLength(8);
    for (const sessao of COERENTES) {
      expect(SessaoViewSchema.safeParse(sessao).success, JSON.stringify(sessao)).toBe(true);
      expect(WorkerToPanelSchema.safeParse({ kind: "sessao", sessao }).success, JSON.stringify(sessao)).toBe(true);
    }
  });

  // M-08: o refine é o que recusa uma sessão "viva" com o erro que a apagaria.
  test.each(INCOERENTES)("recusa { autenticado: $autenticado, erro: $erro } (M-08)", (sessao) => {
    expect(SessaoViewSchema.safeParse(sessao).success).toBe(false);
    expect(WorkerToPanelSchema.safeParse({ kind: "sessao", sessao }).success).toBe(false);
  });

  test.each([
    ["token", { autenticado: true, erro: null, token: "CANARIO.TOKEN" }],
    ["accessToken", { autenticado: true, erro: null, accessToken: "CANARIO.TOKEN" }],
    ["email", { autenticado: true, erro: null, email: "pessoa@exemplo.com" }],
    ["exp", { autenticado: true, erro: null, exp: 1_700_000_900 }],
    ["sub", { autenticado: true, erro: null, sub: "00000000-0000-4000-8000-000000000000" }],
    ["session_id", { autenticado: false, erro: null, session_id: "s" }],
    ["provedor", { autenticado: true, erro: null, provedor: "github" }],
    ["erro com outro código do catálogo", { autenticado: false, erro: "PROIBIDO" }],
    ["erro com texto livre", { autenticado: false, erro: "Sua sessão expirou" }],
    ["sem erro", { autenticado: false }],
    ["sem autenticado", { erro: null }],
    ["autenticado em texto", { autenticado: "true", erro: null }],
    ["__proto__", JSON.parse('{"autenticado":false,"erro":null,"__proto__":{"token":"x"}}')],
  ])("recusa a sessão com %s, e a porta cai", (_caso, sessao) => {
    expect(SessaoViewSchema.safeParse(sessao).success).toBe(false);
    expect(WorkerToPanelSchema.safeParse({ kind: "sessao", sessao }).success).toBe(false);
  });

  test("recusa chave extra na própria mensagem sessao", () => {
    expect(WorkerToPanelSchema.safeParse({ kind: "sessao", sessao: { autenticado: true, erro: null }, token: "x" }).success).toBe(false);
  });

  test("por tipo, a SessaoView não carrega texto livre nem os campos da sessão guardada", () => {
    expectTypeOf<keyof SessaoView>().toEqualTypeOf<"autenticado" | "erro">();
    expectTypeOf<SessaoView["autenticado"]>().toEqualTypeOf<boolean>();
    expectTypeOf<SessaoView["erro"]>().toEqualTypeOf<"NAO_AUTENTICADO" | "SERVICO_INDISPONIVEL" | "LIMITE_DE_TAXA" | "ERRO_INTERNO" | null>();
    expectTypeOf<string>().not.toExtend<SessaoView["erro"]>();
    // O refine é guarda de tipo: a saída do schema (e da mensagem) equivale à união, que já proíbe { true, NAO_AUTENTICADO }.
    type Saida = z.output<typeof SessaoViewSchema>;
    type NaMensagem = Extract<WorkerToPanel, { kind: "sessao" }>["sessao"];
    expectTypeOf<Saida>().toExtend<SessaoView>();
    expectTypeOf<SessaoView>().toExtend<Saida>();
    expectTypeOf<NaMensagem>().toExtend<SessaoView>();
    expectTypeOf<{ autenticado: true; erro: "NAO_AUTENTICADO" }>().not.toExtend<Saida>();
    expectTypeOf<{ autenticado: true; erro: "NAO_AUTENTICADO" }>().not.toExtend<SessaoView>();
    expectTypeOf<{ autenticado: true; erro: "ERRO_INTERNO" }>().not.toExtend<SessaoView>();
  });
});

describe("toSessaoView: a única saída da sessão para o painel", () => {
  test.each(COERENTES)("copia { autenticado: $autenticado, erro: $erro } num objeto novo", (view) => {
    const out = toSessaoView(view as SessaoView);
    expect(out).toStrictEqual(view);
    expect(out).not.toBe(view);
  });

  test("campo a mais nunca sai: um espalhamento da sessão guardada vira só o booleano e o código", () => {
    const vazada = { v: 1, accessToken: "CANARIO.TOKEN.um", refreshToken: "r1.CANARIO", autenticado: true, erro: null } as unknown as SessaoView;
    const out = toSessaoView(vazada);
    expect(out).toStrictEqual({ autenticado: true, erro: null });
    expect(JSON.stringify(out)).not.toContain("CANARIO");
  });

  test.each([
    ...INCOERENTES,
    { autenticado: false, erro: "CANARIO-texto-livre" },
    { autenticado: "true", erro: null },
    { autenticado: true, erro: undefined },
  ])("valor fora do schema vira { false, ERRO_INTERNO }, sem eco: %j", (view) => {
    const out = toSessaoView(view as unknown as SessaoView);
    expect(out).toStrictEqual({ autenticado: false, erro: "ERRO_INTERNO" });
    expect(JSON.stringify(out)).not.toContain("CANARIO");
  });
});
