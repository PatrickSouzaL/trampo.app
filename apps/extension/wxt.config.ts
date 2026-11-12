import { fileURLToPath } from "node:url";

import { defineConfig } from "wxt";

import { loadBuildEnv } from "./build-env";
import { extensionConfig } from "./extension-config";

// Lidas e validadas uma vez, antes de qualquer etapa: um valor fora da forma derruba o build (ADR-004 §4.6).
// TRAMPO_API_ORIGIN e TRAMPO_SUPABASE_ORIGIN são definidas no S-5; sem elas, o build sai com `connect-src 'none'`
// e o login dá `auth_sem_configuracao` (fail closed, a extensão não fala com ninguém).
// F1-EXT-06: as 3 variáveis do build vêm do `process.env` ou, se ele não as define, do `.env` ao lado deste arquivo,
// lido por lista fechada. O caminho é fixo: nenhuma variável escolhe outro arquivo.
const env = loadBuildEnv(process.env, fileURLToPath(new URL(".env", import.meta.url)));

export default defineConfig(extensionConfig(env));
