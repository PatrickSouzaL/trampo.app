# Próximo passo: F1-DOM-04 (sinais determinísticos da Camada 1)

> **Reciclagem de sessão** (AGENTS §4.4): esta janela fez o F1-API-03, o push com o PR #3 e o F1-CACHE-01.
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-21)

### Push e PR da fatia Ingress + Auth + Rate Limit
- **PR #3** aberto para o `master`: https://github.com/PatrickSouzaL/trampo.app/pull/3. Push `001536c..043d488`.
- O PR leva P0-EVL-01, S-4, F1-DOM-02, F1-DOM-03, F1-API-02 e F1-API-03.
- Gate final antes do push: turbo 18/18 em série, API com 1.316 testes e 100% de linhas e ramos, depcruise sem violações e varredura de segredo limpa.
- **Decisões registradas:** HITL-021 fechado (o pepper e as credenciais do Upstash estão no `.env`). Resíduo do S-5 aprovado: requisição anônima é barrada antes do Redis, e o limite de inundação fica na Cloudflare.

### F1-CACHE-01 concluída (commit `c928716`, **local, sem push**)
Decisões em [[ADR-015-job-facts-cache]]:
- **Chave:** `jobfacts:v1:{extractorVersion}:{textHash}`, com TTL de 10 dias. A versão junta prompt, schema, normalizador, seletor, guarda e orçamento.
- **Escrita (SR-08):** só a saída da guarda, e só se valerem todas as condições:
  - a análise não foi degradada;
  - a injection é `baixa` no texto e na saída;
  - a confiança efetiva é ≥ 0,5;
  - o provedor é de produção e está na cadeia (o Ollama de dev nunca grava);
  - os fatos são ponto fixo da guarda.

  Depois vem `SET NX EX`, que não sobrescreve.
- **Leitura:** revalida tudo. Adulteração ou modelo obsoleto viram *miss* com `DEL`. Redis lento ou com erro é *miss*, nunca *hit*.
- **Verificação:** 111 testes novos (API com 1.427, 100% de linhas e ramos); 3 propriedades; mutação 47/47, com o único equivalente removido do código; turbo 18/18 em série; depcruise verde.

### Pendências
- **`c928716` fora do PR #3:** escolha abaixo se ele entra no PR ou espera o merge.
- **Achado para o F1-LLM-02:** os ids de modelo da Workers AI começam com `@cf/`, e o padrão do `model` no contrato recusa `@`. É preciso uma decisão de contrato antes desse adapter.
- **QA-01:** fica para os *jobs* isolados no CI (F1-OPS-01). Até lá, o turbo local roda em série.
- **DOC-01:** no backlog.

## Prompt para enviar ao agente

```text
Equipe, sigam com o F1-DOM-04 (sinais determinísticos da Camada 1).

COMMIT c928716 (F1-CACHE-01), escolha uma:
  A) Autorizo o push para o feat/api-borda: ele entra no PR #3 (recomendado se o PR ainda não foi revisado).
  B) Não façam push: o c928716 espera o merge do PR #3 e vai num PR próprio.

1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md, BACKLOG.md (F1-DOM-04, S-4 e F1-API-04), ADR-011 (porta DeterministicSignals), ADR-005 e ADR-006, spike-metrics §5 (S-4) e o protótipo em evals/spikes/s4-layer1/. Confirme pnpm 11.4.0, Node >= 24 e o branch feat/api-borda. Na opção A, rode antes o gate (turbo em série e lint:deps) e faça o push.
2. [ARCHITECT]: Desenhe o DeterministicSignals real no domínio puro (sinais explícitos de modelo, contrato, senioridade, salário e stack, mais o nível de injection), levando as regras validadas do S-4 para produção, incluindo a guarda de vacuidade do R3 e o aceite desligado (D-H3). Registre num ADR-016.
3. [APPSEC]: Audite antes do código: regex linear (SR-09, 200 ms para 64 KiB, sem afrouxar), controles negativos de injection (SR-04) e nenhum texto de vaga na saída.
4. [DEV] + [QA_EVALS]: Implementem com 100% de linhas e ramos, propriedades, mutação e o golden dataset gd1 como aceite (falso "foge" e precisão por campo, comparados com o S-4). Turbo em série.
5. [SCRIBE]: Atualize STATE.md, BACKLOG.md e SESSION-LOG.md, faça o commit local e gere o novo ./next-step.md.
```
