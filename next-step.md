# Próximo passo: F1-LLM-02, desenho do adapter da Workers AI (ADR-020)

> **Sem HITL bloqueando.** O HITL-023 (aplicar a migration no projeto real) está aberto, mas não bloqueia código. A sessão parou por escopo (AGENTS §4.1 e §4.4): o próximo item é um desenho novo com auditoria.

## O que acabou de ser entregue (2026-10-23)

### HITL-026 fechado e conferido no GitHub (só leitura, pelo `gh`)
- O run `39964371879` (`852e852`) passou nos 4 jobs. O `db` rodou o `test:db` com **47/47** contra o Supabase local do runner.
- O `master` exige `secrets`, `quality`, `test` e `db`. O PR #6 foi mergeado (`031fcf1`), e o `feat/api-borda` local foi adiantado para ele.
- No caminho:
  - o hotfix de CVE do Node (`1cc4055`): CI em `24.22.1`, e `engines` `^24.22.1 || >=26.12.1 <27`;
  - a lista de actions separada por vírgula;
  - o build das dependências da API antes do `test:db` (`852e852`). O 2º run falhou sem o `dist/` dos contratos.
- **Lição:** toda simulação do runner parte de um *checkout* limpo.

### Fechados
- **F1-OPS-01 parte 2** e **F1-DB-01** (partes 1, 2 e 3), em [[ADR-019-ci-github-actions]] §3.3 e [[ADR-018-postgres-schema-rls-and-criteria]] §3.3.

### HITL-023 aberto (runbook [[supabase-migration-real]])
Quem aplica a migration no projeto real é o humano. São quatro passos:
1. conferir o hash do arquivo;
2. conferir que as tabelas ainda não existem;
3. aplicar pelo SQL Editor com `begin;`/`commit;` em volta (ou pela CLI própria);
4. conferir RLS, privilégios, policies e o Security Advisor, só com leitura.

Até lá, toda análise com token responde 503 (falha fechado).

### F1-LLM-02: contrato `@cf/` (commit `a703ed3`, local, sem push; [[ADR-015-job-facts-cache]] §5)
- `JobFactsCacheEntrySchema.model` aceita só o prefixo exato `@cf/`, com `.max(80)`. O router valida pelo mesmo `shape.model`.
- Testes:
  - 38 no contrato, com os 6 negativos do BACKLOG e o espelho do cache;
  - router com 8 negativos e o id exato no resultado;
  - cache grava e lê com `@cf/` e recusa as formas vizinhas.
- Mutação: 17 mutantes, 16 mortos e 1 equivalente.
- Gate:
  - turbo 16/16 e 7/7 em série, 100% em todos os pacotes;
  - API com 2.176 testes e contratos com 82;
  - depcruise sem violações (369 módulos).
- `[APPSEC]` sem veto. **Restrição para o adapter:** o id vai para o caminho da URL. O contrato aceita `a/../b`, então o adapter recusa `.` e `..`.

### Pendências do humano
- **HITL-023**, quando quiser usar a API de verdade. Responda "HITL-023 concluído: migration aplicada pelo caminho <A ou B>, hash conferido, 4.1 a 4.4 conforme o runbook".
- **Push** do `feat/api-borda` (`a703ed3` e o commit deste `next-step`), quando autorizar.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-LLM-02, F1-LLM-01 e S-1) e HITL-QUEUE.md, o ADR-009 (router e porta JobFactsExtractor), o ADR-008 (guarda de saída), o ADR-015 §5 e o runbook llm.md. Confirme pnpm 11.4.0, Node conforme o engines e o branch feat/api-borda. Se o humano respondeu o HITL-023 ou autorizou o push, registre.
2. Tarefa única (AGENTS §4.1): desenho do adapter da Cloudflare Workers AI, no ADR-020, ainda sem código.
   - [ARCHITECT]: a porta JobFactsExtractor devolve a resposta bruta, e a guarda roda no router. Defina:
     - o endpoint e o modo JSON (response_format com json_schema), sem tools;
     - o teto de tokens e o timeout vindo do router;
     - o mapeamento de 429 e Retry-After, 5xx e rede para os motivos do router;
     - o teto de bytes da resposta e o parse sem __proto__;
     - a montagem da URL com o id @cf/ por segmento, recusando "." e ".." e nunca concatenando texto livre;
     - as variáveis de ambiente (só nomes; o token tem escopo só Workers AI, como no runbook llm.md).
   - O S-1 não rodou: decida o modelo primário provisório (com a justificativa e a fonte oficial consultada) ou proponha rodar o S-1 antes. Se a escolha exigir decisão do humano, abra um HITL e PARE.
   - [APPSEC]: audite o SR-01 (sem tools), o T7 e o T28, o vazamento do token em log e erro (SR-12), e a PII no payload (só o texto da vaga selecionado). Liste os critérios de aceite do adapter.
3. [SCRIBE]: registrem o ADR-020 e atualizem STATE.md, BACKLOG.md e SESSION-LOG.md. Façam só o commit local (sem push) e gerem o novo ./next-step.md.
```
