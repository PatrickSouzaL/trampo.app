import { defineConfig, globalIgnores } from "eslint/config";
import { security } from "@trampo/config/eslint/security";

// A extensão só vê os subpaths de contrato que não carregam perfil do usuário
// (contratos-zod §2; revisão M1.6, F-02). A raiz reexporta user-criteria e contornaria o bloqueio.
const CONTRACTS_ALLOWED = "limits|primitives|api|analysis-report";

export default defineConfig([
  globalIgnores([".output/**", ".wxt/**"]),
  ...security,
  {
    name: "@trampo/extension/contracts-boundary",
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: `^@trampo/contracts(?!/(${CONTRACTS_ALLOWED})$)`,
              message: `A extensão só importa @trampo/contracts/{${CONTRACTS_ALLOWED.replaceAll("|", ",")}}: nunca a raiz nem user-criteria (F-02).`,
            },
          ],
        },
      ],
    },
  },
]);
