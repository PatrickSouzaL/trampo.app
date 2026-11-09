// Coletores das provas negativas do 05c-3 (ADR-004 §4.5 itens 1, 3, 6 e 7): o espião do painel, o heap snapshot e os
// dois mundos da aba da vaga. São cola de navegador, fora do `support/`; o que eles procuram e contam está no
// `support/leaks.ts` (cobertura de 100%), e cada "0" deles tem o seu controle positivo no `auth-negative.e2e.test.ts`.
import type { BrowserContext, Page } from "playwright-core";

import type { Loaded } from "./browser";

declare const chrome: (typeof import("wxt/browser"))["browser"];

/** O que o espião do §4.5 item 1 conta e exige em 0 (a porta do painel é contada à parte: é o canal que ele usa). */
export const SPIED_APIS = [
  "storage.session.get",
  "storage.session.getKeys",
  "storage.onChanged.addListener",
  "storage.session.onChanged.addListener",
  "runtime.onMessage.addListener",
  "serviceWorker.message",
  "BroadcastChannel",
  "window.message",
] as const;

export interface SpyReport {
  readonly calls: Readonly<Record<string, number>>;
  /** As APIs que não existiam no painel para o espião envolver: tem de ficar vazio, senão o 0 não vale. */
  readonly missing: readonly string[];
  /** Cada mensagem da porta, nas duas direções (`in` e `out`), em JSON. */
  readonly messages: readonly string[];
}

/**
 * §4.5 item 1, instalado por `addInitScript` antes de qualquer script do painel. Envolve a porta (`runtime.connect`, com
 * as mensagens nas duas direções), o `storage.session.get` e o `getKeys`, os `onChanged` do storage, o
 * `runtime.onMessage`, as mensagens do `navigator.serviceWorker` (por `addEventListener`, `onmessage`, `onmessageerror` e
 * `startMessages`), o `BroadcastChannel` e o `message` da `window` (por `addEventListener`, `onmessage` e
 * `onmessageerror`). Autocontido: o Playwright o serializa.
 */
export function panelSpy(): void {
  type Fn = (...args: unknown[]) => unknown;
  type Bag = Record<string, unknown>;
  const scope = globalThis as unknown as Bag;
  const calls: Record<string, number> = {};
  const missing: string[] = [];
  const messages: string[] = [];
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const wrap = (owner: Bag | undefined, key: string, name: string) => {
    const original = owner?.[key];
    if (owner === undefined || typeof original !== "function") {
      missing.push(name);
      return;
    }
    calls[name] ??= 0;
    owner[key] = function (this: unknown, ...args: unknown[]) {
      count(name);
      return (original as Fn).apply(this, args);
    };
  };

  const ext = scope["chrome"] as { runtime?: Bag & { onMessage?: Bag }; storage?: { onChanged?: Bag; session?: Bag & { onChanged?: Bag } } } | undefined;
  const runtime = ext?.runtime;
  const connect = runtime?.["connect"];
  if (runtime === undefined || typeof connect !== "function") missing.push("runtime.connect");
  else {
    calls["runtime.connect"] = 0;
    runtime["connect"] = (...args: unknown[]) => {
      count("runtime.connect");
      const port = (connect as Fn).apply(runtime, args) as { onMessage: { addListener: (f: (m: unknown) => void) => void }; postMessage: (m: unknown) => void };
      port.onMessage.addListener((m) => messages.push(`in ${JSON.stringify(m)}`));
      const post = port.postMessage.bind(port);
      port.postMessage = (m) => {
        messages.push(`out ${JSON.stringify(m)}`);
        post(m);
      };
      return port;
    };
  }
  wrap(ext?.storage?.session, "get", "storage.session.get");
  wrap(ext?.storage?.session, "getKeys", "storage.session.getKeys");
  wrap(ext?.storage?.onChanged, "addListener", "storage.onChanged.addListener");
  wrap(ext?.storage?.session?.onChanged, "addListener", "storage.session.onChanged.addListener");
  wrap(runtime?.onMessage, "addListener", "runtime.onMessage.addListener");

  const sw = (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer }).serviceWorker;
  const targets: Array<[EventTarget | undefined, string]> = [
    [globalThis, "window.message"],
    [sw, "serviceWorker.message"],
  ];
  const nameOf = (target: unknown) => targets.find(([t]) => t !== undefined && t === target)?.[1];
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
    const name = nameOf(this);
    if (name !== undefined && (type === "message" || type === "messageerror")) count(name);
    return (add as Fn).call(this, type, ...rest) as void;
  };
  for (const [target, name] of targets) {
    if (target === undefined) {
      missing.push(name);
      continue;
    }
    calls[name] ??= 0;
    for (const prop of ["onmessage", "onmessageerror"]) {
      let owner: object | null = target;
      let descriptor: PropertyDescriptor | undefined;
      while (owner !== null && (descriptor = Object.getOwnPropertyDescriptor(owner, prop)) === undefined) owner = Object.getPrototypeOf(owner) as object | null;
      const { get, set } = descriptor ?? {};
      if (get === undefined || set === undefined) {
        missing.push(`${name}.${prop}`);
        continue;
      }
      Object.defineProperty(target, prop, {
        configurable: true,
        get() {
          return get.call(this) as unknown;
        },
        set(value: unknown) {
          count(name);
          set.call(this, value);
        },
      });
    }
  }
  wrap(sw as unknown as Bag | undefined, "startMessages", "serviceWorker.message");

  const Channel = scope["BroadcastChannel"] as typeof BroadcastChannel | undefined;
  if (typeof Channel !== "function") missing.push("BroadcastChannel");
  else {
    calls["BroadcastChannel"] = 0;
    scope["BroadcastChannel"] = class extends Channel {
      constructor(name: string) {
        count("BroadcastChannel");
        super(name);
      }
    };
  }
  Object.defineProperty(scope, "__trampoEspiao", { value: (): SpyReport => ({ calls: { ...calls }, missing: [...missing], messages: [...messages] }) });
}

export const spyReport = (panel: Page): Promise<SpyReport> => panel.evaluate(() => (globalThis as unknown as { __trampoEspiao: () => SpyReport }).__trampoEspiao());

/**
 * O controle positivo do espião: o teste chama cada API envolvida, por cada caminho, uma vez. Depois disso, cada contador
 * tem o número exato de caminhos dele: 4 no `serviceWorker.message`, 3 no `window.message` e 1 no resto.
 */
export const SPY_CONTROL_CALLS: Readonly<Record<(typeof SPIED_APIS)[number], number>> = {
  "storage.session.get": 1,
  "storage.session.getKeys": 1,
  "storage.onChanged.addListener": 1,
  "storage.session.onChanged.addListener": 1,
  "runtime.onMessage.addListener": 1,
  "serviceWorker.message": 4,
  "BroadcastChannel": 1,
  "window.message": 3,
};

export const exerciseSpiedApis = (panel: Page): Promise<void> =>
  panel.evaluate(async () => {
    const noop = () => undefined;
    await chrome.storage.session.get(null);
    await chrome.storage.session.getKeys();
    chrome.storage.onChanged.addListener(noop);
    chrome.storage.session.onChanged.addListener(noop);
    chrome.runtime.onMessage.addListener(noop);
    const sw = navigator.serviceWorker;
    sw.addEventListener("message", noop);
    sw.onmessage = noop;
    sw.onmessageerror = noop;
    sw.startMessages();
    new BroadcastChannel("controle-05c3").close();
    window.addEventListener("message", noop);
    window.onmessage = noop;
    window.onmessageerror = noop;
  });

/** §4.5 item 3: o heap snapshot inteiro da página, em texto (o JSON do snapshot), por CDP `HeapProfiler`. */
export async function heapText(ctx: BrowserContext, page: Page): Promise<string> {
  const cdp = await ctx.newCDPSession(page);
  const chunks: string[] = [];
  cdp.on("HeapProfiler.addHeapSnapshotChunk", (c) => chunks.push(c.chunk));
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  } finally {
    await cdp.detach();
  }
  return chunks.join("");
}

/**
 * §4.5 item 6: tudo o que um mundo da aba vê, em texto: o texto do documento (com o de script, estilo e oculto), os
 * comentários, cada atributo com o valor, cada propriedade própria da `window` (o valor, se texto; o JSON, se objeto
 * simples ou lista), o storage e o cookie da página, o título e a URL. Autocontido: roda no MAIN pelo Playwright e no
 * ISOLATED pelo CDP.
 */
export function dumpWorld(): string {
  const parts = [document.documentElement.textContent ?? "", document.title, location.href];
  const comments = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
  while (comments.nextNode() !== null) parts.push(comments.currentNode.nodeValue ?? "");
  for (const el of document.querySelectorAll("*")) for (const a of el.attributes) parts.push(`${a.name}=${a.value}`);
  const scope = globalThis as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    let value: unknown;
    try {
      value = scope[name];
    } catch {
      continue;
    }
    parts.push(name);
    if (typeof value === "string") parts.push(value);
    else if (value !== null && typeof value === "object" && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
      try {
        parts.push(JSON.stringify(value));
      } catch {
        // Objeto cíclico: o nome basta para o coletor.
      }
    }
  }
  try {
    parts.push(JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), document.cookie);
  } catch {
    // Página sem acesso ao storage (origem opaca).
  }
  return parts.join("\n");
}

interface ExecutionContext {
  readonly id: number;
  readonly origin: string;
  readonly name: string;
  readonly auxData?: { readonly type?: string };
}

/**
 * O mundo ISOLATED da extensão na aba, pelo CDP da página: o contexto `isolated` com a origem da extensão. É o mundo em
 * que o extrator roda (o `executeScript` do SW) e que existe depois da captura. Lança se não houver exatamente um.
 */
export async function isolatedDump(ctx: BrowserContext, tab: Page, extensionId: string): Promise<string> {
  const cdp = await ctx.newCDPSession(tab);
  const contexts: ExecutionContext[] = [];
  cdp.on("Runtime.executionContextCreated", (e) => contexts.push(e.context as ExecutionContext));
  try {
    await cdp.send("Runtime.enable");
    const ours = contexts.filter((c) => c.auxData?.type === "isolated" && c.origin === `chrome-extension://${extensionId}`);
    if (ours.length !== 1) throw new Error(`mundo ISOLATED da extensão: ${ours.length} contextos (${contexts.map((c) => `${c.auxData?.type ?? "?"}:${c.name}`).join(", ")})`);
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression: `(${dumpWorld.toString()})()`, contextId: ours[0]!.id, returnByValue: true });
    if (exceptionDetails !== undefined) throw new Error(`o dump do ISOLATED lançou: ${exceptionDetails.text}`);
    return String(result.value);
  } finally {
    await cdp.detach();
  }
}

/**
 * Roda uma função no mundo ISOLATED da aba pelo caminho do extrator: `chrome.scripting.executeScript` no SW, com o
 * activeTab que o clique concedeu. `kind` escolhe o que roda lá: o storage do §4.5 item 7 ou o controle do item 6.
 */
export function inIsolated(l: Loaded, url: string, kind: "storage"): Promise<Record<string, string>>;
export function inIsolated(l: Loaded, url: string, kind: "plantar", value: string): Promise<Record<string, string>>;
export function inIsolated(l: Loaded, url: string, kind: "storage" | "plantar", value = ""): Promise<Record<string, string>> {
  return l.worker.evaluate(
    async ([target, what, planted]) => {
      const [tab] = await chrome.tabs.query({ url: target });
      if (tab?.id === undefined) throw new Error("aba da vaga não encontrada");
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "ISOLATED",
        args: [what, planted],
        func: async (job: string, text: string) => {
          if (job === "plantar") {
            (globalThis as unknown as Record<string, string>)["__trampoControleIsolado"] = text;
            console.log(`controle do console no ISOLATED: ${text}`);
            return { plantado: "ok" };
          }
          const out: Record<string, string> = {};
          const attempts: Array<[string, () => Promise<unknown>]> = [
            ["session.get", () => chrome.storage.session.get(null)],
            ["session.getKeys", () => chrome.storage.session.getKeys()],
            // eslint-disable-next-line no-restricted-syntax -- só leitura, o controle de que o storage responde no ISOLATED
            ["local.get", () => chrome.storage.local.get(null)],
          ];
          for (const [name, call] of attempts) {
            try {
              await call();
              out[name] = "ok";
            } catch (error) {
              out[name] = error instanceof Error ? error.message : String(error);
            }
          }
          return out;
        },
      });
      return frame?.result as Record<string, string>;
    },
    [url, kind, value] as const,
  );
}
