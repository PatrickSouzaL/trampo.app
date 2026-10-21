# Próximo passo: F1-API-02 (verificação de JWT)

> **Reciclagem de sessão** (AGENTS §4.4): esta conversa entregou um ADR novo, uma mudança de contrato, o `ReportComposer` e duas rodadas de mutação. O F1-API-02 começa numa janela nova.
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-21)

### HITL fechados (declarados por você no chat)
- HITL-004, HITL-007, HITL-008 e HITL-020 estão concluídos.
- Os runbooks `supabase-setup` e `upstash-redis` ficam no cofre.
- Chrome Web Store: E2E em *Developer Mode* e publicação no pós-MVP.

### F1-DOM-03 concluída (2 commits locais no `feat/api-borda`, sem push)
- **`45fbe2f`, contrato primeiro:**
  - `AnalysisReportSchema.summary` (`safeText(200)`): o "template por faixa" do ADR-002 §3.4 não tinha campo onde ir;
  - `meta.reportCatalogVersion`: texto muda sem mudar a nota;
  - o exemplo "você exige remoto" saiu do comentário e da fixture do contrato.
- **`00a6c2e`, o composer:**
  - `ReportComposer` puro em `apps/api/src/domain/report` ([[ADR-012-report-composer]]);
  - **não recebe os critérios do usuário** (SR-11 por construção);
  - catálogo `rc1`: um template por `ScoreReasonCode` (20) e um por faixa, só com rótulos de enum dos fatos;
  - lista fechada de caracteres e limites do pior caso provados exatos;
  - lint que proíbe ler título, cidade, país, tags de stack e campos do perfil;
  - API com 843 testes e 100% de linhas e ramos; mutação 81/81; turbo 18/18.
- **Pendência sem prioridade (DOC-01):** o `contratos-zod.md` do cofre está desatualizado desde o F1-DOM-02. A fonte da verdade é `packages/contracts`.

## Prompt para enviar ao agente

```text
Equipe, sigam com o F1-API-02 (verificação de JWT).

1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md (HITL-004), BACKLOG.md (F1-API-02), threat-model (SR-05, T9, T22), ADR-007 e o runbook supabase-setup. Confirme pnpm 11.4.0, Node >= 24 e o branch feat/api-borda.
2. [ARCHITECT]: Desenhe a verificação com jose e JWKS remoto: ES256 fixo, iss, aud, role, exp com tolerância pequena, is_anonymous recusado, cache e rotação do JWKS com timeout, e falha fechado com JWKS vazio. Defina a porta na aplicação e o plugin na apresentação. Registre num ADR-013.
3. [APPSEC]: Audite antes do código. Recuse alg none, HS256 (inclusive com a chave pública como segredo), kid desconhecido, token sem exp, iss ou aud errados, role diferente de authenticated e anônimo. Nenhum token nem claim vai para log (SR-12). A URL do JWKS vem do ambiente; só os nomes vão para o .env.example.
4. [DEV] + [QA_EVALS]: Implemente com testes de borda contra um JWKS local falso (chaves geradas no teste, sem rede real), 100% de linhas e ramos e mutação. Nenhuma chamada ao projeto Supabase real nos testes.
5. [SCRIBE]: Atualize STATE.md, BACKLOG.md e SESSION-LOG.md. Faça o commit local sem push e gere o novo ./next-step.md.
```
