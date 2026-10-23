# Próximo passo: F1-LLM-02, commit 2 (adapter da Workers AI e `rpd` do ledger)

> **Sem HITL bloqueando.** A sessão parou por escopo (AGENTS §4.1): a entrega única foi o prompt `p1`.

## O que acabou de ser entregue (2026-10-23)

### F1-LLM-02 commit 1: prompt `p1` compartilhado (ADR-020 D1)
- **Arquivo:** `apps/api/src/application/llm/extraction-prompt.ts`, que importa só `zod` e `@trampo/contracts` (depcruise sem violações).
- **O que exporta:**
  - `EXTRACTION_PROMPT_VERSION = "p1"`;
  - o molde do sistema, em que o `{NONCE}` vira o nonce da chamada;
  - `EXTRACTION_RESPONSE_SCHEMA`, relaxado, sem `pattern` e congelado;
  - `buildExtractionMessages(payload, nonce)`, que nunca lança.
- **Recusas (`{ ok: false }`):**
  - nonce fora de 32 hex minúsculos;
  - payload fora da forma ou `text` que não é string primitiva, inclusive o TOCTOU;
  - texto vazio;
  - marcador `vaga id=` em qualquer caixa e espaçamento;
  - o próprio nonce no texto.
- **Testes:** 42, com 100% no arquivo novo. A API tem 2.218 testes e 100% de cobertura. Turbo verde em série.
- **Mutação:** 28 mutantes, 25 mortos e 3 equivalentes provados. Dois sobreviventes da 1ª rodada viraram testes.
- **`[APPSEC]` sem veto:** T1, T2, LGPD e T29.
- **Commit `0cc7d4e`**, local, sem push.

### Pendências do humano
- **Push** do `feat/api-borda` (`a703ed3`, `2b441d3`, `bb0c7ab`, `0cc7d4e` e o commit deste arquivo), quando autorizar.
- O `git stash` no `master` pode ser descartado (`git stash drop`) se a edição não for mais útil.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-LLM-02) e HITL-QUEUE.md, o ADR-020 (§2 D2 a D10, §3 e §4), o ADR-009 (D1, D4, D5 e a porta JobFactsExtractor) e o ADR-014 (D6, o ledger). Confirme pnpm 11.4.0, Node conforme o engines e o branch feat/api-borda. Se o humano autorizou o push, registre.
2. Tarefa única (AGENTS §4.1): commit 2 do ADR-020 §4, o adapter em apps/api/src/infrastructure/llm/cloudflare-workers-ai-extractor.ts e o rpd 46 da Workers AI no ledger, SEM ligação no main.ts.
   - Use buildExtractionMessages e EXTRACTION_RESPONSE_SCHEMA do p1 (commit 0cc7d4e). O nonce vem de crypto.randomBytes(16), um por chamada. { ok: false } do construtor dá erro_permanente sem chamada HTTP.
   - URL por segmento validado e conferida byte a byte no boot (D3), redirect "error", corpo de lista fechada (D4), tetos de 48 KiB e 32 KiB, UTF-8 estrito e reviver (D6), Retry-After (D7) e o token só no closure (D8).
   - Testes contra um servidor simulado em socket real (o padrão do PostgREST simulado), sem chamada externa: a tabela do D6 inteira, os 9 critérios do §3 (SR-01 por propriedade, negativos de path traversal, SR-12 com canários do token, do texto e do corpo de erro) e o rpd contra a fórmula.
   - O teste de composição continua sem adapters (T28).
3. [DEV] + [QA_EVALS]: exijam 100% de cobertura nos arquivos novos e mutação (um mutante por vez, script em arquivo fora do repositório, original conferido depois de cada mutante; patch com acento só pela ferramenta de edição).
4. [APPSEC]: auditem contra os 9 critérios do ADR-020 §3 antes de dar a tarefa como concluída.
5. [SCRIBE]: atualizem STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md.
```
