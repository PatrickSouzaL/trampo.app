# Próximo passo: F1-API-05 commit 3, `PostgrestUserClient.upsert` e `SupabaseCriteriaRepository.save` (ADR-021 D5 e D6)

> **Sem HITL bloqueando.** A sessão parou por escopo (AGENTS §4.1): a única entrega foi o commit 2 do ADR-021.

## O que acabou de ser entregue (2026-10-23)

### F1-API-05 commit 2: porta `save` e `CriteriaGuard.save` (ADR-021 §5.2)
- **Porta partida:**
  - `CriteriaReader` tem o `load`, e `CriteriaWriter` tem o `save`, que devolve `CriteriaSave`;
  - `CriteriaRepository` é a união das duas;
  - o adapter do Supabase declara só `CriteriaReader` até o commit 3, sem stub;
  - a rota de análise pede só `CriteriaReader` (privilégio mínimo).
- **`CriteriaGuard<P>` genérico:**
  - o `save` declara `this: CriteriaGuard<CriteriaRepository>`. Num guarda sobre uma porta só de leitura, chamar `save` não compila (provado com `@ts-expect-error`), e, furado o tipo, a chamada falha fechado;
  - confere o sujeito, reparseia os critérios e entrega à porta o valor reparseado;
  - prazo de 1.000 ms no `Clock`, com o sinal abortado;
  - só `{ saved: true }` estrito conta como sucesso. O `save` nunca rejeita.
- **Fake:** o `FakeCriteriaRepository` ganhou o `save`, que registra `saves`.
- **Testes:** 43 novos. A API está com 2.413 testes e 100% de cobertura.
- **Portão:** turbo 16/16 e 7/7 em série, depcruise sem violações e mutação 14/14. Numa das 8 rodadas, um teste de relógio do SR-09 falhou de forma intermitente com a CPU disputada, como já estava registrado.
- **`[APPSEC]` sem veto.** O critério 6 do §3 está cumprido na camada de aplicação.
- **Commit `3d3cd50`**, mais o commit deste arquivo. Os dois foram enviados no **push autorizado** do `feat/api-borda`. STATE, BACKLOG, SESSION-LOG e ADR-021 foram atualizados.

### Pendências do humano
- **Push:** o gitleaks não rodou na estação. Confira o job `secrets` do CI no GitHub para o push desta sessão.
- **S-1 (autorizado):** o S-1 é um spike inteiro e gasta a cota gratuita dos provedores reais, então fica para uma sessão própria (AGENTS §4.1). Se quiser rodá-lo antes do commit 3, troque a tarefa do prompt abaixo pelo S-1 do BACKLOG.
- O `git stash` no `master` pode ser descartado com `git stash drop`, se a edição não servir mais.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-API-05) e HITL-QUEUE.md, o ADR-021 (D3, D4, D5, D6, D10 e §3, e o §5.2 para a porta partida) e o ADR-018 (D4 e D5). Confirme pnpm 11.4.0, o Node conforme o engines e o branch feat/api-borda.
2. Tarefa única (AGENTS §4.1): o commit 3 do ADR-021, só na camada infrastructure.
   - PostgrestUserClient.upsert:
     - POST /rest/v1/user_criteria?on_conflict=user_id&columns=user_id,schema_version,criteria,salary_ciphertext,updated_at;
     - Prefer: resolution=merge-duplicates,return=minimal; apikey publishable e Bearer do dono;
     - redirect "error", prazo de 900 ms combinado com o sinal do guarda e token conferido antes de virar cabeçalho;
     - teto de 32 KiB no corpo enviado (acima disso, { ok: false } sem enviar);
     - lista de colunas como parâmetro tipado;
     - sucesso só no status fixado (hipótese 201, a confirmar no commit 6);
     - corpo de erro nunca lido.
   - SupabaseCriteriaRepository.save:
     - cipher.seal(userId, salary), com a SalarySealError virando unavailable;
     - coluna criteria sem salary e sem schemaVersion;
     - updated_at vindo do now() injetado, em ISO 8601;
     - linha montada como literal com exatamente as 5 colunas.
     - O adapter passa de CriteriaReader para CriteriaRepository (ADR-021 §5.2), e o composeApp ganha o save sem mudar.
   - Testes do D10 (commit 3), contra o PostgREST simulado em socket real:
     - cabeçalhos exatos, URL e corpo com as 5 colunas;
     - canários (pretensão ausente do corpo cru, coluna criteria sem salary/schemaVersion, AAD do dono);
     - falha fechado em 401, 403, 409 com corpo que ecoa canário, 413, 500, redirecionamento, lento, travado, socket cortado e corpo acima de 32 KiB;
     - ida e volta save → load, inclusive com salary: null.
   - 100% de cobertura, mutação e o [APPSEC] (critérios 1, 3 e 6 do §3).
3. [SCRIBE]: atualizem o ADR-021 (§5.3), STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md.
```
