# Próximo passo: Marco M2.2 (`packages/config`)

## O que acabou de ser entregue (M2.1, 2026-10-18)
- O portal Next foi movido com `git mv` para `apps/web-portal/` (`@trampo/web-portal`), com o histórico preservado. O commit `35d74e5` só tem renames.
- Raiz do workspace (commit `8f4b820`):
  - `package.json` privado, com `pnpm@11.4.0+sha512` e `engines`;
  - `.nvmrc`;
  - `pnpm-workspace.yaml` com `catalog:` exato e as seis políticas de supply chain;
  - `turbo.json` sem `globalEnv`;
  - `.gitignore` ajustado;
  - `pnpm-lock.yaml` gerado por `pnpm import`, no lugar do `package-lock.json`.
- O único script de instalação (`unrs-resolver`) foi **negado** em `allowBuilds`, e nenhum script de dependência rodou.
- Guardrails verdes: install limpo, `turbo run build typecheck lint`, `dev` com HTTP 200 e `git log --follow`.
- Branch `feat/monorepo-workspace`, só local (sem push).

## Ação manual (HITL) antes do próximo comando
1. **HITL-010:** o seu PATH tem um pnpm **12.14.0** standalone, instalado em 2026-10-18 às 11:34, na frente do 11.4.0. Recomendado: apague `%LOCALAPPDATA%\pnpm`, tire `%LOCALAPPDATA%\pnpm\bin` (e `PNPM_HOME`) das variáveis de ambiente do usuário, abra um terminal novo e confirme que `pnpm -v` responde `11.4.0`. Se você **não** reconhece essa instalação, avise.
2. **HITL-011:** o `next dev` grava `apps/web-portal/AGENTS.md` com instruções para agentes. Recomendado: desligar com `agentRules: false` (a equipe aplica na M2.2).

Detalhes em `../base/00-orquestracao/HITL-QUEUE.md`.

## Prompt para enviar ao agente

```text
Equipe, vamos executar a M2.2. Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos.

Respostas HITL:
- HITL-010: [removi o pnpm standalone; `pnpm -v` agora = <cole a saída>] ou [mantenho o 12.x: abram um ADR de upgrade]
- HITL-011: [desligar com agentRules: false] ou [commitar o AGENTS.md gerado]

1. [SCRIBE]: Registre as respostas acima e feche o HITL-010 e o HITL-011 na HITL-QUEUE.
2. [ORCHESTRATOR]: Confirme que `pnpm -v` = 11.4.0 e `node -v` ≥ 24. Se o HITL-010 não estiver resolvido, use o pnpm de %APPDATA%\npm por caminho explícito.
3. [DEV]: Execute somente a M2.2 do BACKLOG (ADR-001 §10.3; threat-model SR-03 e SR-13):
   - crie `packages/config` (`@trampo/config`, sem build) com:
     - `tsconfig.base.json` strict: strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, verbatimModuleSyntax, lib ES2024;
     - preset ESLint 9 flat de segurança: no-explicit-any, react/no-danger, no-unsanitized, no-restricted-syntax para innerHTML, outerHTML, insertAdjacentHTML, srcdoc, document.write e acesso computado; no-eval, no-implied-eval, no-new-func; regexp/no-super-linear-backtracking e regexp/no-super-linear-move;
     - preset de pureza do domínio para apps/api/src/domain/**;
     - configuração do dependency-cruiser com as arestas proibidas da §10.3;
   - fixe todas as dependências novas no `catalog:` com versão exata. Respeite a quarentena e NÃO abra exceção de minimumReleaseAge, trustPolicy ou allowBuilds sem a análise do [APPSEC] registrada;
   - ligue o portal aos presets (tsconfig `extends` e eslint.config) e aplique a decisão do HITL-011 no next.config.ts;
   - não altere a semântica do código do portal. Se o strict revelar erro de tipo no portal, corrija com a menor mudança possível e registre.
   O pacote de contratos é a M3: NÃO execute agora.
4. [APPSEC]: Antes do `pnpm install`, audite cada dependência nova: idade, proveniência, scripts e mantenedor. Confirme que nenhum script não autorizado rodou (`.modules.yaml`).
5. [QA_EVALS]: Valide os guardrails da M2.2:
   - `pnpm install --frozen-lockfile` limpo;
   - `pnpm turbo run build typecheck lint` verde;
   - `depcruise` verde;
   - teste negativo: um arquivo temporário com `innerHTML` e outro com `any` FALHAM no lint e depois são removidos;
   - nenhum `any` novo.
6. [SCRIBE]: Marque a M2.2 como [x] no STATE.md (checkpoint imediato), registre no SESSION-LOG, faça o commit local no feat/monorepo-workspace (push NÃO autorizado) e gere o novo ./next-step.md para a M3 (packages/contracts).

Pare a execução e aguarde minha aprovação após o passo 6.
```
