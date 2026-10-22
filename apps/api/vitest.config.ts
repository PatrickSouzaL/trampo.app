import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Dois grupos em sequência (groupOrder): o domínio roda primeiro, sem disputar CPU com os testes
    // da borda (dezenas de instâncias Fastify e sockets reais). Os testes de relógio do SR-09
    // (< 200 ms por entrada) medem o seletor, não a concorrência entre arquivos de teste.
    projects: [
      {
        extends: true,
        // Propriedades com 1.000 execuções passam de 5 s quando o turbo roda todos os pacotes juntos: o prazo
        // sobe, o número de execuções não cai. O SR-09 mede o próprio relógio e não depende deste prazo.
        test: {
          name: "dominio",
          include: ["test/domain/**/*.test.ts", "test/application/**/*.test.ts", "test/infrastructure/**/*.test.ts"],
          // O motor da nota e o ReportComposer (propriedades pesadas e o ESLint das fixtures) rodam no grupo seguinte, sem disputar
          // CPU com o SR-09 do seletor, que mede 200 ms de relógio de parede.
          // O adapter do JWT (F1-API-02) gera chaves ECDSA e sobe um JWKS em socket real: vai para o grupo da
          // presentation, longe do SR-09.
          // O cliente REST do Upstash (F1-API-03) também usa socket real (servidor simulado lento e travado).
          exclude: [
            "test/domain/scoring-*.test.ts",
            "test/domain/report-*.test.ts",
            "test/infrastructure/jose-*.test.ts",
            "test/infrastructure/upstash-*.test.ts",
          ],
          sequence: { groupOrder: 0 },
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: { name: "motor", include: ["test/domain/scoring-*.test.ts", "test/domain/report-*.test.ts"], sequence: { groupOrder: 1 }, testTimeout: 30_000 },
      },
      {
        extends: true,
        test: { name: "presentation", include: ["test/*.test.ts", "test/infrastructure/jose-*.test.ts", "test/infrastructure/upstash-*.test.ts"], sequence: { groupOrder: 2 } },
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
        // Autenticação (F1-API-02, ADR-013): o adapter jose, o hook e a validação do ambiente.
        "src/infrastructure/auth/**/*.ts",
        "src/presentation/edge/auth*.ts",
        // Rate limit, cota e QuotaLedger (F1-API-03, ADR-014): cliente REST, adapters, relógio e hooks.
        "src/infrastructure/redis/**/*.ts",
        "src/infrastructure/limits/**/*.ts",
        "src/infrastructure/time/**/*.ts",
        "src/presentation/edge/rate-limit.ts",
        "src/presentation/edge/daily-quota.ts",
        "src/presentation/edge/client-address.ts",
        "src/presentation/api-error.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
