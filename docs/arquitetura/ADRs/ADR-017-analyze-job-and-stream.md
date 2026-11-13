---
tipo: adr
id: ADR-017
titulo: "AnalyzeJob (funil E0–E9) e POST /v1/analyze com eventos SSE"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]) dentro do ADR-001 §4–§5.9, ADR-009, ADR-011, ADR-012, ADR-014, ADR-015 e ADR-016. Ordem do humano em 2026-10-22 (next-step). Não muda contrato público: fecha o formato do stream que o contrato deixou para o S-1 (SSE) e acrescenta um tipo à união fechada da telemetria interna."
data: 2026-10-22
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-API-04 (apps/api/src/application/analysis, apps/api/src/application/ports, apps/api/src/presentation/routes)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-007-api-edge](ADR-007-api-edge.md)", "[ADR-008-llm-output-guard](ADR-008-llm-output-guard.md)", "[ADR-009-llm-provider-router](ADR-009-llm-provider-router.md)", "[ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md)", "[ADR-011-deterministic-signals-and-fact-resolver](ADR-011-deterministic-signals-and-fact-resolver.md)", "[ADR-012-report-composer](ADR-012-report-composer.md)", "[ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md)", "[ADR-015-job-facts-cache](ADR-015-job-facts-cache.md)", "[ADR-016-deterministic-pre-filter](ADR-016-deterministic-pre-filter.md)", "[threat-model](../threat-model.md)", "*BACKLOG §F1-API-04*"]
---

# ADR-017: `AnalyzeJob` (funil E0–E9) e `POST /v1/analyze` com eventos SSE

## 1. Contexto

Todas as peças do funil do ADR-001 §4 existem, testadas isoladamente:
- **E0**, a borda: JWT (ADR-013), rate limit e cota (ADR-014), 64 KiB e tipo de mídia (ADR-007);
- **E1**, o normalizador (ADR-005), e o seletor (ADR-006);
- **E2**, a Camada 1 e o roteamento R1–R4 (ADR-016);
- **E3**, o cache (ADR-015);
- **E4 e E5**, o router com a guarda (ADR-008 e ADR-009);
- **E6**, o resolver (ADR-011);
- **E7**, o motor (ADR-002);
- **E8**, o composer (ADR-012).

Falta o **dono do funil**: o caso de uso que chama as peças na ordem certa, escolhe o `decisionPath`, junta os avisos, grava no cache sem bloquear, mede a telemetria e valida a própria saída. Falta também a rota que entrega o progresso.

Três lacunas condicionam o desenho:
1. **Critérios do usuário:** o `CriteriaRepository` em Supabase é o F1-DB-01, ainda não feito.
2. **Adapters de LLM:** o Groq espera o S-1 e a Cloudflare é o F1-LLM-02. Sem adapter, o caminho R4 sempre cai no *fallback*.
3. **Formato do stream:** o contrato (`AnalysisStreamEventSchema`) diz "SSE/NDJSON, formato fechado no Spike S-1", e o S-1 continua bloqueado.

## 2. Decisões

### D1. Onde fica e o que recebe
- **Caso de uso:** `apps/api/src/application/analysis/analyze-job.ts`, versão `aj1`. É a camada `application`: importa `domain` e `@trampo/contracts` (regra `application-only-zod-and-contracts` do depcruise).
- **Portas novas** em `application/ports`:
  - `CriteriaRepository`: `load(userId): Promise<CriteriaLookup>`, com `{ found: true, criteria } | { found: false } | { unavailable: true }`. **Nunca rejeita.** O adapter Supabase é do F1-DB-01. Até lá, só existe um *fake* em memória nos testes;
  - `IdGenerator`: `uuid(): string` (o adapter usa `crypto.randomUUID`). O `AnalyzeJob` valida o formato e lança `DependencyContractError` se vier fora do padrão.
- **Dependências injetadas:** normalizador, seletor, `DeterministicPreFilter`, `PreFilterRouter`, `FactResolver`, `ScoringEngine`, `ReportComposer`, `JobFactsCache | null`, `FactsExtraction | null`, `Telemetry`, `Clock` (monotônico, para as durações e o prazo), `now()` (relógio de parede, só para o `createdAt`) e `IdGenerator`.
  - `FactsExtraction` é `Pick<LlmProviderRouter, "extract">`. `null` quer dizer que não há adapter: o R4 vai direto ao *fallback*. É o estado até o S-1 e o F1-LLM-02, e o caminho é testado;
  - `JobFactsCache | null`: sem cache, o R4 vai direto à extração.
- **Entrada:** `{ request: AnalyzeJobRequest, criteria: UserCriteria }` mais um `onStage(stage, elapsedMs)` que **nunca lança** (a rota garante). O `userId` **não** entra no `AnalyzeJob`: os critérios já chegam carregados, e o caso de uso não tem o que fazer com a identidade (minimização).
- **Saída:** `Promise<AnalysisReport>`, já validado por `AnalysisReportSchema.parse` (ADR-001 §5.8). Falha da autovalidação é bug: vira `ERRO_INTERNO`, nunca relatório parcial.

### D2. O funil, estágio a estágio

| # | Estágio (`AnalysisStage`) | O que roda | Regra |
|---|---|---|---|
| 1 | `recebido` | — | emitido ao entrar, `elapsedMs = 0` |
| 2 | `normalizando` | `normalize(job.text.text)`; `normalizeTitle(job.titleHint)` se não for nulo | o título normalizado vazio vira `null` |
| 3 | `triagem_deterministica` | `extract({ text, title })` → `route({ mode, signals, titleHint, criteria })` | R1, R2 e R3 terminam aqui (D3) |
| 4 | `consultando_cache` | `cache.lookup(textHash)` | só no R4 e só com cache; *hit* pula o 5 |
| 5 | `extraindo_fatos` | `select(normalized)` → `extract({ text: selected.text }, deadline)` | só no R4 com *miss*; sem extração → *fallback* |
| 6 | `pontuando` | `resolve` → `score` → `compose` → `parse` | uma vez, em todos os caminhos |

- **Prazo:** o router tem o próprio prazo de 12 s (ADR-009 D4) e o cache tem os próprios tetos (ADR-015). O `AnalyzeJob` **não** soma um prazo por cima: os dois limites já fecham o pior caso (~12,5 s), e um terceiro relógio só criaria um estado a mais sem teste de valor.
- **O texto que vai ao LLM é só o `select(normalized).text`:** o texto normalizado (PII e URL mascaradas, delimitadores neutralizados) e cortado em 6.000 pelo seletor. **Nenhum campo do `UserCriteria` entra no payload** (AGENTS §1.3).

### D3. Caminho de decisão e avisos

| Regra | `decisionPath` | Fatos | Avisos da rota | `extractorVersion` / `provider` |
|---|---|---|---|---|
| R1 | `triagem_deterministica` | `decision.deterministic` | — | `null` / `null` |
| R3 | `triagem_deterministica` | `decision.deterministic` | `decisao_sem_ia` | `null` / `null` |
| R2 | `fallback_deterministico` | `decision.deterministic` | `possivel_prompt_injection`, `analise_degradada` | `null` / `null` |
| R4 com *hit* | `cache_jobfacts` | resolver com `llmFacts = entry.facts` | — | tag do cache / `entry.provider` |
| R4 com extração ok | `extracao_llm` | resolver com `llmFacts = outcome.facts` | — | tag do cache / `outcome.provider` |
| R4 sem extração | `fallback_deterministico` | `decision.deterministic` | `analise_degradada` | `null` / `null` |

- **R2 como `fallback_deterministico`, não `triagem_deterministica`:** o R2 não é uma decisão da Camada 1. É a recusa de chamar a IA, e o relatório sai sem os campos que só o LLM preenche (localização, idiomas, benefícios e red flags). O usuário precisa ver que a análise está incompleta: daí o `analise_degradada`.
- **Reaproveitamento:** nos caminhos sem IA, os fatos e a nota são os de `decision.deterministic`. O resolver e o motor **não** rodam de novo, porque a nota do relatório é, por construção, a mesma que decidiu o R1 (ADR-016 D9).
- **Resolver no caminho com IA:**
  - `llmOutputInjection` vem de `sanitization.injectionSignal` (ADR-008), e é `false` no *hit*, porque o cache só grava saída sem injection (SR-08);
  - `markedStackTerms` = `dealBreakers` ∪ `mustHave` do usuário. O contrato limita cada lista a 15, então a união cabe no teto de 30 do resolver (ADR-011 D5). Os termos só servem para **manter** uma menção explícita que o LLM omitiu e nunca saem do processo;
  - `titleHint` normalizado.
- **Avisos do relatório:** a união, sem repetição e na ordem do enum do contrato, de:
  - os avisos da rota (acima);
  - `resolution.warnings` (`possivel_prompt_injection`, `informacao_contraditoria`, `baixa_confianca_extracao`);
  - `texto_truncado`, se `truncatedAtEdge`, `clientTruncated` ou `truncatedAfterNfkc`.

  O corte do seletor (6.000) **não** é `texto_truncado`: é a escolha do que vai ao LLM, e a Camada 1 leu o texto inteiro.

### D4. Escrita no cache
- Só no caminho `extracao_llm`, **depois** do resolver (a política do SR-08 precisa do `effectiveConfidence`) e **sem bloquear** a resposta: `void cache.store(...)`, sem `await` no caminho do relatório.
- O candidato leva a **saída da guarda** (`outcome.facts`, antes da fusão), o `sanitization`, o `injectionLevel` da Camada 1, o `effectiveConfidence`, `degraded = false`, o provedor e o modelo. As recusas são todas do `JobFactsCache` (ADR-015); o `AnalyzeJob` não decide nada sobre a escrita.
- O `store` nunca rejeita (ADR-015). Mesmo assim, o `AnalyzeJob` encadeia um `.catch` vazio: uma rejeição não tratada derrubaria o processo no Node.

### D5. Telemetria (emenda à união fechada do ADR-010)
- Novo evento `AnalysisEventSchema`, com `kind: "analysis"`, e `TelemetryEventSchema` passa a ser a união discriminada `llm_extraction | analysis`. Campos, todos enum, booleano ou inteiro:
  - `platform` e `mode`;
  - `rule` (`R1`–`R4`), `decisionPath` e `acceptEligible` (medir a D-H3 com dado real, ADR-016 D9);
  - `cache`: `nao_consultado`, `hit` ou o motivo do *miss* (`ausente`, `corrompido`, `obsoleto`, `indisponivel`);
  - `injectionLevel` e `warnings` (lista do enum);
  - `durationMs`.
- **Fora do evento:** nota, veredito e dimensões. Eles derivam do perfil, e a telemetria não carrega nada derivado dos critérios (minimização). `userId`, `requestId`, `analysisId`, título e modelo também ficam fora, como no ADR-010.
- O `llmExtractionEvent` (ADR-010) continua sendo gravado quando a extração roda.
- `cache_corrompido` vai ao log pelo catálogo do ADR-010 quando a leitura volta `corrompido` (herdado do F1-CACHE-01).

### D6. Rota `POST /v1/analyze` e o stream
- **Formato: SSE** (`text/event-stream; charset=utf-8`), e não NDJSON:
  - o Service Worker lê com `fetch` e um *parser* próprio (o `EventSource` não manda `Authorization`), então os dois custariam o mesmo no cliente;
  - provedores de borda como a Cloudflare repassam `text/event-stream` sem *buffer*, o que não é garantido para NDJSON. Isso é "não confirmado" para o provedor que o S-5 escolher, e o teste de integração do S-5 confere.

  Cada evento é `event: <type>\ndata: <json>\n\n`, com **um** `data:` por evento. `JSON.stringify` escapa `\n` e `\r` dentro das strings, então um campo nunca quebra o enquadramento do SSE (o U+2028 não é fim de linha no SSE). Sem `id:` e sem `retry:`: o cliente não reconecta, porque uma reconexão repetiria a análise.
- **Ordem na borda** (o que roda antes de o stream abrir responde como `ApiError` em JSON, com o status do ADR-007):
  1. hooks globais: CORS, tipo de mídia, JWT e rate limit `analise` (ADR-014; a rota declara `config: { rateLimit: "analise" }`);
  2. 64 KiB e o `AnalyzeJobRequestSchema` (texto curto → 422 `TEXTO_CURTO_DEMAIS`, o resto → 400 `PAYLOAD_INVALIDO`);
  3. `preHandler` **dos critérios**: `found: false` → 409 `CRITERIOS_NAO_CONFIGURADOS`, `unavailable` → 503 `SERVICO_INDISPONIVEL` (falha fechado);
  4. `preHandler` da cota diária (`app.dailyQuotaPreHandler`, ADR-014).

  **Os critérios vêm antes da cota:** uma requisição que não pode ser analisada não deve gastar a cota do dia. O rate limit `analise` (5 por minuto por usuário) já limita as leituras no banco.
- **Depois que o stream abre** (status 200 e cabeçalhos enviados):
  - a rota envia um `Readable` (`reply.send(stream)`), sem `hijack`. Assim, os cabeçalhos que os hooks já puseram no `reply` (o CORS faz `reply.header` no `onRequest`) e o log de resposta do Fastify continuam valendo. Com `hijack`, seria preciso copiar os cabeçalhos à mão. Um teste confere o `access-control-allow-origin` e o `vary` na resposta SSE;
  - cada evento passa por `AnalysisStreamEventSchema.parse` antes de ser escrito;
  - qualquer exceção vira **um** evento `error` com `ERRO_INTERNO` e a mensagem do catálogo, e o stream fecha. Nada do erro (mensagem, pilha, nome) sai: o log recebe só o `err.type` pela lista do ADR-010;
  - o stream termina sempre com exatamente um `result` ou um `error`.
- **Cabeçalhos do stream:** `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` e `X-Accel-Buffering: no`. Sem `Content-Length`.
- **Cliente que desconecta:** o stream para de escrever. A análise em curso termina dentro do prazo do router (12 s, no máximo 2 chamadas), e a cota já foi contada. Cancelar a chamada ao LLM no meio exigiria levar um `AbortSignal` até o router, e isso fica para quando houver adapter real (S-1).

### D7. `buildApp` e `main.ts`
- O `buildApp` ganha a opção `analysis?: { job: AnalyzeJob; criteria: CriteriaRepository }`. **A rota só é registrada com a opção.** Sem ela, `POST /v1/analyze` continua como rota inexistente (401 sem token, como hoje).
- O `main.ts` **não** monta a rota neste F1-API-04, porque não existe `CriteriaRepository` de verdade. A ligação (router com o `createRedisQuotaLedger` e o `systemClock`, cache com `CACHE_CLIENT_LIMITS`, critérios do Supabase) é a primeira tarefa depois do F1-DB-01. Ela fica registrada no BACKLOG como **F1-API-04b**.

## 3. Auditoria `[APPSEC]` (antes do código)

| Requisito | Critério de aceite |
|---|---|
| **PII fora do LLM** (AGENTS §1.3) | Prova por canário: critérios com termos, cidades e observações únicos; o `extract` falso grava o payload; nenhum canário do perfil aparece nele. O payload é exatamente o `select(normalized).text` |
| **SR-11** | O relatório de todos os caminhos (R1, R2, R3, *hit*, extração e *fallback*) passa no `AnalysisReportSchema` e não contém canário do perfil (propriedade sobre o motor e o composer reais) |
| **SR-12** | Nenhum texto de vaga, título, critério ou token nos logs e na telemetria: canário no texto e no título, com o stream capturado. O evento `analysis` é validado pelo schema estrito, e a `InMemoryTelemetry` descarta o que não vale |
| **SR-08** | O `store` só é chamado no caminho `extracao_llm`, com a saída da guarda e não a fundida. Um `store` lento ou que rejeita não atrasa nem derruba o relatório |
| **SR-06 e *Denial of Wallet*** | A cota roda antes do handler. Critério ausente ou banco fora do ar não gasta cota. Os caminhos R1, R2 e R3 nunca chamam `extract`. Sem `FactsExtraction`, nenhum R4 chama LLM |
| **Enquadramento SSE** | Título e texto com `\r`, `\n`, `\r\n`, U+2028, `event:` e `data:` não criam evento extra: o stream tem exatamente os eventos esperados, e cada `data:` passa no `AnalysisStreamEventSchema` |
| **Erro sem vazamento** | Exceção no meio do stream: um único `error` com `ERRO_INTERNO`, sem a mensagem nem a pilha; antes do stream, `ApiError` com o status do catálogo |
| **Autovalidação** | Um composer que devolve relatório inválido dá `error`/`ERRO_INTERNO`, nunca `result` |
| **Ordem de defesa** | Sem token → 401 sem ler o corpo; 64 KiB → 413 sem parse; rate limit antes dos critérios; critérios antes da cota (testes de borda com os *fakes* do ADR-014) |
| **R2 em qualquer modo** | `aprofundada` com injection `alta` nunca chama `extract` |

- **Riscos residuais aceitos:**
  - o cliente que desconecta não cancela a chamada ao LLM em curso. Ela é limitada pelo prazo e pelo orçamento de 2 chamadas, e a cota já foi contada;
  - a ausência de *buffer* do SSE no provedor de borda é "não confirmado" até o S-5.
- **Veto não exercido.**

## 3.1 Implementação da parte 1 (2026-10-22)
Código em `apps/api/src/application/analysis/analyze-job.ts` (`aj1`), portas em `application/ports/criteria-repository.ts` e `id-generator.ts`, adapter `infrastructure/ids/crypto-id-generator.ts`. Refinamentos do desenho, sem mudar decisão:
- **`onAlert(alert)`** na entrada, ao lado do `onStage`. O `AnalyzeJob` não tem logger, então o `cache_corrompido` (D5) sai como enum e a rota (parte 2) o leva ao catálogo do ADR-010. Nunca lança (a rota garante).
- **`CriteriaLookup`** ficou `{ found: true, criteria } | { found: false } | { found: false, unavailable: true }`, para discriminar por `found` sem `in`.
- **`extractorVersion`** é uma dependência (a mesma `extractorVersionTag` do cache): vai no relatório do caminho `extracao_llm` mesmo sem cache. O construtor lança `AnalyzeJobConfigError` se a tag é inválida ou diverge da do cache (o `JobFactsCache` ganhou o getter `extractorVersion`). No *hit*, a tag é a da entrada, que o cache já conferiu.
- **Dependências por `Pick`** (só os métodos usados), o que permite testar um `store` que rejeita ou lança.
- **Prazo do router:** `deadlineAfter(clock, 12 s)` criado no início da extração, como no D2 (cache e router com limites próprios, pior caso ~12,5 s).
- **`elapsedMs` e `durationMs`** passam pelo `telemetryMs` (arredonda e limita a [0, 120.000]): o stream nunca recebe um valor fora do contrato.
- **Estágios:** `consultando_cache` só com cache; `extraindo_fatos` só com `FactsExtraction`; `pontuando` antes do resolver e do motor no R4.
- **Autovalidação:** falha vira `DependencyContractError` com mensagem fixa, sem as *issues* do Zod (podem ecoar valores do relatório). O `IdGenerator` fora do padrão tem mensagem própria.
- **Verificação:** 61 testes em `analyze-job.test.ts` (ponta a ponta com as peças reais do domínio, o router real com extratores roteirizados e o `JobFactsCache` real sobre store em memória; 1 deles é do *fake* de critérios da parte 2), 1 propriedade com 1.000 execuções (SR-11, PII fora do LLM e telemetria válida em qualquer perfil), 27 testes novos de telemetria (26 da porta e das métricas, 1 do adapter em memória) e 2 do adapter de UUID: 91 novos. API com 1.806 testes e 100%; mutação com 71 mutantes, 70 mortos e 1 equivalente (o `if (cache === null) return` do `#storeLater`: sem cache, o `store` nulo lança dentro do `.then` e o `.catch` engole).

## 3.2 Implementação da parte 2 (2026-10-22)
Código em `apps/api/src/presentation/routes/analyze.ts` (rota e `preHandler` dos critérios) e `presentation/streaming/sse-stream.ts` (escritor). O `buildApp` ganhou a opção `analysis`. Refinamentos do desenho, sem mudar decisão:
- **`job: Pick<AnalyzeJob, "run">`** na opção `analysis`, em vez da classe inteira: permite testar o `run` que lança de forma síncrona, que rejeita com qualquer valor ou que devolve relatório inválido.
- **Critérios fora do objeto da requisição:** o `preHandler` guarda os critérios num `WeakMap` por requisição, então nenhum serializer os alcança. O handler sem o `preHandler` falha fechado (500 `ERRO_INTERNO`, antes do stream).
- **Porta de critérios que rejeita ou lança** vira 503, como o `unavailable`. O 503 grava `criterios_indisponiveis`, só a mensagem do catálogo.
- **422 `TEXTO_CURTO_DEMAIS`:** o mapeador de erro do `buildApp` responde 422 só quando **todas** as *issues* da validação são `too_small` em `/job/text`. Texto curto junto com outro erro continua 400.
- **Escritor:** `SseStream` sobre um `Readable` entregue por `reply.send`, sem `hijack`. O `write` valida antes de escrever e lança `SseEventContractError`, com mensagem fixa. Depois do fim, ou com o readable destruído (o Fastify o destrói quando o cliente sai), nada é escrito.
- **`onStage`** que recebe um estágio fora do contrato descarta o evento, registra `erro_interno` (tipo `SseEventContractError`) e a análise segue. **`onAlert`** leva o enum ao log. Os dois e o log do erro passam por um `safely`: um destino de log que lança não derruba o stream.
- **Fim único:** o `result` só é escrito se passar no schema. Senão, o `catch` escreve o `error`. O `requestId` do erro é o id do servidor, o mesmo do log.
- **Catálogo do log (emenda ao ADR-010 D2):** `cache_corrompido`, `criterios_indisponiveis` e o tipo `SseEventContractError`.
- **Verificação:** 72 testes novos (`analyze-route.test.ts`, `sse-stream.test.ts` e 6 do mapeador em `app.test.ts`), entre eles:
  - os da ordem de defesa;
  - 9 de enquadramento;
  - 8 de erro sem vazamento;
  - 3 de SR-12 com o log capturado;
  - 1 de desconexão em socket real.

  API com 1.878 testes e 100%; mutação com 52 mutantes, 49 mortos, 1 sobrevivente que virou teste (o caminho da rota) e 1 equivalente (a guarda do `end()`: o Node ignora `push(null)` repetido). Outros 2 equivalentes (`Promise.resolve().then` em volta do `run` e o `loaded.delete`) saíram do código.
- **Auditoria `[APPSEC]`:** sem veto. Um risco residual novo vai para o F1-DB-01: a porta promete nunca rejeitar, mas não promete prazo, e um adapter travado seguraria a requisição. O adapter do Supabase precisa de prazo próprio, como os guardas do ADR-014.

## 3.3 Implementação do F1-API-04b (2026-10-22)
O F1-DB-01 parte 2 entregou o `CriteriaRepository` do Supabase ([ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md) §3.2), e o `main.ts` passou a montar a rota. A parte 3 do F1-DB-01 (RLS) foi para o F1-OPS-01, o que o ADR-018 D1 já permitia.

Código:
- `apps/api/src/composition/compose-app.ts`: `composeApp(env, options)`, a raiz de composição. Ela valida o ambiente, monta cada adapter uma vez e chama o `buildApp` com `analysis: { job, criteria }`;
- `apps/api/src/main.ts`: só chama o `composeApp(process.env)`, sobe a porta e encerra limpo;
- `apps/api/src/infrastructure/random/crypto-random.ts`: o adapter da porta `Random` (CSPRNG) para o jitter do router.

Refinamentos do desenho, sem mudar decisão:
- **Raiz de composição testável fora do `main.ts`:** o teste de boot exercita exatamente a ligação de produção, sem subir porta nem ler o `process.env` real.
- **Critérios:** o `createSupabaseCriteriaRepository` entra **sempre** dentro do `CriteriaGuard` (herdado do ADR-018). A URL do PostgREST é a origem da `SUPABASE_URL`, já validada pelo `AuthEnvSchema`. A chave vem de `SUPABASE_PUBLISHABLE_KEY ?? ""`, e o anel de `parseSalaryKeyring(CRITERIA_SALARY_KEYS ?? "", CRITERIA_SALARY_ACTIVE_KEY ?? "")`.
- **Extração por LLM opcional (`options.llm`):** ainda não há adapter da Groq nem da Workers AI (F1-LLM-02). Sem a opção, `extraction` e `cache` ficam `null`, e a análise segue só pelo determinístico. Nenhum LLM é chamado, e o R4 sai como `fallback_deterministico` (a lacuna do §4). A `extractorVersion` usa o prompt `p0`, que nunca chega a relatório nem a chave de cache.
- **Com `options.llm`**, entram:
  - o `LlmProviderRouter`, com a cadeia de `parseLlmProviderChain(LLM_PROVIDER_CHAIN, { allowDevOnlyProviders: false })` (o Ollama nunca sobe por aqui);
  - o `createRedisQuotaLedger`, sobre a mesma instância do cliente REST do rate limit (os tetos de contador), mais o `systemClock`, o `cryptoRandom` e o `InMemoryProviderStateStore`;
  - o `JobFactsCache`, numa instância própria do cliente REST com `CACHE_CLIENT_LIMITS`, e `acceptedModels` tirado dos adapters.
- **Telemetria:** `InMemoryTelemetry` até existir um exportador.

Falha fechado no boot, provada no teste: sem publishable, com chave *secret* ou legada, sem o anel, com `kid` ativo fora do anel ou chave curta, sem token do Upstash, sem pepper, sem `SUPABASE_URL`, com JWKS de outro projeto e com `TRUST_PROXY=true`. Com LLM: cadeia sem adapter, Ollama, cadeia ausente e versão de prompt inválida. Nenhuma mensagem repete segredo.

Verificação:
- **30 testes novos:** 28 do boot e 2 do `cryptoRandom`. Entre eles, o **aceite do BACKLOG** (o boot monta `POST /v1/analyze` e responde 401 sem token, sem tocar o banco nem o Redis). Há também o fluxo completo com as peças reais: JWT ES256 num JWKS local, limites no Upstash simulado e critérios decifrados do PostgREST simulado, com 200 em SSE e um `result`. Ele vem com o SR-12 do log, 409 sem linha e 503 com chave perdida. Por fim, a análise aprofundada pelo router real, com reserva no `QuotaLedger` e gravação no cache.
- **API com 2.108 testes e 100%** (1.781/1.781 ramos). Turbo 18/18 em série, depcruise sem violações (354 módulos).
- **Mutação:** 18 mutantes, 16 mortos e 2 equivalentes. Os sobreviventes de CORS, `trustProxy` e `acceptedModels` viraram 4 testes. Os equivalentes:
  - B5 (sem o `CriteriaGuard`): com este adapter, o cliente tem prazo menor e o repositório já devolve a forma canônica. O guarda continua obrigatório como defesa em profundidade (ADR-018 D6) e tem os próprios testes;
  - B9 (URL com o caminho do *issuer*): o cliente monta o caminho absoluto `/rest/v1/`.

**Auditoria `[APPSEC]`: sem veto.** O boot falha fechado em toda credencial ausente ou do tipo errado. A chave *secret* do Supabase não é lida por nenhum código. O token do usuário não aparece no log do fluxo completo. A requisição anônima não toca o Redis nem o banco (*Denial of Wallet*).

## 3.4 Cadeia de LLM ligada (Trilha L1, 2026-10-30)
- O `main.ts` passou a chamar o `composeProductionApp` (`composition/production-app.ts`), que monta a cadeia Groq → Workers AI do ambiente e chama o `composeApp` com `options.llm` ([ADR-022-groq-adapter](ADR-022-groq-adapter.md) §6, commit `adb392d`).
- **A lacuna de produto do §4 fecha em produção:** o R4 sai de `extracao_llm` quando um provedor responde e só cai em `fallback_deterministico` em tempo de requisição. A produção não sobe sem a cadeia.
- O `composeApp` continua aceitando subir sem LLM, só para os testes de borda e de critérios.

## 4. Consequências
- **Partição do F1-API-04 (AGENTS §4.1):**
  - **parte 1:** o `AnalyzeJob` com as portas e os testes de ponta a ponta com o LLM, o cache e os critérios falsos, mais a emenda da telemetria;
  - **parte 2:** a rota e o escritor SSE, com os testes de borda;
  - **F1-API-04b** (depois do F1-DB-01): ligação no `main.ts`.
- **Lacuna de produto exposta:** até o S-1 e o F1-LLM-02, todo R4 sai como `fallback_deterministico` com `analise_degradada`. É o comportamento seguro do ADR-001 C5, não um defeito.
- O contrato `AnalysisStreamEventSchema` não muda. O comentário "formato fechado no Spike S-1" passa a apontar para este ADR (mudança só de comentário, num commit do `@trampo/contracts`).
