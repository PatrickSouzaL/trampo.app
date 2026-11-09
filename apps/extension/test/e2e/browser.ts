// Carrega o build de produção da extensão no Edge/Chrome instalado, num perfil descartável.
// Edge e Chrome de marca não aceitam mais --load-extension (Chrome 137+): a extensão entra por CDP
// Extensions.loadUnpacked. As flags abaixo valem só neste perfil de teste.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page, type Worker } from "playwright-core";

import { type CdpTap, REMOTE_DEBUGGING_ARG, openTap } from "./cdp-tap";

const DEFAULT_BROWSERS: Partial<Record<NodeJS.Platform, string>> = {
  win32: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  linux: "/usr/bin/microsoft-edge",
  darwin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
};
export const browserPath = process.env["TRAMPO_E2E_BROWSER"] ?? DEFAULT_BROWSERS[process.platform];

export interface Loaded {
  ctx: BrowserContext;
  worker: Worker;
  panel: Page;
  id: string;
  profile: string;
  /** Sessão CDP do navegador (Extensions.*, Target.*). */
  cdp: CDPSession;
  /** O coletor de console e rede das provas negativas (§4.5 itens 4 e 9), quando pedido no load. */
  tap?: CdpTap;
}

export interface LoadOptions {
  /**
   * Porta do chromiumapp local (ADR-004 §4.4): o `*.chromiumapp.org` vai para ele pelo --host-resolver-rules. O
   * navegador intercepta o retorno do login antes da rede, então o contador desse servidor tem de ficar em 0.
   */
  readonly chromiumappPort?: number;
  /**
   * F1-EXT-05c, 05c-3 (§4.5 itens 4 e 9): abre a porta de depuração e liga o coletor de console e rede antes do
   * loadUnpacked, para o SW e o painel nascerem já observados.
   */
  readonly tap?: boolean;
  /** Roda na página do painel antes do `goto` (o espião do §4.5 item 1 entra por `addInitScript`). */
  readonly beforePanel?: (panel: Page) => Promise<void>;
}

async function launch(profile: string, options: LoadOptions): Promise<{ ctx: BrowserContext; cdp: CDPSession }> {
  if (browserPath === undefined) throw new Error("Defina TRAMPO_E2E_BROWSER com o caminho do Edge ou do Chrome.");
  const rules = options.chromiumappPort === undefined ? [] : [`--host-resolver-rules=MAP *.chromiumapp.org 127.0.0.1:${options.chromiumappPort}`];
  if (options.tap === true) rules.push(REMOTE_DEBUGGING_ARG);
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: browserPath,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", "--ignore-certificate-errors", "--no-first-run", "--no-default-browser-check", ...rules],
  });
  const browser = ctx.browser();
  const cdp = browser === null ? await ctx.newCDPSession(ctx.pages()[0] ?? (await ctx.newPage())) : await browser.newBrowserCDPSession();
  return { ctx, cdp };
}

const loadUnpacked = async (cdp: CDPSession, extDir: string): Promise<string> =>
  ((await cdp.send("Extensions.loadUnpacked" as never, { path: extDir } as never)) as { id: string }).id;

/** O SW da extensão que ainda não é o `previous` (depois de uma recarga, o SW novo). */
async function ourWorker(ctx: BrowserContext, id: string, previous?: Worker): Promise<Worker> {
  const isOurs = (w: Worker) => w.url().startsWith(`chrome-extension://${id}/`) && w !== previous;
  return ctx.serviceWorkers().find(isOurs) ?? (await ctx.waitForEvent("serviceworker", { predicate: isOurs }));
}

export async function loadExtension(extDir: string, options: LoadOptions = {}): Promise<Loaded> {
  const profile = mkdtempSync(join(tmpdir(), "trampo-e2e-profile-"));
  const { ctx, cdp } = await launch(profile, options);
  const tap = options.tap === true ? await openTap(profile) : undefined;
  const id = await loadUnpacked(cdp, extDir);
  const worker = await ourWorker(ctx, id);

  const panel = await ctx.newPage();
  await options.beforePanel?.(panel);
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  return { ctx, worker, panel, id, profile, cdp, ...(tap === undefined ? {} : { tap }) };
}

/**
 * Para o SW da extensão pelo alvo `service_worker`, na sessão CDP do navegador (achado do 05b-3 no Edge 157): a porta do
 * painel cai, e o próximo `runtime.connect` acorda um SW novo. Com o CDP anexado o SW não suspende sozinho (P12).
 */
export async function stopWorker(l: Loaded): Promise<void> {
  const { targetInfos } = (await l.cdp.send("Target.getTargets" as never)) as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
  const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${l.id}/`));
  if (sw === undefined) throw new Error("SW da extensão não encontrado");
  await l.cdp.send("Target.closeTarget" as never, { targetId: sw.targetId } as never);
}

/** O painel numa página nova; logo depois de uma recarga a extensão pode ainda não ter voltado, então tenta por até 10 s. */
async function openPanel(ctx: BrowserContext, id: string): Promise<Page> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const page = await ctx.newPage();
    if (await page.goto(`chrome-extension://${id}/sidepanel.html`).then((r) => r?.ok() === true, () => false)) return page;
    await page.close();
    if (Date.now() > deadline) throw new Error("o painel da extensão não abriu depois da recarga");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** O `close` do SW antigo, armado antes da recarga: o painel novo nunca conecta ao SW que vai morrer. */
function closed(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("o SW antigo não fechou em 10 s depois da recarga")), 10_000);
    worker.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Depois de uma recarga da extensão: um painel novo e o SW novo, no mesmo navegador (cenário 6). O painel vem antes,
 * porque a porta dele acorda o SW: no Chrome 156 o SW novo não sobe sozinho depois do `runtime.reload()` (no Edge 157 sobe).
 */
async function reattach(l: Loaded, gone: Promise<void>): Promise<Loaded> {
  await gone;
  await l.panel.close().catch(() => undefined);
  const panel = await openPanel(l.ctx, l.id);
  const worker = await ourWorker(l.ctx, l.id, l.worker);
  return { ...l, worker, panel };
}

/** Recarga pela própria extensão: `chrome.runtime.reload()` no SW, que morre no meio do `evaluate`. */
export async function reloadByRuntime(l: Loaded): Promise<Loaded> {
  const gone = closed(l.worker);
  await l.worker.evaluate(() => (globalThis as unknown as { chrome: { runtime: { reload: () => void } } }).chrome.runtime.reload()).catch(() => undefined);
  return reattach(l, gone);
}

/** Recarga como atualização: um novo `loadUnpacked` no mesmo caminho, que mantém o ID pela `key` (P17). */
export async function reloadByLoadUnpacked(l: Loaded, extDir: string): Promise<Loaded> {
  const gone = closed(l.worker);
  const id = await loadUnpacked(l.cdp, extDir);
  if (id !== l.id) throw new Error(`o loadUnpacked no mesmo caminho deu outro ID: ${id}`);
  return reattach(l, gone);
}

/**
 * Reinício do navegador (P13): fecha sem apagar o perfil e abre de novo com ele. `persisted` diz se a extensão do
 * `loadUnpacked` voltou sozinha com o perfil; se não voltou, ela é carregada de novo do mesmo caminho, com o mesmo ID.
 * Sondado no 05c-2 (Edge 157 e Chrome 156): não volta (`ERR_BLOCKED_BY_CLIENT` até 3 s depois do launch). A página da
 * sondagem é descartada, porque a navegação de erro dela correria com a do painel.
 */
export async function relaunch(l: Loaded, extDir: string, options: LoadOptions = {}): Promise<{ loaded: Loaded; persisted: boolean }> {
  await l.ctx.close();
  const { ctx, cdp } = await launch(l.profile, options);
  const url = `chrome-extension://${l.id}/sidepanel.html`;
  const probe = await ctx.newPage();
  const persisted = await probe.goto(url).then(
    (response) => response?.ok() === true,
    () => false,
  );
  await probe.close();
  if (!persisted) {
    const id = await loadUnpacked(cdp, extDir);
    if (id !== l.id) throw new Error(`o loadUnpacked depois do reinício deu outro ID: ${id}`);
  }
  // O painel conecta e acorda o SW, se ele ainda não tiver subido.
  const panel = await openPanel(ctx, l.id);
  const worker = await ourWorker(ctx, l.id);
  return { loaded: { ctx, worker, panel, id: l.id, profile: l.profile, cdp }, persisted };
}

const tabs = async (l: Loaded) =>
  ((await l.cdp.send("Target.getTargets", { filter: [{ type: "tab" }] } as never)) as { targetInfos: Array<{ targetId: string; url: string }> }).targetInfos;

/**
 * Clique no ícone da extensão na aba com esta URL, como o usuário faria: `Extensions.triggerAction`
 * dispara `action.onClicked` com gesto e concede o activeTab de verdade (sondado no Edge 155).
 * QA-04 (F1-EXT-05c, 05c-1): antes do clique, espera até 5 s as abas de páginas http(s) dos testes anteriores
 * terminarem de fechar, para o clique nunca correr com o fechamento de outra aba.
 */
export async function clickAction(l: Loaded, url: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let open = await tabs(l);
  while (open.some((t) => t.url !== url && /^https?:/.test(t.url)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    open = await tabs(l);
  }
  const tab = open.find((t) => t.url === url);
  if (tab === undefined) throw new Error(`aba não encontrada: ${url}`);
  await l.cdp.send("Extensions.triggerAction" as never, { id: l.id, targetId: tab.targetId } as never);
}

/**
 * QA-04 (F1-EXT-05c, 05c-1): guarda no Service Worker, só no E2E, a mensagem de cada rejeição do `executeScript`, sem
 * URL. O código da captura nunca lê essa mensagem (pode trazer a URL da aba, ADR-024 D6); quem a lê é o teste, para
 * dizer por que uma captura deu `sem_acesso`. Instalado pelo teste depois do load, por `evaluate`: nada no build muda.
 */
export async function recordScriptRejections(l: Loaded): Promise<void> {
  await l.worker.evaluate(() => {
    const scope = globalThis as unknown as { chrome: { scripting: { executeScript: (i: unknown) => Promise<unknown> } }; __trampoScriptRejections?: string[] };
    if (scope.__trampoScriptRejections !== undefined) return;
    const rejections: string[] = [];
    scope.__trampoScriptRejections = rejections;
    const scripting = scope.chrome.scripting;
    const original = scripting.executeScript.bind(scripting);
    scripting.executeScript = async (injection) => {
      try {
        return await original(injection);
      } catch (error) {
        // Palavra com "://" vira <url>: a mensagem do navegador pode trazer a URL da aba.
        const words = String(error instanceof Error ? error.message : error).split(" ");
        rejections.push(words.map((word) => (word.includes("://") ? "<url>" : word)).join(" "));
        throw error;
      }
    };
  });
}

export const scriptRejections = (l: Loaded): Promise<string[]> =>
  l.worker.evaluate(() => [...((globalThis as unknown as { __trampoScriptRejections?: string[] }).__trampoScriptRejections ?? [])]);

export async function unload(l: Loaded | undefined): Promise<void> {
  if (l === undefined) return;
  l.tap?.close();
  await l.ctx.close().catch(() => undefined);
  rmSync(l.profile, { recursive: true, force: true });
}
