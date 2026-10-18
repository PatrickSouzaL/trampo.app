# Próximo passo: Marco M3 (`packages/contracts`)

## O que acabou de ser entregue (M2.2, 2026-10-18; Marco M2 concluído)
- `packages/config` (`@trampo/config`, sem build):
  - `tsconfig.base.json` strict;
  - preset ESLint de segurança (SR-03);
  - preset de pureza do domínio (SR-13);
  - `dependency-cruiser` com 11 regras de fronteira (§10.3).
- O portal estende a base strict e usa o preset de segurança (passou sem nenhuma correção de código). O `next.config.ts` ganhou `agentRules: false`.
- Dependências novas auditadas antes do install, fixadas no `catalog:` e sem scripts de instalação:
  - `eslint-plugin-no-unsanitized` 4.1.5;
  - `eslint-plugin-regexp` 3.3.1;
  - `dependency-cruiser` 18.6.0;
  - `@types/node` 24.19.2.
- A exceção de `trustPolicy` do `undici-types` foi removida; ficam duas.
- Cada regra foi provada com um teste negativo:
  - lint do portal: 11 erros (`innerHTML` e afins) e 2 erros (`any`);
  - preset de domínio: 9 erros;
  - depcruise: 9 violações.
- Achado corrigido: o `exclude` do dependency-cruiser escondia as arestas para `dist/`, o que deixaria a extensão importar `user-criteria` sem ser barrada.
- HITL-010 e HITL-011 fechados. Branch `feat/monorepo-workspace`, só local (sem push).

## Ação manual (HITL) antes do próximo comando
- Nenhuma ação manual necessária.
- (Opcional) Se a variável `PNPM_HOME` ainda estiver nas variáveis de ambiente do seu usuário, ela pode ser apagada: o diretório que ela apontava não existe mais.

## Prompt para enviar ao agente

```text
Equipe, vamos executar a M3. Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos.

1. [ORCHESTRATOR]: Leia STATE.md e HITL-QUEUE.md. Confirme `pnpm -v` = 11.4.0, `node -v` ≥ 24 e o branch feat/monorepo-workspace limpo.
2. [APPSEC]: Antes do `pnpm install`, audite cada dependência nova (zod, vitest, @vitest/coverage-v8, fast-check): idade, proveniência, scripts e mantenedor. Fixe as versões no `catalog:` com versão exata (zod ≥ 4.6.6). NÃO abra exceção de minimumReleaseAge, trustPolicy ou allowBuilds sem a análise registrada.
3. [DEV]: Execute somente a M3 do BACKLOG (contratos-zod §4; ADR-001 §10.4):
   - crie `packages/contracts` (`@trampo/contracts`): ESM, compilado com `tsc` para `dist/` com `.d.ts`, estendendo `@trampo/config/tsconfig.base.json`, com o preset de segurança no eslint.config;
   - use os subpath exports `.`, `./limits`, `./primitives`, `./api`, `./analysis-report`, `./job-facts` e `./user-criteria`, com zod como dependência única;
   - copie os arquivos da §4 do contratos-zod SEM mudar a semântica;
   - porte a suíte de 21 testes para Vitest e acrescente:
     - testes de propriedade (fast-check) para `truncateCodePoints` e `safeText`;
     - o snapshot do JSON Schema de `JobFactsSchema`;
   - acrescente as tarefas `build` e `test` no pacote, para que o turbo as rode.
   O código da API, da extensão e do ui-kit fica para as próximas tarefas: NÃO execute agora.
4. [QA_EVALS]: Valide os guardrails da M3:
   - `pnpm install --frozen-lockfile` limpo;
   - `pnpm turbo run build typecheck lint test` verde;
   - `pnpm --filter @trampo/contracts test` com 100% de cobertura;
   - testes 1–19, 15b e 15c verdes;
   - `pnpm lint:deps` verde (a regra contracts-only-zod precisa passar);
   - nenhum `z.object` frouxo, nenhum `z.url()` puro e nenhum `any`.
5. [SCRIBE]: Marque a M3 como [x] no STATE.md (checkpoint imediato), atualize o contratos-zod.md se algo mudar, registre no SESSION-LOG, faça o commit local no feat/monorepo-workspace (push NÃO autorizado) e gere o novo ./next-step.md para a próxima tarefa do BACKLOG.

Pare a execução e aguarde minha aprovação após o passo 5.
```
