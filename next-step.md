# Próximo passo: F1-API-01 (borda da API, SR-07)

> **Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.**
> (AGENTS §2, Fase 5, e §4.4. A parada é por reciclagem de sessão, não por HITL: a próxima tarefa não exige nenhuma ação sua.)

## O que acabou de ser entregue (F1-DOM-01 completa, 2026-10-19)

### Parte 1: `JobTextNormalizer` (commit `54412d6`, ADR-005)
- `sha256` por porta `TextHasher` (adapter `node:crypto` provado com o NIST).
- A única exceção de valor no domínio é `@trampo/contracts/limits`, trancada pela regra `contracts-limits-leaf`.
- `toWellFormed` → [NFKC → fins de linha → invisíveis → re-truncamento → espaços → máscaras de PII e URL → delimitadores → guarda final], repetido até o ponto fixo → sha256. Versão `n1`.

### Parte 2: `RelevantSectionSelector` (ADR-006)
- **Micro-payload do LLM por blocos.** Os blocos de **contato** (F-04, nomes de recrutadores) e de **diretiva ao modelo** (T2, mesmo sob "Requisitos") são descartados antes do orçamento.
- **Faixas de prioridade:** salário e modelo de trabalho → cabeçalho (300) → relevante → não classificado → boilerplate.
- **Montagem:** corte parcial com sobra ≥ 200 e ordem original. O marcador `[…]` usa U+2026, que a vaga não consegue forjar (o NFKC troca as reticências por três pontos).
- **Orçamento:** 6.000, com falha fechada fora de [1.000, 15.000]. Versão `sel1`.
- **Refactor:** `countCodePoints`, `truncateWithinCeiling` e `DependencyContractError` agora ficam em `domain/text/code-points.ts`. A saída do normalizador não mudou.

### Qualidade
- API com **134 testes**:
  - 9 propriedades no fast-check;
  - SR-09 com 20 entradas patológicas de 64 KiB, cada uma em < 200 ms;
  - cobertura de **100%** no domínio (63/63 ramos);
  - **15/15** mutantes mortos (6 do normalizador e 9 do seletor).
- 15/15 tarefas do turbo, depcruise verde e e2e da extensão 10/10.

### Fila depois desta tarefa
- **F1-DOM-04:** ⛔ pelo S-4 (HITL-003).
- **F1-DOM-05:** depende da forma dos sinais do F1-DOM-04.
- **F1-DOM-02:** exige o **ADR-002** (fórmula e pesos da nota), um marco de aprovação humana.

Por isso, a próxima tarefa é a borda da API.

- Branch `feat/monorepo-workspace`, só local (sem push).

## Ação manual (HITL) antes do próximo comando
- Nenhuma, além de **reciclar a sessão** (veja o aviso no topo).
- Em background: HITL-003 (30 vagas), com o guia na HITL-QUEUE. Ele destrava a P0-EVL-01, os Spikes S-1, S-2 e S-4 e, por consequência, o F1-DOM-04.

## Prompt para enviar ao agente

```text
Equipe, vamos executar a F1-API-01 (borda da API). Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos. Sigam o ciclo de 5 fases do AGENTS.md, inclusive a avaliação de continuidade da Fase 5.

[Opcional] HITL-003: [concluído: N vagas / ainda não].

1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md, BACKLOG.md (F1-API-01), o ADR-001 §5.1 (E0 Borda: ordem onRequest → parser → preValidation), o threat-model (SR-07, T18, T19 e T37, se houver) e o código atual de apps/api/src/presentation/build-app.ts e main.ts. Confirme pnpm 11.4.0, Node ≥ 24 e o branch limpo.
2. [ARCHITECT] + [APPSEC]: Decidam e registrem ANTES de codar:
   - só o parser JSON. Sem Content-Type application/json, 415. Content-Encoding diferente de identity, 415, e nenhum plugin de descompressão;
   - bodyLimit = HTTP_BODY_MAX_BYTES (de @trampo/contracts/limits), checado pelo Content-Length e no streaming, com 413 ANTES do parse;
   - requestTimeout e connectionTimeout explícitos (o padrão do Fastify é ilimitado), e também keepAliveTimeout e headersTimeout;
   - trustProxy: a hospedagem ainda não foi decidida (S-5 / ADR-003). Escolham um padrão seguro (false) e a forma de configurar por ambiente, validada com Zod no main.ts, sem confiar em X-Forwarded-For por padrão;
   - CORS com as origens EXATAS (chrome-extension://<ID> e a origem do portal) vindas do ambiente, sem curinga, sem credentials se não forem necessárias, e com preflight restrito aos métodos e headers usados. Decidam se usam @fastify/cors (proveniência, idade mínima, árvore) ou um hook próprio;
   - o mapeamento de 413 e 415 para ApiError (PAYLOAD_GRANDE_DEMAIS e PAYLOAD_INVALIDO? Conferir o catálogo do contrato v1).
3. [DEV]: Implemente SOMENTE a borda (presentation + main.ts + .env.example só com nomes). Não implemente JWT (F1-API-02) nem rate limit (F1-API-03).
4. [QA_EVALS]: Valide com fastify.inject e, onde o inject não exercita o socket (Content-Length mentiroso, streaming lento, timeouts), com um servidor real em porta efêmera:
   - 413 sem parse (prova: o handler e o parser não rodam);
   - 415 para tipo não JSON e para gzip;
   - CORS: origem permitida, origem negada, preflight;
   - proto poisoning recusado;
   - timeouts;
   - 100% dos testes verdes; `pnpm install --frozen-lockfile` limpo; `pnpm turbo run build typecheck lint test` verde; `pnpm lint:deps` verde; `test:e2e` da extensão verde.
5. [SCRIBE]: Marque a F1-API-01 como [x] no STATE.md (checkpoint imediato), registre no SESSION-LOG (e em ADR, se houver decisão de arquitetura), faça o commit local no feat/monorepo-workspace (push NÃO autorizado) e gere o novo ./next-step.md. Na Fase 5, avancem sozinhos só se não houver HITL e o contexto estiver seguro.
```
