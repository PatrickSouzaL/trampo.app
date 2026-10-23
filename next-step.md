# Próximo passo: F1-API-05 commit 2, porta `save` e `CriteriaGuard.save` (ADR-021 D5)

> **Sem HITL bloqueando.** A sessão parou por escopo (AGENTS §4.1): a entrega única foi o commit 1 do ADR-021.

## O que acabou de ser entregue (2026-10-23)

### F1-API-05 commit 1: teto de bytes no contrato (ADR-021 §5.1)
- **Contrato:**
  - `USER_CRITERIA_MAX_JSON_BYTES` = 12.288, medido em bytes UTF-8 do JSON do valor já parseado;
  - `CRITERIA_BODY_MAX_BYTES` = 16.384, o teto do corpo da rota PUT, que entra no commit 5;
  - o `UserCriteriaSchema` recusa o que passar do teto com `criterios_grandes_demais`. A conta usa `TextEncoder`, que também roda no portal.
- **Leitura:** herda o teto. Uma linha gravada direto no PostgREST acima dele dá 503.
- **Correção no ADR-021 §1.1:** o caso "latino" de 7.228 bytes tinha as notas com caracteres de 4 bytes. Com `Ã`, são 6.328. Nenhuma decisão muda.
- **Testes:** 10 novos. Contratos com 91 e API com 2.370, os dois com 100%.
- **Portão:** turbo 16/16 e 7/7 em série; depcruise sem violações; mutação com 9 mutantes, todos mortos.
- **`[APPSEC]` sem veto.**
- **Commit `1cbf825`**, local, sem push. STATE, BACKLOG, SESSION-LOG e ADR-021 atualizados.

### Pendências do humano
- **Push** do `feat/api-borda` (o `next-step` anterior, o `1cbf825` e o commit deste arquivo), quando quiser. O gitleaks não rodou na estação, e o job `secrets` do CI confere no push.
- **S-1 (decisão do humano):** continua disponível. Ele gasta a cota gratuita dos provedores reais. Se quiser rodá-lo antes do commit 2, avise.
- O `git stash` no `master` pode ser descartado (`git stash drop`) se a edição não for mais útil.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-API-05) e HITL-QUEUE.md e o ADR-021 (D5, D10 e §3) e o ADR-018 D6. Confirme pnpm 11.4.0, Node conforme o engines e o branch feat/api-borda. Está autorizado o push e o S-1, pode fazer tudo planejado
2. Tarefa única (AGENTS §4.1): o commit 2 do ADR-021, só na camada application (e o fake de teste).
   - CriteriaSave = { saved: true } | { saved: false, unavailable: true } e o save(subject, criteria, signal) na porta, que nunca rejeita.
   - Ponto a decidir e registrar no ADR-021 §5.2: pôr o save na interface CriteriaRepository obriga o SupabaseCriteriaRepository a implementá-lo já neste commit, mas o adapter é do commit 3. Separem a porta em leitura e escrita (CriteriaReader e CriteriaWriter, com CriteriaRepository como a união), ou escolham outra forma, desde que não fique stub nem código morto no adapter.
   - CriteriaGuard.save: confere o sujeito, revalida os critérios com o UserCriteriaSchema e passa o objeto reparseado, prazo de 1.000 ms com o Clock e o sinal abortado, resposta conferida por schema estrito. Nunca rejeita.
   - FakeCriteriaRepository com o save.
   - Testes do D10 (commit 2): porta travada, que rejeita, que lança de forma síncrona e que devolve forma errada; critérios fora do schema, acima do teto ou com chave a mais não chegam à porta; o adapter recebe o objeto reparseado.
   - 100% de cobertura, mutação e o [APPSEC] (critério 6 do §3).
3. [SCRIBE]: atualizem o ADR-021 (§5.2), STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md.
```
