import { defineConfig, globalIgnores } from "eslint/config";
import { security } from "@trampo/config/eslint/security";

export default defineConfig([globalIgnores(["coverage/**", "golden/**"]), ...security]);
