# Próximo passo: F1-SEC-00 (numeração da OWASP GenAI LLM Top 10 2026 no PDF oficial)

> **Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.**
> (AGENTS §2, Fase 5, e §4.4. A parada é por reciclagem de sessão, não por HITL: a próxima tarefa não exige nenhuma ação sua.)

## O que acabou de ser entregue (F1-OBS-01, 2026-10-19, ADR-010)

### Logger com lista fechada (SR-12)
- **Achado:** o campo `msg` do Fastify é texto livre e vazava dados. Exemplos:
  - o 404 padrão grava a URL com a query;
  - `Reply was already sent` grava a URL;
  - `err.message` vira `msg` no pino.

  Serializers de plugin e `child()` também conseguiam trocar os serializers da F1-API-00.
- **Imposição na escrita final:** o `hooks.streamWrite` do pino é da raiz, e nenhum `child`, plugin ou formatter o alcança. Ele reconstrói cada linha só com:
  - `level`, `time`, `msg`, `reqId` e `responseTime`;
  - `req{id, method, route}`, `res{statusCode}` e `err{type, code, statusCode}`;
  - `signal`.

  Cada campo tem a forma validada. A `route` só aparece se for uma rota registrada.
- **Mensagens:** `msg` vem de um catálogo de enums. Qualquer outra vira `mensagem_fora_do_catalogo`.
- **O resto da política:**
  - nenhum cabeçalho é gravado;
  - o `redact` foi rejeitado, porque é denylist e seria código morto;
  - o `buildApp` só aceita `logger: false` ou `{ level, stream }`.

### Porta `Telemetry`
- **Evento:** schema estrito, só com enums e números. Não tem perfil, `userId`, `reqId` nem `model`.
- **`llmExtractionEvent`:** monta o evento a partir do `ExtractionOutcome` do router.
- **Catálogo de 6 métricas:** contadores e histogramas, com rótulos de cardinalidade fechada.
- **`InMemoryTelemetry`:** descarta e conta evento inválido e nunca lança.
- O exportador externo fica para o S-5.

### Qualidade
- **Testes:** API com **461**, 57 deles novos.
  - O SR-12 é provado por canário numa requisição real, com 200, 404, 400, 415 e 500, um child logger malicioso e um serializer de plugin.
  - As propriedades rodam 1.000 execuções cada.
- **A propriedade achou um defeito:** `responseTime` igual a 2^53 virava um inteiro inseguro. Já está corrigido.
- **Cobertura:** **100%** (324/324 ramos).
- **Mutação:** **69/69** mortos. O código equivalente foi removido.
- **Guardrails:**
  - 15/15 tarefas do turbo, três vezes;
  - `--frozen-lockfile` limpo e depcruise verde;
  - e2e da extensão 10/10;
  - smoke do JS compilado;
  - nenhuma dependência nova.

### Branch
- Commit local no **`feat/api-borda`**, **sem push**. Continua valendo a sua decisão: nada de push nem PR até a fatia Ingress + Auth + Rate Limit ficar completa.

## Fila depois desta tarefa
- **F1-OBS-02:** depende dos adapters (S-1) e das contas (HITL-004 e HITL-007).
- **S-5:** exige criar contas de hospedagem, então é HITL.
- **F1-LLM-01 parte 2 e F1-LLM-02:** dependem do S-1 (HITL-003).
- **F1-API-02 e F1-API-03:** HITL-004 e HITL-007.
- **F1-DOM-04:** ⛔ pelo S-4. **F1-DOM-02:** depende do ADR-002, um marco humano.

Por isso, a próxima tarefa é a **F1-SEC-00**: só leitura de fonte oficial e ajuste do threat model, sem conta e sem chave.

## Ação manual (HITL) antes do próximo comando
- Nenhuma, além de **reciclar a sessão** (veja o aviso no topo).
- Em background: HITL-003 (30 vagas).

## Prompt para enviar ao agente

```text
Equipe, vamos executar a F1-SEC-00 (conferir a numeração da OWASP GenAI LLM Top 10 2026 no PDF oficial v1.0 e ajustar o threat model). Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos. Sigam o ciclo de 5 fases do AGENTS.md, inclusive a avaliação de continuidade da Fase 5.

HITL-003: [em andamento / concluído: N vagas]

1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md, BACKLOG.md (F1-SEC-00) e o threat-model inteiro (toda referência LLMxx:2026, A0x:2025 e API Top 10). Confirme pnpm 11.4.0, Node ≥ 24 e o branch feat/api-borda limpo.
2. [APPSEC]: Busque a fonte OFICIAL (genai.owasp.org / owasp.org: PDF v1.0 da LLM Top 10 2026, Top 10:2025 e API Security Top 10:2023). Registre a URL, a data de acesso e o título exato de cada item usado. Se o PDF 2026 não existir ou divergir, registre o que existe e NÃO invente numeração.
3. [APPSEC]: Monte uma tabela (referência no threat model → título oficial → confere/diverge) e corrija só o que diverge, no threat-model, no ADR-001 e nos ADR-005 a ADR-010 que citarem o item. Nada de código.
4. [QA_EVALS]: Faça uma varredura (grep) para provar que nenhuma referência antiga ficou para trás no cofre e no repositório (comentários de código inclusive). `pnpm turbo run build typecheck lint test` continua verde se algum comentário mudar.
5. [SCRIBE]: Marque a F1-SEC-00 no STATE.md (checkpoint imediato), registre no SESSION-LOG com a nota de verificação, faça o commit local se o repositório mudar (push NÃO autorizado) e gere o novo ./next-step.md. Na Fase 5, avancem sozinhos só se não houver HITL e o contexto estiver seguro.
```
