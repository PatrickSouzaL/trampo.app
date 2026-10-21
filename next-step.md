# Próximo passo: F1-API-03 (rate limit, cota e breaker de LLM)

> **Reciclagem de sessão** (AGENTS §4.4): o F1-API-02 rodou em duas janelas, porque a primeira caiu antes do registro. O F1-API-03 tem ADR novo, dependência nova e Redis, e começa numa janela nova.
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-21)

### F1-API-02 concluída (1 commit local no `feat/api-borda`, sem push)
- **`fbb6895`**, verificação do JWT ([[ADR-013-jwt-verification]]):
  - porta `AccessTokenVerifier` na aplicação; adapter `jose` 6.2.12 na infraestrutura; hook `onRequest` depois do CORS e antes do corpo;
  - ES256 fixo, `kid`, `exp` e `is_anonymous: false` obrigatórios, tolerância de 10 s e idade máxima de 900 s;
  - o JWKS falha fechado: se estiver fora do ar, vazio ou sem chave P-256, a resposta é 503 `SERVICO_INDISPONIVEL`. Token inválido dá 401;
  - só `GET /health` é público, e nenhum token ou claim vai para o log;
  - API com 965 testes e 100% de linhas e ramos; mutação 55/55; turbo em série e depcruise verdes (reconferidos nesta sessão).
- **Registro feito nesta sessão:** STATE, BACKLOG e SESSION-LOG. A janela anterior caiu depois do commit e do ADR-013, antes de registrar.

### Pendências novas
- **QA-01:** no turbo em paralelo, o SR-09 do seletor (200 ms de relógio de parede) falha quando o `api:test` roda junto com o `next build`. Em série, passa. Precisa de decisão antes do F1-OPS-01 (CI), sem afrouxar o orçamento.
- **DOC-01** (sem prioridade): o `contratos-zod.md` do cofre continua desatualizado.

## Prompt para enviar ao agente

```text
Equipe, sigam com o F1-API-03 (rate limit, cota diária e breaker de LLM).

1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md (HITL-007), BACKLOG.md (F1-API-03 e F1-LLM-03), threat-model (SR-06, T7, T23 item 6, T39), ADR-009 (D6, QuotaLedger), ADR-013 (§5) e o runbook upstash-redis. Confirme pnpm 11.4.0, Node >= 24 e o branch feat/api-borda.
2. [ARCHITECT]: Desenhe o rate limit por usuário (sub já verificado) e por IP, a cota diária idempotente por requestId e o breaker diário global de LLM. Defina as portas na aplicação, o adapter Upstash na infraestrutura e o hook na apresentação, logo depois do JWT. Implemente o QuotaLedger real do ADR-009. Registre num ADR-014.
3. [APPSEC]: Audite antes do código. Tudo falha fechado: timeout, erro ou resposta inesperada do Redis dão 429/503, nunca liberação (T39: o @upstash/ratelimit libera no timeout por padrão). As instâncias são criadas uma vez no boot. IP e sub nunca aparecem em claro nas chaves: use HMAC-SHA256 com pepper do ambiente (T23). Nenhuma chave, IP ou sub vai para o log (SR-12). Só os nomes entram no .env.example. Confira a dependência nova (versão, proveniência e quarentena de 3 dias do T26).
4. [DEV] + [QA_EVALS]: Implemente com Redis simulado (lento, com erro, que trava), sem chamadas ao Upstash real, com 100% de linhas e ramos e mutação. Rode o turbo em série (--concurrency=1) até o QA-01 ser decidido.
5. [SCRIBE]: Atualize STATE.md, BACKLOG.md e SESSION-LOG.md. Faça o commit local sem push e gere o novo ./next-step.md. Com a fatia Ingress + Auth + Rate Limit completa, pergunte ao humano sobre o push e o PR.
```
