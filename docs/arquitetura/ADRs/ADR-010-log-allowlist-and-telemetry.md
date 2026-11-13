---
tipo: adr
id: ADR-010
titulo: "Logger com lista fechada imposta na escrita final (streamWrite), mensagens por catálogo, serializers que só escolhem campos, e porta de Telemetry com eventos de enums e catálogo de métricas"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]), dentro do ADR-001 §5.9 e do threat-model T23 aprovados no HITL-001. Não muda contrato público."
data: 2026-10-19
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-OBS-01 (apps/api/src/presentation/logging, apps/api/src/application/ports/telemetry.ts, apps/api/src/application/telemetry, apps/api/src/infrastructure/telemetry)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-007-api-edge](ADR-007-api-edge.md)", "[ADR-009-llm-provider-router](ADR-009-llm-provider-router.md)", "[threat-model](../threat-model.md)", "*BACKLOG*"]
---

# ADR-010: logger com lista fechada e porta de Telemetry

## 1. Contexto

O **SR-12** exige que o log nunca contenha texto de vaga, critérios, token ou IP em claro (T23). O ADR-001 §5.9 pede telemetria por **lista fechada**. A F1-API-00 já tirou IP, query, hostname e pid com serializers mínimos. A leitura do Fastify 5.12.7 e do pino 10.4.0 nesta tarefa mostrou que **isso não basta**:

1. **O `msg` é texto livre e vaza.** O Fastify grava:
   - `Route ${method}:${url} not found`, com a URL **e a query**, no 404 padrão;
   - `Reply was already sent ... "${request.raw.url}"`;
   - `error?.message` no tratador de erro padrão.
   
   O pino usa `err.message` como `msg` quando o primeiro argumento é um `Error`, ou quando o objeto tem `err` e não há mensagem. Uma mensagem de erro pode carregar qualquer coisa, inclusive o `input` do zod.
2. **Serializers são sobrescrevíveis.** `logSerializers` de rota e `log.child({}, { serializers, formatters })` trocam a projeção por outra, sem passar pela revisão da borda.
3. **O `redact` do pino é uma denylist por caminho.** Ele só esconde o que alguém lembrou de listar.

## 2. Decisões

### D1. A lista fechada é imposta na **escrita final** (`hooks.streamWrite`)
- O pino chama `hooks.streamWrite(linha)` com a linha JSON pronta, imediatamente antes de escrever no destino. O hook é **da raiz**: um `child()` herda e não consegue trocar. Opções de `child`, serializers de rota e formatters não alcançam esse ponto.
- `enforceLogAllowlist(linha)` faz `JSON.parse` e **reconstrói** o registro só com as chaves e formas da tabela abaixo, depois re-serializa:
  - chave fora da lista é descartada;
  - valor com forma errada é descartado;
  - linha que não é um objeto JSON vira um registro fixo `{"level":50,"msg":"linha_de_log_descartada"}`.
- Não há caminho de configuração que desligue isso. `BuildAppOptions.logger` aceita só `false` ou `{ level, stream }`. As opções brutas do pino deixam de ser aceitas, porque eram uma porta para fugir da política.

| Chave | Forma aceita | Origem |
|---|---|---|
| `level` | 10, 20, 30, 40, 50 ou 60 | pino |
| `time` | inteiro ≥ 0 (epoch ms) | pino |
| `msg` | **catálogo** (D2) | log |
| `reqId` | UUID v4 minúsculo (gerado pelo servidor, ADR-007) | binding do Fastify |
| `req` | `{ id?: UUID, method: GET\|HEAD\|POST\|PUT\|PATCH\|DELETE\|OPTIONS\|OUTRO, route: rota registrada \| "rota_desconhecida" }` | serializer |
| `res` | `{ statusCode?: inteiro 100–599 }` | serializer |
| `err` | `{ type: tipo do catálogo \| "outro", code?: /^(FST_ERR\|ERR)_[A-Z0-9_]{1,60}$/, statusCode?: 100–599 }` | serializer |
| `responseTime` | número que, arredondado para ms, é inteiro seguro ≥ 0 | Fastify |
| `signal` | `SIGINT` \| `SIGTERM` | `main.ts` |
| `suprimidas` | inteiro seguro ≥ 0 | linhas amostradas do BFF ([ADR-004-extension-auth](ADR-004-extension-auth.md) D8 item 7; emenda do 07g, D2) |

- **`route` só passa se for uma rota registrada.** Um hook `onRoute` alimenta um `Set` fechado com o padrão da rota (ex.: `/health`), e o valor nunca sai da URL da requisição. Assim, nem a rota vira canal de dado.
- **Tipos de erro do catálogo:** `Error`, `TypeError`, `RangeError`, `SyntaxError`, `FastifyError`, `ZodError`, `AbortError`, `RouterConfigError`, `ProviderChainConfigError`, `DependencyContractError`. Qualquer outro nome vira `outro`.

### D2. Mensagens por catálogo (enum), nunca texto livre
- O código da aplicação escreve só valores do catálogo: `erro_interno` e `encerrando`.
- As mensagens conhecidas do Fastify são traduzidas para o catálogo:
  - `incoming request` → `requisicao_recebida`;
  - `request completed` → `requisicao_concluida`;
  - `request errored` → `requisicao_com_erro`;
  - `stream closed prematurely` → `fluxo_encerrado_antes`;
  - `Server listening at …` → `servidor_ouvindo` (o endereço de bind também sai).
- Qualquer outra mensagem vira `mensagem_fora_do_catalogo`, inclusive a do 404 padrão com a query, `err.message` e argumentos de interpolação.
- **Emenda do [ADR-017-analyze-job-and-stream](ADR-017-analyze-job-and-stream.md) D5 e D6 (2026-10-22, F1-API-04 parte 2):** entraram no catálogo:
  - `cache_corrompido` (warn), quando a leitura do `JobFactsCache` volta `corrompido`;
  - `criterios_indisponiveis` (warn), quando o banco de critérios está fora do ar (503);
  - `SseEventContractError` na lista de tipos de erro, para um evento do stream fora do contrato.

  Nenhuma delas carrega campo além dos da tabela do D1.
- **Emenda do [ADR-021-criteria-routes](ADR-021-criteria-routes.md) D9 (2026-10-24, F1-API-05 commit 5):** entrou no catálogo `criterios_gravacao_indisponivel` (warn, sem campos), no `PUT /v1/criteria` que vira 503. O `GET /v1/criteria` que vira 503 reusa o `criterios_indisponiveis`. Nenhum evento novo de telemetria. Provado com canários das notas, cidades, tecnologias, pretensão e token nos caminhos 200, 204, 400, 413, 429 e 503 ([ADR-021-criteria-routes](ADR-021-criteria-routes.md) §5.5).
- **Emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md) D8 item 7 (F1-API-07 07g, 2026-11-07, `b516fd0`):** entraram no catálogo as 10 mensagens do BFF: `auth_troca_recusada`, `auth_renovacao_recusada`, `auth_envelope_invalido`, `auth_sessao_idade_maxima`, `auth_sessao_inativa`, `auth_provedor_indisponivel`, `auth_chaves_indisponiveis`, `auth_token_fora_da_politica`, `auth_renovacao_perdida` e `auth_limite_local`.
  - Todas são `warn` e **amostradas**: no máximo 1 linha por motivo a cada 60 s, por instância. A linha seguinte leva a chave nova `suprimidas` (tabela do D1), com quantas foram caladas no intervalo.
  - Nenhum outro campo. Código, verifier, `state`, tokens, envelope, `provider_token`, `sub`, e-mail e IP nunca aparecem (SR-12, provado nos caminhos 200, 401, 429 e 503).
  - As métricas `auth_*_total` do mesmo item ficam para o 07i: a porta `Telemetry` (D5) ainda não tem evento de autenticação.
  - **Emenda do 07i (F1-API-07, 2026-11-11, `53ba9c1`):** a união fechada do D5 passou a ser `llm_extraction | analysis | auth`. O evento `auth` é um `strictObject` com `kind`, `operation` (`troca`, `renovacao`, `logout`) e `result` (`ok`, `recusado`, `indisponivel`, `limitado`): sem motivo, token, envelope, código, `sub`, sessão, origem, IP ou `reqId`. O catálogo do D6 ganhou três contadores, `auth_troca_total`, `auth_renovacao_total` e `auth_logout_total`, todos só com o rótulo `resultado`. O motivo continua nas linhas amostradas do D2; a métrica é o volume.

### D3. Serializers só **escolhem** campos; quem valida é o D1
- `req` escolhe `id`, `method` e `routeOptions.url`. `res` escolhe `statusCode`. `err` escolhe `name` (só se for `Error`), `code` e `statusCode`.
- Eles substituem os serializers padrão do Fastify. O padrão grava `url` com query, `host`, `remoteAddress` e `remotePort`, e o do pino grava `message` e `stack`.
- Cabeçalhos **nunca** são escolhidos. A lista de cabeçalhos permitidos é **vazia**, o que cobre `Authorization`, `Cookie` e qualquer outro.
- Divisão de responsabilidades sem código redundante: sem o serializer, os dados certos não chegam; sem o D1, a forma não é garantida. A mutação de cada um derruba testes diferentes.

### D4. Rejeitado: `redact` do pino
- É uma denylist por caminho, e o SR-12 pede allowlist. Com D1 e D3, um `redact` para `req.headers.authorization` nunca dispararia: seria código morto, um mutante equivalente. A política do projeto é remover esse tipo de código (ADR-009 §4).
- A *redaction* exigida pelo T23.5 é feita **por construção**: tudo o que não está na tabela do D1 é removido.

### D5. Porta `Telemetry` em `application` (eventos com enums, sem texto livre)
```ts
interface Telemetry { record(event: TelemetryEvent): void }   // nunca lança; adapter absorve falhas
type TelemetryEvent = LlmExtractionEvent;                      // união fechada, cresce por ADR
interface LlmExtractionEvent {
  kind: "llm_extraction";
  platform: Platform;                                  // @trampo/contracts
  outcome: "ok" | ExtractionFailureReason;             // ADR-009 D3
  provider: LlmProviderId | null;                      // quem respondeu ok; null na falha
  latencyMs: number;                                   // inteiro, [0, 120_000]
  llmCalls: 0 | 1 | 2;                                 // derivado da trilha (called = true)
  inputTokens: number; outputTokens: number;           // inteiros ≥ 0; 0 na falha
  steps: { provider; outcome; called; guardRejection? }[];  // = RouterTrailEntry, até 6
}
```
- `TelemetryEventSchema` (Zod **estrito**) é a definição. O tipo é `z.infer` e uma asserção de tipo trava a igualdade com `ExtractionFailureReason`, `LlmOutputRejection` e `RouterTrailEntry`.
- `llmExtractionEvent(outcome, { platform, latencyMs })` é uma função pura que monta o evento a partir do `ExtractionOutcome` do router. Ela só copia enums e números: não tem caminho para `facts`, `sanitization` ou `model`.
  - O `model` fica de fora por dois motivos: é texto de configuração, e a cardinalidade dele é ilimitada se a configuração mudar. O provedor basta até o S-1.
- **Sem dado de perfil e sem id de usuário.** O id pseudonimizado do ADR-001 §5.9 entra só com o HMAC com *pepper* do T23.7, que chega na F1-API-02/03 (SR-17). Mesmo assim, ele nunca será rótulo de métrica: rótulo só pode ter cardinalidade fechada.

> [!note] Emenda do [ADR-022-groq-adapter](ADR-022-groq-adapter.md) D10 (2026-10-26, desenho)
> O `LlmExtractionEvent` ganha `guardNormalizations` com três inteiros do `sanitization`: `offEnumItemsRemoved`, `absentValuesNormalized` (`g3`) e `stackOverlapsResolved` (`g4`). Eles valem 0 na falha. Só esses três números passam, e a métrica nova é `llm_guard_normalization_total{provider, kind}`. Entra no commit 6 da partição do ADR-022.
> **Implementado em 2026-10-27** (commit `797c04b`, local): os três contadores são saturados em 8.192 (`TELEMETRY_GUARD_NORMALIZATION_MAX`), e valor fora da forma vira 0. A métrica só sai quando o contador é > 0 e há provedor que respondeu. Uma propriedade com canários no `sanitization` prova que nenhum texto passa.

### D6. O que é métrica e o que é log
- **Log** (pino, D1): um registro por evento operacional de requisição (recebida, concluída, erro, encerramento). Serve para depurar uma requisição pelo `reqId`. **Não** recebe eventos de telemetria.
- **Métrica** (porta `Telemetry`): agregados com rótulos de enum, sem `reqId`. `telemetryMetricSamples(event)` é pura e define o catálogo:

| Métrica | Tipo | Rótulos | Valor |
|---|---|---|---|
| `llm_extraction_total` | contador | `platform`, `outcome`, `provider` (ou `nenhum`) | 1 |
| `llm_extraction_latency_ms` | histograma | `outcome` | `latencyMs`; limites 250, 500, 1.000, 2.000, 4.000, 8.000, 12.000 e +Inf |
| `llm_calls_per_analysis` | histograma | — | `llmCalls`; limites 0, 1, 2 |
| `llm_provider_step_total` | contador | `provider`, `outcome`, `called` (`sim`/`nao`) | 1 por passo |
| `llm_guard_rejection_total` | contador | `provider`, `rejection` | 1 por passo com rejeição |
| `llm_tokens_total` | contador | `provider`, `direction` (`input`/`output`) | tokens (só no ok) |
| `analysis_total` | contador | `platform`, `mode`, `rule`, `decision_path` | 1 por análise |
| `analysis_duration_ms` | histograma | `decision_path` | `durationMs`; limites 50, 250, 1.000, 2.000, 4.000, 8.000, 12.000 e +Inf |
| `analysis_cache_total` | contador | `cache` (`nao_consultado`, `hit` ou o motivo do *miss*) | 1 |
| `analysis_injection_level_total` | contador | `level` | 1 |
| `analysis_accept_eligible_total` | contador | `eligible` (`sim`/`nao`) | 1 |
| `analysis_warning_total` | contador | `warning` | 1 por aviso |

- **Emenda do [ADR-017-analyze-job-and-stream](ADR-017-analyze-job-and-stream.md) D5 (2026-10-22, F1-API-04 parte 1):** a união fechada passou a ser `llm_extraction | analysis` (discriminada por `kind`), e as seis métricas `analysis_*` acima entraram no catálogo. Nenhuma tem nota, veredito ou dimensão, porque elas derivam do perfil.

- A taxa de falha de extração por plataforma é `llm_extraction_total{outcome≠ok} / llm_extraction_total`, por `platform`. O custo vem de `llm_tokens_total` vezes a tabela de preço. A tabela fica fora do código até a Fase 2, porque o free tier não cobra.
- **Adapter:** só `InMemoryTelemetry` em `infrastructure/telemetry`, com contadores e histogramas e uma contagem de eventos descartados. Ele valida cada evento com o schema estrito: evento inválido é descartado e contado, e nunca lança. O **exportador externo** (OTLP ou outro) depende da hospedagem e fica para o S-5.

## 3. Consequências
- **Positivas:**
  - nenhuma configuração, rota ou plugin consegue gravar um campo fora da tabela;
  - o vazamento por `msg` do Fastify (URL com query, `err.message`) foi fechado;
  - métricas com cardinalidade fechada e conhecida.
- **Negativas:**
  - um `JSON.parse` e um `JSON.stringify` por linha de log (algumas linhas por requisição);
  - mensagens novas do Fastify aparecem como `mensagem_fora_do_catalogo` até entrarem no catálogo por ADR;
  - um campo novo no log exige mudar a tabela do D1, de propósito.
- **Revisar no S-5:** o destino do log (stdout da hospedagem) e o exportador de métricas.

## 4. Verificação
Em `apps/api/test/log-policy.test.ts`, `apps/api/test/log-sr12.test.ts`, `apps/api/test/application/telemetry.test.ts` e `apps/api/test/infrastructure/in-memory-telemetry.test.ts`:
- **SR-12 por canário:** uma requisição real ao `buildApp`, com log capturado pelo `stream`, carrega canários em:
  - corpo (texto de vaga e critérios);
  - query;
  - `Authorization`, `Cookie` e um cabeçalho qualquer;
  - `X-Forwarded-For` e `User-Agent`.
  
  Ela passa por 200, 404 padrão, 4xx, 500 e um *child logger* malicioso com serializers e formatters próprios. Nenhum canário aparece em nenhuma linha, e o IP do cliente (`127.0.0.1` do inject) também não.
- **Propriedade no fast-check:** para qualquer string, e para qualquer JSON com chaves arbitrárias e com as chaves da lista com valores arbitrários, a saída de `enforceLogAllowlist`:
  - é um objeto JSON;
  - só tem chaves da tabela, nos níveis 1 e 2;
  - tem cada valor na forma da tabela;
  - nunca contém o canário plantado.
- **Telemetria:** o evento derivado de qualquer `ExtractionOutcome` passa no schema estrito e não contém o texto do `facts`. O catálogo de métricas é fixado por teste contra este ADR. O adapter descarta e conta evento inválido, inclusive com chave extra.
- Cobertura de 100% e mutação manual.

**Resultado (2026-10-19):**
- **Testes:** 57 novos (API com 461). Propriedades com 1.000 execuções cada.
- **A propriedade achou um defeito real**, corrigido antes do commit: `responseTime` igual a 2^53 arredondava para um inteiro inseguro. A forma passou a ser "inteiro seguro ≥ 0 depois de arredondar".
- **Cobertura:** 100% (324/324 ramos). Entram agora `presentation/logging` e `infrastructure/telemetry`.
- **Mutação:** 69/69 mortos. A remoção do `streamWrite` sozinha derruba 4 testes do SR-12 de ponta a ponta.
- **Código equivalente removido:** o `base: null` da F1-API-00, porque hostname e pid já caem na allowlist.
- **Smoke:** o JS compilado grava só `servidor_ouvindo`, `requisicao_recebida` e `requisicao_concluida`, sem a query nem o token da requisição.
