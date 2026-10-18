# Próximo passo: P0-RUN-01 (runbook das contas de LLM)

## O que acabou de ser entregue (M3, 2026-10-18)
- `packages/contracts` (`@trampo/contracts`):
  - fonte **idêntica, byte a byte**, ao código verificado em 2026-10-17, extraída por script da §4 do contratos-zod (inclusive os 22 caracteres invisíveis das regexes);
  - ESM compilado com `tsc` para `dist/`, com 7 subpath exports e zod 4.6.7 como dependência única.
- 38 testes no Vitest, com **cobertura de 100%** (statements, branches, funções e linhas):
  - os 21 originais, portados com diff de uma linha;
  - 13 propriedades com fast-check, provadas por mutação;
  - snapshot do JSON Schema;
  - uma invariante que estava sem teste, achada pela cobertura de branches.
- Guardrails verdes: install `--frozen-lockfile`, `turbo run build typecheck lint test` (7/7), `lint:deps` e varredura de `z.object` frouxo, `z.url()` puro e `any`.
- Dependências novas auditadas (zod, vitest, @vitest/coverage-v8, vite, fast-check), todas com proveniência contínua e sem scripts de instalação.
- **Incidente resolvido:** o `contratos-zod.md` foi zerado por um script da equipe e reconstruído com validação independente (detalhes no SESSION-LOG, sessão 5).
- Branch `feat/monorepo-workspace`, só local (sem push).

## Ação manual (HITL) antes do próximo comando
- Nenhuma ação manual obrigatória.
- (Recomendado) Abra `02-arquitetura/contratos-zod.md` no Obsidian e confira em **File recovery** (ou no histórico do Sync) que a versão atual bate com a anterior ao incidente. A diferença esperada é só o que a M3 acrescentou.

## Prompt para enviar ao agente

```text
Equipe, vamos executar a P0-RUN-01. Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (P0-RUN-01) e HITL-QUEUE.md (HITL-002 e HITL-008). Confirme que nenhum HITL bloqueia a tarefa.
2. [APPSEC]: Antes de escrever, confira na documentação OFICIAL e ATUAL de cada provedor (Groq, Cloudflare Workers AI e Google AI Studio):
   - onde se liga o Zero Data Retention no Groq;
   - como criar um token da Cloudflare com escopo só para Workers AI;
   - onde ficam os limites do free tier no AI Studio;
   - os termos de uso de dados de cada provedor.
   Registre as fontes com data. Nada de memória de treino como fonte.
3. [SCRIBE]: Escreva `../base/03-infra-runbook/llm.md` (o arquivo existe e está vazio) com:
   - checklist verificável por provedor: criar a conta com 2FA (HITL-008), ligar o ZDR no Groq, criar o token da Cloudflare com escopo mínimo, criar a chave do AI Studio e consultar os limites;
   - onde guardar as chaves: SÓ no `.env` local da API, fora do git e do cofre. Criar o `apps/api/.env.example` fica para a tarefa da API;
   - revogação e rotação de cada chave;
   - como verificar, sem expor a chave, que ela funciona (comando que não imprime o segredo).
   Guardrail: nenhum valor de segredo no documento.
4. [SCRIBE]: Atualize o HITL-002 na HITL-QUEUE apontando para o runbook, marque a P0-RUN-01 como [x] no STATE.md (checkpoint imediato), registre no SESSION-LOG, faça o commit local se algo mudar no repositório (push NÃO autorizado) e gere o novo ./next-step.md.

Pare a execução e aguarde minha aprovação após o passo 4.
```
