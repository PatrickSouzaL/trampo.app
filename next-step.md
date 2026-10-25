# Próximo passo: desenhar o `g3` e o `p2` e implementar o `g3` (S-1, HITL-028 fechado)

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-25)

### S-1 medido por inteiro (branch `spike/s1-extraction`)
- **Groq `gpt-oss-20b` estrito:** **26 de 92 chamadas (28%) foram recusadas com `400 json_validate_failed`**, inclusive o `gupy-03` em 4k, que faltava.
- **Groq sem `strict` (`nao_estrito`), nas 26 recusadas:** todas voltaram 200, com 0 recusas do servidor. O guard aceitou 12 e recusou 14 (`schema_invalido`).
- **Groq composto** (estrito onde passou, `nao_estrito` onde foi recusado):
  - 83/83 respostas e **85,5% de JSON válido** depois do guard;
  - p95 de 1,2 s, com máximo de 1,39 s em 118 chamadas.
- **Diagnóstico em memória** (modo novo `S1_MODE=diag`):
  - as recusas vêm de `benefits` fora do enum (`vale_transporte` em 8, `auxilio_refeicao` e `gympass`) e de `languageRequirements: null`;
  - o gabarito já mapeia esses benefícios (golden-dataset-spec §5.1);
  - o modo estrito do Groq só valida depois de gerar, então perde a extração inteira.
- **Segurança:**
  - 0 canário vazado, 0 salário inventado e 0 moeda nula;
  - o SR-04 só diverge em `benefits`, e nenhum ataque mira benefícios;
  - o T4 real é 0.
- **Gate §8.1:** nenhum provedor passa inteiro. Os dois falham em `contractTypes` e no recall de stack, que são alvo do `p2`.
- Commits locais `d1f0b07` e seguinte, sem push. A cota do Groq usada hoje foi de ~86K tokens.

### HITL-028 fechado: 1A, 2A, 3A, 4A (todas as recomendações)
1. **Cadeia:** Groq sem `strict`, com o guard como portão → Workers AI → determinístico.
2. **Teto do Groq:** 3 s por tentativa, o que pede uma emenda ao ADR-009 D4 com teto por provedor.
3. **`gd2`:** o SR-04 deixa de comparar `benefits`, que fica só no §8.1. A nota está na golden-dataset-spec §8.2.
4. **Correção:** `p2` e `g3` antes do adapter do Groq. O `g3` exige uma emenda ao ADR-008 D5.

### Pendências do humano
- Nenhuma bloqueante.
- O `git stash` no `master` pode ser descartado com `git stash drop`, se não servir mais.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leiam STATE.md, HITL-QUEUE.md (HITL-028), spike-metrics §2.2.1 e §2.5, ADR-008 (D5) e o llm-output-guard.ts. Confirmem pnpm 11.4.0, o Node conforme o engines e o branch spike/s1-extraction.
2. [ARCHITECT] + [APPSEC]: desenhem o guard g3 (emenda ao ADR-008 D5) com auditoria prévia e critérios de aceite:
   - item fora do enum sai do array, sem virar outro valor;
   - null num array vira [];
   - location com os três campos nulos vira null;
   - tudo contado no sanitization e fora do injectionSignal.
   Registrem também o p2 (mapeamento de benefícios do §5.1, "tempo integral" não é contrato, recall de stack, sem salario_omitido) e a emenda ao ADR-009 D4 (teto de 3 s por provedor), só como desenho.
3. [DEV] + [QA_EVALS]: implementem SÓ o g3, num commit atômico, com testes, cobertura de 100% e mutação. O p2 fica para o commit seguinte, e a rodada de aceite do S-1 para uma sessão própria (gasta um dia de cota do Groq).
4. [SCRIBE]: atualizem STATE.md e SESSION-LOG.md, façam o commit local e gerem o novo ./next-step.md.
```
