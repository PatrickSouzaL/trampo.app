// Prepara o E2E: dois builds de PRODUÇÃO, o certificado autoassinado e o IdP falso (ADR-004 §4.4; F1-EXT-05c, 05c-1).
// - "fechado": sem nenhuma variável (connect-src 'none', sem key, login sem configuração);
// - "auth": as duas origens locais e a `key` de uma chave RSA efêmera, gerada aqui em memória. Só a parte pública sai
//   do processo (o campo `key` do manifesto), e o ID que o Chromium deriva dela é conhecido antes do launch (P17).
// O BFF falso (47443) e o Supabase falso (47444) sobem aqui, num só processo, porque o `authorize` guarda o challenge
// que a troca confere. O chromiumapp local recebe o `*.chromiumapp.org` do --host-resolver-rules e tem de ficar em 0.
// Os testes leem e zeram o estado pelo canal de controle (HTTP em 127.0.0.1, com segredo). Tudo some no fim.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type Server, createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { build } from "wxt";

import { extensionIdFromSpki } from "../../build-env";
import { type Handler, createFakeEnvironment } from "./support/fake-servers";

/** Portas fixas: as origens entram no build. */
export const E2E_API_PORT = Number(process.env["TRAMPO_E2E_API_PORT"] ?? "47443");
export const E2E_SUPABASE_PORT = Number(process.env["TRAMPO_E2E_SUPABASE_PORT"] ?? "47444");

declare module "vitest" {
  export interface ProvidedContext {
    e2e: {
      extNoOrigin: string;
      /** Build com as duas origens e a chave efêmera. */
      extAuth: string;
      /** O ID derivado da chave efêmera (P17). */
      extensionId: string;
      apiOrigin: string;
      supabaseOrigin: string;
      certPem: string;
      keyPem: string;
      chromiumappPort: number;
      control: { url: string; token: string };
    };
  }
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const BUILD_VARS = ["TRAMPO_API_ORIGIN", "TRAMPO_SUPABASE_ORIGIN", "TRAMPO_EXTENSION_KEY"] as const;

async function buildVariant(outDir: string, vars: Partial<Record<(typeof BUILD_VARS)[number], string>>): Promise<string> {
  const previous = new Map([...BUILD_VARS, "NODE_ENV"].map((name) => [name, process.env[name]]));
  const assign = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  for (const name of BUILD_VARS) assign(name, vars[name]);
  // O vitest define NODE_ENV=test, e o Vite respeita um NODE_ENV já definido: sem isto, o build sairia com o React de
  // desenvolvimento (StrictMode rodando os efeitos duas vezes), e não o da loja (ADR-025 D6).
  assign("NODE_ENV", "production");
  try {
    await build({ root, outDir, mode: "production" });
  } finally {
    for (const [name, value] of previous) assign(name, value);
  }
  return join(outDir, "chrome-mv3");
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const work = mkdtempSync(join(tmpdir(), "trampo-e2e-"));
  const apiOrigin = `https://localhost:${E2E_API_PORT}`;
  const supabaseOrigin = `https://localhost:${E2E_SUPABASE_PORT}`;

  // Chave efêmera: a privada nunca é exportada nem gravada; o Chromium só precisa da pública para o ID (P17).
  const spki = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" });
  const extensionId = extensionIdFromSpki(spki);

  const extNoOrigin = await buildVariant(join(work, "no-origin"), {});
  const extAuth = await buildVariant(join(work, "auth"), {
    TRAMPO_API_ORIGIN: apiOrigin,
    TRAMPO_SUPABASE_ORIGIN: supabaseOrigin,
    TRAMPO_EXTENSION_KEY: spki.toString("base64"),
  });

  // Certificado só para o teste (CN=localhost, 1 dia). Nunca sai da pasta temporária.
  const certPem = join(work, "cert.pem");
  const keyPem = join(work, "key.pem");
  const openssl = process.env["TRAMPO_OPENSSL"] ?? "openssl";
  execFileSync(
    openssl,
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", keyPem, "-out", certPem],
    { stdio: "ignore" },
  );

  const token = randomBytes(32).toString("hex");
  const fakes = createFakeEnvironment({ extensionId, now: Date.now, controlToken: token });
  const tls = { cert: readFileSync(certPem), key: readFileSync(keyPem) };
  const https = (handler: Handler) => createHttpsServer(tls, handler);
  const servers = [https(fakes.bff), https(fakes.supabase), https(fakes.chromiumapp), createHttpServer(fakes.control)] as const;
  const [bff, supabase, chromiumapp, control] = servers;
  await listen(bff, E2E_API_PORT);
  await listen(supabase, E2E_SUPABASE_PORT);
  const chromiumappPort = await listen(chromiumapp, 0);
  const controlPort = await listen(control, 0);

  project.provide("e2e", {
    extNoOrigin,
    extAuth,
    extensionId,
    apiOrigin,
    supabaseOrigin,
    certPem,
    keyPem,
    chromiumappPort,
    control: { url: `http://127.0.0.1:${controlPort}`, token },
  });
  return async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    rmSync(work, { recursive: true, force: true });
  };
}
