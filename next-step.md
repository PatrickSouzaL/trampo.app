# Próximo passo: F1-API-05 commit 6, `test:db` da escrita (ADR-021 D10 e §3, critérios 2 e 9)

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este `next-step.md`.
>
> **Nenhum HITL bloqueia o código do commit 6.** Ele só **fecha** com push e o job `db` verde no GitHub, e o HITL de push abre nessa entrega.

## O que acabou de ser entregue (2026-10-24)

### F1-API-05 commit 5: rotas `GET` e `PUT /v1/criteria` e a composição (ADR-021 §5.5)
- **Rotas** (`presentation/routes/criteria.ts`), só com a opção `criteria?: { repository }` do `buildApp`. Sem ela, as rotas dão 404 `PROIBIDO`.
  - **GET**, na classe `padrao`: 200 com o `UserCriteria` validado na saída, 409 `CRITERIOS_NAO_CONFIGURADOS` e 503. Uma saída fora do contrato vira 500 sem eco.
  - **PUT**, na classe `criterios`:
    - `bodyLimit` de 16 KiB: 413 sem parse, provado no byte exato;
    - `UserCriteriaSchema`: 400 sem as *issues* do Zod;
    - 204 sem corpo, e 503 sem eco.
  - **`Cache-Control: no-store`** por `onSend` da rota. Vale também nos erros dos hooks globais (401, 403, 415, 429) e do mapeador de erro (400, 413, 500). O `/health` não ganha o cabeçalho.
  - O dono vem só do principal, e o token é o bearer já verificado. A *query* é ignorada, e nenhuma das rotas gasta cota diária.
- **`composeApp`:** passa o **mesmo** `CriteriaGuard` da análise. Isso foi provado pela identidade da instância, com um espião no protótipo, em PUT, GET e `POST /v1/analyze`.
- **Log (emenda ao ADR-010 D2):** `criterios_gravacao_indisponivel` (warn, sem campos), no PUT que vira 503. O GET reusa o `criterios_indisponiveis`.
- **Testes:**
  - 65 novos: 60 da rota e 5 do boot com as peças reais;
  - o parser JSON instrumentado prova que não há parse no 401, no 413 e no 429;
  - o SR-12 usa canários nos caminhos 200, 204, 400, 413, 429 e 503;
  - a API tem 2.598 testes e 100% de cobertura, já com o `criteria.ts`;
  - o `HEAD` anterior tinha 2.533 testes, e não os 2.531 registrados antes. A contagem foi corrigida no cofre.
- **Portão:**
  - turbo com 16/16 de build, typecheck e lint e 7/7 de teste, em série, sem intermitência;
  - depcruise sem violações (381 módulos);
  - mutação com 34 mortos de 35. O sobrevivente é equivalente: o GET sem a classe declarada cai em `padrao`.
- **`[APPSEC]` sem veto.** Os critérios 1, 4, 7 e 8 do §3 foram atendidos.
- **Commit `2667e6e`**, local, sem push. ADR-021, ADR-010, STATE, BACKLOG e SESSION-LOG foram atualizados.

### Pendências do humano
- **Push** do `feat/api-borda`, quando quiser. Faltam subir o `955da43`, o `9371774`, o `2667e6e` e os commits de `next-step`. O CI deste branch só roda em `pull_request`.
- **S-1 (autorizado):** fica para uma sessão própria, porque gasta a cota gratuita dos provedores reais. Para rodá-lo antes do commit 6, troque a tarefa do prompt abaixo pela do S-1 no BACKLOG.
- O `git stash` no `master` pode ser descartado com `git stash drop`, se a edição não servir mais.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leiam STATE.md, BACKLOG.md (F1-API-05) e HITL-QUEUE.md, o ADR-021 (D5, D7, D10, §3 e §5.3 a §5.5), o ADR-018 (D2, D3, D7 e §3.3) e o ADR-019 (§3.2 e §3.3, o job db). Confirmem pnpm 11.4.0, o Node conforme o engines e o branch feat/api-borda.
2. Tarefa única (AGENTS §4.1): o commit 6 do ADR-021, em apps/api/test/db, contra o Supabase local do runner (nunca o projeto real).
   - SR-15 da escrita: A grava pelo adapter real; o cliente de A, chamado direto com o user_id de B (furando a primeira barreira de propósito), é recusado pela RLS na inserção e na sobrescrita da linha de B, e a linha de B continua intacta.
   - O upsert real fixa o status de sucesso do D5 (hipótese: 201). Se for outro, ajustem o upsertSuccessStatus e registrem no ADR.
   - O perfil válido mais pesado (12.288 bytes de JSON, caracteres de 4 bytes não compressíveis) passa no check de 16 KiB do banco real.
   - Duas gravações concorrentes do mesmo dono terminam em um dos dois documentos inteiros, nunca numa mistura.
   - A vírgula de columns= codificada (%2C) é aceita pelo PostgREST real na escrita.
   - anon continua sem acesso (herdado).
   - Sem Docker na estação: a prova local é a simulação já usada no F1-DB-01 parte 3 (scratchpad). A prova real é o job db no GitHub.
   - 100% de cobertura no que for tocado, mutação e o [APPSEC] (critérios 2 e 9 do §3).
3. [SCRIBE]: atualizem o ADR-021 (§5.6), STATE.md, BACKLOG.md e SESSION-LOG.md, façam o commit local, abram o HITL de push e da execução do job db (o F1-API-05 só fecha com ele verde) e gerem o novo ./next-step.md.
```
