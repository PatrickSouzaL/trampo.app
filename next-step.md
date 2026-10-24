# Próximo passo: F1-API-05 commit 5, rotas `GET` e `PUT /v1/criteria` e a composição (ADR-021 D2, D8.1, D9 e D10)

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este `next-step.md`.
>
> **Nenhum HITL bloqueia.** A única entrega desta rodada foi o commit 4 do ADR-021.

## O que acabou de ser entregue (2026-10-24)

### F1-API-05 commit 4: CORS por rota e a classe `criterios` (ADR-021 §5.4)
- **CORS (emenda ao ADR-007 D6):**
  - `EXTENSION_ROUTES` é congelada e só tem `POST /v1/analyze`;
  - só a origem que começa com `https://` ou `http://` (o portal) fica sem restrição. Toda outra fica presa à lista: a da extensão, e também qualquer forma que chegue ao `buildApp` sem passar pelo `edge-env`. Assim a regra falha fechado;
  - a regra vale no *preflight* (pelo `Access-Control-Request-Method`) e na requisição real (pelo método);
  - o caminho é o cru antes do `?`. No Fastify, o `request.url` é o `raw.url`;
  - `%61`, `//`, barra final, `..`, `.`, `#`, maiúsculas e a forma absoluta dão 403 `PROIBIDO`. O 403 sai antes do JWT, do rate limit e do corpo, e os testes contam cada um em zero;
  - o roteador decodifica `%61` e chegaria à rota de análise. Há teste provando isso com o portal.
- **Rate limit (emenda ao ADR-014 D4):** a classe `criterios` tem 10 por minuto por usuário e 30 por IP. A `analise` continua a mais estrita nas duas dimensões, e um valor desconhecido continua caindo nela.
- **Testes:**
  - 59 novos;
  - o `light-my-request` normaliza `..`, `/./` e `#`, então esses casos vão por socket real, com a linha de requisição escrita à mão;
  - os testes antigos que usavam a origem da extensão em rotas de sonda passaram para a rota dela ou para o portal;
  - o `cors.ts` entrou no `include` da cobertura;
  - a API tem 2.531 testes e 100% de cobertura.
- **Portão:**
  - turbo com 16/16 de build, typecheck e lint e 7/7 de teste, em série, sem intermitência nesta rodada;
  - depcruise sem violações (378 módulos);
  - mutação com 27 mortos de 27. O `WEB_ORIGIN` sem âncora sobreviveu na 1ª rodada e virou teste.
- **`[APPSEC]` sem veto.** Os critérios 5 e 8 do §3 foram atendidos.
- **Commit `9371774`**, local, sem push. ADR-021, ADR-007, ADR-014, STATE, BACKLOG e SESSION-LOG foram atualizados.

### Pendências do humano
- **Push** do `feat/api-borda`, quando quiser. Faltam subir o `955da43`, o `9371774` e os commits de `next-step`. O CI deste branch só roda em `pull_request`, então o `secrets` (gitleaks) só confere quando o PR para o `master` for aberto.
- **S-1 (autorizado):** fica para uma sessão própria, porque gasta a cota gratuita dos provedores reais. Para rodá-lo antes do commit 5, troque a tarefa do prompt abaixo pela do S-1 no BACKLOG.
- O `git stash` no `master` pode ser descartado com `git stash drop`, se a edição não servir mais.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leiam STATE.md, BACKLOG.md (F1-API-05) e HITL-QUEUE.md, o ADR-021 (D2, D4, D6, D8.1, D9, D10 e §3, e as implementações §5.2 a §5.4) e a emenda do ADR-010 D2 (catálogo do log). Confirmem pnpm 11.4.0, o Node conforme o engines e o branch feat/api-borda.
2. Tarefa única (AGENTS §4.1): o commit 5 do ADR-021, em presentation (rotas e build-app) e composition.
   - Rotas, só com a opção criteria?: { repository } do buildApp (sem ela, 404 PROIBIDO, como hoje):
     - GET /v1/criteria, na classe padrao: 200 com o UserCriteria validado na saída, 409 CRITERIOS_NAO_CONFIGURADOS e 503 SERVICO_INDISPONIVEL;
     - PUT /v1/criteria, na classe criterios: bodyLimit de CRITERIA_BODY_MAX_BYTES (16 KiB, 413 sem parse) e UserCriteriaSchema (400 PAYLOAD_INVALIDO, sem as issues do Zod); 204 sem corpo; 503 sem eco;
     - Cache-Control: no-store nas duas, em sucesso e em erro;
     - o dono vem só do principal, e o token é o bearer já verificado;
     - nenhuma cota diária.
   - O composeApp passa o MESMO CriteriaGuard que já entrega à análise.
   - O catálogo do log ganha criterios_gravacao_indisponivel (warn, sem campos), no PUT que vira 503. O GET reusa criterios_indisponiveis.
   - Testes do D10 (commit 5):
     - ordem de defesa: sem token, 401 sem ler o corpo; 17 KiB dá 413 sem parse; rate limit antes do corpo; userId no corpo dá 400 e nada é gravado;
     - GET 200 com no-store e o corpo igual ao gravado; GET 409 e 503 (linha de outro dono, chave perdida);
     - PUT 204 sem corpo, e 503 sem eco;
     - SR-12 com canários nas notas, cidades, tecnologias, pretensão e token, com o log capturado nos caminhos 200, 204, 400, 413, 429 e 503;
     - a origem da extensão continua 403 nas rotas reais (herda o commit 4);
     - o boot do composeApp monta as duas rotas com o mesmo guarda da análise.
   - 100% de cobertura, mutação e o [APPSEC] (critérios 1, 4, 7 e 8 do §3).
3. [SCRIBE]: atualizem o ADR-021 (§5.5), o ADR-010 (nota da emenda), STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md. O commit 6 (test:db) fecha com push e o job db verde, e o HITL dele abre nessa entrega.
```
