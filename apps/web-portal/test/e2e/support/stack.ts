// A pilha do E2E do portal (ADR-027 §7): o GoTrue simulado do portal, o `next start` do build e o navegador do sistema,
// tudo em 127.0.0.1. Molde do harness da extensão, reescrito aqui (o portal não importa a extensão).
// - O `next start` recebe um ambiente fechado, só com origens de loopback; o anel de selo é efêmero.
// - O navegador sobe pelo `chromium.launch` do playwright-core: transporte por pipe (nenhuma porta de depuração),
//   contexto novo por teste e perfil temporário apagado no `close`. Sem download de navegador e sem TLS.
// - Duas origens a mais, em outras portas: a que tenta pôr o portal num iframe e a do controle (página sem cabeçalho).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright-core";

import { startFakeGotrue, type FakeGotrue } from "../../support/fake-gotrue";

const DEFAULT_BROWSERS: Partial<Record<NodeJS.Platform, string>> = {
  win32: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  linux: "/usr/bin/microsoft-edge",
  darwin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
};
export const browserPath = process.env["TRAMPO_E2E_BROWSER"] ?? DEFAULT_BROWSERS[process.platform];

export const APP = fileURLToPath(new URL("../../../", import.meta.url));
const NEXT_BIN = join(APP, "node_modules", "next", "dist", "bin", "next");
const PUBLISHABLE = ["sb", "publishable", "e".repeat(24)].join("_");
/** O `kid` do anel efêmero (entra na conta do tamanho do access do runbook `auth-portal`). */
export const SEAL_KID = "e2e";
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export interface Stack {
  readonly portal: string;
  readonly fake: FakeGotrue;
  /** Origem que tenta pôr o portal (`/portal`) ou a página de controle (`/controle`) num iframe. */
  readonly framer: string;
  readonly browser: Browser;
  /** Tudo que o processo do `next start` escreveu até agora. */
  output(): string;
  close(): Promise<void>;
}

async function listen(handler: RequestListener): Promise<{ server: Server; origin: string }> {
  const server = createHttpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

async function freePort(): Promise<number> {
  const { server, origin } = await listen(() => undefined);
  await closeServer(server);
  return Number(new URL(origin).port);
}

const html =
  (body: string): RequestListener =>
  (_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body>${body}</body></html>`);
  };

/** Sobe o `next start` com o ambiente fechado e espera responder. Recusa qualquer origem fora do loopback. */
async function startNext(port: number, env: Readonly<Record<string, string>>, sink: (chunk: string) => void): Promise<ChildProcess> {
  for (const name of ["PORTAL_ORIGIN", "SUPABASE_URL"]) {
    if (!LOOPBACK_ORIGIN.test(env[name] ?? "")) throw new Error(`o E2E só sobe o portal com origens de loopback (${name})`);
  }
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: APP,
    env: { PATH: process.env["PATH"], SYSTEMROOT: process.env["SYSTEMROOT"], NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => sink(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => sink(chunk.toString("utf8")));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(`${env["PORTAL_ORIGIN"]}/favicon.ico`);
      return child;
    } catch {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error("o next start não subiu em 60 s");
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

export async function startStack(): Promise<Stack> {
  if (browserPath === undefined) throw new Error("Defina TRAMPO_E2E_BROWSER com o caminho do Edge ou do Chrome.");
  const port = await freePort();
  const portal = `http://127.0.0.1:${port}`;
  const fake = await startFakeGotrue({ publishableKey: PUBLISHABLE, allowedRedirects: [`${portal}/auth/retorno`] });
  // O controle do iframe: outra origem, página sem nenhum cabeçalho de segurança.
  const open = await listen(html('<p id="aberta">CONTROLE-ABERTO</p>'));
  const framer = await listen((request, response) => {
    const target = request.url === "/portal" ? `${portal}/` : request.url === "/controle" ? `${open.origin}/` : null;
    if (target === null) {
      response.writeHead(404);
      response.end();
      return;
    }
    html(`<iframe id="moldura" src="${target}" width="600" height="400"></iframe>`)(request, response);
  });
  let output = "";
  const next = await startNext(
    port,
    {
      PORTAL_ORIGIN: portal,
      SUPABASE_URL: fake.url.origin,
      SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
      PORTAL_SEAL_KEYS: `${SEAL_KID}:${randomBytes(32).toString("base64url")}`,
      PORTAL_SEAL_ACTIVE_KEY: SEAL_KID,
    },
    (chunk) => (output += chunk),
  ).catch(async (error: unknown) => {
    await Promise.all([fake.close(), closeServer(open.server), closeServer(framer.server)]);
    throw error;
  });
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-first-run", "--no-default-browser-check"] });
  return {
    portal,
    fake,
    framer: framer.origin,
    browser,
    output: () => output,
    async close() {
      await browser.close().catch(() => undefined);
      next.kill();
      await Promise.all([fake.close(), closeServer(open.server), closeServer(framer.server)]);
    },
  };
}

/** Uma aba num contexto novo, com os coletores das provas (ADR-027 §7). */
export interface Tab {
  readonly context: BrowserContext;
  readonly page: Page;
  /** `tipo: texto` de cada mensagem de console. */
  readonly console: string[];
  readonly pageErrors: string[];
  /** Toda URL pedida pelo contexto e toda URL navegada pela aba. */
  readonly urls: string[];
  /** O HTML e o corpo de todo script vindos do portal. */
  readonly bodies: string[];
  /** O valor de todo `Set-Cookie` recebido do portal. */
  readonly cookieValues: string[];
  /** Espera os corpos e cabeçalhos ainda em leitura. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export async function openTab(stack: Stack): Promise<Tab> {
  const context = await stack.browser.newContext();
  const page = await context.newPage();
  const tab = { console: [] as string[], pageErrors: [] as string[], urls: [] as string[], bodies: [] as string[], cookieValues: [] as string[] };
  const pending: Array<Promise<void>> = [];
  const collect = async (response: Response): Promise<void> => {
    if (!response.url().startsWith(`${stack.portal}/`)) return;
    for (const line of (await response.headerValue("set-cookie"))?.split("\n") ?? []) {
      const pair = line.split(";")[0] ?? "";
      const value = pair.slice(pair.indexOf("=") + 1);
      if (value.length > 0) tab.cookieValues.push(value);
    }
    const type = response.request().resourceType();
    if (type !== "document" && type !== "script") return;
    // Resposta de redirecionamento não tem corpo.
    const body = await response.text().catch(() => null);
    if (body !== null) tab.bodies.push(body);
  };
  context.on("request", (request) => tab.urls.push(request.url()));
  context.on("response", (response) => void pending.push(collect(response)));
  page.on("framenavigated", (frame) => tab.urls.push(frame.url()));
  page.on("console", (message) => tab.console.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => tab.pageErrors.push(String(error)));
  return {
    context,
    page,
    ...tab,
    async settle() {
      await Promise.all(pending);
    },
    close: () => context.close(),
  };
}

/** Os segredos do texto, crus ou codificados para URL, na ordem da lista. */
export function secretsIn(haystack: string, secrets: Iterable<string>): string[] {
  return [...secrets].filter((secret) => haystack.includes(secret) || haystack.includes(encodeURIComponent(secret)));
}

/** As mensagens de console que falam de CSP (bloqueio de script, de estilo ou de moldura). */
export const cspMessages = (tab: Tab): string[] => tab.console.filter((line) => /Content Security Policy|Refused to/i.test(line));
