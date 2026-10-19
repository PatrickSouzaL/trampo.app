# Próximo passo: F1-EXT-02 (mensageria do Service Worker)

## O que acabou de ser entregue (F1-EXT-01, 2026-10-19)
- **A CSP de loja foi provada num navegador real** com `pnpm --filter @trampo/extension test:e2e`: 5 testes no Edge 155 instalado, cobrindo o Service Worker e o Side Panel, com e sem `TRAMPO_API_ORIGIN`.
  - Sem origem, **nada** sai, nem para a "API".
  - Com origem, só a origem exata da API passa: outra porta do mesmo host e HTTP são bloqueados.
  - O bloqueio é provado por **contagem zero** de requisições no servidor de destino e pelo evento `securitypolicyviolation` em `connect-src`.
- **Mutação:** com `connect-src *`, os 3 testes de bloqueio falham.
- **Sem download de navegador:** o Chrome e o Edge de marca não aceitam mais `--load-extension`, então a extensão é carregada via CDP `Extensions.loadUnpacked` com `playwright-core`, que tem zero dependências e nenhum script.
- O `test` padrão continua sem navegador (11/11 tarefas verdes).
- **Achado novo (HITL-013):** o Google Chrome desta máquina está na versão 138, e o Chromium atual está na 155.
- Branch `feat/monorepo-workspace`, só local (sem push).

## Ação manual (HITL) antes do próximo comando
- Nenhuma ação obrigatória para a F1-EXT-02.
- **Recomendado logo:** HITL-013. Atualize o Chrome em `chrome://settings/help` (detalhes na HITL-QUEUE).
- Em background: HITL-003 (30 vagas), com o guia na HITL-QUEUE.

## Prompt para enviar ao agente

```text
Equipe, vamos executar a F1-EXT-02. Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos.

[Opcional] HITL-013: [concluído: Chrome <versão>]. HITL-003: [concluído: N vagas / ainda não].

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-EXT-02), HITL-QUEUE.md, o ADR-001 §5.0 (itens 5 e 6) e §5.0.1 (Mensagens internas e Armazenamento) e o threat-model (T22, SR-10). Confirme pnpm 11.4.0, Node ≥ 24 e o branch limpo.
2. [ARCHITECT] + [APPSEC]: Antes de codar, definam e registrem no SESSION-LOG:
   - o contrato das mensagens Side Panel ↔ Service Worker. Ele é interno da extensão (não vai para @trampo/contracts), é Zod estrito e reutiliza `AnalysisStreamEventSchema` de `@trampo/contracts/api` para o que o painel renderiza;
   - as regras: porta via `runtime.connect` com nome fixo; `sender.id === chrome.runtime.id`; mensagem com `sender.tab` é dado e nunca comando; nada de `onMessageExternal`; `storage.session` como único armazenamento, sem `setAccessLevel` e nunca `storage.local`.
3. [DEV]: Execute somente a F1-EXT-02:
   - no Service Worker: o handler da porta, com validação de origem e de forma (mensagem inválida é descartada e registrada sem conteúdo), e um adaptador de armazenamento que só usa `storage.session`;
   - no Side Panel: a conexão com a porta e a revalidação com Zod de tudo o que chega, antes de qualquer render (sem renderizar ainda o relatório: isso é a F1-EXT-04);
   - NADA de chamada à API, extração de página ou autenticação (S-3, F1-EXT-03 e Fase 1 API).
4. [QA_EVALS]: Valide:
   - testes unitários (Vitest com o fake-browser do WXT): mensagem de outra extensão, mensagem com `sender.tab`, forma inválida, chave extra e porta com nome errado são REJEITADAS; mensagem válida passa;
   - teste negativo de lint ou de tipo: o uso de `storage.local` no código da extensão FALHA (regra nova em `no-restricted-properties` ou equivalente) e depois é removido;
   - `pnpm install --frozen-lockfile` limpo; `pnpm turbo run build typecheck lint test` verde; `pnpm lint:deps` verde; `test:e2e` verde (os 5 testes de CSP continuam passando).
5. [SCRIBE]: Marque a F1-EXT-02 como [x] no STATE.md (checkpoint imediato), registre no SESSION-LOG, faça o commit local no feat/monorepo-workspace (push NÃO autorizado) e gere o novo ./next-step.md.

Pare a execução e aguarde minha aprovação após o passo 5.
```
