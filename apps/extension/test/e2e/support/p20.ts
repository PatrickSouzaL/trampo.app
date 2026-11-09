// Modo do headless do P20 (ADR-004 §4.4), fixo por navegador e nunca escolhido em runtime. Sondado em 2026-11-09
// (F1-EXT-05c, 05c-1) com o build de produção, a chave efêmera e o 302 imediato do Supabase falso, em headless: o
// `launchWebAuthFlow({ interactive: true })` real resolveu no Edge 157.0.4341.42 (53 ms) e no Chrome 156.0.8078.80
// (73 ms), sem janela nova e com 0 pedidos no chromiumapp local. Os dois ficam no modo 1, e o modo 3 (adapter falso
// da AuthCodeSource) não tem código: o build recusa TRAMPO_E2E_FAKE_IDENTITY (build-env.ts). Navegador novo, ou um
// destes que mude de modo, passa por sondagem nova e emenda do §4.4 antes de rodar o E2E de login.
import { basename } from "node:path";

export type P20Mode = 1 | 2 | 3;
export type Brand = "edge" | "chrome";

export const P20_MODES: Readonly<Record<Brand, P20Mode>> = Object.freeze({ edge: 1, chrome: 1 });

/** A marca pelo nome do executável (Windows, Linux e macOS); outro nome não tem modo fixado. */
export function browserBrand(executablePath: string): Brand | undefined {
  const name = basename(executablePath).toLowerCase();
  if (/^(msedge(\.exe)?|microsoft-edge(-[a-z]+)?|microsoft edge)$/.test(name)) return "edge";
  if (/^(chrome(\.exe)?|google-chrome(-[a-z]+)?|google chrome)$/.test(name)) return "chrome";
  return undefined;
}

export function p20ModeFor(executablePath: string): P20Mode {
  const brand = browserBrand(executablePath);
  if (brand === undefined) throw new Error("navegador sem modo do P20 fixado: sonde e registre no ADR-004 §4.4 antes do E2E de login");
  return P20_MODES[brand];
}
