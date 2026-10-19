# Próximo passo: F1-EXT-01 (teste de CSP no navegador real)

## O que acabou de ser entregue (2026-10-18)
- **Decisões HITL registradas:**
  - HITL-012, opção 1: Gemini fora da cadeia nas Fases 0 e 1. A cadeia é Groq com ZDR → Cloudflare → fallback determinístico. Emenda registrada no ADR-001.
  - HITL-002 concluído.
  - HITL-008 parcial.
- **Guia do HITL-003** (como coletar as 30 vagas e em quais portais) na HITL-QUEUE.
- **Regra nova no `.gitignore`** para `evals/golden/raw/`, criada antes da coleta (commit `e57bd4f`). Sem ela, as vagas brutas, com nomes e contatos de terceiros, iriam para um commit.
- **F1-EXT-00:** `apps/extension` com WXT 0.21.4, Vite 8.3.4 e React. O manifesto gerado tem:
  - só `activeTab`, `scripting`, `sidePanel` e `storage`;
  - sem host permissions e sem popup;
  - `externally_connectable` vazio;
  - CSP de loja com `connect-src 'none'` até o S-5;
  - Chrome mínimo 116.
- **Service Worker** sem handler de `fetch`.
- **Fronteira F-02** aplicada no ESLint e no depcruise, com testes negativos.
- **10 testes do manifesto gerado**, provados por mutação. 11/11 tarefas do turbo verdes.
- Branch `feat/monorepo-workspace`, só local (sem push).

## Ação manual (HITL) antes do próximo comando
- Nenhuma ação manual obrigatória.
- Em background: **HITL-003** (30 vagas). O guia está em `../base/00-orquestracao/HITL-QUEUE.md`, seção HITL-003. Ao terminar, responda só "HITL-003 concluído: N vagas (L LinkedIn, G Gupy, O outros)", sem colar o texto das vagas.

## Prompt para enviar ao agente

```text
Equipe, vamos executar a F1-EXT-01. Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos.

[Opcional] HITL-003: [concluído: N vagas / ainda não].

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-EXT-01) e HITL-QUEUE.md. Confirme pnpm 11.4.0, Node ≥ 24 e o branch limpo.
2. [APPSEC]: Decida e registre COMO carregar a extensão num navegador de teste, verificando na documentação OFICIAL atual (Chrome e Playwright):
   - se o Chrome e o Edge instalados nesta máquina ainda aceitam `--load-extension` (versões recentes do Chrome de marca deixaram de aceitar);
   - se for preciso baixar um navegador de teste (Chromium do Playwright ou Chrome for Testing): de onde ele vem, como verificar a integridade e onde fica guardado. Esse download é um comando explícito e NUNCA um postinstall.
   Audite o `playwright-core` (ou equivalente) como as demais dependências. Se o único caminho exigir algo fora das políticas, PARE e me pergunte.
3. [DEV]: Execute somente o restante da F1-EXT-01:
   - teste de integração que carrega o build de PRODUÇÃO da extensão e prova, de dentro de uma página da extensão (o Side Panel) e do Service Worker, que um `fetch` para um host arbitrário é BLOQUEADO pela CSP (`connect-src 'none'` sem `TRAMPO_API_ORIGIN`);
   - com `TRAMPO_API_ORIGIN` apontando para um servidor local de teste em HTTPS (ou o equivalente que a CSP aceitar), prove que só essa origem passa;
   - o teste roda numa tarefa separada (ex.: `test:e2e`), fora do `test` padrão, se precisar de navegador.
4. [QA_EVALS]: Valide:
   - `pnpm install --frozen-lockfile` limpo;
   - `pnpm turbo run build typecheck lint test` verde;
   - o `test:e2e` verde;
   - mutação: com a CSP afrouxada à mão (`connect-src *`), o teste de bloqueio FALHA, e depois é restaurado.
5. [SCRIBE]: Marque a F1-EXT-01 como [x] no STATE.md (checkpoint imediato), registre no SESSION-LOG, faça o commit local no feat/monorepo-workspace (push NÃO autorizado) e gere o novo ./next-step.md.

Pare a execução e aguarde minha aprovação após o passo 5.
```
