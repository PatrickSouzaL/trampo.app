// F1-EXT-01 (threat-model SR-02; ADR-001 §5.0.1): a CSP do build de PRODUÇÃO bloqueia, no navegador
// real, qualquer fetch fora da origem da API, tanto no Side Panel quanto no Service Worker.
// A prova não é só "o fetch rejeitou": o servidor de destino conta as requisições e precisa
// receber ZERO nos casos bloqueados (uma rejeição por TLS ou rede não passaria por bloqueio).
// F1-EXT-05b, 05b-1 (ADR-004 D10 B4 e §4.5 item 5): a meta CSP do painel tira dele toda rede, inclusive a API, e o
// envio de formulário; o Service Worker continua alcançando só a API. Puxado da F1-EXT-05c porque a meta entra aqui.
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";

import { loadExtension, unload, type Loaded } from "./browser";

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

/** Espera a 1ª violação de CSP da página depois da ação (prazo curto: sem violação, devolve o aviso em 5 s). */
const violationAfter = async ([action, url]: ["fetch" | "form" | "base", string]): Promise<string> => {
  const seen = new Promise<string>((resolve) => {
    document.addEventListener("securitypolicyviolation", (e) => resolve(e.effectiveDirective), { once: true });
    setTimeout(() => resolve("nenhuma violação em 5 s"), 5000);
  });
  if (action === "fetch") await fetch(url).catch(() => undefined);
  if (action === "form") {
    const form = document.createElement("form");
    form.method = "post";
    form.action = url;
    document.body.append(form);
    form.submit();
  }
  if (action === "base") {
    const base = document.createElement("base");
    base.href = url;
    document.head.append(base);
  }
  return seen;
};

describe(`build de produção com TRAMPO_API_ORIGIN (só o Service Worker alcança, e só a API)`, () => {
  let l: Loaded | undefined;
  beforeAll(async () => {
    l = await loadExtension(cfg.extWithOrigin);
  });
  afterAll(() => unload(l));

  test("Service Worker: a API responde e o resto é bloqueado", async () => {
    resetCounters();
    expect(await l!.worker.evaluate(tryFetch, `${cfg.apiOrigin}/v1/health`)).toEqual({ ok: true, body: '{"ok":true}' });
    expect(await l!.worker.evaluate(tryFetch, otherHttpsUrl), otherHttpsUrl).toEqual({ ok: false, error: "TypeError" });
    expect(await l!.worker.evaluate(tryFetch, otherHttpUrl), otherHttpUrl).toEqual({ ok: false, error: "TypeError" });
    expect({ api: api.hits, otherHttps: otherHttps.hits, otherHttp: otherHttp.hits }).toEqual({ api: 1, otherHttps: 0, otherHttp: 0 });
  });

  test("Side Panel: nenhum fetch sai, nem para a API que o manifesto libera (meta CSP do B4)", async () => {
    resetCounters();
    for (const url of [`${cfg.apiOrigin}/v1/health`, `${cfg.apiOrigin}/v1/auth/refresh`, otherHttpsUrl, otherHttpUrl]) {
      expect(await l!.panel.evaluate(tryFetch, url), url).toEqual({ ok: false, error: "TypeError" });
    }
    expect({ api: api.hits, otherHttps: otherHttps.hits, otherHttp: otherHttp.hits }).toEqual({ api: 0, otherHttps: 0, otherHttp: 0 });
  });

  test("Side Panel: o bloqueio da API é da meta (securitypolicyviolation em connect-src), com 0 hits", async () => {
    resetCounters();
    expect(await l!.panel.evaluate(violationAfter, ["fetch", `${cfg.apiOrigin}/v1/health`] as ["fetch", string])).toBe("connect-src");
    expect(api.hits).toBe(0);
  });

  test("Side Panel: envio de formulário barrado por form-action, com 0 hits", async () => {
    resetCounters();
    expect(await l!.panel.evaluate(violationAfter, ["form", `${cfg.apiOrigin}/v1/auth/logout`] as ["form", string])).toBe("form-action");
    expect(api.hits).toBe(0);
  });

  test("Side Panel: <base> barrado por base-uri", async () => {
    expect(await l!.panel.evaluate(violationAfter, ["base", `${cfg.apiOrigin}/`] as ["base", string])).toBe("base-uri");
  });

  test("Side Panel: sink de HTML e política de Trusted Types lançam (require-trusted-types-for e trusted-types 'none')", async () => {
    const outcome = await l!.panel.evaluate(() => {
      const attempt = (f: () => void): string => {
        try {
          f();
          return "passou";
        } catch (e) {
          return e instanceof Error ? e.name : String(e);
        }
      };
      return {
        innerHTML: attempt(() => {
          // eslint-disable-next-line no-restricted-syntax -- a prova é justamente o sink barrado pelo Trusted Types
          document.createElement("div").innerHTML = "<b>CANARIO</b>";
        }),
        createPolicy: attempt(() => {
          // A lib DOM do TypeScript ainda não tipa o window.trustedTypes do Chromium.
          const tt = (globalThis as unknown as { trustedTypes?: { createPolicy(name: string, rules: { createHTML(s: string): string }): unknown } }).trustedTypes;
          tt?.createPolicy("trampo-e2e", { createHTML: (s) => s });
        }),
      };
    });
    expect(outcome).toEqual({ innerHTML: "TypeError", createPolicy: "TypeError" });
  });

  test("o painel real segue renderizando com a meta (React só com texto, sem política de Trusted Types)", async () => {
    await expect.poll(() => l!.panel.locator("[data-connection]").getAttribute("data-connection"), { timeout: 5000 }).toBe("pronto");
  });
});
