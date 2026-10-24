# Próximo passo: S-1 (spike de extração com provedores reais)

## O que acabou de ser entregue (2026-10-24)

### HITL-027 fechado e F1-API-05 concluído
- O humano declarou o HITL-027 no next-step. A equipe conferiu no GitHub, só com leitura:
  - **PR #11** foi mergeado no `master` (`086730e`), com head `910b28b`, igual ao branch local. O `955da43` e o `9371774` já estavam no `master`;
  - o run `40119326854` teve `secrets`, `quality`, `test` e `db` verdes;
  - o passo `test:db` do job `db` mostrou **61 passed (61)** contra a pilha inteira do runner. A emenda ao ADR-021 D5 (201 na inserção e 200 na atualização) vale também fora da prova local.
- **F1-API-05 concluído.** Foram atualizados o ADR-021 (§5.7), o STATE, o BACKLOG, o HITL-QUEUE e o SESSION-LOG. Nenhum código mudou.

### Pendências do humano
- Nenhuma bloqueante. As variáveis `GROQ_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` e `CLOUDFLARE_API_TOKEN` existem no `apps/api/.env`. A equipe conferiu só os nomes, sem ler os valores.
- O `git stash` no `master` pode ser descartado com `git stash drop`, se a edição não servir mais.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leiam STATE.md, BACKLOG.md (S-1) e HITL-QUEUE.md, o runbook llm e a spike-metrics. Confirmem pnpm 11.4.0, o Node conforme o engines e o branch (criar um branch novo a partir do master atualizado, se o feat/api-borda não for o lugar do spike).
2. S-1 (autorizado; gasta a cota gratuita dos provedores reais): script descartável em evals/spikes/s1-extraction/, com o prompt p1 e o LlmOutputGuard reais, Groq e Cloudflare Workers AI, sobre os 83 casos do golden dataset, nos orçamentos de 4k, 6k e 8k caracteres. Chaves só do .env, sem nenhum texto de vaga em log e sem tools (SR-01). Antes de rodar o lote, um único caso por provedor para conferir os limites.
3. [SCRIBE]: preencham a seção S-1 da spike-metrics, atualizem SESSION-LOG.md e STATE.md, façam o commit local e gerem o novo ./next-step.md.
```
