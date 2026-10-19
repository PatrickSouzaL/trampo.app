# Próximo passo: F1-OBS-01 (logger com lista fechada de campos e *redaction*, SR-12)

> **Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.**
> (AGENTS §2, Fase 5, e §4.4. A parada é por reciclagem de sessão, não por HITL: a próxima tarefa não exige nenhuma ação sua.)

## O que acabou de ser entregue (F1-LLM-03, 2026-10-19, ADR-009)

### `LlmProviderRouter` (Camada 3)
- **Portas** em `apps/api/src/application/ports`:
  - `Clock`: monotônico, com um `sleep` que nunca rejeita;
  - `Random`;
  - `JobFactsExtractor`: um por provedor, devolve a resposta **bruta**;
  - `QuotaLedger`: cota por provedor e breaker diário global;
  - `ProviderStateStore`: síncrono, com `InMemoryProviderStateStore` por processo até o S-5.
- **A guarda de saída roda no router**, não no adapter (refina o ADR-008 D2). Nenhum provedor entrega fatos sem passar por ela.
- **Política** (constantes fixadas por teste contra o ADR):
  - prazo de 12 s; cada tentativa tem `min(10 s, restante − 300 ms)`; nenhuma chamada com menos de 2,5 s restantes;
  - **no máximo 2 chamadas por análise**;
  - retry só para rede ou 5xx, com jitter de 200 a 600 ms;
  - 429 troca de provedor na hora e resfria pelo `Retry-After`, limitado a [1 s, 120 s] (60 s se ausente);
  - breaker abre com 3 falhas seguidas ou 50% em 10, fica 60 s aberto e tem sonda única;
  - cota esgotada no provedor pula **antes** do 429. Cota global, ou ledger com erro ou acima de 250 ms, **falha fechado**.
- **Cadeia:** `parseLlmProviderChain` recusa o Gemini (HITL-012) e só aceita o Ollama com a flag de dev. O construtor lança no boot se a cadeia não casa com os adapters. Em requisição, o router nunca lança, e a trilha só carrega enums.

### Qualidade
- API com **404 testes**, 82 novos. A propriedade roda 1.000 cenários por execução, e uma caça avulsa de 60.000 não achou contraexemplo.
- Cobertura de **100%** (206/206 ramos). Mutação: **52/52** não equivalentes mortos; os 2 equivalentes tiveram o código removido.
- 15/15 tarefas do turbo **três vezes**; `--frozen-lockfile` limpo; depcruise verde; e2e da extensão 10/10; nenhuma dependência nova.
- **Intermitência investigada:**
  - O teste de propriedade passava do timeout padrão de 5 s sob CPU disputada e agora tem timeout explícito.
  - O SR-09 do seletor (pré-existente, 200 ms de relógio de parede) oscila só sob estresse artificial, com 3 suítes ao mesmo tempo. Não foi afrouxado.

### Branch
- Commit local no **`feat/api-borda`**, **sem push**. Sua decisão está registrada no SESSION-LOG: nada de push nem PR até a fatia Ingress + Auth + Rate Limit ficar completa, e PR para o principal só com a primeira rota de domínio integrada e testada.

## Fila depois desta tarefa
- **F1-LLM-01 parte 2 (Groq e SR-01)** e **F1-LLM-02 (Cloudflare):** dependem do S-1, que depende do HITL-003.
- **F1-API-02 / F1-DB-01:** HITL-004. **F1-API-03 / F1-CACHE-01:** HITL-007.
- **F1-DOM-04:** ⛔ pelo S-4. **F1-DOM-02:** exige o ADR-002, um marco humano. O F1-DOM-03 e o F1-DOM-05 dependem deles.
- **F1-OPS-01 (CI):** só roda com push, que não está autorizado.

Por isso, a próxima tarefa é o **logger (F1-OBS-01)**. Ele não depende de conta nem de chave, e a trilha do router (só enums) é a primeira fonte de métrica.

## Ação manual (HITL) antes do próximo comando
- Nenhuma, além de **reciclar a sessão** (veja o aviso no topo).
- Em background: HITL-003 (30 vagas).

## Prompt para enviar ao agente

```text
Equipe, vamos executar a F1-OBS-01 (logger com lista fechada de campos e redaction, SR-12). Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos. Sigam o ciclo de 5 fases do AGENTS.md, inclusive a avaliação de continuidade da Fase 5.

HITL-003: [em andamento / concluído: N vagas]

1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md, BACKLOG.md (F1-OBS-01), o ADR-007 (borda: log sem IP, query, hostname e pid), o ADR-009 (RouterTrailEntry e ExtractionOutcome), o threat-model (SR-12, SR-17, T12 e T23) e o código atual de apps/api/src (presentation/build-app.ts e application). Confirme pnpm 11.4.0, Node ≥ 24 e o branch feat/api-borda limpo.
2. [ARCHITECT] + [APPSEC]: Decidam e registrem em ADR ANTES de codar:
   - lista FECHADA de campos permitidos no log (allowlist, não denylist), com serializadores do Fastify/pino para req, res e err;
   - redaction de Authorization, Cookie e qualquer cabeçalho fora da lista; nunca corpo de requisição, texto de vaga, critérios, token, IP em claro nem resposta do LLM;
   - porta de Telemetry em application (eventos com enums: motivo do router, provedor, latência, chamadas, guardRejection), sem texto livre;
   - o que é métrica (contador/histograma) e o que é log; nenhum dado de perfil.
3. [DEV]: Implemente o logger e a porta de Telemetry com um adapter em memória para os testes. Não implemente exportador externo (depende do S-5).
4. [QA_EVALS]:
   - Teste do SR-12: o log de uma requisição com texto de vaga, critérios, token, cookie e IP não contém nenhum deles (varredura por canário).
   - Teste de propriedade: para qualquer entrada, a saída do log só tem chaves da allowlist.
   - Cobertura de 100% e mutação.
   - `pnpm install --frozen-lockfile` limpo; `pnpm turbo run build typecheck lint test` verde; `pnpm lint:deps` verde; `test:e2e` da extensão verde.
5. [SCRIBE]: Marque a F1-OBS-01 no STATE.md (checkpoint imediato), registre no SESSION-LOG e em ADR, faça o commit local (push NÃO autorizado) e gere o novo ./next-step.md. Na Fase 5, avancem sozinhos só se não houver HITL e o contexto estiver seguro.
```
