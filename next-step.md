# Próximo passo: F1-LLM-01, parte 1 (`LlmOutputGuard`, SR-01)

> **Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.**
> (AGENTS §2, Fase 5, e §4.4. A parada é por reciclagem de sessão, não por HITL: a próxima tarefa não exige nenhuma ação sua.)

## O que acabou de ser entregue (F1-API-01, 2026-10-19, ADR-007)

### Borda da API (E0, SR-07)
- **Só o parser JSON.** O `text/plain` foi removido. O 415 sai para tipo não JSON, `charset` diferente de UTF-8 e `Content-Encoding` diferente de `identity` (gzip, br e listas). A checagem roda no `onRequest`, **antes de ler o corpo**, e não há nenhum plugin de descompressão.
- **`bodyLimit = HTTP_BODY_MAX_BYTES`:** 413 sem parse, tanto pelo Content-Length (antes de chegar um byte do corpo) quanto pela contagem no streaming chunked.
- **Proto poisoning** (`onProtoPoisoning` e `onConstructorPoisoning`) em `error`, declarado e testado.
- **Timeouts explícitos:**

  | Prazo | Valor |
  |---|---|
  | headers | 5 s |
  | request | 10 s |
  | conexão | 30 s |
  | keep-alive | 5 s |

  `connectionsCheckingInterval` ficou em 1 s, porque o padrão do Node, de 30 s, atrasaria os prazos. Os erros de socket (408, 431 e 400) saem como `ApiError`.
- **`trustProxy`:** `false` por padrão. `TRUST_PROXY` aceita só IP ou CIDR, validado com Zod no `main.ts`, e recusa `true`, `*`, `/0` e contagem de saltos.
- **CORS por hook próprio** (sem dependência nova). As origens exatas vêm de `CORS_ALLOWED_ORIGINS`, validadas na subida:
  - origem fora da lista dá 403 na borda;
  - sem `credentials`;
  - preflight só com GET, POST e PUT e com `authorization` e `content-type`;
  - as respostas de erro também levam CORS.

### Qualidade
- API com **224 testes**, 90 novos, 9 deles em servidor real numa porta efêmera:
  - Content-Length mentiroso para mais e para menos;
  - chunked;
  - slowloris;
  - socket ocioso;
  - keep-alive;
  - HTTP malformado;
  - headers grandes demais.
- **18/18** mutantes mortos.
- **Instabilidade introduzida e corrigida:** com os testes novos, os testes de relógio do SR-09 passaram a falhar no turbo paralelo, por disputa de CPU (de 1 a 28 ms parado, até 557 ms sob carga). Agora o SR-09 mede o **melhor de 3**, com o **mesmo orçamento de 200 ms**, e os projetos do Vitest rodam em sequência (domínio antes da borda).
- 15/15 tarefas do turbo **em paralelo, três vezes seguidas**; `--frozen-lockfile` limpo; depcruise verde; e2e da extensão 10/10.

### Branch
- O `feat/monorepo-workspace` já tinha sido mergeado no `master` pelo PR #1. Esta tarefa foi para o novo branch local **`feat/api-borda`**, com commit local e **sem push**.

## Fila depois desta tarefa
- **F1-LLM-01, parte 2 (adapter do Groq):** depende do S-1 (modelo, `reasoning_effort` e tetos de token medidos).
- **F1-API-02:** HITL-004 (Supabase). **F1-API-03:** HITL-007 (Upstash).
- **F1-DOM-04:** ⛔ pelo S-4 (HITL-003). **F1-DOM-02:** exige o ADR-002, um marco de aprovação humana.

Por isso, a próxima tarefa é o `LlmOutputGuard`, que não depende de provedor nem de chave.

## Ação manual (HITL) antes do próximo comando
- Nenhuma, além de **reciclar a sessão** (veja o aviso no topo).
- **Opcional:** decidir se o `feat/api-borda` vira PR (push não autorizado até você dizer).
- Em background: HITL-003 (30 vagas).

## Prompt para enviar ao agente

```text
Equipe, vamos executar a F1-LLM-01 parte 1 (LlmOutputGuard, E5). Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos. Sigam o ciclo de 5 fases do AGENTS.md, inclusive a avaliação de continuidade da Fase 5.

HITL-003: [em andamento / concluído: N vagas]

1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md, BACKLOG.md (F1-LLM-01), o ADR-001 (E5 Guarda de saída e §5.5), o contratos-zod (JobFactsSchema e safeText), o threat-model (SR-01, T1, T2, T3, T17 e a regra de remover URL dos campos de texto) e o código atual de apps/api/src (domínio e ports). Confirme pnpm 11.4.0, Node ≥ 24 e o branch (feat/api-borda ou o que o humano indicar) limpo.
2. [ARCHITECT] + [APPSEC]: Decidam e registrem em ADR ANTES de codar:
   - onde o guard mora (domínio puro ou application) e a sua porta de entrada: string bruta do provedor → resultado tipado (ok com JobFacts | falha com motivo fechado);
   - teto de tamanho em bytes da resposta ANTES do parse;
   - parse seguro (secure-json-parse ou equivalente, com __proto__ e constructor em erro), sem eval;
   - pré-saneamento: remover URLs e esquemas (javascript:, data:) dos campos de texto livre de saída, reaplicar o NFKC e os invisíveis e limitar strings e arrays;
   - validação com o JobFactsSchema estrito (chave extra = falha), sem coerção silenciosa;
   - nenhum dado do perfil do usuário no guard (LGPD) e nenhum texto do LLM em log.
3. [DEV]: Implemente SOMENTE o guard e os seus testes. Não implemente o adapter do Groq (parte 2, depende do S-1) nem o router (F1-LLM-03).
4. [QA_EVALS]:
   - Testes com saídas maliciosas: JSON gigante, proto poisoning, chaves extras, URLs e javascript: nos textos, invisíveis, números absurdos (1e308, NaN como string), arrays enormes, tipos trocados e JSON truncado.
   - Propriedades no fast-check: nunca lança, saída ok sempre passa no JobFactsSchema e nunca contém URL.
   - Cobertura de 100% e mutação.
   - `pnpm install --frozen-lockfile` limpo; `pnpm turbo run build typecheck lint test` verde; `pnpm lint:deps` verde; `test:e2e` da extensão verde.
5. [SCRIBE]: Marque a F1-LLM-01 parte 1 no STATE.md (checkpoint imediato), registre no SESSION-LOG e em ADR, faça o commit local (push NÃO autorizado) e gere o novo ./next-step.md. Na Fase 5, avancem sozinhos só se não houver HITL e o contexto estiver seguro.
```
