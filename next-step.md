# Próximo passo: F1-EXT-04 parte 2 (envio da análise à API)

> Abra uma sessão nova e envie o prompt abaixo. Nenhum HITL bloqueia a F1-EXT-04 parte 2.
> Última entrega: batelada da sessão 21, com o hotfix do job `db` (`4bf1e40`), a F1-EXT-07 (`08149f0`), a F1-EXT-06 (`8f81e42`) e o 07i e o 07j da F1-API-07 (`53ba9c1` e `c6f0c3b`); PR #21 com os 4 checks verdes. Detalhes no `SESSION-LOG`; trilhas e cuidados em `../base/00-orquestracao/TRILHAS.md`.

## Pendências do humano

- **HITL-037:** conferir o PR #21 (`spike/s1-extraction` para o `master`) e mergear com merge commit, sem apagar o branch. Runbook `../base/03-infra-runbook/publicar-branch-pr.md` (§5 e §6). Não bloqueia a próxima trilha.

## Próximo prompt

```text
Equipe, sigam em ciclo estrito de DevSecOps. Trilha F1-EXT-04 parte 2 (envio da análise à API pela extensão), sem gastar cota e sem chamar o Supabase real (API falsa nos testes). Push do spike/s1-extraction só com autorização no prompt.

1. [ORCHESTRATOR]: leiam o STATE.md, o HITL-QUEUE.md e o TRILHAS.md (linha da F1-EXT-04 parte 2 e cuidados 19 a 24 e 27 a 29); rodem git fetch e gh pr view 21 --json state,mergeCommit. Leiam o BACKLOG#F1-EXT-04, o ADR-025, o ADR-004 (D10 B6, D11.4 e D12) e o ADR-017 (SSE).
2. [ARCHITECT] + [APPSEC]: desenhem o envio no Service Worker: portão do consent.isGranted() e da sessão, accessToken() e onUnauthorized(tentativa, usado) com o token capturado no envio, SSE, source com platform e extractorVersion, a mensagem analisar e a fonte do API_DO_ENVIO (B6). Registrem no ADR antes do código.
3. [DEV] + [QA_EVALS]: testes antes do código, 100% nas 4 métricas, mutação dirigida em primeiro plano com sha256 conferido; os cenários 3, 4, 5 e 12 do E2E entram também nas provas negativas (cuidado 24).
4. [SCRIBE]: STATE a cada passo; no fim, SESSION-LOG, BACKLOG, TRILHAS.md e next-step (só status, pendências apontando para HITL/runbook e o prompt). Commit atômico; push só se autorizado aqui.
```
