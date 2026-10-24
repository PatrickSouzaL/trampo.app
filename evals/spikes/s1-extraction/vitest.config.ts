import { defineConfig } from "vitest/config";

// S-1: roda à parte do `pnpm test` do pacote (spike descartável, sem limiar de cobertura). O modo vem de S1_MODE:
// `plan` (sem rede), `smoke` (1 chamada por provedor), `run` (o plano, retomável) e `report` (sem rede).
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["*.spike.ts"],
    testTimeout: 6 * 60 * 60 * 1_000,
  },
});
