# Próximo passo: HITL-027 (push e job `db` verde), que fecha o F1-API-05; depois, o S-1

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este `next-step.md`.
>
> **O HITL-027 bloqueia o fechamento do F1-API-05.** Ele não bloqueia o S-1.

## O que acabou de ser entregue (2026-10-24)

### F1-API-05 commit 6: `test:db` da escrita (ADR-021 §5.6)
- **`apps/api/test/db/criteria-write.db.test.ts`**, com 14 testes no job `db`:
  - **SR-15 da escrita:** a primeira barreira foi furada de propósito (dono B, token de A). O resultado foi 403 `42501` na inserção, na sobrescrita e no insert puro, e a linha de B ficou intacta byte a byte. Sem token, `anon` recebeu 401;
  - o status real do *upsert*;
  - o perfil válido mais pesado dentro do `check` de 16 KiB;
  - 5 rodadas de concorrência sem mistura;
  - o `columns=` com `%2C`, lido como lista.
- **`heaviest-criteria.ts`:** gera um perfil com 12.288 bytes de JSON em ideogramas de 4 bytes sorteados, com semente fixa. O teste dele roda no `pnpm test`.
- **Achado (emenda ao ADR-021 D5):** o PostgREST 16.4 responde **201 quando insere e 200 quando atualiza**. Com a hipótese anterior (só 201), todo PUT depois do primeiro viraria 503.
  - O cliente passou a aceitar `[201, 200]`.
  - O PostgREST simulado agora imita o real.
  - Os testes de unidade conferem o retorno das duas gravações.
- **Prova local com Postgres 17.11 e PostgREST 16.4 reais**, no scratchpad e sem Docker:
  - `test:db` com 61/61 e 100% de cobertura no apoio;
  - a coluna do pior caso tem 12.663 bytes sem compressão, abaixo dos 16.384;
  - o Kong e o GoTrue foram trocados por um gateway mínimo, então a prova definitiva continua sendo o job `db`.
- **Mutação:**
  - cliente com 7/7 mortos;
  - migration com 6/6 mortos, rodando contra a pilha real;
  - um teste de insert puro entrou para isolar a policy de insert da de SELECT.
- **Portão:**
  - turbo com 16/16 de build, typecheck e lint e 7/7 de teste, em série;
  - API com 2.609 testes e 100% de cobertura;
  - depcruise sem violações (384 módulos).
- **`[APPSEC]` sem veto.** Os critérios 2 e 9 do §3 foram atendidos.
- **Commit `f3491d8`**, local, sem push. ADR-021, STATE, BACKLOG, HITL-QUEUE e SESSION-LOG foram atualizados.

### Pendências do humano
- **HITL-027:**
  1. Faça o push do `feat/api-borda`. Sobem o `955da43`, o `9371774`, o `2667e6e`, o `f3491d8` e os commits de `next-step`.
  2. Abra o PR para o `master`. O CI deste branch só roda em `pull_request`.
  3. Confira o job `db`: o `test:db` precisa mostrar **61 passed**.
  4. Responda "HITL-027 concluído: db verde com 61/61, PR #N", ou mande as últimas linhas do erro, sem o bloco de chaves do `supabase start`.
- O `git stash` no `master` pode ser descartado com `git stash drop`, se a edição não servir mais.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leiam STATE.md, BACKLOG.md e HITL-QUEUE.md. Confirmem pnpm 11.4.0, o Node conforme o engines e o branch feat/api-borda.
2. HITL-027: <cole aqui a resposta, por exemplo "HITL-027 concluído: db verde com 61/61, PR #N", ou o erro do job>.
   - Se o db estiver verde, conferir no GitHub só com leitura, fechar o HITL-027 e o F1-API-05 (ADR-021, STATE e BACKLOG).
   - Se falhou, diagnosticar pelo log e corrigir numa tarefa única (AGENTS §4.1).
3. Com o F1-API-05 fechado, a tarefa seguinte é o S-1 (autorizado; gasta a cota gratuita dos provedores reais), conforme o BACKLOG, numa sessão própria se o contexto não for seguro.
4. [SCRIBE]: atualizem SESSION-LOG.md e STATE.md, façam o commit local e gerem o novo ./next-step.md.
```
