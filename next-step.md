# Próximo passo: F1-EXT-00 (esqueleto WXT da extensão)

## O que acabou de ser entregue (P0-RUN-01, 2026-10-18)
- Runbook `../base/03-infra-runbook/llm.md`, verificado em 13 fontes oficiais de hoje. Cobre:
  - 2FA antes de tudo;
  - Groq com **ZDR global antes da primeira chamada**;
  - Cloudflare com token personalizado, só Workers AI e com TTL;
  - Google com projeto dedicado sem faturamento e chave restrita à Gemini API;
  - revogação e rotação de cada chave;
  - um teste em PowerShell que só imprime o código HTTP.
- Guardrail confirmado: nenhum valor de segredo no documento. O teste foi checado pelo parser e executado só com um `.env` falso.
- **Novo HITL-012:** os termos do Gemini gratuito proíbem enviar "personal information", e isso entra em conflito com o D-H4 (nomes "minimizados, não garantidamente removidos"). Recomendação: Gemini **fora da cadeia** nas Fases 0 e 1.
- Branch `feat/monorepo-workspace`, só local (sem push).

## Ação manual (HITL) antes do próximo comando
- **Nenhuma ação obrigatória para a F1-EXT-00.**
- Quando puder (é pré-requisito do Spike S-1):
  1. **HITL-002:** siga `../base/03-infra-runbook/llm.md` e responda só "HITL-002 concluído", **sem nenhum valor de chave**.
  2. **HITL-012:** escolha uma opção: (1) Gemini fora da cadeia nas Fases 0 e 1, que é a recomendada; (2) Gemini só se o S-1 medir zero PII residual; (3) manter o D-H4.
  3. **HITL-003:** colete as 30 vagas reais. Isso destrava a P0-EVL-01 e os Spikes S-1, S-2 e S-4.

## Prompt para enviar ao agente

```text
Equipe, vamos executar a F1-EXT-00. Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos.

[Opcional] Respostas HITL: HITL-012: [opção 1, 2 ou 3]. HITL-002: [concluído / ainda não].

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-EXT-00 e F1-EXT-01), HITL-QUEUE.md e o ADR-001 §5.0 e §5.0.1. Registre as respostas HITL, se vieram. Confirme pnpm 11.4.0, Node ≥ 24 e o branch limpo.
2. [APPSEC]: Antes do `pnpm install`, audite as dependências novas (wxt na versão EXATA da linha 0.21.x, react, react-dom e o que mais o esqueleto exigir): idade, proveniência, scripts e mantenedor. Fixe no `catalog:` com versão exata e reutilize o vite 8.3.4 já fixado, se o WXT aceitar (se não aceitar, PARE e registre). NÃO abra exceção de minimumReleaseAge, trustPolicy ou allowBuilds sem a análise registrada.
3. [DEV]: Execute somente a F1-EXT-00 do BACKLOG:
   - crie `apps/extension` (`@trampo/extension`): WXT, MV3, React, entrypoints `background` e `sidepanel`, estendendo o `@trampo/config` (tsconfig strict e preset de segurança);
   - endureça o manifesto conforme o ADR-001 §5.0.1:
     - permissões mínimas: `activeTab`, `scripting`, `sidePanel` e `storage`;
     - sem `host_permissions` e sem `<all_urls>`;
     - CSP explícita no build de loja;
     - `externally_connectable` declarado de forma explícita (D-H7);
     - sem `default_popup`;
     - `minimum_chrome_version`;
   - Service Worker sem handler de `fetch`, com `openPanelOnActionClick: false` no `onInstalled`;
   - `no-restricted-imports` no eslint.config da extensão proibindo `@trampo/contracts` (raiz) e `@trampo/contracts/user-criteria` (F-02);
   - sem lógica de negócio, extratores ou UI de relatório: isso fica para a F1-EXT-02 em diante.
4. [QA_EVALS]: Valide:
   - `pnpm install --frozen-lockfile` limpo, sem scripts não autorizados (`.modules.yaml`);
   - `pnpm turbo run build typecheck lint test` verde;
   - `pnpm lint:deps` verde;
   - **inspeção do manifest.json GERADO** no build de produção: permissões exatas, ausência de `host_permissions`, `<all_urls>`, `default_popup` e CSP de dev;
   - testes negativos: um import de `@trampo/contracts/user-criteria` e um de `@trampo/contracts` na extensão FALHAM no lint e no depcruise, e depois são removidos.
5. [SCRIBE]: Marque a F1-EXT-00 como [x] no STATE.md (checkpoint imediato), registre no SESSION-LOG, faça o commit local no feat/monorepo-workspace (push NÃO autorizado) e gere o novo ./next-step.md.

Pare a execução e aguarde minha aprovação após o passo 5.
```
