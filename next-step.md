# Próximo passo: terminar o S-1 no Groq (cota renovada) e decidir a cadeia de provedores

> **O próximo passo depende do tempo, não de você.** O teto diário de tokens do Groq (200K) acabou em 2026-10-24, por volta das 19h UTC, e se renova aos poucos ao longo de 24 h. Rode o prompt abaixo a partir de 2026-10-25, por volta das 19h UTC.

## O que acabou de ser entregue (2026-10-24)

### HITL-027 fechado e F1-API-05 concluído
- **PR #11** foi mergeado, e o job `db` passou com **61/61**. A equipe conferiu no GitHub, só com leitura.
- ADR-021 §5.7, STATE, BACKLOG e HITL-QUEUE foram fechados.

### S-1 medido em parte (branch `spike/s1-extraction`)
- **Script:** `evals/spikes/s1-extraction/`, com o prompt `p1`, o guard `g2`, o normalizador e o seletor reais. O comando é `pnpm --filter @trampo/evals spike:s1`, e os modos estão no README do spike.
- **Plano estratificado**, decidido pelo humano:
  - 6k nos 83 casos;
  - 4k e 8k só onde o orçamento muda o texto. Isso dá 9 casos em 4k e nenhum em 8k, porque o maior texto do `gd1` tem 5.602 caracteres.
- **Workers AI (Llama 3.3 70B), 92/92:**
  - 96,4% de JSON válido depois do guard;
  - **p50 de 6,4 s e p95 de 9,9 s**;
  - cerca de 70 neurônios por chamada (o ADR-020 estimava 182).
- **Groq `gpt-oss-20b` estrito:**
  - p95 de 1,2 s, cerca de 2,1k tokens por chamada e a melhor qualidade por campo;
  - **21 de 83 recusas com `400 json_validate_failed`**;
  - o teto diário chegou depois de 90 chamadas.
- **Gate §8.1:** nenhum dos dois provedores passa inteiro. Os dois falham em `contractTypes`, porque leem "Tempo integral" como contrato, e no recall de stack.
- **Segurança:** 0 canário vazado, 0 salário inventado e 0 moeda nula. O SR-04 só diverge em `benefits`.
- **Recomendação** (proposta, [[spike-metrics]] §2.5):
  - Groq como primário, se o modo `nao_estrito` com o guard resolver as recusas;
  - Workers AI como fallback, com o Groq limitado a cerca de 3 s;
  - `LLM_INPUT_MAX_CHARS` mantido em 6.000;
  - um prompt `p2`.
- **Commits locais**, sem push.

### Pendências do humano
- **Nenhuma bloqueante.** Depois da rodada final, a equipe vai pedir a sua decisão sobre a cadeia de provedores e o gate `gd2`.
- O `git stash` no `master` pode ser descartado com `git stash drop`, se não servir mais.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leiam STATE.md, BACKLOG.md (S-1), spike-metrics §2 e o README de evals/spikes/s1-extraction. Confirmem pnpm 11.4.0, o Node conforme o engines e o branch spike/s1-extraction.
2. S-1, rodada final do Groq (gasta a cota gratuita; autorizado):
   - S1_MODE=run S1_PROVIDERS=groq (1 item em 4k);
   - S1_MODE=run S1_PROVIDERS=groq S1_GROQ_VARIANT=nao_estrito S1_ONLY=json_validate_failed (24 itens), com o diagnóstico do failed_generation;
   - se a cota ainda não tiver voltado, o script para sozinho no teto diário: registrem e parem.
3. [ARCHITECT] + [APPSEC]: fechar a §2.5 com os números finais e levar ao humano a decisão da cadeia (primário, fallback, strict ou não, teto do Groq) e do gd2 (SR-04 sem benefits?), via HITL.
4. [SCRIBE]: atualizem spike-metrics, SESSION-LOG.md e STATE.md, façam o commit local e gerem o novo ./next-step.md.
```
