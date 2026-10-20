# Próximo passo: F1-DOM-02 (`ScoringEngine`, com clearance)

> **Reciclagem de sessão** (AGENTS §4.4): nesta conversa, duas decisões humanas foram registradas, três runbooks foram escritos e o S-4 foi medido em duas rodadas. O F1-DOM-02 começa numa janela nova.
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-20)

### Decisões registradas
- **HITL-018 fechado.** A interpretação 1 foi trocada: com stack > 80% numa vaga um nível acima, o `r` da senioridade **sobe para 0,8** e a penalidade sai. As interpretações 2, 3 e 4 foram mantidas. O ADR-002 está atualizado, e o F1-DOM-02 tem **clearance**.
- **HITL-019 dispensado:** os chips do topo da página ficam com o S-2.
- **HITL-006 fechado.**
- **Divergência anotada:** você chamou o ARS 0,0034 de "*fallback* do serviço de Redis aprovado na D-S3", mas a D-S3 aprovou só a tabela fixa. Ficou assim:
  - o motor continua puro e recebe a taxa pela política;
  - uma fonte de câmbio ao vivo virou o item **F1-FX-01**, opcional e fora do F1-DOM-02.

### Runbooks de infra de custo zero (`../base/03-infra-runbook/`)
- **`regiao-custo-zero.md`:** tudo em **AWS `us-east-1`**, que no Supabase aparece como "East US (North Virginia)".
  - No plano Free, nem o Supabase nem o Upstash cobram diferente por região.
  - O ganho de sair de São Paulo é ficar junto da hospedagem grátis da API (Render Virginia ou Koyeb Washington, D.C.) e fugir de SP no plano pago.
  - **A região do Supabase não muda depois de criada.**
- **`supabase-setup.md` (HITL-004):** passo a passo do projeto, da chave ES256, do JWT de 900 s, do login anônimo desligado, das chaves novas e do OAuth do Google e do GitHub, mais pausa e restauração.
- **`upstash-redis.md` (HITL-007):** crie o banco **só quando o F1-API-03 começar**, porque o Free é arquivado se ficar parado.

### S-4: Camada 1 medida (`evals/spikes/s4-layer1/`)
- **Falso "foge":** 0,1% (4 de 3.188) na varredura exaustiva e **0** nas 8 personas. A versão às cegas tinha 1,4%.
- **Precisão dos sinais explícitos:** 100% em modelo de trabalho, contrato, senioridade e salário; 99,4% em stack. Nenhum salário inventado, e o `AR$` nunca é lido como `R$`.
- **Injection:** 7 de 7 casos em `alta` e 0 controle negativo em `alta`.
- **D-H3:** o aceite sem IA continua desligado. Ele quase nunca dispara (2 de 581 pares), e sem critério obrigatório aceita qualquer vaga. Essa guarda entra no F1-DOM-04.
- **Provas:** SR-09 com entradas de 64 KiB; nenhum texto de vaga nem canário na saída; lint, tipagem e os 28 testes do pacote verdes.
- **Commit local** no `feat/api-borda`, sem push.

## Ações manuais (HITL)
- **HITL-004 (agora, se quiser destravar o S-3, o F1-API-02 e o F1-DB-01):** siga o `supabase-setup.md` e responda "HITL-004 concluído: região East US (North Virginia)". **Nunca cole chave no chat.**
- **HITL-007:** só quando o F1-API-03 começar.
- **Para conferir quando puder** (não bloqueia):
  - o gabarito de `gupy-12` e `gupy-13` não lista AWS, mas a regra "migração X para Y" da spec diz que entraria;
  - os itens "não confirmado" dos runbooks, como a taxa da Chrome Web Store e a regra de inatividade do Upstash (30 dias ou 1 semana).

## Prompt para enviar ao agente

```text
Equipe, sigam com o F1-DOM-02 (clearance do HITL-018).

1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md (HITL-016 e HITL-018), BACKLOG.md (F1-DOM-02 e F1-DOM-03), ADR-002 inteiro (§3, §4.2, §4.4 com as 14 invariantes, §5, §8.1 e §8.2), ADR-011 (ResolvedJobFacts, FactProvenance) e contratos-zod. Confirme pnpm 11.4.0, Node ≥ 24 e o branch feat/api-borda.
2. [DEV] (1º commit, contrato primeiro, AGENTS §1.4): as 3 mudanças do ADR-002 §8.1 em packages/contracts (ARS no CurrencySchema, pressao_excessiva no RedFlagSignalSchema e VerdictSchema de 5 valores), com testes; revise na mesma tarefa os casos do golden com contractGaps (o validador do @trampo/evals tem de continuar verde) e ajuste o protótipo do S-4 para ARS virar currency 'ARS'.
3. [ARCHITECT]: Desenhe ScoringPolicy (se1, validada no construtor com RangeError: adjacentUpRatio 0,5 < adjacentValidatedRatio 0,8 < 1, fxToBrl completo, eliminatoryConflictPenalty > 100 − recommendedMin, dealBreakerCap < bandMins.baixo_alinhamento) e a ordem de cálculo (stack antes de senioridade).
4. [APPSEC]: Audite antes do código: regra de lint do ADR-002 §5.1 (sem includes/startsWith/indexOf/regex sobre string dos fatos em domain/scoring, com fixture negativa), SR-11 (nenhum valor do perfil no ScoreResult) e motor sem logger.
5. [DEV] + [QA_EVALS]: Implemente o ScoringEngine puro em apps/api/src/domain/scoring com 100% de linhas e ramos, as 14 invariantes como propriedade (fast-check), mutação e as fixtures de estresse do §8.2 (casos estresse e sintéticos de câmbio e senioridade).
6. [SCRIBE]: Atualize STATE, BACKLOG e SESSION-LOG, faça commit local sem push e gere o novo ./next-step.md.
```
