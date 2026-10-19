// F1-EXT-01 (threat-model SR-02; ADR-001 §5.0.1): a CSP do build de PRODUÇÃO bloqueia, no navegador
// real, qualquer fetch fora da origem da API, tanto no Side Panel quanto no Service Worker.
// A prova não é só "o fetch rejeitou": o servidor de destino conta as requisições e precisa
// receber ZERO nos casos bloqueados (uma rejeição por TLS ou rede não passaria por bloqueio).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";

const DEFAULT_BROWSERS: Partial<Record<NodeJS.Platform, string>> = {
  win32: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  linux: "/usr/bin/microsoft-edge",
  darwin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
};
const browserPath = process.env["TRAMPO_E2E_BROWSER"] ?? DEFAULT_BROWSERS[process.platform];

const cfg = inject("e2e");

/** Servidor que só conta requisições e responde com CORS aberto (o bloqueio tem de vir da CSP). */
function countingHandler(counter: { hits: number }) {
  return (req: IncomingMessage, res: ServerResponse) => {
    counter.hits += 1;
    req.resume();
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end('{"ok":true}');
  };
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

type FetchOutcome = { ok: true; body: string } | { ok: false; error: string };

/** Mesmo código no Side Panel e no Service Worker: tenta o fetch e devolve o resultado. */
const tryFetch = async (url: string): Promise<FetchOutcome> => {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return { ok: true, body: await r.text() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.name : String(e) };
  }
};

interface Loaded {
  ctx: BrowserContext;
  worker: Worker;
  panel: Page;
  profile: string;
}

async function loadExtension(extDir: string): Promise<Loaded> {
  if (browserPath === undefined) throw new Error("Defina TRAMPO_E2E_BROWSER com o caminho do Edge ou do Chrome.");
  const profile = mkdtempSync(join(tmpdir(), "trampo-e2e-profile-"));
  // Edge e Chrome de marca não aceitam mais --load-extension (Chrome 137+): a extensão entra por
  // CDP Extensions.loadUnpacked. As duas flags abaixo valem só neste perfil descartável.
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: browserPath,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--enable-unsafe-extension-debugging",
      "--ignore-certificate-errors",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const browser = ctx.browser();
  const cdp = browser === null ? await ctx.newCDPSession(ctx.pages()[0] ?? (await ctx.newPage())) : await browser.newBrowserCDPSession();
  const { id } = (await cdp.send("Extensions.loadUnpacked" as never, { path: extDir } as never)) as { id: string };

  const worker =
    ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${id}/`)) ??
    (await ctx.waitForEvent("serviceworker", { predicate: (w) => w.url().startsWith(`chrome-extension://${id}/`) }));

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  return { ctx, worker, panel, profile };
}

async function unload(l: Loaded | undefined): Promise<void> {
  if (l === undefined) return;
  await l.ctx.close().catch(() => undefined);
  rmSync(l.profile, { recursive: true, force: true });
}

const api = { hits: 0 };
const otherHttps = { hits: 0 };
const otherHttp = { hits: 0 };
const servers: Server[] = [];
let otherHttpsUrl = "";
let otherHttpUrl = "";

beforeAll(async () => {
  const tls = { cert: readFileSync(cfg.certPem), key: readFileSync(cfg.keyPem) };
  const apiServer = createHttpsServer(tls, countingHandler(api));
  const otherHttpsServer = createHttpsServer(tls, countingHandler(otherHttps));
  const otherHttpServer = createHttpServer(countingHandler(otherHttp));
  servers.push(apiServer, otherHttpsServer, otherHttpServer);
  await listen(apiServer, cfg.apiPort);
  // Mesmo host da API, outra porta: é outra origem e também tem de ser bloqueada.
  otherHttpsUrl = `https://localhost:${await listen(otherHttpsServer)}/exfil`;
  otherHttpUrl = `http://127.0.0.1:${await listen(otherHttpServer)}/exfil`;
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

function resetCounters(): void {
  api.hits = 0;
  otherHttps.hits = 0;
  otherHttp.hits = 0;
}

describe("build de produção sem TRAMPO_API_ORIGIN (connect-src 'none')", () => {
  let l: Loaded | undefined;
  beforeAll(async () => {
    l = await loadExtension(cfg.extNoOrigin);
  });
  afterAll(() => unload(l));

  for (const where of ["Service Worker", "Side Panel"] as const) {
    test(`${where}: nenhum fetch sai, nem para a "API"`, async () => {
      resetCounters();
      const run = (url: string) => (where === "Service Worker" ? l!.worker.evaluate(tryFetch, url) : l!.panel.evaluate(tryFetch, url));
      for (const url of [`${cfg.apiOrigin}/v1/health`, otherHttpsUrl, otherHttpUrl]) {
        expect(await run(url), url).toEqual({ ok: false, error: "TypeError" });
      }
      expect({ api: api.hits, otherHttps: otherHttps.hits, otherHttp: otherHttp.hits }).toEqual({ api: 0, otherHttps: 0, otherHttp: 0 });
    });
  }

  test("Side Panel: o bloqueio é da CSP (evento securitypolicyviolation em connect-src)", async () => {
    const directive = await l!.panel.evaluate(async (url) => {
      // Prazo curto: sem violação (CSP afrouxada), falha em 5 s em vez de esperar o timeout do teste.
      const seen = new Promise<string>((resolve) => {
        document.addEventListener("securitypolicyviolation", (e) => resolve(e.effectiveDirective), { once: true });
        setTimeout(() => resolve("nenhuma violação em 5 s"), 5000);
      });
      await fetch(url).catch(() => undefined);
      return seen;
    }, otherHttpUrl);
    expect(directive).toBe("connect-src");
  });
});

describe(`build de produção com TRAMPO_API_ORIGIN (só a origem da API passa)`, () => {
  let l: Loaded | undefined;
  beforeAll(async () => {
    l = await loadExtension(cfg.extWithOrigin);
  });
  afterAll(() => unload(l));

  for (const where of ["Service Worker", "Side Panel"] as const) {
    test(`${where}: a API responde e o resto é bloqueado`, async () => {
      resetCounters();
      const run = (url: string) => (where === "Service Worker" ? l!.worker.evaluate(tryFetch, url) : l!.panel.evaluate(tryFetch, url));
      expect(await run(`${cfg.apiOrigin}/v1/health`)).toEqual({ ok: true, body: '{"ok":true}' });
      expect(await run(otherHttpsUrl), otherHttpsUrl).toEqual({ ok: false, error: "TypeError" });
      expect(await run(otherHttpUrl), otherHttpUrl).toEqual({ ok: false, error: "TypeError" });
      expect({ api: api.hits, otherHttps: otherHttps.hits, otherHttp: otherHttp.hits }).toEqual({ api: 1, otherHttps: 0, otherHttp: 0 });
    });
  }
});
