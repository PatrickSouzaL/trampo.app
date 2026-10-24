# Próximo passo: F1-API-05 commit 4, CORS por rota e a classe `criterios` (ADR-021 D8.2 e D8.3)

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este `next-step.md`.
>
> **Nenhum HITL bloqueia.** A única entrega desta rodada foi o commit 3 do ADR-021.

## O que acabou de ser entregue (2026-10-24)

### F1-API-05 commit 3: `PostgrestUserClient.upsert` e `SupabaseCriteriaRepository.save` (ADR-021 §5.3)
- **Cliente (`upsert`):**
  - faz `POST` com `on_conflict=user_id` e `columns=` e manda `Prefer: resolution=merge-duplicates,return=minimal`;
  - usa a chave publishable e o Bearer do dono;
  - tem `redirect: "error"` e prazo de 900 ms combinado com o sinal do guarda;
  - monta o corpo **só com as colunas declaradas**, tipadas por tabela. Uma chave a mais no `row` não chega ao servidor;
  - tem teto de 32 KiB **em bytes**. Acima disso, nada é enviado;
  - só o 201 conta como sucesso;
  - **nunca lê o corpo da resposta.** Há um teste com uma resposta que não termina.
- **Adapter (`save`):**
  - agora é um `CriteriaRepository`;
  - cifra a pretensão com o AAD do dono, inclusive `null`;
  - grava a coluna `criteria` sem `salary` e sem `schemaVersion`;
  - preenche o `updated_at` com o `now` injetado;
  - faz um único *upsert* com as 5 colunas;
  - falha no `seal` ou no relógio dá `unavailable`, sem enviar nada.
- **`composeApp`:** só passa o `now` ao adapter. O guarda da análise ganhou o `save` sem outra mudança.
- **Testes:** 59 novos, entre eles os canários no corpo cru, a RLS recusando com a primeira barreira furada (no PostgREST simulado) e a ida e volta `save` → `load`. A API tem 2.472 testes e 100% de cobertura.
- **Portão:**
  - turbo 16/16, depcruise sem violações e mutação com 26 mortos de 27 (1 equivalente);
  - 2 rodadas do turbo tiveram 1 falha intermitente cada, em arquivos que este commit não tocou (`limits-stack` e `upstash-cache-stack`, os dois com prazo em relógio real; QA-01). A suíte da API sozinha passou nas 4 rodadas.
- **`[APPSEC]` sem veto.** Critérios 1, 3 e 6 do §3 atendidos na infraestrutura. A metade "banco real" do critério 2 e o status 201 real ficam para o commit 6.
- **Commit `955da43`**, local, sem push. STATE, BACKLOG, SESSION-LOG e ADR-021 foram atualizados.

### Pendências do humano
- **Push** do `feat/api-borda` (o `955da43` e o commit deste arquivo), quando quiser. O CI deste branch só roda em `pull_request`, então o `secrets` (gitleaks) só confere quando o PR para o `master` for aberto.
- **S-1 (autorizado):** fica para uma sessão própria, porque gasta a cota gratuita dos provedores reais. Para rodá-lo antes do commit 4, troque a tarefa do prompt abaixo pela do S-1 no BACKLOG.
- O `git stash` no `master` pode ser descartado com `git stash drop` se a edição não servir mais.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leiam STATE.md, BACKLOG.md (F1-API-05) e HITL-QUEUE.md, o ADR-021 (D8.1, D8.2, D8.3, D10 e §3) e as partes emendadas: ADR-007 D6 (CORS) e ADR-014 D4 (classes de rate limit). Confirmem pnpm 11.4.0, o Node conforme o engines e o branch feat/api-borda.
2. Tarefa única (AGENTS §4.1): o commit 4 do ADR-021, só em presentation/edge e application/limits.
   - CORS por rota (emenda ao ADR-007 D6):
     - uma origem chrome-extension:// (o padrão EXTENSION_ORIGIN do edge-env) é aceita só nas rotas de EXTENSION_ROUTES = [{ method: "POST", path: "/v1/analyze" }];
     - comparação exata do caminho cru antes do "?", sem normalizar;
     - fora da lista, 403 PROIBIDO, tanto no preflight (pelo Access-Control-Request-Method) quanto na requisição real (pelo método);
     - as outras origens (o portal) não mudam.
   - Classe de rate limit "criterios" (emenda ao ADR-014 D4): 10 por minuto por usuário e 30 por IP. A "analise" continua a mais estrita, e um valor desconhecido continua caindo nela.
   - Testes do D10 (commit 4):
     - a origem da extensão passa no POST /v1/analyze;
     - ela recebe 403 em GET e PUT /v1/criteria, no preflight e na requisição real;
     - também recebe 403 em /v1/analyze/, /v1/%61nalyze, //v1/analyze e com outro método;
     - a origem do portal passa em todas;
     - a política fixa "criterios" em 10/30 contra o ADR.
   - 100% de cobertura, mutação e o [APPSEC] (critérios 5 e 8 do §3).
3. [SCRIBE]: atualizem o ADR-021 (§5.4), o ADR-007 e o ADR-014 (nota da emenda), STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md.
```
