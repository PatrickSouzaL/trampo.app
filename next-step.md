# Próximo passo: F1-DOM-01, parte 1 (`JobTextNormalizer`)

> **Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.**
> (AGENTS §2, Fase 5, e §4.4. A parada é por reciclagem de sessão, não por HITL: a próxima tarefa não exige nenhuma ação sua.)

## O que acabou de ser entregue (F1-API-00, 2026-10-19)
- `apps/api` (`@trampo/api`):
  - Fastify 5.12.7 com `@fastify/type-provider-zod` 1.0.1, que valida a entrada **e a saída**;
  - camadas da §7, com o preset de pureza em `src/domain`;
  - todo erro sai como `ApiError` autovalidado, sem stack, sem detalhes do Zod e sem eco do caminho;
  - `/health`;
  - `requestId` em UUID do servidor (o header do cliente é ignorado);
  - log sem IP, query, hostname e pid;
  - `.env.example` só com nomes.
- **Cadeia de suprimentos:** a árvore do Swagger foi evitada com `packageExtensions`, porque os peers só existem nos tipos.
- **Testes:** 7 testes; negativo de pureza no pacote real (6 erros de lint e 3 violações no depcruise); o JS compilado sobe e responde. 15/15 tarefas do turbo, e2e da extensão 10/10.
- **Decisão provisória:** rota inexistente responde 404 com o código `PROIBIDO`, porque o contrato v1 não tem "não encontrado". Fica para revisar quando uma rota real precisar.
- **Governança:** a sua edição da Fase 5 do AGENTS.md foi commitada (`92032a9`).
- Branch `feat/monorepo-workspace`, só local (sem push).

## Ação manual (HITL) antes do próximo comando
- Nenhuma, além de **reciclar a sessão** (veja o aviso no topo).
- Em background: HITL-003 (30 vagas), com o guia na HITL-QUEUE.

## Prompt para enviar ao agente

```text
Equipe, vamos executar a F1-DOM-01, parte 1 (JobTextNormalizer). Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos. Sigam o ciclo de 5 fases do AGENTS.md, inclusive a avaliação de continuidade da Fase 5.

[Opcional] HITL-003: [concluído: N vagas / ainda não].

1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md, BACKLOG.md (F1-DOM-01), o ADR-001 §5.2 (E1 Normalização), o threat-model (T2, T15, SR-09) e a revisão M1.6 (F-01: re-truncar depois do NFKC). Confirme pnpm 11.4.0, Node ≥ 24 e o branch limpo.
2. [ARCHITECT] + [APPSEC]: Decidam e registrem ANTES de codar:
   - o domínio é puro e NÃO pode importar node:crypto. Para o sha256, escolham entre uma porta `TextHasher` injetada (implementada em infrastructure) e um sha256 em TypeScript puro com vetores de teste oficiais. Registrem a escolha e o porquê;
   - a ordem exata do pipeline: toWellFormed → NFKC → remoção de invisíveis até o ponto fixo → re-truncamento com truncateCodePoints(…, JOB_TEXT_MAX_CHARS) → máscara de PII (e-mail, telefone, CPF e CNPJ) e de URL → neutralização de delimitadores → hash. Justifiquem cada passo com a ameaça que ele mitiga;
   - a versão do normalizador (entra na chave de cache).
3. [DEV]: Implemente SOMENTE o `JobTextNormalizer` em `apps/api/src/domain/` (o `RelevantSectionSelector` fica para a parte 2), reutilizando `truncateCodePoints` e `JOB_TEXT_MAX_CHARS` de `@trampo/contracts` via `import type`… mas atenção: são VALORES. Se o domínio só pode importar tipos, decidam (passo 2) se essas duas peças entram por injeção ou se o preset de pureza abre uma exceção estreita para `@trampo/contracts/limits` e `@trampo/contracts/primitives`, com justificativa e teste.
4. [QA_EVALS]: Valide:
   - 100% de cobertura no normalizador;
   - testes de T2 e T15, inclusive a amplificação do NFKC (15.000 × U+FDFA precisa sair com no máximo 15.000 code points), Tag characters, zero-width, bidi, surrogates órfãos e PII mascarada;
   - testes de propriedade (fast-check): idempotência, saída sem invisíveis e tamanho máximo;
   - `pnpm install --frozen-lockfile` limpo; `pnpm turbo run build typecheck lint test` verde; `pnpm lint:deps` verde; `test:e2e` da extensão verde.
5. [SCRIBE]: Marque a parte 1 da F1-DOM-01 como [x] no STATE.md (checkpoint imediato), registre no SESSION-LOG (e em ADR, se o passo 2 decidir algo de arquitetura), faça o commit local no feat/monorepo-workspace (push NÃO autorizado) e gere o novo ./next-step.md. Na Fase 5, avancem sozinhos só se não houver HITL e o contexto estiver seguro.
```
