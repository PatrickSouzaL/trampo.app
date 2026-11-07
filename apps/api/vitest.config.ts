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
          // Camada 1 (F1-DOM-04): o roteador roda o motor da nota e as propriedades fazem 1.000 execuções, então vão
          // para o grupo do motor. O SR-09 do pré-filtro (48 entradas de 64 KiB) roda sozinho no grupo seguinte, sem
          // disputar CPU com o SR-09 do normalizador e do seletor.
          // PostgREST simulado em socket real (F1-DB-01 parte 2), como o Upstash: grupo da presentation.
          // Workers AI simulada em socket real (F1-LLM-02), idem.
          // AnalyzeJob (F1-API-04): o funil inteiro com o motor real e propriedades de 1.000 execuções, no grupo do motor.
          // GoTrue simulado em socket real (F1-API-07 07c, ADR-004 §4.2), como o PostgREST: grupo da presentation.
          exclude: [
            "test/domain/scoring-*.test.ts",
            "test/domain/report-*.test.ts",
            "test/domain/prefilter-router.test.ts",
            "test/domain/prefilter.properties.test.ts",
            "test/domain/prefilter-sr09.test.ts",
            "test/application/analyze-job*.test.ts",
            "test/infrastructure/jose-*.test.ts",
            "test/infrastructure/upstash-*.test.ts",
            "test/infrastructure/postgrest-*.test.ts",
            "test/infrastructure/cloudflare-*.test.ts",
            "test/infrastructure/gotrue-*.test.ts",
          ],
          sequence: { groupOrder: 0 },
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: { name: "sr09-camada1", include: ["test/domain/prefilter-sr09.test.ts"], sequence: { groupOrder: 1 } },
      },
      {
        extends: true,
        test: { name: "motor", include: ["test/domain/scoring-*.test.ts", "test/domain/report-*.test.ts", "test/domain/prefilter-router.test.ts", "test/domain/prefilter.properties.test.ts", "test/application/analyze-job*.test.ts"], sequence: { groupOrder: 2 }, testTimeout: 30_000 },
      },
      {
        extends: true,
        test: { name: "presentation", include: ["test/*.test.ts", "test/infrastructure/jose-*.test.ts", "test/infrastructure/upstash-*.test.ts", "test/infrastructure/postgrest-*.test.ts", "test/infrastructure/cloudflare-*.test.ts", "test/infrastructure/gotrue-*.test.ts"], sequence: { groupOrder: 3 } },
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
        // IdGenerator (F1-API-04, ADR-017 D1).
        "src/infrastructure/ids/**/*.ts",
        "src/presentation/logging/**/*.ts",
        // Autenticação (F1-API-02, ADR-013): o adapter jose, o hook e a validação do ambiente.
        "src/infrastructure/auth/**/*.ts",
        "src/presentation/edge/auth*.ts",
        // Rate limit, cota e QuotaLedger (F1-API-03, ADR-014): cliente REST, adapters, relógio e hooks.
        // JobFactsCache (F1-CACHE-01, ADR-015): o adapter em Redis.
        "src/infrastructure/cache/**/*.ts",
        "src/infrastructure/redis/**/*.ts",
        "src/infrastructure/limits/**/*.ts",
        "src/infrastructure/time/**/*.ts",
        // Cliente REST de usuário do PostgREST e o CriteriaRepository do Supabase (F1-DB-01 parte 2, ADR-018 D5).
        "src/infrastructure/supabase/**/*.ts",
        "src/infrastructure/persistence/**/*.ts",
        // Raiz de composição do main.ts e o Random do router (F1-API-04b).
        "src/composition/**/*.ts",
        "src/infrastructure/random/**/*.ts",
        "src/infrastructure/llm/**/*.ts",
        "src/presentation/edge/rate-limit.ts",
        "src/presentation/edge/daily-quota.ts",
        "src/presentation/edge/client-address.ts",
        // Limitador local antes do JWT e API_BEHIND_PROXY (F1-API-07 07e, ADR-004 D8 item 4; ADR-014 D10).
        "src/presentation/edge/pre-auth-limit.ts",
        "src/presentation/edge/behind-proxy-env.ts",
        // CORS por rota (F1-API-05 commit 4, ADR-021 D8.3): a origem da extensão só alcança EXTENSION_ROUTES.
        "src/presentation/edge/cors.ts",
        "src/presentation/api-error.ts",
        // POST /v1/analyze e o escritor SSE (F1-API-04 parte 2, ADR-017 D6 e D7), com o buildApp que a registra.
        "src/presentation/routes/analyze.ts",
        // GET e PUT /v1/criteria (F1-API-05 commit 5, ADR-021 D2).
        "src/presentation/routes/criteria.ts",
        "src/presentation/streaming/**/*.ts",
        "src/presentation/build-app.ts",
        // Guarda do test:db (F1-OPS-01 parte 2, ADR-019 D8): só 127.0.0.1 e a publishable local. A suíte do banco
        // roda à parte (vitest.db.config.ts), mas os casos negativos do guarda rodam aqui, sem Docker.
        "test/db/support/local-stack-env.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
