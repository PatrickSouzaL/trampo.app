# Próximo passo: F1-DOM-01, parte 2 (`RelevantSectionSelector`)

## O que acabou de ser entregue (F1-DOM-01, parte 1, 2026-10-19)
- **`JobTextNormalizer`** em `apps/api/src/domain/normalization`, decidido antes do código no **ADR-005**:
  - **D1:** `sha256` por porta `TextHasher`, com adapter `node:crypto` provado com os vetores do NIST. O sha256 artesanal foi vetado;
  - **D2:** a única exceção de valor no domínio é `@trampo/contracts/limits`, trancada pela nova regra `contracts-limits-leaf`;
  - **D3:** `truncateCodePoints` entra por injeção (a exceção para `primitives` foi vetada porque carregaria o zod). O conjunto de invisíveis é copiado, com prova exaustiva de equivalência;
  - **D4:** `toWellFormed` → [NFKC → fins de linha → invisíveis → re-truncamento → espaços → máscaras de PII e URL → delimitadores → guarda final], repetido até o ponto fixo (no máximo 4 passadas) → sha256;
  - **D5:** versão `n1`.
- **Sinais para o F1-DOM-04:**
  - invisíveis removidos;
  - expansão do NFKC acima de 1,5×;
  - `fixedPointReached`;
  - máscaras por tipo;
  - delimitadores neutralizados.
- **Testes:** API com 92 testes (85 novos). Cobrem T2, T15, F-01 (15.000 × U+FDFA dá no máximo 15.000 code points), SR-09 (12 entradas de 64 KiB, cada uma em < 200 ms), PII e controles negativos, além de 5 propriedades no fast-check.
- **Qualidade:** cobertura de 100% no domínio; 6/6 mutantes mortos; negativo de pureza (ESLint 2 erros e depcruise 3 violações).
- **Guardrails:** 15/15 tarefas do turbo, depcruise verde e e2e 10/10.
- **Achado de processo:** o Write do agente gravava `​`/` ` crus, um risco de Trojan Source. Tudo foi saneado, e a varredura do diff ficou em zero.
- Branch `feat/monorepo-workspace`, só local (sem push).

## Ação manual (HITL) antes do próximo comando
- Nenhuma.
- Em background: HITL-003 (30 vagas), com o guia na HITL-QUEUE.

## Prompt para enviar ao agente

```text
Equipe, vamos executar a F1-DOM-01, parte 2 (RelevantSectionSelector). Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos. Sigam o ciclo de 5 fases do AGENTS.md, inclusive a avaliação de continuidade da Fase 5.

[Opcional] HITL-003: [concluído: N vagas / ainda não].

1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md, BACKLOG.md (F1-DOM-01 e F1-DOM-04), o ADR-001 §5.5 (seletor e orçamento de tokens do LLM) e §5.2, item 4 (F-04: descartar blocos de contato), o ADR-005 e o threat-model (T12, T2 e SR-09). Confirme pnpm 11.4.0, Node ≥ 24 e o branch limpo.
2. [ARCHITECT] + [APPSEC]: Decidam e registrem ANTES de codar (acréscimo ao ADR-005 ou ADR novo):
   - a entrada é o texto JÁ normalizado (saída do JobTextNormalizer), e o seletor nunca reintroduz conteúdo removido;
   - como os blocos são segmentados (títulos, linhas em branco, listas) e quais seções são priorizadas (requisitos, responsabilidades, benefícios, modelo de trabalho, salário) e descartadas (contato, "fale com", "envie para", "recrutador(a)", sobre a empresa longo, EEO e boilerplate legal);
   - o orçamento de saída em code points para o LLM (hipótese do ADR-001 §8) e o que acontece quando nenhuma seção casa (fallback: prefixo do texto);
   - a versão do seletor (`sel1`, que entra no extractorVersion).
3. [DEV]: Implemente SOMENTE o RelevantSectionSelector em apps/api/src/domain/ (domínio puro, só regex linear, sem valor de contrato além de @trampo/contracts/limits).
4. [QA_EVALS]: Valide:
   - 100% de cobertura no domínio;
   - testes de F-04 (blocos de contato descartados) e de T2 (o seletor não pode ser induzido a escolher um bloco de injection só por ter um título "Requisitos");
   - SR-09 (64 KiB patológicos em < 200 ms);
   - propriedades com fast-check (determinismo, saída ⊆ entrada por blocos e teto do orçamento);
   - `pnpm install --frozen-lockfile` limpo; `pnpm turbo run build typecheck lint test` verde; `pnpm lint:deps` verde; `test:e2e` da extensão verde.
5. [SCRIBE]: Marque a F1-DOM-01 como [x] no STATE.md (checkpoint imediato), registre no SESSION-LOG (e no ADR), faça o commit local no feat/monorepo-workspace (push NÃO autorizado) e gere o novo ./next-step.md. Na Fase 5, avancem sozinhos só se não houver HITL e o contexto estiver seguro.
```
