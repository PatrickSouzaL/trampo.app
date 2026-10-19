# Próximo passo: F1-LLM-03 (`LlmProviderRouter`, com portas e fakes)

> **Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.**
> (AGENTS §2, Fase 5, e §4.4. A parada é por reciclagem de sessão, não por HITL: a próxima tarefa não exige nenhuma ação sua.)

## O que acabou de ser entregue (F1-LLM-01 parte 1, 2026-10-19, ADR-008)

### `LlmOutputGuard` (E5)
- **Onde mora:** `apps/api/src/application/llm/llm-output-guard.ts`. O domínio não pode rodar zod, e o guard é política, não adapter.
- **Fronteira nova no depcruise:** `application` não importa `infrastructure`, `presentation` nem `main.ts`, e só usa os pacotes `zod` e `@trampo/contracts`.
- **Pipeline:**
  1. 8 KiB em bytes UTF-8, **antes do parse**;
  2. `JSON.parse` com *reviver* que recusa `__proto__` e `constructor`, inclusive escapados (sem `eval` e sem dependência nova);
  3. pré-saneamento **contado**;
  4. `JobFactsSchema` estrito.
- **Resultado fechado:** `ok` com os fatos e o `LlmOutputSanitization`, ou falha com **só o motivo** (`resposta_grande_demais`, `json_invalido`, `poluicao_de_prototipo`, `schema_invalido`). O guard não tem logger nem parâmetro de perfil e nunca lança.
- **Saneamento:**
  - texto livre (`title`, `city`): NFKC → espaços → invisíveis → `<>` → corte → remoção do token com URL ou esquema → NFKC final. Vazio vira `null`;
  - tags com URL, invisível ou fora do padrão saem **inteiras**;
  - duplicatas e cortes de array são contados;
  - nenhuma conversão de tipo;
  - `injectionSignal` (URL, invisível ou marcação) fica pronto para o SR-08 e para o aviso `possivel_prompt_injection`.
- Versão `g1`, que entra no `extractorVersion` do cache.

### Qualidade
- API com **322 testes**, 98 novos:
  - saídas maliciosas: JSON gigante, *proto poisoning*, chaves extras, URLs e `javascript:`, invisíveis, `1e308`, `1e400`, `"NaN"`, arrays enormes, tipos trocados e JSON truncado;
  - 5 propriedades: nunca lança; ok passa no schema; ok sem URL; idempotente; a falha não ecoa a resposta. Um contador prova que elas não são vazias.
- Cobertura de **100%** (123/123 ramos). Mutação: **20/20** não equivalentes; o 21º era equivalente e o código foi removido.
- 15/15 tarefas do turbo **três vezes**; `--frozen-lockfile` limpo; depcruise verde; e2e da extensão 10/10.

### Branch
- Commit local no **`feat/api-borda`** (junto com a F1-API-01), **sem push**.

## Fila depois desta tarefa
- **F1-LLM-01 parte 2 (adapter do Groq e SR-01)** e **F1-LLM-02 (Cloudflare):** dependem do S-1, que depende do HITL-003.
- **F1-API-02 / F1-DB-01:** HITL-004. **F1-API-03 / F1-CACHE-01:** HITL-007.
- **F1-DOM-04:** ⛔ pelo S-4. **F1-DOM-02:** exige o ADR-002, um marco humano.

Por isso, a próxima tarefa é o **router**. Ele não depende de provedor nem de chave e pode ser provado com *fakes*.

## Ação manual (HITL) antes do próximo comando
- Nenhuma, além de **reciclar a sessão** (veja o aviso no topo).
- **Opcional:** decidir se o `feat/api-borda` vira PR (push não autorizado até você dizer).
- Em background: HITL-003 (30 vagas).

## Prompt para enviar ao agente

```text
Equipe, vamos executar a F1-LLM-03 (LlmProviderRouter, Camada 3). Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos. Sigam o ciclo de 5 fases do AGENTS.md, inclusive a avaliação de continuidade da Fase 5.

HITL-003: [em andamento / concluído: N vagas]

1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md, BACKLOG.md (F1-LLM-03), o ADR-001 §5.5 (tabela do LlmProviderRouter, porta JobFactsExtractor e ExtractionOutcome), o ADR-008 (LlmOutputGuard e injectionSignal), o threat-model (T7, T28, T30 e T39) e o código atual de apps/api/src (domain e application). Confirme pnpm 11.4.0, Node ≥ 24 e o branch (feat/api-borda ou o que o humano indicar) limpo.
2. [ARCHITECT] + [APPSEC]: Decidam e registrem em ADR ANTES de codar:
   - as portas em application: JobFactsExtractor (por provedor), Clock (relógio monotônico injetado), QuotaLedger e o estado do circuit breaker (interfaces, sem Redis);
   - prazo global (ANALYSIS_DEADLINE_MS = 12 s), por tentativa min(10 s, restante − 300 ms), sem tentar com menos de 2,5 s restantes;
   - orçamento de NO MÁXIMO 2 chamadas de LLM por análise, somando retry e troca de provedor;
   - 429 troca de provedor na hora e respeita Retry-After (com teto); timeout e erro do provedor; circuit breaker por provedor; breaker diário global;
   - a cadeia vem de configuração validada (groq → cloudflare_workers_ai; google_ai_studio recusado nas Fases 0 e 1, HITL-012), e todo resultado ok passou pelo LlmOutputGuard;
   - resultado fechado (ExtractionOutcome), sem texto do LLM em log e sem dado de perfil.
3. [DEV]: Implemente SOMENTE o router, as portas e fakes em memória para os testes. Não implemente adapters HTTP (Groq/Cloudflare dependem do S-1) nem o QuotaLedger em Redis (HITL-007).
4. [QA_EVALS]:
   - Testes com relógio falso: prazo global, orçamento de 2 chamadas nunca excedido, 429 com troca, Retry-After, breaker abrindo e fechando, cota esgotada e cadeia vazia ou inválida.
   - Propriedades no fast-check: para qualquer sequência de respostas dos provedores, nunca mais de 2 chamadas, nunca passa do prazo e nunca lança.
   - Cobertura de 100% e mutação.
   - `pnpm install --frozen-lockfile` limpo; `pnpm turbo run build typecheck lint test` verde; `pnpm lint:deps` verde; `test:e2e` da extensão verde.
5. [SCRIBE]: Marque a F1-LLM-03 no STATE.md (checkpoint imediato), registre no SESSION-LOG e em ADR, faça o commit local (push NÃO autorizado) e gere o novo ./next-step.md. Na Fase 5, avancem sozinhos só se não houver HITL e o contexto estiver seguro.
```
