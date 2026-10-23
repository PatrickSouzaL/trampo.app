# Próximo passo: push e primeira execução do job `db` (HITL-026)

> **[PARADA OBRIGATÓRIA]** (AGENTS §2, Fase 5):
> - a prova definitiva da migration é o job `db` no *runner* do GitHub, porque a estação não tem Docker;
> - o **HITL-026** (lista de actions, push e execução) é ação humana.

## O que acabou de ser entregue (2026-10-22, commit local `02f4bcb`, sem push)

### Decisões registradas
- **HITL-025 fechado:** os jobs `secrets`, `quality` e `test` ficaram verdes no GitHub, e o **QA-01 fechou**. As actions estão restritas, o `GITHUB_TOKEN` é só leitura e a proteção do `master` é a opção B.

### F1-OPS-01 parte 2 e F1-DB-01 parte 3 ([[ADR-019-ci-github-actions]] §3.2, [[ADR-018-postgres-schema-rls-and-criteria]] §3.3; `[APPSEC]` sem veto)
- **Migration** `supabase/migrations/20261022230000_criterios_analises_feedback.sql`, numa transação:
  - as tabelas `user_criteria`, `analyses` e `analysis_feedback`, com `check`s nomeados;
  - RLS ligada e forçada, e `revoke` de `public`, `anon`, `authenticated` e `service_role`;
  - uma policy por comando, pelo dono, e a FK composta no feedback.
- **Job `db`** no `ci.yml`:
  - `supabase/setup-cli` v2.1.2 por SHA e a CLI 2.120.0, com os dois binários conferidos por sha256;
  - telemetria desligada e `start -x` só com Postgres, Auth, PostgREST e o gateway;
  - só `API_URL`, `DB_URL` e `PUBLISHABLE_KEY` saem do `status`.
- **`test:db`** (fora do `pnpm test`): o SR-15 inteiro em 47 testes, inclusive pelo adapter real da API. O guarda aceita só `127.0.0.1` e a publishable, e recusa qualquer variável do projeto real.
- **Política** `@trampo/ci-policy`: `setup-cli` na lista fechada, com duas regras novas:
  - `versao_nao_fixa`;
  - `supabase_remoto`: lista positiva de subcomandos e nenhuma marca do projeto real, em valor ou em chave.
- **Prova local**, por simulação do runner no scratchpad (PGlite com um esboço do Supabase):
  - 88/88 cenários SQL;
  - o próprio `test:db` com 47/47, por um emulador de Auth e PostgREST;
  - mutação: migration com 63 de 65 mortos (2 equivalentes), política com 31 de 32 (1 equivalente) e guarda com 35 de 35.
- **Gate:**
  - turbo 21/21 em série;
  - API com 2.162 testes e 100%;
  - depcruise sem violações (368 módulos);
  - gitleaks sem achados.

### Pendência do humano: HITL-026 ([[github-actions]] §6)
1. **Antes do push**, acrescentar `supabase/setup-cli@*` e `oven-sh/setup-bun@*` à lista de actions permitidas. A `setup-cli` chama o `setup-bun` por dentro.
2. Fazer o push do `feat/api-borda` e abrir o PR.
3. Conferir os quatro jobs: `secrets`, `quality`, `test` e `db`.
4. Com o `db` verde, exigir o check `db` no `master`.

Não crie *secret* nem token. Não rode `supabase link` nem `db push`. Se o `db` falhar, mande o passo e as últimas linhas do erro, sem o bloco de chaves locais que o `supabase start` imprime.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md e HITL-QUEUE.md (HITL-026), o ADR-019 §3.2 e o ADR-018 §3.3. Confirme pnpm 11.4.0, Node >= 24 e o branch feat/api-borda. Registre a resposta do humano ao HITL-026: db verde (e o check db exigido no master) ou o passo que falhou, com as últimas linhas do erro.
2. Escolha UMA tarefa (AGENTS §4.1):
   - Se o job db falhou: corrija a causa na migration, no test:db ou no workflow, sem afrouxar a política do @trampo/ci-policy, o guarda do test:db nem a RLS. Repita a simulação do runner fora do repositório (PGlite e emulador) e a mutação, e devolva para um novo push (HITL-026 de novo).
   - Com o db verde: feche o F1-OPS-01 parte 2 e o F1-DB-01 parte 3 e abra o HITL-023 (aplicar a migration no projeto real pelo painel ou pela CLI do humano, nunca pela equipe), com runbook. Depois siga para o F1-LLM-02: o contrato do model com o prefixo estrito @cf/ vem primeiro, num commit próprio, com os testes negativos do BACKLOG.
   - Sem resposta do HITL-026: o F1-LLM-02, como acima.
3. [DEV] + [QA_EVALS]: exijam 100% de cobertura nos arquivos novos e mutação (um mutante por vez, script em arquivo fora do repositório, original conferido depois de cada mutante; patch com acento só pela ferramenta de edição).
4. [APPSEC]: auditem antes de dar a tarefa como concluída.
5. [SCRIBE]: atualizem STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md.
```
