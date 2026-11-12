// Lado do Service Worker da porta com o Side Panel (ADR-001 §5.0.1, "Mensagens internas"; SR-10).
// Funções puras sobre uma porta mínima, para testar sem navegador; o background só faz a ligação.
import { type AnalysisMode, type AuthProvider, PANEL_PAGE_PATH, PANEL_PORT_NAME, PROTOCOL_VERSION, PanelToWorkerSchema, type WorkerToPanel } from "./protocol";

/** O mínimo de `runtime.Port` que usamos. */
export interface PanelPort {
  readonly name: string;
  readonly sender?: { readonly id?: string | undefined; readonly url?: string | undefined } | undefined;
  postMessage(message: WorkerToPanel): void;
  disconnect(): void;
  readonly onMessage: { addListener(listener: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void };
}

export type RejectReason =
  | "nome_de_porta"
  | "sem_remetente"
  | "extensao_diferente"
  | "origem_diferente"
  | "pagina_diferente"
  | "forma_invalida";

export type PortVerdict = { readonly trusted: true } | { readonly trusted: false; readonly reason: RejectReason };

/**
 * A porta só é confiável se vier da NOSSA página de painel: nome fixo, mesmo id de extensão e
 * `sender.url` na origem da extensão com o caminho do painel. Um content script tem `sender.url` da
 * página web e cai aqui (é dado de página, não comando). `sender.tab` não é critério: o próprio
 * painel aberto numa aba continua sendo código da extensão.
 *
 * A origem é comparada por protocolo e host, não por `URL.origin`: fora do navegador, esquemas não
 * especiais (`chrome-extension:`) têm origem "null", e dois "null" seriam iguais.
 */
export function checkPanelPort(port: Pick<PanelPort, "name" | "sender">, runtimeId: string, extensionBaseUrl: string): PortVerdict {
  if (port.name !== PANEL_PORT_NAME) return { trusted: false, reason: "nome_de_porta" };
  const sender = port.sender;
  if (sender?.url === undefined) return { trusted: false, reason: "sem_remetente" };
  if (sender.id !== runtimeId) return { trusted: false, reason: "extensao_diferente" };

  const expected = new URL(extensionBaseUrl);
  let actual: URL;
  try {
    actual = new URL(sender.url);
  } catch {
    return { trusted: false, reason: "origem_diferente" };
  }
  if (actual.protocol !== expected.protocol || actual.host !== expected.host || actual.host === "") {
    return { trusted: false, reason: "origem_diferente" };
  }
  if (actual.pathname !== PANEL_PAGE_PATH) return { trusted: false, reason: "pagina_diferente" };
  return { trusted: true };
}

export interface PortContext {
  readonly runtimeId: string;
  readonly extensionBaseUrl: string;
  /** A composição tem o cliente da API (as duas origens do build): vai no `ready`, para o portão do "Analisar" (ADR-025 §6.4 D18). */
  readonly envio: boolean;
  /** Registra só o motivo, nunca o conteúdo da mensagem (threat-model T23). */
  readonly logRejection: (reason: RejectReason) => void;
  /** Porta confiável depois do `hello`: passa a receber o estado da captura (ADR-024 D4). */
  readonly onReady: (port: PanelPort) => void;
  /** Texto colado no painel, já com a forma validada (ADR-024 D5). */
  readonly onPaste: (texto: string) => void;
  /** Aceite do aviso de envio, já com a versão vigente conferida pelo schema (ADR-025 D2). */
  readonly onConsent: () => void;
  /** O usuário retirou o consentimento. */
  readonly onRevoke: () => void;
  /** Clique em "Entrar com …": só o provedor da lista fechada, conferido pelo schema (ADR-004 D12). */
  readonly onLogin: (provedor: AuthProvider) => void;
  /** Clique em "Sair da conta" (ou "Tentar sair de novo"). */
  readonly onLogout: () => void;
  /** Clique em "Analisar vaga" ou "Reanalisar com IA": só o modo do contrato (ADR-025 §6 D12). */
  readonly onAnalyze: (mode: AnalysisMode) => void;
}

/** Valida a porta na conexão e cada mensagem recebida. Qualquer falha desconecta (fail closed). */
export function handlePanelConnection(port: PanelPort, ctx: PortContext): void {
  const verdict = checkPanelPort(port, ctx.runtimeId, ctx.extensionBaseUrl);
  if (!verdict.trusted) {
    ctx.logRejection(verdict.reason);
    port.disconnect();
    return;
  }

  port.onMessage.addListener((raw) => {
    const parsed = PanelToWorkerSchema.safeParse(raw);
    if (!parsed.success) {
      ctx.logRejection("forma_invalida");
      port.disconnect();
      return;
    }
    switch (parsed.data.kind) {
      case "hello":
        port.postMessage({ kind: "ready", protocolVersion: PROTOCOL_VERSION, envio: ctx.envio });
        ctx.onReady(port);
        break;
      case "colar":
        ctx.onPaste(parsed.data.texto);
        break;
      case "consentir":
        ctx.onConsent();
        break;
      case "revogar":
        ctx.onRevoke();
        break;
      case "entrar":
        ctx.onLogin(parsed.data.provedor);
        break;
      case "sair":
        ctx.onLogout();
        break;
      case "analisar":
        ctx.onAnalyze(parsed.data.mode);
        break;
    }
  });
}
