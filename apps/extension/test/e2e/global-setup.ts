// Prepara o E2E de CSP: dois builds de PRODUÇÃO (sem e com TRAMPO_API_ORIGIN) e um certificado
// autoassinado para o servidor HTTPS local. Tudo em uma pasta temporária, apagada no fim.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { build } from "wxt";

/** Porta fixa da "API" no E2E: a origem precisa estar no manifesto na hora do build. */
export const E2E_API_PORT = Number(process.env["TRAMPO_E2E_API_PORT"] ?? "47443");

declare module "vitest" {
  export interface ProvidedContext {
    e2e: {
      extNoOrigin: string;
      extWithOrigin: string;
      apiOrigin: string;
      apiPort: number;
      certPem: string;
      keyPem: string;
    };
  }
}

const root = fileURLToPath(new URL("../../", import.meta.url));

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function buildVariant(outDir: string, apiOrigin: string | undefined): Promise<string> {
  const previousOrigin = process.env["TRAMPO_API_ORIGIN"];
  // O vitest define NODE_ENV=test, e o Vite respeita um NODE_ENV já definido: sem isto, o build sairia
  // com o React de desenvolvimento (StrictMode rodando os efeitos duas vezes), e não o da loja (ADR-025 D6).
  const previousNodeEnv = process.env["NODE_ENV"];
  setEnv("TRAMPO_API_ORIGIN", apiOrigin);
  setEnv("NODE_ENV", "production");
  try {
    await build({ root, outDir, mode: "production" });
  } finally {
    setEnv("TRAMPO_API_ORIGIN", previousOrigin);
    setEnv("NODE_ENV", previousNodeEnv);
  }
  return join(outDir, "chrome-mv3");
}

export default async function setup(project: TestProject): Promise<() => void> {
  const work = mkdtempSync(join(tmpdir(), "trampo-e2e-"));
  const apiOrigin = `https://localhost:${E2E_API_PORT}`;

  const extNoOrigin = await buildVariant(join(work, "no-origin"), undefined);
  const extWithOrigin = await buildVariant(join(work, "with-origin"), apiOrigin);

  // Certificado só para o teste (CN=localhost, 1 dia). Nunca sai da pasta temporária.
  const certPem = join(work, "cert.pem");
  const keyPem = join(work, "key.pem");
  const openssl = process.env["TRAMPO_OPENSSL"] ?? "openssl";
  execFileSync(
    openssl,
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", keyPem, "-out", certPem],
    { stdio: "ignore" },
  );

  project.provide("e2e", { extNoOrigin, extWithOrigin, apiOrigin, apiPort: E2E_API_PORT, certPem, keyPem });
  return () => rmSync(work, { recursive: true, force: true });
}
