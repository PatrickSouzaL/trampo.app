# Próximo Passo de Execução (Conclusão do Marco M1: Revisão Adversarial e Checkpoint)

## Status Atual
- Tarefas M1.1 a M1.5 concluídas e salvas no Obsidian.
- Tarefas pendentes: M1.6 (Revisão Adversarial) e M1.7 (Geração do próximo next-step).
- Restrição Ativa: O motor atual (Opus) está operando em esforço normal. A delegação paralela profunda (Fan-Out) está estritamente proibida para preservar a janela de tokens.

## Ação Manual Necessária (Human-in-the-Loop)
- [x] Motor calibrado para esforço normal. Pronto para retomar de forma sequencial.

## Prompt para Enviar ao Agente

"Equipe, vamos finalizar o Marco 1. Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos (factcheck/review).

1. `[ORCHESTRATOR]`: Acione o `[APPSEC]` e o `[ARCHITECT]`.
2. `[APPSEC]` e `[ARCHITECT]`: Leiam OBRIGATORIAMENTE os artefatos gerados: `ADR-001`, `contratos-zod.md` e `threat-model.md`. Façam a execução do item **M1.6 (Revisão adversarial)**: cruzem a matriz de ameaças com os contratos. Verifiquem rapidamente se as restrições de payload duplo e isolamento de PII (LGPD) estão bem definidas.
3. `[SCRIBE]`: Caso a revisão aponte alguma falha crítica, corrija o documento correspondente. Se estiver tudo sólido, atualize o `STATE.md` marcando M1.6 como `[x]`.
4. `[SCRIBE]`: Execute o item **M1.7**: gere o novo `./next-step.md` focando no início do Marco M2 (Inicialização do Monorepo Turborepo/Nx e configuração do ambiente TypeScript Strict). E marque M1.7 como `[x]` no `STATE.md`, alterando o status do Marco M1 para `concluido`.

Pare a execução e aguarde minha aprovação após o passo 4.