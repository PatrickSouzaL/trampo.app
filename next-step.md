# Próximo passo: push e primeira execução do CI (HITL-025), depois o job `db` do F1-OPS-01

> **[PARADA OBRIGATÓRIA]** (AGENTS §2, Fase 5):
> - a parte 2 do F1-OPS-01 (job `db`, com as migrations e o SR-15) só pode ser verificada no *runner* do GitHub;
> - o **HITL-025** (push, primeira execução do CI e configuração do repositório) está aberto.

## O que acabou de ser entregue (2026-10-22, commit local `b48a6cc`, sem push)

### Decisões registradas
- **HITL-024 fechado:** a publishable e o anel da pretensão estão no `apps/api/.env` (declarado pelo humano; a equipe não leu o arquivo).
- **Push autorizado:** o PR #4 foi mergeado no `master`. O `feat/api-borda` foi adiantado para o `master` só com *fast-forward*.

### F1-OPS-01 parte 1 ([[ADR-019-ci-github-actions]], `[APPSEC]` sem veto)
- **`.github/workflows/ci.yml`**, com três jobs:
  - `secrets`: gitleaks 8.30.1 baixado do release, conferido por sha256 e rodado sobre o histórico inteiro com `--redact`;
  - `quality`: build, lint, typecheck e depcruise;
  - `test`: turbo em série num job próprio, para o SR-09 não disputar CPU com o `next build` (QA-01).
- **Endurecimento:**
  - actions de lista fechada, fixadas por SHA;
  - `contents: read` e nenhum segredo;
  - `persist-credentials: false`, sem cache e nenhum `${{ }}` em `run:`;
  - runner `ubuntu-24.04` e Node 24 (o piso do `engines`).
- **`.gitleaks.toml`:** libera só os valores exatos das 8 *fixtures* falsas, nunca um caminho. O histórico sai sem achados, e uma chave nova num arquivo de teste continua sendo pega.
- **`@trampo/ci-policy`:** a política do workflow é uma função pura, e o `ci.yml` real passa por ela no `pnpm test`. Afrouxar o workflow derruba o próprio CI.
  - 134 testes e 100% de cobertura;
  - mutação com 74 mutantes, 72 mortos e 2 equivalentes;
  - o `js-yaml` 4.3.2 já estava no lockfile, então nenhum pacote novo foi baixado.
- **Gate:** turbo 21/21 em série e depcruise sem violações (362 módulos).

### Pendência do humano: HITL-025 ([[github-actions]])
1. Fazer o push do `feat/api-borda` e abrir o PR para o `master`.
2. Conferir os jobs `secrets`, `quality` e `test`.
3. Restringir as actions à lista do ADR-019 e deixar o `GITHUB_TOKEN` só de leitura.
4. Exigir o CI no `master`. **Atenção:** em repositório privado no plano Free, o GitHub não aplica regra de branch. O runbook traz as opções A, B e C.

Não crie *secret* nenhum para o CI.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md e HITL-QUEUE.md (HITL-025) e o ADR-019. Confirme pnpm 11.4.0, Node >= 24 e o branch feat/api-borda. Registre a resposta do humano ao HITL-025: CI verde ou o job e o passo que falharam, as permissões de Actions e a opção de proteção (A, B ou C).
2. Escolha UMA tarefa (AGENTS §4.1):
   - Se algum job do CI falhou: corrija a causa no código (nunca afrouxe o workflow nem a política do @trampo/ci-policy) e devolva para um novo push.
   - Com o CI verde: o F1-OPS-01 parte 2 (ADR-019 D8). É o job db com o F1-DB-01 parte 3: supabase init, as migrations do ADR-018 D2 e D3 e o projeto Vitest test:db com todo o SR-15 do ADR-018 D7. O supabase/setup-cli entra na lista fechada da política, por SHA e com a versão do CLI fixa. Nunca use supabase link, db push, token ou o projeto real, e o teste recusa URL que não seja 127.0.0.1. Feche o QA-01 se o job test estiver verde.
   - Sem resposta do HITL-025: o F1-LLM-02. O contrato do model com o prefixo estrito @cf/ vem primeiro, num commit próprio, com os testes negativos do BACKLOG. Depois vem o adapter da Workers AI, ligado pelo composeApp com options.llm.
3. [DEV] + [QA_EVALS]: exijam 100% de cobertura nos arquivos novos e mutação (um mutante por vez, script em arquivo fora do repositório, original conferido depois de cada mutante; patch com acento só pela ferramenta de edição). Nas migrations, a prova é o test:db no runner.
4. [APPSEC]: auditem antes de dar a tarefa como concluída.
5. [SCRIBE]: atualizem STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md. Se a parte 2 ficar pronta, abram o HITL-026 (push e execução do job db). O HITL-023 só abre com o job db verde.
```
