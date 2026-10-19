import { defineConfig, globalIgnores } from "eslint/config";
import { security } from "@trampo/config/eslint/security";

export default defineConfig([
  globalIgnores(["dist/**", "coverage/**"]),
  ...security,
  {
    // Os testes carregam payloads de ataque de propósito ('javascript:alert(1)' etc.), para provar
    // que o contrato os rejeita. Exceção restrita a esta regra e a test/; src/ continua com ela em error.
    name: "@trampo/contracts/test-payloads",
    files: ["test/**/*.ts"],
    rules: { "no-script-url": "off" },
  },
]);
