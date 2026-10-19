import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { security } from "@trampo/config/eslint/security";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Preset de segurança (SR-03) por último: nenhum preset de framework o rebaixa.
  ...security,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
