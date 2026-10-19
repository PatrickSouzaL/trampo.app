# Próximo passo: decisão HITL-015 (redigir o ADR-002 como proposta?)

> **Parada obrigatória** (AGENTS §2, Fase 5): nenhum item restante roda sem HITL. **Reciclagem de sessão** (§4.4): ADR novo, duas rodadas de mutação e escrita extensa nesta conversa.
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (F1-DOM-05, 2026-10-19)

### Decisão aplicada
- **HITL-014: opção A.** A porta `DeterministicSignals` foi fixada pelo lado do consumidor no **ADR-011**, e o F1-DOM-04 passa a implementá-la.

### ADR-011 (cofre)
- **Porta** (`apps/api/src/domain/ports/deterministic-signals.ts`, só tipos): modelo de trabalho, contrato e senioridade com força; salário; menções de stack com a grafia do dicionário; nível de injection. É independente do usuário, e o resolver ignora sinal `fraco`.
- **Lacunas do ADR-001 §5.6 fechadas:**
  - sobreposição parcial de conjuntos vira união;
  - estouro do teto do contrato vira conflito;
  - moeda ou período diferentes no salário são conflito;
  - o modo só determinístico tem confiança 0;
  - injection `alta` descarta a saída do LLM;
  - o título é validado por predicado injetado (o domínio não roda zod).
- **Limiares** (5%, 0,4 e 0,5) ficam em `FactResolverPolicy`, como hipóteses calibráveis no golden dataset.

### `FactResolver` (`apps/api/src/domain/fusion/fact-resolver.ts`, versão `fr1`)
- Um termo marcado pelo usuário, com menção explícita no texto e omitido pelo LLM, entra em `stackRequired`. No teto de 30, os termos marcados ficam.
- Conflito vira "não informado" com o aviso `informacao_contraditoria`.
- `salario_omitido` é definido só pelo código.
- Injection média ou saída saneada multiplicam a confiança por 0,5.

### Verificação
- API com **521 testes**: 60 novos, sendo 7 propriedades com 1.000 execuções cada (evidência preservada, LGPD, conflito, pureza etc.).
- Cobertura de **100%**: 133/133 ramos no resolver e 457/457 no total.
- **Mutação 47/48.** O sobrevivente é equivalente: a ordem do `??` na moeda.
- Turbo 15/15, depcruise verde e e2e 10/10. Nenhuma dependência nova.
- Correção feita durante os testes: `location` e `salary` saíam por referência à entrada. Agora são copiados.

### Cofre e branch
- **Cofre:** STATE, BACKLOG, SESSION-LOG, HITL-QUEUE (HITL-014 fechado, HITL-015 aberto) e ADR-011.
- **Branch:** commit local no **`feat/api-borda`**, **sem push**.

## Por que parou
- **F1-DOM-02** (`ScoringEngine`) exige o **ADR-002**, a fórmula da nota. Esse ADR é marco de aprovação humana, e o F1-DOM-03 depende dele.
- **F1-DOM-04** está ⛔ pelo S-4 (HITL-003).
- **F1-LLM-01 parte 2 e F1-LLM-02** esperam o S-1.
- **F1-API-02 e F1-API-03** esperam o HITL-004 e o HITL-007.
- **F1-OPS-01** exige push e CI, que não estão autorizados.

## Ação manual (HITL) antes do próximo comando
- **HITL-015:** responda A ou B no prompt abaixo.
  - **A (recomendada):** a equipe redige o ADR-002 como **proposta**, sem implementar, e para para aprovação.
  - **B:** a esteira espera os HITL de dados ou de contas.
- Em background: HITL-003 (30 vagas).

## Prompt para enviar ao agente

```text
Equipe, HITL-015: [A / B]. HITL-003: [em andamento / concluído: N vagas]. Atuem de forma estritamente SEQUENCIAL E ATÔMICA, sem instanciar sub-agentes paralelos. Sigam o ciclo de 5 fases do AGENTS.md, inclusive a avaliação de continuidade da Fase 5.

Se A (ADR-002 como proposta):
1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md (HITL-015), BACKLOG.md (F1-DOM-02 e F1-DOM-03), ADR-001 §5.7 e §5.8, ADR-011 e os contratos user-criteria e analysis-report. Confirme pnpm 11.4.0, Node ≥ 24 e o branch feat/api-borda.
2. [ARCHITECT]: Redija o ADR-002 com status "proposto": assinatura score(ResolvedJobFacts, provenance, UserCriteria, ScoringPolicy), regra por dimensão (stack com dealBreakerScope, modelo de trabalho, senioridade, contrato, salário com moeda e período, localização, idiomas, benefícios e red flags), tratamento de "não informado" e de "conflito" (ADR-001 §5.7), pesos e faixas como hipóteses versionadas em engineVersion. Liste as decisões que o humano precisa aprovar, com a recomendação primeiro.
3. [APPSEC]: Audite. A nota não pode depender de texto livre do LLM; conflito em dimensão eliminatória não elimina sozinho nem aprova em silêncio; a explicação nunca ecoa valor do perfil (SR-11).
4. [SCRIBE]: Abra o HITL de aprovação do ADR-002, faça o checkpoint no STATE.md, registre no SESSION-LOG e gere o novo ./next-step.md. Sem código nesta sessão.

Se B: o [ORCHESTRATOR] só registra a decisão no HITL-QUEUE e no STATE.md e para até um HITL de dados ou de contas ser concluído.
```
