// Coletor de console e rede do 05c-3 (ADR-004 §4.5 itens 4 e 9) por uma conexão CDP própria, ao lado da do Playwright.
// A sessão CDP do Playwright não entrega as sessões filhas de um auto-attach "flatten", então o navegador do teste abre
// também o --remote-debugging-port=0 (só em 127.0.0.1, num perfil descartável, só no E2E das provas negativas), e este
// coletor liga o auto-attach no nível do navegador ANTES do loadUnpacked: todo SW e toda página nascem pausados
// (`waitForDebuggerOnStart`) até o Runtime, o Log e o Network estarem ligados. Nas páginas, o auto-attach se repete para os
// filhos (workers e iframes). Sondado no 05c-3 (Edge 157): o pipe do Playwright e a porta convivem.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TapTarget {
  readonly targetId: string;
  readonly type: string;
  /** A URL no momento do attach (a página nova nasce em about:blank). */
  readonly url: string;
  /** O alvo cuja sessão fez o attach (o painel, para um worker dele); `null` no nível do navegador. */
  readonly parentId: string | null;
}

export interface TapEvent {
  readonly target: TapTarget;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface TapRequest {
  readonly target: TapTarget;
  readonly url: string;
}

export interface CdpTap {
  /** Cada alvo, na ordem do attach. */
  targets(): TapTarget[];
  /** `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` e `Log.entryAdded` de todos os alvos (§4.5 item 9). */
  console(): TapEvent[];
  /** Cada `Network.requestWillBeSent`, com o alvo que pediu (§4.5 item 4). */
  requests(): TapRequest[];
  close(): void;
}

export const REMOTE_DEBUGGING_ARG = "--remote-debugging-port=0";
const CONSOLE_EVENTS: ReadonlySet<string> = new Set(["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"]);

/** O endereço que o navegador grava no perfil ao abrir a porta (`DevToolsActivePort`: a porta e o caminho do alvo). */
async function browserEndpoint(profile: string): Promise<string> {
  const file = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error("o navegador não abriu a porta de depuração em 10 s");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const [port, path] = readFileSync(file, "utf8").trim().split("\n");
  return `ws://127.0.0.1:${String(port)}${String(path)}`;
}

interface Message {
  readonly id?: number;
  readonly sessionId?: string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly error?: { readonly message: string };
}

export async function openTap(profile: string): Promise<CdpTap> {
  const ws = new WebSocket(await browserEndpoint(profile));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("a conexão CDP do coletor falhou")), { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  const sessions = new Map<string, TapTarget>();
  const targets: TapTarget[] = [];
  const events: TapEvent[] = [];
  const requests: TapRequest[] = [];

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });

  /** Liga os domínios e só então solta o alvo: nada do que ele fizer fica antes do coletor. */
  async function prepare(sessionId: string, target: TapTarget): Promise<void> {
    const steps = [send("Runtime.enable", {}, sessionId), send("Log.enable", {}, sessionId), send("Network.enable", {}, sessionId)];
    if (target.type === "page" || target.type === "iframe") steps.push(send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId));
    // Um domínio que o alvo não tem (o Log num worker, por exemplo) não pode deixar o alvo pausado.
    await Promise.allSettled(steps);
    await send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
  }

  ws.addEventListener("message", (event: MessageEvent) => {
    const msg = JSON.parse(String(event.data)) as Message;
    if (msg.id !== undefined) {
      const waiting = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error === undefined) waiting?.resolve();
      else waiting?.reject(new Error(msg.error.message));
      return;
    }
    const params = msg.params ?? {};
    if (msg.method === "Target.attachedToTarget") {
      const info = params["targetInfo"] as { targetId: string; type: string; url: string };
      const target = { targetId: info.targetId, type: info.type, url: info.url, parentId: sessions.get(String(msg.sessionId))?.targetId ?? null };
      const sessionId = String(params["sessionId"]);
      sessions.set(sessionId, target);
      targets.push(target);
      void prepare(sessionId, target);
      return;
    }
    const target = sessions.get(String(msg.sessionId));
    if (target === undefined || msg.method === undefined) return;
    if (CONSOLE_EVENTS.has(msg.method)) events.push({ target, method: msg.method, params });
    else if (msg.method === "Network.requestWillBeSent") requests.push({ target, url: (params["request"] as { url: string }).url });
  });
  ws.addEventListener("close", () => {
    for (const waiting of pending.values()) waiting.reject(new Error("a conexão CDP do coletor fechou"));
    pending.clear();
  });

  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  return {
    targets: () => [...targets],
    console: () => [...events],
    requests: () => [...requests],
    close: () => ws.close(),
  };
}
