// Config de teste do manifest.test.ts (F1-EXT-06): o mesmo build do wxt.config.ts, pela mesma fábrica, com o `.env` de um
// arquivo temporário. O wxt.config.ts de produção tem o caminho fixo e nenhuma variável que o troque; só este arquivo,
// que nenhum build fora do teste carrega, recebe o caminho por variável.
import { defineConfig } from "wxt";

import { loadBuildEnv } from "../../build-env";
import { extensionConfig } from "../../extension-config";

const dotenvPath = process.env["MANIFEST_TEST_DOTENV"];
if (dotenvPath === undefined || dotenvPath === "") throw new Error("MANIFEST_TEST_DOTENV ausente: esta config só serve ao manifest.test.ts");

export default defineConfig(extensionConfig(loadBuildEnv(process.env, dotenvPath)));
