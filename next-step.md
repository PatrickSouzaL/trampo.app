# Próximo passo: S-4 (protótipo da Camada 1 medido no golden dataset)

> **Reciclagem de sessão** (AGENTS §4.4): nesta conversa, o ADR-002 foi reescrito, a spec do golden dataset foi criada, um pacote novo foi criado e 83 casos foram anotados e auditados por 9 agentes. O S-4 começa numa janela nova.
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-20)

### HITL-016: ADR-002 aceito com variações
- **D-S1, D-S2, D-S4 e D-S6:** conforme a recomendação.
- **D-S3, câmbio por tabela fixa:** USD 5,5, EUR 6,0 e ARS 0,0034, com conversão para BRL/mês antes do `r`. Moeda nula em vaga estrangeira **não** vira BRL.
- **D-S5, adjacência ascendente validada:** um nível acima vale parcial com r = 0,5, e a stack > 80% dispensa a penalidade. Rebaixamento leva −30.
- **D-S7:** inglês avaliado com rigor em vaga internacional.
- **D-S8:** atenuação de 50% nos sinais de cultura quando os benefícios têm r > 0,8.
- **D-S9:** 5 faixas: 90, 75, 50, 21 e 0–20.
- **14 invariantes** e **3 mudanças de contrato** (ADR-002 §8.1): `ARS`, `pressao_excessiva` e `verdict` de 5 valores. Entram no 1º commit do F1-DOM-02.
- **Achado `[APPSEC]`:** `AR$` contém `R$`. A regra antiga leria salário argentino como real, ~294 vezes maior.

### HITL-017: Dataset de Estresse Consolidado
- **33 vagas novas** (total de 63), de LinkedIn, Gupy, GeekHunter, 99jobs e Sólides.
- **Conferido no corpo:** só 7 vagas têm salário no texto (1 em ARS). **Nenhuma** é em USD, EUR, por hora ou anual. Em 13 vagas, o dado está só no cabeçalho que você preencheu.

### P0-EVL-01: golden dataset (`gd1`)
- **Spec:** `../base/04-qualidade-evals/golden-dataset-spec.md`.
- **83 casos** em `evals/golden/cases/`:
  - **63 reais anonimizados**, fiéis ao raw (provado por script);
  - **20 sintéticos:** injection visível e oculta com canário, controles negativos, negação, USD/hora, EUR/ano, dupla senioridade, adjacência, rebaixamento, cultura tóxica e vaga em inglês.
- **Pacote `@trampo/evals`:** valida todo caso no `pnpm test` (schema, PII, invisíveis, tags derivadas, cobertura). Tem 28 testes e 100% de cobertura, sem dependência nova.
- **Revisão cruzada:** 97,2% de concordância. Os padrões de erro foram varridos em todos os casos.
- **`[APPSEC]`:** nenhuma PII nos casos versionados; injection só sintética e separada do real; `raw/` fora do git.
- **Commit local** no `feat/api-borda`, sem push.

## Ações manuais (HITL)
- **HITL-018 (bloqueia só o F1-DOM-02):** confirme as 4 interpretações do `[ARCHITECT]` (tabela no HITL-QUEUE e marcas ⚖️ no ADR-002):
  1. stack > 80% dispensa a penalidade, em vez de elevar o r;
  2. rebaixamento = a vaga inteira abaixo do que você aceita;
  3. inglês com nível nulo em vaga internacional = avançado;
  4. taxa do ARS 0,0034 e a lista de sinais de cultura.

  Pode responder no prompt abaixo.
- **HITL-019 (opcional):** recoletar 13 vagas incluindo os "chips" do topo da página (salário, nível, modelo). A lista está no HITL-QUEUE.
- Em aberto, para depois: HITL-004 (Supabase), HITL-007 (Upstash) e HITL-006.

## Prompt para enviar ao agente

```text
Equipe,
HITL-018: conforme interpretação.   <- ou ajuste (ex.: "HITL-018: 1 alternativa; 3 intermediario")
HITL-019: dispensado.               <- ou "HITL-019 concluído"

0. [SCRIBE]: Registre as respostas do HITL-018 e do HITL-019 no HITL-QUEUE. Se o HITL-018 mudar alguma interpretação, aplique-a no ADR-002 (marcas ⚖️). Se o HITL-019 foi concluído, revise os casos afetados em evals/golden/cases/real/ (o validador tem de continuar verde). Faça o checkpoint no STATE.md.
1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md, BACKLOG.md (S-4, F1-DOM-04), ADR-001 §5.3, ADR-005 D4, ADR-011 D1 (porta DeterministicSignals), threat-model (T3, T4, T15, SR-09) e golden-dataset-spec §4 e §8. Confirme pnpm 11.4.0, Node ≥ 24 e o branch feat/api-borda.
2. [ARCHITECT]: Desenhe o protótipo descartável do DeterministicPreFilter em evals/spikes/s4-layer1/:
   - dicionário de tecnologias com aliases;
   - janela de negação e contexto de diferencial;
   - termos ambíguos (Go, R, "Senior" como ERP, "PJ" como produto);
   - detector de salário com fronteira à esquerda (AR$ ≠ R$);
   - heurística de injection.
   Ele consome os 83 casos via @trampo/evals e produz a forma da porta DeterministicSignals (ADR-011 D1).
3. [APPSEC]: Audite o design: regex lineares (SR-09), nenhum texto de vaga em log, canários dos sintéticos nunca impressos.
4. [DEV] + [QA_EVALS]: Implemente e meça no golden dataset:
   - % resolvida sem LLM;
   - falso positivo de deal-breaker (armadilhas de negação = 0);
   - falso positivo de injection nos controles negativos (gupy-19, geekhunter-07, syn-08 e syn-09 = 0 em alta);
   - detecção dos 7 casos de injection;
   - precisão que um curto-circuito de aceite teria.
   Preencha a seção S-4 de spike-metrics e recomende a revisão da D-H3.
5. [SCRIBE]: Atualize STATE, BACKLOG e SESSION-LOG, faça commit local sem push e gere o novo ./next-step.md.
```
