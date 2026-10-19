import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Dois grupos em sequência (groupOrder): o domínio roda primeiro, sem disputar CPU com os testes
    // da borda (dezenas de instâncias Fastify e sockets reais). Os testes de relógio do SR-09
    // (< 200 ms por entrada) medem o seletor, não a concorrência entre arquivos de teste.
    projects: [
      {
        extends: true,
        test: { name: "dominio", include: ["test/domain/**/*.test.ts", "test/application/**/*.test.ts", "test/infrastructure/**/*.test.ts"], sequence: { groupOrder: 0 } },
      },
      {
        extends: true,
        test: { name: "presentation", include: ["test/*.test.ts"], sequence: { groupOrder: 1 } },
      },
    ],
    coverage: {
      provider: "v8",
      // Domínio inteiro (AGENTS §1.5), a aplicação (LlmOutputGuard, ADR-008) e o adapter de hash que a
      // chave de cache usa (ADR-005 D1).
      include: [
        "src/domain/**/*.ts",
        "src/application/**/*.ts",
        "src/infrastructure/crypto/**/*.ts",
        "src/infrastructure/telemetry/**/*.ts",
        "src/presentation/logging/**/*.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
