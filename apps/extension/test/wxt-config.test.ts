// F1-EXT-06 (ADR-004 §4.6): a ligação do wxt.config.ts. As variáveis do build vêm do `loadBuildEnv`, com o `process.env`
// e o `.env` fixo ao lado do wxt.config.ts: nenhuma variável escolhe outro arquivo. O leitor em si é provado no
// build-env.test.ts, e o build real com um `.env` de teste, no manifest.test.ts.
import { fileURLToPath } from "node:url";

import { expect, test, vi } from "vitest";

import type * as BuildEnvModule from "../build-env";

const loadBuildEnv = vi.hoisted(() => vi.fn(() => ({ apiOrigin: "https://api.ligacao.test", supabaseOrigin: undefined, extensionKey: undefined })));
vi.mock("../build-env", async (importOriginal) => ({ ...(await importOriginal<typeof BuildEnvModule>()), loadBuildEnv }));

test("o wxt.config.ts lê as variáveis pelo loadBuildEnv, com o process.env e o .env fixo ao lado dele, e as entrega à configuração", async () => {
  const { default: config } = await import("../wxt.config");
  expect(loadBuildEnv).toHaveBeenCalledTimes(1);
  expect(loadBuildEnv).toHaveBeenCalledWith(process.env, fileURLToPath(new URL("../.env", import.meta.url)));
  const manifest = typeof config.manifest === "function" ? await config.manifest({ mode: "production", command: "build", browser: "chrome", manifestVersion: 3 }) : undefined;
  expect(manifest?.content_security_policy).toStrictEqual({
    extension_pages: "script-src 'self'; object-src 'self'; default-src 'self'; connect-src https://api.ligacao.test",
  });
});

test("os testes de unidade rodam isolados do .env do desenvolvedor: leitura desligada e variáveis do build vazias", () => {
  expect(process.env["TRAMPO_IGNORE_DOTENV"]).toBe("1");
  for (const name of ["TRAMPO_API_ORIGIN", "TRAMPO_SUPABASE_ORIGIN", "TRAMPO_EXTENSION_KEY", "TRAMPO_E2E", "TRAMPO_E2E_FAKE_IDENTITY"]) {
    expect(process.env[name], name).toBe("");
  }
});
