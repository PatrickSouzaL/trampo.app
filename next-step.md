# Próximo passo: F1-EXT-07 (achados E-01 a E-03 da revisão adversarial de auth)

> Abra uma sessão nova e envie o prompt abaixo. Nenhum HITL bloqueia a F1-EXT-07.
> Última entrega: F1-API-08 (`142da30`), com a recusa do GoTrue só com o corpo dele, o 401 do logout fora de "encerrada" e a vaga do *bulkhead* que a troca nunca ocupa; HITL-038 e HITL-039 fechados (sessão 20). Detalhes no `SESSION-LOG`; trilhas e cuidados em `../base/00-orquestracao/TRILHAS.md`.

## Pendências do humano

- **HITL-037:** o GitHub não mostra PR depois do #20, e o `master` ainda não tem os commits desde o `8c59e5a`. Abrir o PR do `spike/s1-extraction` para o `master`, conferir os 4 checks e mergear com merge commit, sem apagar o branch. O job `db` roda pela 1ª vez os 9 casos novos do contrato do GoTrue (F1-API-08). Runbook: `../base/03-infra-runbook/publicar-branch-pr.md` §4 a §6.

## Próximo prompt

```text
Equipe, sigam em ciclo estrito de DevSecOps. Trilha F1-EXT-07 (achados E-01, E-02 e E-03 da revisao-adversarial-auth), sem gastar cota e sem chamar o Supabase real. Push do spike/s1-extraction só com autorização no prompt.

1. [ORCHESTRATOR]: leiam o STATE.md, o HITL-QUEUE.md e o TRILHAS.md (cuidados 10, 15 a 18 e 22 a 26); rodem git fetch e gh pr list do branch. Leiam a revisao-adversarial-auth (E-01 a E-03), o BACKLOG#F1-EXT-07, o ADR-004 D10 (B2 e B5) e D11, e o auth-service.ts e o eslint.config.js com os testes deles.
2. [ARCHITECT] + [APPSEC]: decidir a forma do item 2 (geração ou token capturado no envio) e do item 3 (logout remoto em melhor esforço da troca descartada, sem gravar nada), registrar no ADR-004 (D10 e D11) e conferir que o alias de storage fica como residual de lint coberto pelo E2E.
3. [DEV] + [QA_EVALS]: testes antes do código (setAccessLevel computado e desestruturado derrubam o lint do SW; o marcador no artefato inteiro, background.js incluído; o 2º 401 de uma sessão anterior não apaga a sessão de um login novo; "Sair" durante a troca em voo chama o logout remoto com o access recebido e não grava nada), 100% de cobertura, mutação dirigida no auth-service e no bloco B2, E2E local no Edge, turbo em série, depcruise e gitleaks 8.30.1 conferido.
4. [SCRIBE]: STATE a cada passo; no fim, SESSION-LOG, BACKLOG, TRILHAS.md e next-step (só status, pendências apontando para HITL/runbook e o prompt). Commit atômico; push só se autorizado.
```
