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
const browserPath = process.env["TRAMPO_E2E_BROWSER"] ?? DEFAULT_BROWSERS[process.platform];

export interface Loaded {
  ctx: BrowserContext;
  worker: Worker;
  panel: Page;
  id: string;
  profile: string;
  /** Sessão CDP do navegador (Extensions.*, Target.*). */
  cdp: CDPSession;
}

export async function loadExtension(extDir: string): Promise<Loaded> {
  if (browserPath === undefined) throw new Error("Defina TRAMPO_E2E_BROWSER com o caminho do Edge ou do Chrome.");
  const profile = mkdtempSync(join(tmpdir(), "trampo-e2e-profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: browserPath,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", "--ignore-certificate-errors", "--no-first-run", "--no-default-browser-check"],
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

/**
 * Clique no ícone da extensão na aba com esta URL, como o usuário faria: `Extensions.triggerAction`
 * dispara `action.onClicked` com gesto e concede o activeTab de verdade (sondado no Edge 155).
 */
export async function clickAction(l: Loaded, url: string): Promise<void> {
  const { targetInfos } = (await l.cdp.send("Target.getTargets", { filter: [{ type: "tab" }] } as never)) as {
    targetInfos: Array<{ targetId: string; url: string }>;
  };
  const tab = targetInfos.find((t) => t.url === url);
  if (tab === undefined) throw new Error(`aba não encontrada: ${url}`);
  await l.cdp.send("Extensions.triggerAction" as never, { id: l.id, targetId: tab.targetId } as never);
}

export async function unload(l: Loaded | undefined): Promise<void> {
  if (l === undefined) return;
  await l.ctx.close().catch(() => undefined);
  rmSync(l.profile, { recursive: true, force: true });
}
