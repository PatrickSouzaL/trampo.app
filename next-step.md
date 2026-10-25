# Próximo passo: decidir a cadeia de provedores (HITL-028) e então fazer o `p2` e o `g3`

> **O próximo passo depende de você.** O S-1 foi medido por inteiro, e a recomendação final está na `spike-metrics` §2.5. Responda o **HITL-028** (no chat ou no `HITL-QUEUE.md`) antes de enviar o prompt abaixo.

## O que acabou de ser entregue (2026-10-25)

### S-1 medido por inteiro (branch `spike/s1-extraction`)
- **Groq `gpt-oss-20b` estrito:** o item de 4k que faltava (`gupy-03`) também foi recusado. No total, **26 de 92 chamadas (28%) foram recusadas com `400 json_validate_failed`**.
- **Groq sem `strict` (`nao_estrito`), nas 26 recusadas:**
  - todas voltaram 200, com 0 recusas do servidor;
  - o guard aceitou 12 e recusou 14 (`schema_invalido`).
- **Groq composto** (estrito onde passou, `nao_estrito` onde foi recusado):
  - 83/83 respostas e **85,5% de JSON válido** depois do guard;
  - p95 de 1,2 s, com máximo de 1,39 s em 118 chamadas.
- **Diagnóstico em memória** (modo novo `S1_MODE=diag`, que mostra só o caminho, o código e o valor com forma de enum):
  - as recusas vêm de `benefits` fora do enum (`vale_transporte` em 8, `auxilio_refeicao` e `gympass`) e de `languageRequirements: null`;
  - o gabarito já mapeia esses três benefícios (golden-dataset-spec §5.1), mas o prompt `p1` não traz a regra;
  - o modo estrito do Groq valida depois de gerar: é a mesma saída, só que a extração inteira se perde.
- **Segurança:**
  - 0 canário vazado, 0 salário inventado e 0 moeda nula;
  - o SR-04 só diverge em `benefits`, e nenhum ataque do `gd1` mira benefícios (conferido nos textos sintéticos);
  - o T4 real é 0.
- **Gate §8.1:** ainda nenhum provedor passa inteiro. Os dois falham em `contractTypes` e no recall de stack.
- **Recomendação final** (spike-metrics §2.5):
  - Groq sem `strict` e com o guard como primário;
  - Workers AI como fallback, com teto de ~3 s no Groq (emenda ao ADR-009 D4);
  - `p2` e `g3` (emenda ao ADR-008 D5) antes do adapter;
  - `LLM_INPUT_MAX_CHARS` mantido em 6.000 e as metas do Blueprint mantidas;
  - `gd2` com o SR-04 sem `benefits`.
- **Commit local**, sem push. Cota usada hoje: ~86K tokens do Groq e ~300 neurônios.

### Pendências do humano
- **HITL-028 (bloqueante):** responda **"HITL-028: 1A, 2A, 3A, 4A"** (ou as letras escolhidas). Os quatro itens:
  1. **Cadeia e modo:** (A) Groq sem `strict` → Workers AI → determinístico; (B) Groq estrito; (C) Workers AI como primário.
  2. **Teto da tentativa do Groq:** (A) 3 s; (B) 2,5 s; (C) manter 10 s.
  3. **SR-04 no `gd2`:** (A) sem `benefits`; (B) como está.
  4. **Escopo da correção:** (A) `p2` e `g3`; (B) só o `p2`; (C) ampliar o enum de `benefits`.
- O `git stash` no `master` pode ser descartado com `git stash drop`, se não servir mais.

## Prompt para enviar ao agente (depois de responder o HITL-028)

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leiam STATE.md, HITL-QUEUE.md (HITL-028), spike-metrics §2.5 e ADR-008. Confirmem pnpm 11.4.0, o Node conforme o engines e o branch spike/s1-extraction. Minha resposta ao HITL-028 é: <cole aqui, por exemplo "1A, 2A, 3A, 4A">.
2. [SCRIBE]: fechem o HITL-028 com a resposta acima e registrem as emendas aceitas (ADR-008 D5, ADR-009 D4, golden-dataset-spec gd2).
3. [ARCHITECT] + [APPSEC]: desenhem o prompt p2 e o guard g3 conforme o escopo decidido, com a auditoria prévia e os critérios de aceite. Sem rodar o S-1 nesta sessão.
4. [DEV] + [QA_EVALS]: implementem SÓ o g3 (um commit atômico), com testes, cobertura de 100% e mutação; o p2 fica para o commit seguinte.
5. [SCRIBE]: atualizem STATE.md e SESSION-LOG.md, façam o commit local e gerem o novo ./next-step.md.
```
