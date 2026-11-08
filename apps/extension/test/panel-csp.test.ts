// F1-EXT-05b, 05b-1 (ADR-004 D10 B4; P16): a meta CSP das páginas da extensão sai só no `mode` de produção, que é o
// do build de loja e o do E2E. O dev do WXT (HMR por WebSocket com o servidor local) nunca a recebe. O build real é
// provado no manifest.test.ts, nos dois builds de produção.
import type { Plugin } from "vite";
import { describe, expect, test } from "vitest";
import type { ConfigEnv } from "wxt";

import { PANEL_CSP, panelCspPlugin } from "../panel-csp";
import config from "../wxt.config";

const B4 = "connect-src 'none'; form-action 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
const META = [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: B4 }, injectTo: "head-prepend" }];

function tagsOf(plugin: Plugin | undefined): unknown {
  const hook = plugin?.transformIndexHtml;
  if (typeof hook !== "function") throw new Error("o plugin expõe o transformIndexHtml como função");
  return hook.call({} as never, "<!doctype html><html><head></head><body></body></html>", {} as never);
}

const tagsFor = (mode: string): unknown => tagsOf(panelCspPlugin(mode));

/** O plugin como o wxt.config.ts o monta: o `wxt` (dev, com HMR) roda em "development", e o `wxt build` em "production". */
async function tagsFromConfig(env: Pick<ConfigEnv, "mode" | "command">): Promise<unknown> {
  const vite = await config.vite?.({ ...env, browser: "chrome", manifestVersion: 3 });
  const csp = ((vite?.plugins ?? []) as Plugin[]).filter((plugin) => plugin.name === "trampo:panel-csp");
  expect(csp).toHaveLength(1);
  return tagsOf(csp[0]);
}

describe("meta CSP das páginas da extensão (ADR-004 D10 B4)", () => {
  test("a política é exatamente a do B4, com as 5 diretivas", () => {
    expect(PANEL_CSP).toBe(B4);
  });

  test("no mode de produção, uma meta http-equiv no início do head, antes de qualquer script", () => {
    expect(tagsFor("production")).toStrictEqual(META);
  });

  test("o wxt.config.ts passa o mode do comando ao plugin: o dev do WXT nunca recebe a meta, e o build sempre", async () => {
    expect(await tagsFromConfig({ mode: "development", command: "serve" })).toStrictEqual([]);
    expect(await tagsFromConfig({ mode: "production", command: "build" })).toStrictEqual(META);
  });

  test.each(["development", "test", "", "Production", "production "])("no mode %j, nenhuma meta (o HMR do dev precisa do WebSocket)", (mode) => {
    expect(tagsFor(mode)).toStrictEqual([]);
  });

  test("o plugin tem nome próprio e não roda em outra fase", () => {
    const plugin = panelCspPlugin("production");
    expect(plugin.name).toBe("trampo:panel-csp");
    expect(Object.keys(plugin).sort()).toStrictEqual(["name", "transformIndexHtml"]);
  });
});
