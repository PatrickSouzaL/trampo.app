# Próximo passo: P0-EVL-01 (spec do golden dataset e anotação das 30 vagas)

> **Reciclagem de sessão** (AGENTS §4.4): ADR extenso e quatro arquivos do cofre reescritos nesta conversa. A P0-EVL-01 não exige HITL, mas precisa ler 30 vagas e anotar 30 gabaritos, o que pede uma janela nova.
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-19)

### Decisões aplicadas
- **HITL-015: opção A.** O ADR-002 foi redigido como **proposta**, sem código.
- **HITL-003: fechado.** São 30 vagas (15 LinkedIn, 15 Gupy), conferidas **só pelo cabeçalho**. A pasta `evals/golden/raw/` está ignorada pelo git.

### ADR-002 (`base/02-arquitetura/ADRs/ADR-002-scoring-engine.md`, `status: proposto`)
- **Fórmula:**
  - média ponderada das dimensões;
  - obrigatório e eliminatório entram com peso 5;
  - "não informado" e conflito valem 0,5, para que uma vaga vaga não pareça boa;
  - penalidades de −30 (violado), −5 (não informado) e proporcional no parcial;
  - deal-breaker leva a "foge" com teto 20; faixas de 75 e 45.
- **Regras por dimensão:**
  - stack, com deal-breaker por `dealBreakerScope`;
  - modelo de trabalho, senioridade e contrato, por regra de conjunto;
  - salário sem câmbio, com hora × 220 e ano ÷ 12;
  - localização só para híbrido ou presencial;
  - idiomas pelo nível;
  - benefícios;
  - red flags pela tolerância.
- **Saída do motor:** o motor só emite `reason` de um enum fechado. O texto fica com o ReportComposer.
- **Desvio proposto (D-S6):** a assinatura ganha `llmExtracted`. Hoje o resolver não distingue "o LLM disse vazio" de "não houve LLM".
- **Auditoria `[APPSEC]` (sem veto):** strings do LLM só entram por igualdade contra a lista do usuário, e o F1-DOM-02 terá regra de lint para isso. Conflito eliminatório nunca elimina nem recomenda. Os templates não podem ecoar critérios.
- **Invariantes:** 10, que viram testes de propriedade no F1-DOM-02.

### Cofre
- HITL-QUEUE: HITL-003 e HITL-015 fechados; **HITL-016** (aprovar o ADR-002) e **HITL-017** (complemento opcional de vagas) abertos.
- BACKLOG: P0-EVL-01 🔜 e F1-DOM-02 ⛔ HITL-016.
- STATE e SESSION-LOG atualizados.

### Código
Nenhum. O repositório só mudou neste arquivo.

## Lacunas das 30 vagas (pelos cabeçalhos)
- **Com salário:** 2 de 10.
- **Contrato:** só PJ 1 de 3; "CLT ou PJ" 0 de 3; estágio 0 de 1.
- **Dupla senioridade:** 0 de 3.
- **Modelo:** remoto 4 de 5; "remoto ou híbrido" nenhuma.
- **Tamanho:** nenhuma muito longa (a maior tem 5,5 KB).
- **Bônus:** a `linkedin-13` traz um conflito real de modelo de trabalho, ótimo caso para o `FactResolver`.

## Ações manuais (HITL), nenhuma bloqueia a P0-EVL-01
- **HITL-016:** aprovar o ADR-002 e decidir D-S1 a D-S9 (§6 do ADR). Pode responder no mesmo prompt abaixo.
- **HITL-017 (opcional):** cerca de 10 vagas a mais, com salário, contratos variados e dupla senioridade, no mesmo formato.
- Em aberto, para depois: HITL-004 (Supabase), HITL-007 (Upstash) e HITL-006.

## Prompt para enviar ao agente

```text
Equipe, HITL-016: [aprovado conforme recomendação / aprovado com variações: D-S? ... / ainda não]. HITL-017: [vou coletar / dispensado]. Atuem de forma estritamente SEQUENCIAL E ATÔMICA, sem instanciar sub-agentes paralelos. Sigam o ciclo de 5 fases do AGENTS.md, inclusive a avaliação de continuidade da Fase 5.

0. [SCRIBE]: Se o HITL-016 foi respondido, registre a decisão no HITL-QUEUE, mude o status do ADR-002 (aceito, ou aceito com as variações aplicadas no texto) e faça o checkpoint no STATE.md. Não implemente o ScoringEngine nesta sessão.
1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md, BACKLOG.md (P0-EVL-01, S-1, S-4), threat-model (T1, T2, T4, T12, SR-04) e os contratos job-facts e enums. Confirme pnpm 11.4.0, Node ≥ 24 e o branch feat/api-borda.
2. [QA_EVALS]: Escreva ../base/04-qualidade-evals/golden-dataset-spec.md:
   - formato do caso;
   - categorias: normal, ambígua, injection visível, injection oculta, controle negativo e armadilha de negação;
   - método de anonimização: nomes de pessoas, e-mail, telefone e empresa quando identificar a pessoa;
   - métricas por campo e tolerâncias do gate de CI;
   - marcação de casos sintéticos.
   Depois, anote os JobFacts esperados à mão para as 30 vagas de evals/golden/raw/. Os casos anonimizados versionáveis vão para evals/golden/cases/; o raw continua fora do git.
3. [APPSEC]: Audite. Nenhum dado pessoal nos casos versionados (varredura de e-mail, telefone, CPF/CNPJ e nomes); nenhum texto de vaga colado no chat; injection sintética separada do real.
4. [QA_EVALS] + [SCRIBE]: Se o volume pedir, divida em P0-EVL-01 parte 1 (spec e anonimização) e parte 2 (anotação). Atualize STATE, BACKLOG e SESSION-LOG, faça commit local sem push e gere o novo ./next-step.md.
```
