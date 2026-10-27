# Próximo passo: trilhas paralelas enquanto a cota do Groq não zera

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie **um** dos prompts abaixo.

## O que acabou de ser entregue (2026-10-27)

### Trilha B2: adapter do Groq (ADR-022 §4), 6 commits locais
| # | Commit | O que entrou | Mutação |
|---|---|---|---|
| 1 | `4220bee` | `infrastructure/llm/llm-http.ts`: helpers HTTP compartilhados pela Workers AI e pelo Groq | 11/11 |
| 2 | `5cc746d` | teto da tentativa por provedor no router (Groq 3 s; com o Groq travado, a Workers AI recebe 8,7 s) | 9/9 |
| 3 | `1b07950` | reserva pessimista de 3.000 tokens no ledger, com reconciliação (inclusive negativa) | 17/17 |
| 4 | `27aa181` | `recordRateLimit` e `llm:block` (bloqueio por `Retry-After` até 1 h, entre instâncias) | 16/16 |
| 5 | `f6e2cb8` | `groq-extractor.ts` contra um Groq simulado em socket real (113 testes) | 33/33 |
| 6 | `797c04b` | contadores do `g3`/`g4` na telemetria (`llm_guard_normalization_total`) | 14/14 |

- **Prova:**
  - os 10 critérios do ADR-022 §3 estão cobertos;
  - API com 2.879 testes e 100%;
  - turbo 19/19 em série;
  - depcruise sem violações;
  - typecheck do `@trampo/evals` verde.
- **O que a B2 não fez:** não ligou o adapter no `main.ts` (um teste confere isso), não chamou o Groq real e não mudou `p3`/`g4`. `[APPSEC]` sem veto.
- **Riscos residuais novos** (ADR-022 §5):
  - a reconciliação que cruza a virada do minuto ou do dia desloca até (reserva − uso) para a janela nova;
  - um 429 com `Retry-After` menor sobrescreve o bloqueio;
  - `tool_calls: null` é tolerado como ausência.
- **Instabilidade observada:** com a CPU em ~70% por carga externa, o SR-09 (QA-01) e o `edge-socket` 413 (QA-03) caíram em rodadas isoladas e passaram na suíte inteira em seguida. Os dois já estão no BACKLOG, e nada foi afrouxado.

### Antes (ainda valendo)
- `g4` (`90867d9`) e `p3` (`61474d0`), locais e sem push. O aceite dos dois espera a cota do Groq (Trilha A).
- QA-02 fechado (`d03c9c7`). Os residuais estão no QA-03.

### Pendências do humano
- Nenhum HITL aberto. O push continua não autorizado.

---

## Como usar: trilhas

**Regra de ouro:** só a **Trilha A** espera a cota do Groq. As outras andam hoje, em qualquer ordem entre si.

| Trilha | Sessão | Gasta cota do Groq? | Espera a Trilha A? |
|---|---|---|---|
| **A** | Aceite do `p3`/`g4` e, se o gate passar, ligar a cadeia no `main.ts` | **sim, um dia inteiro** | — |
| **D** | S-2 com fixtures sintéticas (extrator genérico e técnicas de ocultação do T2) | não | não |
| **E** | DOC-01 (sincronizar o `contratos-zod` do cofre com o código) | não | não |

**O que de fato espera a Trilha A:**
- ligar a cadeia Groq → Workers AI → determinístico no `main.ts`. O adapter do Groq já está pronto (B2);
- fechar o S-1 (modelo primário e gate por modelo do F1-EVL-01).

Nada nas trilhas D e E depende do resultado do aceite.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`. A Trilha A entra entre duas sessões quaisquer, assim que a cota zerar.
2. **Nenhuma sessão D ou E muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`.** Se mudar, o aceite passa a medir outra coisa. Se uma sessão precisar mudar alguma das duas, ela para e registra no STATE.
3. **Nenhuma sessão D ou E chama o Groq real.** Os testes usam *fakes*, e qualquer *smoke* com o provedor fica para a Trilha A.
4. **Testes novos de socket real seguem o QA-02:** o prazo folgado (`test/support/socket-deadlines.ts`) vale para protocolo e fluxo, e o prazo curto, para os testes de prazo.
5. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

**Sugestão de ordem:** D → E (B1, B2 e C concluídas). A Trilha A entra quando a cota zerar. O humano estima 24 h depois da rodada do `p2`, feita em 2026-10-26.

**Algo que o humano pode adiantar (opcional, sem bloquear nada):** para a parte real do S-2, salvar o HTML de 3 a 5 vagas do LinkedIn e da Gupy. Pela janela anônima, use "Salvar como → Página da Web, somente HTML", sem estar logado, e guarde **fora do repositório**. A Trilha D gera o runbook de anonimização antes de qualquer arquivo entrar no git.

---

## Prompts

### Trilha A: aceite do `p3`/`g4` (só com a cota do Groq zerada)
```text
Equipe, sigam em ciclo estrito. Trilha A do next-step: aceite do p3/g4 (spike-metrics §2.8, ADR-020 §8.4).
1. [ORCHESTRATOR]: leiam STATE.md, spike-metrics §2.7 e §2.8 e ADR-020 §8. Confirmem pnpm, Node, o branch spike/s1-extraction e que os HEADs do p3 e do g4 (61474d0 e 90867d9) e os 6 commits da B2 (4220bee a 797c04b) estão no histórico. Confirmem com o humano que a cota do Groq zerou antes de qualquer chamada.
2. [QA_EVALS]: S1_MODE=plan (sem rede) e um smoke de 1 chamada por provedor. Depois, S1_MODE=run S1_BUDGETS=6000 S1_GROQ_VARIANT=nao_estrito, com saída em out/s1-results.p3-g4.jsonl, e S1_MODE=report.
3. [QA_EVALS] + [APPSEC]: julguem pelo gate (precisão de stack ≥ 0,85, recall ≥ 0,80, JSON válido ≥ 98% no Groq, +400 tokens sobre o p1, gate de segurança do gd2, regressões do previousComparisons e contador do g4). Revisem o T4 à mão e confiram que as linhas gravadas não têm texto de vaga, canário nem saída bruta.
4. [SCRIBE]: spike-metrics §2.8, ADR-020 §8.6, STATE e SESSION-LOG. Se o gate passar, o próximo passo é ligar a cadeia no main.ts com o adapter do Groq (pronto na B2): o smoke de 1 chamada pelo adapter real, a forma da GROQ_API_KEY conferida com a chave real sem exibi-la (ADR-022 D8) e a reserva de 3.000 tokens do ADR-022 D7.2 recalibrada com o p95 medido. Se falhar, abram um HITL com as opções. Reescrevam o next-step mantendo as trilhas que faltam.
```

### Trilha D: S-2 com fixtures sintéticas
```text
Equipe, sigam em ciclo estrito. Trilha D do next-step: S-2 (BACKLOG), só a parte que não precisa de página real.
1. [ORCHESTRATOR]: leiam STATE.md, a entrada S-2 do BACKLOG, ADR-001 §5.0 e o threat-model T2 (técnicas de ocultação). Confirmem que F1-EXT-00 a 02 estão prontos.
2. [ARCHITECT] + [APPSEC]: desenhem o extrator genérico autocontido (para scripting.executeScript, sem innerHTML, sem ler atributos, ignorando display:none, visibility:hidden, font-size:0 e as demais técnicas do T2) e o formato das fixtures de DOM anonimizadas. Escrevam o runbook de coleta e anonimização das fixtures reais (o humano salva as páginas) e abram o HITL correspondente, que não bloqueia esta trilha.
3. [DEV] + [QA_EVALS]: extrator genérico e uma fixture adversarial sintética por técnica do T2, com o descarte provado, cobertura de 100% e mutação. Os extratores do LinkedIn e da Gupy esperam as fixtures reais.
4. [SCRIBE]: spike-metrics §3 (parcial), STATE e SESSION-LOG, commit local. Reescrevam o next-step mantendo as trilhas.
```

### Trilha E: DOC-01
```text
Equipe, sigam em ciclo estrito. Trilha E do next-step: DOC-01 (BACKLOG). [SCRIBE] + [ARCHITECT]: sincronizem o contratos-zod do cofre com packages/contracts. A fonte da verdade é o código: veredito de 5 faixas, ARS, pressao_excessiva, summary, reportCatalogVersion, o prefixo @cf/ do model e o teto de 12.288 bytes dos critérios. Nenhum código muda. Atualizem STATE e SESSION-LOG e reescrevam o next-step mantendo as trilhas.
```
