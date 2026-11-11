# Próximo passo: F1-API-08 (recusa do GoTrue só com o corpo dele)

> Abra uma sessão nova e envie o prompt abaixo. Nenhum HITL bloqueia a F1-API-08.
> Última entrega: F1-SEC-01, com o threat model v2, a revisão adversarial de auth (7 achados, nenhum crítico) e os testes do A-03 e do A-04 (sessão 19). Detalhes no `SESSION-LOG`; trilhas e cuidados em `../base/00-orquestracao/TRILHAS.md`.

## Pendências do humano

- **HITL-039 (não bloqueia trilha):** aprovar o threat model v2 e a revisão adversarial de auth (CA-13). O que ler e como responder: `../base/00-orquestracao/HITL-QUEUE.md`, seção HITL-039.
- **HITL-037:** abrir o PR do `spike/s1-extraction` para o `master`, conferir os 4 checks e mergear com merge commit, sem apagar o branch. Runbook: `../base/03-infra-runbook/publicar-branch-pr.md` §4 a §6.
- **HITL-038 (antes do 1º build real):** corrigir as origens do `apps/extension/.env` e rodar a conferência. Runbook: `../base/03-infra-runbook/auth-extensao.md` §1.7.
- **Ambiente local:** `supabase start` exige a chave de assinatura (`auth-extensao` §1.6); a API fora de teste exige as variáveis de `auth-extensao` §1.5.

## Próximo prompt

```text
Equipe, sigam em ciclo estrito de DevSecOps. Trilha F1-API-08 (achados A-01, A-02 e A-03 da revisao-adversarial-auth; emenda do ADR-004 D7), sem gastar cota e sem chamar o Supabase real. Push do spike/s1-extraction só com autorização no prompt.

1. [ORCHESTRATOR]: leiam o STATE.md, o HITL-QUEUE.md e o TRILHAS.md (cuidados 10, 14 e 25); rodem git fetch e gh pr list do branch. Leiam a revisao-adversarial-auth (A-01 a A-03), o BACKLOG#F1-API-08, o ADR-004 D7, D8 item 5 e a "Emenda da F1-SEC-01" no §3, e o gotrue-token-client.ts com os testes dele.
2. [ARCHITECT] + [APPSEC]: primeiro, conferir no job db (GoTrue local, test:db) se as recusas reais de 400, 401, 403 e 422 da troca, da renovação e do logout trazem error_code; depois, escrever a emenda do D7 (recusa só com o corpo do GoTrue; o 401 do logout deixa de valer como encerrada) e decidir a vaga da renovação no bulkhead (A-03).
3. [DEV] + [QA_EVALS]: testes novos antes do código (401 "Invalid API key" e 403 text/html dão nao_recebido; RefreshSession responde 503 sem apagar a sessão; logout com publishable errada não sai como 204), troca dos testes que prendem o comportamento de hoje, 100% de cobertura, mutação dirigida no gotrue-token-client, turbo em série, depcruise e gitleaks 8.30.1 conferido.
4. [SCRIBE]: STATE a cada passo; no fim, SESSION-LOG, BACKLOG, TRILHAS.md e next-step (só status, pendências apontando para HITL/runbook e o prompt). Commit atômico; push só se autorizado.
```
