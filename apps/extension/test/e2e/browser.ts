// Carrega o build de produção da extensão no Edge/Chrome instalado, num perfil descartável.
// Edge e Chrome de marca não aceitam mais --load-extension (Chrome 137+): a extensão entra por CDP
// Extensions.loadUnpacked. As flags abaixo valem só neste perfil de teste.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page, type Worker } from "playwright-core";

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
}

export interface LoadOptions {
  /**
   * Porta do chromiumapp local (ADR-004 §4.4): o `*.chromiumapp.org` vai para ele pelo --host-resolver-rules. O
   * navegador intercepta o retorno do login antes da rede, então o contador desse servidor tem de ficar em 0.
   */
  readonly chromiumappPort?: number;
}

export async function loadExtension(extDir: string, options: LoadOptions = {}): Promise<Loaded> {
  if (browserPath === undefined) throw new Error("Defina TRAMPO_E2E_BROWSER com o caminho do Edge ou do Chrome.");
  const rules = options.chromiumappPort === undefined ? [] : [`--host-resolver-rules=MAP *.chromiumapp.org 127.0.0.1:${options.chromiumappPort}`];
  const profile = mkdtempSync(join(tmpdir(), "trampo-e2e-profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: browserPath,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", "--ignore-certificate-errors", "--no-first-run", "--no-default-browser-check", ...rules],
  });
  const browser = ctx.browser();
  const cdp = browser === null ? await ctx.newCDPSession(ctx.pages()[0] ?? (await ctx.newPage())) : await browser.newBrowserCDPSession();
  const { id } = (await cdp.send("Extensions.loadUnpacked" as never, { path: extDir } as never)) as { id: string };

  const isOurs = (w: Worker) => w.url().startsWith(`chrome-extension://${id}/`);
  const worker = ctx.serviceWorkers().find(isOurs) ?? (await ctx.waitForEvent("serviceworker", { predicate: isOurs }));

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  return { ctx, worker, panel, id, profile, cdp };
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
  await l.ctx.close().catch(() => undefined);
  rmSync(l.profile, { recursive: true, force: true });
}
