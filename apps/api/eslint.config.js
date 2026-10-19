import { defineConfig, globalIgnores } from "eslint/config";
import { domainPurity } from "@trampo/config/eslint/domain-purity";
import { security } from "@trampo/config/eslint/security";

// O preset de pureza vem depois do de segurança: em src/domain ele acrescenta as proibições de rede,
// relógio, aleatoriedade e imports de runtime (ADR-001 §7 e §10.3; SR-13).
export default defineConfig([
  globalIgnores(["dist/**", "coverage/**"]),
  ...security,
  ...domainPurity({ files: ["src/domain/**/*.ts"] }),
]);
