# Próximo passo: F1-DB-01 (schema Postgres, RLS e `CriteriaRepository` do Supabase)

> **Reciclagem de sessão** (AGENTS §4.4): esta janela entregou a parte 2 do F1-API-04, com três lotes de mutação e a auditoria.
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-22)

### F1-API-04 parte 2: rota `POST /v1/analyze` e escritor SSE (commit `f0bcd52`, **local, sem push**)
- **Código:**
  - `apps/api/src/presentation/routes/analyze.ts`: rota, `preHandler` dos critérios e handler;
  - `apps/api/src/presentation/streaming/sse-stream.ts`: `encodeSseEvent` e `SseStream`;
  - `buildApp`: opção `analysis: { job, criteria }`; sem ela, a rota não existe. O mapeador de erro dá 422 `TEXTO_CURTO_DEMAIS` só quando todas as *issues* são `too_small` em `/job/text`;
  - catálogo do log com `cache_corrompido`, `criterios_indisponiveis` e o tipo `SseEventContractError` (emenda ao ADR-010 D2).
- **Ordem na borda:** CORS, tipo de mídia, JWT, rate limit `analise`, 64 KiB, schema, **critérios** (409 ou 503, sem gastar cota) e só então a **cota**.
- **Stream:**
  - `reply.send(Readable)`, sem hijack, então o CORS e o `vary` continuam na resposta;
  - `event: <type>\ndata: <json>\n\n`, cada evento validado, sem `id:` e sem `retry:`;
  - cabeçalhos `no-store`, `nosniff` e `X-Accel-Buffering: no`;
  - termina com exatamente um `result` ou um `error` `ERRO_INTERNO` com a mensagem do catálogo;
  - cliente que desconecta para a escrita.
- **Testes:** 72 novos, e a API está com **1.878 testes e 100%** de cobertura (1.686/1.686 ramos). Cobrem:
  - borda;
  - enquadramento hostil (CR, LF, CRLF, U+2028, U+2029, `event:`, `data:`, `id:` e `retry:`);
  - 8 de erro sem vazamento;
  - SR-12 com o log capturado;
  - CORS no SSE;
  - desconexão em socket real.
- **Mutação:** 52 mutantes, 49 mortos e 1 equivalente (a guarda do `end()`). O A27 (caminho da rota) sobreviveu e virou teste. Dois equivalentes saíram do código.
- **`[APPSEC]`:** auditou o ADR-017 §3 e **não vetou**. Há um risco residual novo, levado ao F1-DB-01: a porta de critérios não tem prazo.
- **Verificação:** `tsc`, `eslint` e depcruise verdes (329 módulos). O turbo completo não rodou, porque só a API mudou.
- **Documentação:**
  - ADR-017 §3.2;
  - emenda ao ADR-010 D2;
  - BACKLOG (parte 2 ✅, herdado para o F1-DB-01 e aceite do F1-API-04b);
  - STATE;
  - SESSION-LOG.

### Pendências
- **Push e PR:** os commits `c928716`, `ddd148b`, `83d5fe4`, `0c235fd`, `78f7a07`, `5bc3f3d`, `5755033`, `f0bcd52` e o deste `next-step` continuam locais. Vale a opção B: um PR de processamento e domínio depois do merge do #3. A decisão é do humano.
- **QA-01:** fica para o CI (F1-OPS-01).
- **DOC-01:** no backlog.

## Herdado para o F1-DB-01 (BACKLOG)
- O adapter `CriteriaRepository` do Supabase precisa:
  - **nunca rejeitar**: qualquer falha vira `{ found: false, unavailable: true }`;
  - recusar resposta fora do `UserCriteriaSchema` como `unavailable`;
  - ter **prazo próprio**, no modelo dos guardas do ADR-014.

  Aceite: um adapter travado responde `unavailable` dentro do prazo.
- **SR-15:** o usuário A não lê nem altera dados de B, e o cliente *admin* nunca carrega token de usuário. A prova é por teste de banco, com o Supabase CLI local (HITL-020).
- **Pretensão salarial cifrada no app** antes de ir ao banco.
- **Depois do F1-DB-01 vem o F1-API-04b:** o `main.ts` passa `analysis: { job, criteria }` ao `buildApp`. Aceite: teste de boot respondendo 401 sem token.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-DB-01, inclusive o "Herdado do F1-API-04 parte 2"), HITL-QUEUE.md (HITL-004 e HITL-020), o threat-model (SR-15) e o ADR-017 §3.2. Confirme pnpm 11.4.0, Node >= 24, o branch feat/api-borda (commits locais, sem push: opção B) e a memória livre da máquina antes de rodar suítes pesadas. Verifique se o Supabase CLI local está disponível; se faltar algo que exija ação humana (instalação, Docker, credencial), pare e registre no HITL-QUEUE com runbook.
2. [ARCHITECT] + [APPSEC]: escrevam o ADR-018 do F1-DB-01 ANTES do código:
   - schema Postgres: critérios do usuário, registro mínimo de análises e feedback; RLS em todas as tabelas;
   - cifra da pretensão salarial no app (algoritmo, chave e rotação; chave só no .env, nunca no cofre);
   - os dois clientes Supabase (usuário e admin) e quem usa cada um;
   - adapter CriteriaRepository: nunca rejeita, revalida com UserCriteriaSchema, prazo próprio no modelo do ADR-014;
   - migrations versionadas e o teste de RLS do SR-15 com o Supabase CLI local.
   O [APPSEC] audita e só então libera o código. Se o ADR exigir decisão do humano (ex.: aplicar migration no projeto real), registre um HITL e pare.
3. [DEV] + [QA_EVALS]: só o que o ADR-018 liberar nesta janela (AGENTS §4.1), com 100% de cobertura nos arquivos novos e mutação (um mutante por vez, em primeiro plano, script fora de coverage/ e do repositório, conferindo o original depois de cada lote; patch de arquivo com acento pela ferramenta de edição ou por arquivo UTF-8, nunca por heredoc no stdin).
4. [APPSEC]: auditem o código contra o ADR-018 antes de dar a parte como concluída.
5. [SCRIBE]: atualizem STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md (próxima: o restante do F1-DB-01 ou o F1-API-04b).
```
