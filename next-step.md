# Próximo passo: F1-API-04 parte 1 (`AnalyzeJob`)

> **Reciclagem de sessão** (AGENTS §4.4): esta janela fechou a mutação do F1-DOM-04 e escreveu o ADR-017.
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-22)

### Mutação do F1-DOM-04 fechada (commit `0c235fd`, **local, sem push**)
- O script da rodada anterior tinha se perdido. Os 29 mutantes pendentes foram **reconstruídos a partir do código**, e a rodada ganhou 13 extras: 42 no total.
- **Resultado:** 41 mortos e 1 equivalente (V18, provado por varredura exaustiva). Três sobreviventes viraram teste no `PreFilterRouter`:
  - **R5:** a vaga limpa ganhava um aviso falso de injection;
  - **R6:** termos do perfil iam ao resolver (minimização);
  - **R14:** a guarda de vacuidade dependia de um detalhe do motor.
- **Total do F1-DOM-04:** 144 mutantes, 140 mortos e 4 equivalentes.
- **Verificação:** API com 1.715 testes e 100% de cobertura; `tsc` e `eslint` verdes. O turbo completo não rodou: só um arquivo de teste mudou, e a máquina tinha ~1 GB de RAM livre.

### F1-API-04: desenho aceito ([[ADR-017-analyze-job-and-stream]], sem código)
- **Funil:** `recebido` → `normalizando` → `triagem_deterministica` → `consultando_cache` → `extraindo_fatos` → `pontuando`.
- **Caminhos sem IA:** R1 e R3 saem como `triagem_deterministica`, e o **R2 sai como `fallback_deterministico`** com `analise_degradada`. Os três reaproveitam `decision.deterministic`.
- **Caminho R4:** `cache_jobfacts`, `extracao_llm` ou `fallback_deterministico`. Os `markedStackTerms` são os deal-breakers ∪ must-have do usuário.
- **Cache:** escrito sem bloquear e só no caminho `extracao_llm`, com a saída da guarda.
- **Stream em SSE:** um `data:` por evento, validado pelo `AnalysisStreamEventSchema`; sem `id:` e sem `retry:`; `reply.send(stream)` sem `hijack`; exceção vira um único `error` com `ERRO_INTERNO`.
- **Borda:** os **critérios são lidos antes da cota**. Ausentes dão 409; banco fora do ar dá 503.
- **Telemetria:** evento `analysis` novo, sem nota, veredito nem nada derivado do perfil.
- **Ligação:** a rota só existe com a opção `analysis` do `buildApp`. O `main.ts` liga depois do F1-DB-01 (F1-API-04b).
- **`[APPSEC]`:** 10 critérios de aceite (ADR-017 §3) e sem veto.

### Pendências
- **Push e PR:** os commits `c928716`, `ddd148b`, `83d5fe4`, `0c235fd` e o deste `next-step` continuam locais (opção B: PR de processamento e domínio depois do merge do #3).
- **QA-01:** fica para o CI (F1-OPS-01).
- **DOC-01:** no backlog.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-API-04) e o ADR-017 inteiro. Confirme pnpm 11.4.0, Node >= 24, o branch feat/api-borda (commits locais, sem push: opção B) e a memória livre da máquina antes de rodar suítes pesadas.
2. [DEV] + [QA_EVALS]: F1-API-04 parte 1, só ela:
   - application/analysis/analyze-job.ts (aj1);
   - as portas CriteriaRepository e IdGenerator;
   - o evento de telemetria "analysis" (emenda ao ADR-010);
   - testes de ponta a ponta com LLM, cache e critérios falsos em todos os caminhos da tabela D3 do ADR-017, e os critérios do §3 que cabem na aplicação (canário de PII no payload, SR-11, SR-12, SR-08, nenhum extract em R1/R2/R3, autovalidação);
   - 100% de cobertura e mutação (um mutante por vez, em primeiro plano, script fora de coverage/, conferindo o original depois de cada lote).
3. [APPSEC]: Auditem o código contra o ADR-017 §3 antes de dar a parte como concluída.
4. [SCRIBE]: Atualizem STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md (próxima: parte 2, rota e SSE).
```
