import { defineConfig, globalIgnores } from "eslint/config";
import { domainPurity } from "@trampo/config/eslint/domain-purity";
import { security } from "@trampo/config/eslint/security";

// O preset de pureza vem depois do de segurança: em src/domain ele acrescenta as proibições de rede,
// relógio, aleatoriedade e imports de runtime (ADR-001 §7 e §10.3; SR-13).
export default defineConfig([
  globalIgnores(["dist/**", "coverage/**"]),
  ...security,
  ...domainPurity({ files: ["src/domain/**/*.ts"] }),
  {
    // Os testes do normalizador carregam payloads de ataque de propósito ('javascript:alert(1)'), para
    // provar que viram [link]. Exceção restrita a esta regra e a test/; src/ continua com ela em error.
    name: "@trampo/api/test-payloads",
    files: ["test/**/*.ts"],
    rules: { "no-script-url": "off" },
  },
]);
