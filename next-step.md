# Próximo passo: decisão HITL-014 (adiantar a F1-DOM-05 antes do S-4?)

> **Parada por marco de decisão humana** (AGENTS §1.1 e §2, Fase 5), não por contexto. A próxima tarefa sem conta nem chave exige escolher uma interface de arquitetura antes dos dados do S-4.

## O que acabou de ser entregue (F1-SEC-00, 2026-10-19)

### Fontes oficiais conferidas (acesso em 2026-10-19)
- **OWASP GenAI LLM Top 10 2026:**
  - PDF baixado de `genai.owasp.org`, pelo botão *Download* da página do recurso: `OWASP-GenAI-LLM-Top-10-2026-v1.0.pdf`, com o sha256 registrado no threat model.
  - **Os 10 IDs e títulos `LLMxx:2026` conferem** com o threat model.
  - O "v1.0" só aparece no nome do arquivo. Dentro do PDF, o rótulo é "Version 2026".
  - A página `genai.owasp.org/llm-top-10/` ainda mostra a 2025.
- **OWASP Top 10:2025** (`top10.owasp.org/2025`) e **API Security Top 10:2023**, conferidos com as CWEs mapeadas de cada categoria usada.

### Divergências corrigidas (4, só no cofre)
1. **T27 (vazamento de segredos):** `A04:2025` virou `A02:2025; A07:2025`. A A04 (Cryptographic Failures) só cobre chave criptográfica embutida. Segredo em configuração ou variável de ambiente é A02, e credencial embutida é A07.
2. **SESSION-LOG, "OWASP A03" para XSS:** usava a numeração 2021. Agora é `A05:2025`.
3. **SESSION-LOG, "LLM05" para saída imprópria:** usava a numeração 2025. Agora é `LLM10:2026`.
4. **IDs sem edição** (`LLM01`, `API4`, `API8`): receberam a edição.

### Registro e varredura
- A tabela completa (referência → título oficial → confere/diverge) está em `threat-model` §0.1.
- **Varredura:** nenhuma referência antiga ou sem edição restou no cofre. **Nenhum ID OWASP aparece no código**, então nenhum comentário mudou e o build não precisou rodar de novo.
- ADR-001, `contratos-zod` e ADR-005 a ADR-010 conferem ou não citam IDs.

### Branch
- Commit local no **`feat/api-borda`** (só este `next-step.md`), **sem push**.

## Por que parou
- O **F1-DOM-05 (`FactResolver`, E6)** é o único item sem conta e sem chave. Ele funde a saída do LLM com os **sinais da Camada 1**, e quem produz esses sinais é o F1-DOM-04, ⛔ pelo S-4 (HITL-003).
- Adiantá-lo exige fixar agora a interface desses sinais. Detalhes e opções estão no **HITL-014**:
  - **A (recomendada):** ADR curto com a porta `DeterministicSignals` como contrato do consumidor, depois o `FactResolver`.
  - **B:** esperar o HITL-003 e o S-4.
- O restante da fila continua com HITL:
  - F1-OBS-02, F1-API-02 e F1-API-03: HITL-004 e HITL-007;
  - S-5: contas de hospedagem;
  - F1-LLM-01 parte 2 e F1-LLM-02: S-1;
  - F1-DOM-02: ADR-002;
  - F1-OPS-01: exige push e CI, não autorizados.

## Ação manual (HITL) antes do próximo comando
- **HITL-014:** responda A ou B no prompt abaixo.
- Em background: HITL-003 (30 vagas).

## Prompt para enviar ao agente

```text
Equipe, HITL-014: [A / B]. HITL-003: [em andamento / concluído: N vagas]. Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos. Sigam o ciclo de 5 fases do AGENTS.md, inclusive a avaliação de continuidade da Fase 5.

Se A (F1-DOM-05, FactResolver):
1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md (HITL-014), BACKLOG.md (F1-DOM-04 e F1-DOM-05), ADR-001 §5.5 a §5.7 e os contratos de JobFacts. Confirme pnpm 11.4.0, Node ≥ 24 e o branch feat/api-borda limpo.
2. [ARCHITECT]: Escreva o ADR-011 com a porta DeterministicSignals (contrato do consumidor, domínio puro, sem zod no domínio), que o F1-DOM-04 vai implementar. Registre os limiares (5%, 0,4, 0,5) como hipóteses calibráveis.
3. [APPSEC]: Audite. Omissão suspeita do LLM não apaga evidência; conflito leva a "não informado" mais aviso; injection reduz a confiança; nada de perfil além dos termos marcados.
4. [DEV] + [QA_EVALS]: Implementem o FactResolver em apps/api/src/domain com 100% de linhas e ramos, propriedades no fast-check e mutação. `pnpm turbo run build typecheck lint test`, depcruise e e2e verdes.
5. [SCRIBE]: Faça o checkpoint no STATE.md, registre no SESSION-LOG, faça o commit local (push NÃO autorizado) e gere o novo ./next-step.md.

Se B: o [ORCHESTRATOR] só registra a decisão no HITL-QUEUE e no STATE.md e para até o HITL-003 ser concluído.
```
