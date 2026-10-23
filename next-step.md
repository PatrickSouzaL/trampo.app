# Próximo passo: F1-API-05 commit 1, teto de bytes no `UserCriteriaSchema` (ADR-021 D3)

> **Sem HITL bloqueando.** A sessão parou por escopo (AGENTS §4.1): a entrega única foi o ADR-021.

## O que acabou de ser entregue (2026-10-23)

### F1-API-05: desenho aceito no ADR-021 (sem código)
- **Arquivo:** `../base/02-arquitetura/ADRs/ADR-021-criteria-routes.md`, com `status: aceito`.
- **Rotas:**
  - `GET /v1/criteria` responde 200 com o `UserCriteria` e `Cache-Control: no-store`. Sem critérios, 409 `CRITERIOS_NAO_CONFIGURADOS`; em qualquer falha, 503.
  - `PUT /v1/criteria` substitui o documento inteiro e responde 204, sem corpo. Também pode responder 400, 413 (teto de 16 KiB na rota) ou 503.
- **Escrita:**
  - um *upsert* único no PostgREST (`on_conflict=user_id`, `merge-duplicates`, `return=minimal`), com as colunas explícitas em `columns=`;
  - a pretensão sai da API só cifrada e nunca é devolvida pelo PUT;
  - o corpo de erro do PostgREST nunca é lido, porque o Postgres ecoa a linha recusada;
  - o `CriteriaGuard.save` tem prazo de 1.000 ms e revalida os critérios.
- **Idempotência e concorrência:** o PUT é idempotente porque substitui tudo. A última gravação vence, sem coluna de versão na Fase 1; o ADR registra quando rever.
- **Borda:**
  - classe de rate limit `criterios` no PUT, com 10 por usuário e 30 por IP;
  - CORS por rota: a origem da extensão só alcança `POST /v1/analyze` (emenda ao ADR-007 D6), para os critérios nunca chegarem à extensão;
  - nenhum evento de telemetria novo.
- **Achado:** um perfil válido com caracteres de 4 bytes ocupa 16.693 bytes na coluna, acima do `check` de 16.384 do banco. O PUT desse perfil daria 503 para sempre. A correção é um teto de 12.288 bytes no contrato, sem migration. O pior caso em texto latino tem 7,2 KB.
- **`[APPSEC]` sem veto:** 10 critérios de aceite e 5 riscos residuais aceitos.
- **Partição em 6 commits:** contrato → porta e guarda → cliente e adapter → CORS e classe → rotas e composição → `test:db`. O 6º só fecha com push e o job `db` verde.
- STATE, BACKLOG e SESSION-LOG atualizados. Só este arquivo entra no commit local, sem push.

### Pendências do humano
- **Push** do commit deste arquivo, quando quiser. Nada do código mudou.
- **S-1 (decisão do humano):** continua disponível. Ele manda os textos do golden dataset para a Groq e a Workers AI reais e gasta a cota gratuita. Se quiser rodá-lo antes do commit 1, avise.
- O `git stash` no `master` pode ser descartado (`git stash drop`) se a edição não for mais útil.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-API-05) e HITL-QUEUE.md e o ADR-021 (D1, D3, D10 e §3). Confirme pnpm 11.4.0, Node conforme o engines e o branch feat/api-borda. Se o humano pediu o S-1 no lugar desta tarefa, registre e siga a escolha dele.
2. Tarefa única (AGENTS §4.1): o commit 1 do ADR-021, só em packages/contracts.
   - USER_CRITERIA_MAX_JSON_BYTES = 12_288 e CRITERIA_BODY_MAX_BYTES = 16_384 em limits.ts.
   - refine no UserCriteriaSchema com TextEncoder sobre o JSON.stringify do valor parseado, erro criterios_grandes_demais, sem Buffer (o portal usa o mesmo schema). Confirmem que o .shape e os usos atuais do schema continuam funcionando.
   - Testes: o pior caso de 4 bytes (16.828) recusado, o pior caso latino (7.228) aceito, as bordas 12.288 e 12.289 no byte exato e o espelho na leitura do SupabaseCriteriaRepository (linha acima do teto → unavailable).
   - 100% de cobertura no contrato, mutação e o [APPSEC] do critério 9 do §3.
3. [SCRIBE]: atualizem o ADR-021 (§5, implementação), STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md.
```
