# Próximo passo: F1-API-04 parte 2 (rota `POST /v1/analyze` e escritor SSE)

> **Reciclagem de sessão** (AGENTS §4.4): esta janela entregou a parte 1 do F1-API-04, com a mutação e a auditoria.
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-22)

### F1-API-04 parte 1: `AnalyzeJob` `aj1` (commit `5bc3f3d`, **local, sem push**)
- **Código:**
  - `apps/api/src/application/analysis/analyze-job.ts`, com a tabela D3 inteira do [[ADR-017-analyze-job-and-stream]]:
    - R1 e R3 saem como `triagem_deterministica`;
    - R2 e o R4 sem extração saem como `fallback_deterministico`, com `analise_degradada`;
    - R4 com *hit* sai como `cache_jobfacts`, e com extração ok, como `extracao_llm`;
  - portas `CriteriaRepository` e `IdGenerator`, e o adapter `cryptoIdGenerator`;
  - evento de telemetria `analysis` e seis métricas `analysis_*` (emenda ao ADR-010);
  - getter `extractorVersion` no `JobFactsCache`, conferido pelo `AnalyzeJob` no boot.
- **Refinamentos registrados no ADR-017 §3.1:**
  - `onAlert("cache_corrompido")`, porque o caso de uso não tem logger;
  - `extractorVersion` como dependência;
  - dependências por `Pick`;
  - `pontuando` emitido antes do resolver e do motor;
  - durações limitadas a 120.000 ms.
- **Testes:** 91 novos, e a API está com **1.806 testes e 100%** de cobertura. Entre eles:
  - 61 testes de ponta a ponta com as peças reais;
  - uma propriedade com 1.000 execuções (SR-11 e PII fora do LLM);
  - 27 testes de telemetria.
- **Mutação:** 71 mutantes, 70 mortos e 1 equivalente (B13). Seis sobreviventes viraram teste.
- **`[APPSEC]`:** auditou o ADR-017 §3 na parte que cabe à aplicação e **não vetou**.
- **Verificação:** `tsc`, `eslint` e depcruise verdes (325 módulos). O turbo completo não rodou, porque só a API mudou. O `edge-socket` chunked oscilou uma vez com a suíte cheia (RST do Windows, já conhecido).

### Pendências
- **Push e PR:** os commits `c928716`, `ddd148b`, `83d5fe4`, `0c235fd`, `78f7a07`, `5bc3f3d` e o deste `next-step` continuam locais. Vale a opção B: um PR de processamento e domínio depois do merge do #3.
- **QA-01:** fica para o CI (F1-OPS-01).
- **DOC-01:** no backlog.

## Herdado para a parte 2 (BACKLOG F1-API-04)
- Levar o `onAlert("cache_corrompido")` ao log, incluindo `cache_corrompido` no `LOG_MESSAGES`.
- Garantir que `onStage` e `onAlert` nunca lançam.
- Qualquer rejeição do `run` (inclusive `DependencyContractError` e `RangeError`) vira um único evento `error` com `ERRO_INTERNO`.
- Usar o `FakeCriteriaRepository` (`test/application/fakes/fake-criteria-repository.ts`) e o `JobHarness` (`test/application/fakes/analyze-job-harness.ts`).
- O SR-12 dos logs, com o stream capturado, é verificado na rota.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-API-04, inclusive o "Herdado da parte 1") e o ADR-017 inteiro (D6, D7, §3 e §3.1). Confirme pnpm 11.4.0, Node >= 24, o branch feat/api-borda (commits locais, sem push: opção B) e a memória livre da máquina antes de rodar suítes pesadas.
2. [DEV] + [QA_EVALS]: F1-API-04 parte 2, só ela:
   - rota POST /v1/analyze registrada só com a opção analysis do buildApp ({ job: AnalyzeJob; criteria: CriteriaRepository }); config { rateLimit: "analise" };
   - preHandler dos critérios ANTES do app.dailyQuotaPreHandler (409 CRITERIOS_NAO_CONFIGURADOS, 503 SERVICO_INDISPONIVEL);
   - escritor SSE: reply.send(Readable) sem hijack, "event: <type>\ndata: <json>\n\n", cada evento validado pelo AnalysisStreamEventSchema, sem id: e sem retry:, Cache-Control no-store, nosniff e X-Accel-Buffering no; termina com exatamente um result ou um error (ERRO_INTERNO, mensagem do catálogo);
   - cache_corrompido no catálogo do log; cliente que desconecta para a escrita;
   - testes de borda e de enquadramento do ADR-017 §3 (401 sem ler o corpo, 413 sem parse, rate limit antes dos critérios, critérios antes da cota, CR/LF/U+2028/"event:"/"data:" no título e no texto sem evento extra, erro sem vazamento, CORS e vary na resposta SSE, SR-12 nos logs com o stream capturado);
   - 100% de cobertura e mutação (um mutante por vez, em primeiro plano, script fora de coverage/ e do repositório, conferindo o original depois de cada lote; patch de arquivo com acento via arquivo UTF-8, nunca por heredoc no stdin).
3. [APPSEC]: Auditem o código contra o ADR-017 §3 antes de dar a parte como concluída.
4. [SCRIBE]: Atualizem STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md (próxima: F1-DB-01, que destrava o F1-API-04b).
```
