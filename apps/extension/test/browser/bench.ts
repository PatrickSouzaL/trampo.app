// Bancada do extrator no navegador real (ADR-023 D10). Cada execução:
// setContent → mundo isolado novo por CDP (o mesmo mecanismo do mundo ISOLATED do executeScript) →
// Runtime.evaluate da função SERIALIZADA, sem o módulo. A rede da página fica bloqueada.
// A cobertura de bloco do V8 de todas as execuções é unida para provar 100% do extrator.
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";

import { extractGenericJobText, type ExtractionLimits, type ExtractionResult } from "../../src/extraction/generic-extractor";

const DEFAULT_BROWSERS: Partial<Record<NodeJS.Platform, string>> = {
  win32: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  linux: "/usr/bin/microsoft-edge",
  darwin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
};

export const SOURCE = extractGenericJobText.toString();
export const LIMITS: ExtractionLimits = { maxChars: 30_000, maxNodes: 50_000, minChars: 1 };

/** Molde comum das fixtures: fundo branco, texto escuro, fonte de 16 px. */
export function page(body: string, head = ""): string {
  return (
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    "<style>body{margin:0;background:#fff;color:#111;font:16px/1.4 sans-serif}</style>" +
    `${head}</head><body>${body}</body></html>`
  );
}

interface CoverageRange {
  startOffset: number;
  endOffset: number;
  count: number;
}
interface FunctionCoverage {
  functionName: string;
  ranges: CoverageRange[];
}

export class Bench {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private cdp: CDPSession | undefined;
  /** covered[i] diz se o caractere i de SOURCE rodou em alguma execução. */
  readonly covered: boolean[] = new Array<boolean>(SOURCE.length).fill(false);

  async open(): Promise<void> {
    const executablePath = process.env["TRAMPO_E2E_BROWSER"] ?? DEFAULT_BROWSERS[process.platform];
    if (executablePath === undefined) throw new Error("Defina TRAMPO_E2E_BROWSER com o caminho do Edge ou do Chrome.");
    this.browser = await chromium.launch({ executablePath, headless: true });
    this.page = await this.browser.newPage({ viewport: { width: 1280, height: 800 } });
    // Fixture nunca sai para a rede: só o próprio documento (setContent) existe.
    await this.page.route("**/*", (route) => route.abort());
    this.cdp = await this.page.context().newCDPSession(this.page);
    await this.cdp.send("Profiler.enable");
    await this.cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }

  /** Página aberta, para conferir o mundo principal (página hostil). */
  get mainWorld(): Page {
    if (this.page === undefined) throw new Error("Bench.open() não foi chamado.");
    return this.page;
  }

  async run(html: string, limits: unknown = LIMITS): Promise<ExtractionResult> {
    const cdp = this.cdp;
    if (cdp === undefined) throw new Error("Bench.open() não foi chamado.");
    await this.mainWorld.setContent(html, { waitUntil: "load" });
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "trampo-extrator",
    });
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `(${SOURCE})(${JSON.stringify(limits)})`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails !== undefined) {
      throw new Error(`O extrator lançou no navegador: ${evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text}`);
    }
    await this.collectCoverage();
    return evaluated.result.value as ExtractionResult;
  }

  private async collectCoverage(): Promise<void> {
    const { result } = (await this.cdp?.send("Profiler.takePreciseCoverage")) as { result: { functions: FunctionCoverage[] }[] };
    const script = result.find((s) => s.functions.some((f) => f.functionName === "extractGenericJobText"));
    if (script === undefined) return;
    // A expressão é `(${SOURCE})(...)`: o extrator começa no deslocamento 1. Pinta do maior intervalo
    // para o menor, para que cada caractere fique com a contagem do bloco mais interno.
    const ranges = script.functions
      .flatMap((f) => f.ranges)
      .filter((r) => r.startOffset >= 1 && r.endOffset <= SOURCE.length + 1)
      .sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));
    const counts = new Array<number>(SOURCE.length).fill(0);
    for (const r of ranges) counts.fill(r.count, r.startOffset - 1, r.endOffset - 1);
    counts.forEach((c, i) => {
      if (c > 0) this.covered[i] = true;
    });
  }

  /** Trechos do extrator que nenhuma execução cobriu (ignora espaço e pontuação de fechamento). */
  uncovered(): string[] {
    const out: string[] = [];
    let start = -1;
    for (let i = 0; i <= SOURCE.length; i += 1) {
      const miss = i < SOURCE.length && !this.covered[i] && !/[\s{}();,]/.test(SOURCE.charAt(i));
      if (miss && start < 0) start = i;
      if (!miss && start >= 0) {
        const line = SOURCE.slice(0, start).split("\n").length;
        out.push(`linha ${line}: ${SOURCE.slice(start, i)}`);
        start = -1;
      }
    }
    return out;
  }
}
