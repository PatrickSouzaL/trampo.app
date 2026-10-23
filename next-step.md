# Próximo passo: F1-LLM-02, commit 1 (prompt `p1` compartilhado)

> **Sem HITL bloqueando.** A sessão parou por escopo (AGENTS §4.1): a entrega única foi o desenho do ADR-020.

## O que acabou de ser entregue (2026-10-23)

### HITL-023 fechado (declarado pelo humano)
- A migration foi aplicada no projeto real pelo caminho A (SQL Editor), com o hash conferido e as consultas §4.1 a §4.4 conforme.
- A equipe não conferiu o projeto real ([[supabase-migration-real]] §6).
- A API deixa de dar 503 por falta das tabelas, e o F1-API-05 de ponta a ponta fica destravado.

### Arrumação do git
- A cópia de trabalho estava no `master`, com o `next-step.md` editado. A edição foi para o `git stash` ("master: next-step.md sem o bloco do prompt"), sem descarte.
- A equipe está no `feat/api-borda`.

### ADR-020: desenho do adapter da Workers AI (sem código; `[APPSEC]` sem veto)
- **Prompt `p1` compartilhado** em `apps/api/src/application/llm/extraction-prompt.ts`:
  - sistema fixo;
  - envelope `<vaga id=NONCE>` com 128 bits;
  - recusa de texto com `vaga id=`;
  - schema relaxado sem `pattern`, em *snapshot*;
  - o Groq usa o mesmo prompt.
- **URL** `/client/v4/accounts/{conta}/ai/run/{model}`, montada por segmento validado e conferida byte a byte no boot. `redirect: "error"`.
- **Corpo de lista fechada:** `messages`, `response_format` `json_schema`, `max_tokens` 600 e `temperature` 0. O SR-01 é um teste do corpo exato.
- **Tetos e parse:** 48 KiB enviados, 32 KiB lidos, UTF-8 estrito e *reviver*.
- **Mapeamento de status:**
  - 429 dá `limite_de_taxa`, com `Retry-After`;
  - 5xx, 408 e rede dão `erro_transitorio`;
  - os outros 4xx e o envelope fora da forma dão `erro_permanente`;
  - o corpo de erro nunca é lido.
- **Modelo provisório:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, o único modelo de chat ativo na lista oficial do modo JSON. Ele fica **fora da cadeia de produção até o gate do S-1** (T28). O `rpd` do ledger vai a 46 (~182 neurons por chamada).

### Pendências do humano
- **Push** do `feat/api-borda` (`a703ed3`, `2b441d3` e este commit), quando autorizar.
- O `git stash` no `master` pode ser descartado (`git stash drop`) se a edição não for mais útil.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-LLM-02) e HITL-QUEUE.md, o ADR-020 (§2 D1 e §4), o ADR-008 (D1) e o ADR-015 D2. Confirme pnpm 11.4.0, Node conforme o engines e o branch feat/api-borda. Se o humano autorizou o push, registre.
2. Tarefa única (AGENTS §4.1): commit 1 do ADR-020 §4, o prompt p1 em apps/api/src/application/llm/extraction-prompt.ts, ainda sem o adapter.
   - EXTRACTION_PROMPT_VERSION = "p1", EXTRACTION_RESPONSE_SCHEMA (relaxado, sem pattern, congelado) e buildExtractionMessages(payload, nonce), que nunca lança.
   - Testes: nonce de 32 hex (inválido dá { ok: false }), envelope, recusa de "vaga id=" e do próprio nonce no texto, só o campo text no corpo, snapshot do schema (sem pattern, additionalProperties false, todos os campos em required) e hash do prompt fixado contra o p1.
   - Fronteira: application só importa zod e @trampo/contracts (depcruise).
3. [DEV] + [QA_EVALS]: exijam 100% de cobertura nos arquivos novos e mutação (um mutante por vez, script em arquivo fora do repositório, original conferido depois de cada mutante; patch com acento só pela ferramenta de edição).
4. [APPSEC]: auditem contra os critérios do ADR-020 §3 que cabem ao prompt (T1, T2, LGPD) antes de dar a tarefa como concluída.
5. [SCRIBE]: atualizem STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md.
```
