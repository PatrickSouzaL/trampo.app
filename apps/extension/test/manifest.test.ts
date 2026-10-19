// Auditoria do manifesto GERADO pelo build de produção (ADR-001 §5.0.1; threat-model SR-02).
// Roda depois do `wxt build` (apps/extension/turbo.json). Qualquer permissão nova quebra aqui de
// propósito: ampliar privilégio exige revisão do [APPSEC] e a atualização deste teste.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const outDir = fileURLToPath(new URL("../.output/chrome-mv3/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${outDir}manifest.json`, "utf8")) as Record<string, unknown>;
const background = readFileSync(`${outDir}background.js`, "utf8");

describe("manifest.json de produção", () => {
  test("MV3 e Chrome mínimo 116 (sidePanel.open com gesto)", () => {
    expect(manifest["manifest_version"]).toBe(3);
    expect(manifest["minimum_chrome_version"]).toBe("116");
  });

  test("permissões exatas: nada além de activeTab, scripting, sidePanel e storage", () => {
    expect([...(manifest["permissions"] as string[])].sort()).toEqual(["activeTab", "scripting", "sidePanel", "storage"]);
  });

  test("sem acesso amplo a sites", () => {
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
  });

  test("ação sem popup (o clique precisa disparar action.onClicked e conceder activeTab)", () => {
    expect(manifest["action"]).toBeTypeOf("object");
    expect(manifest["action"]).not.toHaveProperty("default_popup");
  });

  test("externally_connectable declarado e vazio (omitir liberaria todas as extensões, D-H7)", () => {
    expect(manifest["externally_connectable"]).toEqual({ ids: [], matches: [] });
  });

  test("CSP de loja: só 'self' para scripts e connect-src fechado ou na origem da API", () => {
    const csp = (manifest["content_security_policy"] as { extension_pages: string }).extension_pages;
    expect(csp).toMatch(/(^|; )script-src 'self'(;|$)/);
    expect(csp).toMatch(/(^|; )object-src 'self'(;|$)/);
    expect(csp).toMatch(/(^|; )default-src 'self'(;|$)/);
    expect(csp).toMatch(/(^|; )connect-src ('none'|https:\/\/[a-z0-9.-]+(:\d{1,5})?)$/);
    // Nada da CSP de desenvolvimento (HMR do WXT) no build de loja.
    expect(csp).not.toMatch(/localhost|127\.0\.0\.1|unsafe-eval|unsafe-inline|wasm-unsafe-eval|ws:|http:/);
  });

  test("sem web_accessible_resources (nenhum recurso da extensão exposto às páginas)", () => {
    expect(manifest).not.toHaveProperty("web_accessible_resources");
  });
});

describe("Service Worker gerado", () => {
  test("não registra handler do evento fetch (crbug 1463420)", () => {
    expect(background).not.toMatch(/addEventListener\(\s*[`'"]fetch[`'"]/);
    expect(background).not.toMatch(/\bonfetch\s*=/);
  });

  test("força openPanelOnActionClick: false e abre o painel no clique", () => {
    expect(background).toMatch(/setPanelBehavior\(\{openPanelOnActionClick:!1\}\)/);
    expect(background).toContain("sidePanel.open(");
  });

  test("sem eval nem código remoto", () => {
    expect(background).not.toMatch(/\beval\(|new Function\(|importScripts\(/);
  });
});
