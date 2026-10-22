# Próximo passo: decidir o push e o PR da fatia Ingress + Auth + Rate Limit

> **PARADA OBRIGATÓRIA** (AGENTS §2, fase 5): a fatia Ingress + Auth + Rate Limit está completa, e a regra do humano é parar aqui para decidir o push e o PR. Nada saiu do repositório local.

## O que acabou de ser entregue (2026-10-21)

### F1-API-03 concluída (commit `f1e09dc` no `feat/api-borda`, sem push)
Decisões em [[ADR-014-rate-limit-and-quota]]:
- **Sem dependência nova.** O `@upstash/ratelimit` 2.2.0 e o `@upstash/redis` 1.39.0 foram conferidos no npm e recusados:
  - o `@upstash/ratelimit` libera no timeout (T39) e põe a regra em Lua, que nenhum Redis simulado executa;
  - o `@upstash/redis` faz retry por padrão.

  No lugar deles, um cliente REST próprio (`fetch` em `/multi-exec`) devolve 503 em qualquer desvio: prazo de 200 ms, status ≠ 200, redirecionamento, corpo acima de 16 KiB, JSON ou UTF-8 inválido, `{ error }` em qualquer comando, tamanho ou tipo errado.
- **Rate limit** por usuário e por IP (IPv6 pelo /64), logo depois do JWT e antes de ler o corpo. Por minuto: `padrao` com 60 por usuário e 120 por IP; `analise` com 5 e 20.
- **Cota diária:** 50 análises por dia de Brasília, idempotente por `requestId`. Fica num `preHandler` pronto para o `/v1/analyze`.
- **`QuotaLedger`** em Redis: 15% de folga por provedor e breaker global de 400 chamadas por dia UTC. Provado com o router real, que dá `cota_esgotada` quando o Redis falha.
- **Chaves:** HMAC-SHA256 com `RATE_KEY_PEPPER` obrigatório (SR-17). Nenhum IP, `sub`, chave ou `requestId` vai para o log (SR-12).
- **Verificação:**
  - 351 testes novos; a API tem 1.316 testes, com 100% de linhas e ramos;
  - Upstash simulado em socket real: lento, travado, 401, 500, lixo e gigante;
  - mutação 98/98;
  - turbo 18/18 em série; depcruise verde.

### A fatia completa, local e sem push
11 commits à frente de `origin/feat/api-borda`, de `855382b` (S-4) até o commit deste `next-step.md`. Inclui F1-DOM-02, F1-DOM-03, F1-API-02 e F1-API-03, além dos `next-step.md`.

### Pendências
- **HITL-021** (novo, 🟡): gerar o `RATE_KEY_PEPPER` e colocar no `apps/api/.env` ([[upstash-redis]] §8). Ele **não bloqueia** testes, push nem PR. Sem ele, só não dá para subir a API fora dos testes.
- **QA-01:** sem afrouxar os 200 ms. Resolve-se com *jobs* isolados no CI (F1-OPS-01); até lá, o turbo local roda em série.
- **DOC-01:** no backlog, sem prioridade.
- **Resíduo novo (S-5):** a inundação **sem token** não passa pelo limitador do Redis, para não gastar o orçamento de comandos. Fica para a borda da hospedagem.

## Prompt para enviar ao agente

Escolha uma opção de push e PR e, se quiser, troque a tarefa seguinte:

```text
Equipe, sobre a fatia Ingress + Auth + Rate Limit:

PUSH E PR (escolha uma):
  A) Autorizo push do feat/api-borda e abertura do PR para o master (recomendado: a fatia está verde e o CI do F1-OPS-01 depende do push).
  B) Autorizo só o push, sem PR.
  C) Ainda não: mantenham tudo local.

1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md e o ADR-014. Confirme pnpm 11.4.0, Node >= 24 e o branch feat/api-borda.
2. [SCRIBE] (A ou B): antes do push, rode de novo `pnpm exec turbo run build lint typecheck test --concurrency=1 --force` e `pnpm lint:deps`. Faça o push. Na opção A, abra o PR para o master com o resumo da fatia (F1-DOM-02, F1-DOM-03, F1-API-02 e F1-API-03, os ADRs 002 e 012 a 014, e as pendências HITL-021, QA-01 e o resíduo do S-5). Registre no STATE e no SESSION-LOG.
3. [ORCHESTRATOR]: depois, sigam com o F1-CACHE-01 (JobFactsCache em Redis: chave versionada, SET NX EX, revalidação na leitura, política de escrita do SR-08). Reaproveitem o cliente REST do ADR-014, e o cache falha como miss, nunca como hit. Ciclo estrito: ADR-015, auditoria do [APPSEC] antes do código, Redis simulado, 100% de linhas e ramos, mutação e turbo em série.
```
