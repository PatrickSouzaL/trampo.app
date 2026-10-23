# Próximo passo: F1-API-05, desenho do `GET`/`PUT /v1/criteria` (ADR-021)

> **Sem HITL bloqueando.** A sessão parou por escopo (AGENTS §4.1): a entrega única foi o commit 2 do F1-LLM-02.

## O que acabou de ser entregue (2026-10-23)

### F1-LLM-02 commit 2: adapter da Workers AI e `rpd` do ledger (ADR-020 §6.2)
- **Adapter:** `apps/api/src/infrastructure/llm/cloudflare-workers-ai-extractor.ts`, **sem ligação no `main.ts`**. Ele só entra na produção depois do gate do S-1 (T28).
  - URL por segmento validado e conferida no boot.
  - Corpo de lista fechada com o prompt `p1` (SR-01) e um nonce por chamada.
  - Tetos de 48 KiB enviados e 32 KiB lidos, com UTF-8 estrito e *reviver*.
  - Tabela de status do D6 e `Retry-After` só em segundos ou IMF-fixdate.
  - O token fica só no closure, e o corpo de erro nunca é lido (SR-12).
- **Emendas ao ADR-020:**
  - **D5:** `redirect: "manual"`. O 3xx vira `erro_permanente` sem 2ª requisição; com `"error"`, viraria transitório.
  - **D9:** `rpd` publicado 54 e efetivo 45. O 46 do ADR já tinha a folga, que seria aplicada duas vezes.
- **Testes:** 151 novos, contra uma Workers AI simulada em socket real. A API tem 2.369 testes e 100% de cobertura.
- **Mutação:** 54 mutantes, 49 mortos e 5 equivalentes. Três sobreviventes da 1ª rodada viraram testes.
- **`[APPSEC]` sem veto:** os 9 critérios do §3 foram cumpridos.
- **Commit `b4b4689`**, local, sem push.

### Pendências do humano
- **Push** do `feat/api-borda` (`a703ed3`, `2b441d3`, `bb0c7ab`, `0cc7d4e`, `56d8f09`, `b4b4689` e o commit deste arquivo), quando autorizar. O gitleaks não rodou na estação, e o job `secrets` do CI confere no push.
- **S-1 (decisão do humano):** o código do F1-LLM-02 está pronto para o S-1, que manda os textos do golden dataset para a Groq e a Workers AI reais e gasta a cota gratuita. Se quiser rodá-lo antes do F1-API-05, avise. Antes, rode o teste do passo 4 do runbook `llm`.
- O `git stash` no `master` pode ser descartado (`git stash drop`) se a edição não for mais útil.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-API-05) e HITL-QUEUE.md, o ADR-018 (D2 a D7 e §3), o ADR-017 (a rota /v1/analyze e o CriteriaGuard) e o ADR-014 (classes de rate limit). Confirme pnpm 11.4.0, Node conforme o engines e o branch feat/api-borda. Se o humano autorizou o push, ou pediu o S-1 no lugar desta tarefa, registre e siga a escolha dele.
2. Tarefa única (AGENTS §4.1): o desenho do F1-API-05 num ADR-021 aceito, SEM código.
   - GET /v1/criteria e PUT /v1/criteria com o UserCriteriaSchema, o userId só do token verificado e o erro CRITERIOS_NAO_CONFIGURADOS.
   - Escrita pelo cliente de usuário do PostgREST (publishable + JWT, RLS como 2ª barreira), com a pretensão cifrada pelo SalaryCipher antes de sair da API e nunca devolvida em claro de forma diferente da leitura.
   - Rate limit, teto do corpo, idempotência do PUT, concorrência (upsert e versão), telemetria sem perfil e logs sem PII (SR-12).
   - Partição em commits atômicos e critérios de aceite do [APPSEC] (SR-15, T16).
3. [APPSEC]: auditem o desenho com poder de veto antes de aceitar o ADR.
4. [SCRIBE]: atualizem STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md.
```
