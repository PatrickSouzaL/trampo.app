# Próximo passo: F1-DOM-03 (`ReportComposer`)

> **Reciclagem de sessão** (AGENTS §4.4): esta conversa entregou o contrato do §8.1, o motor inteiro e uma rodada de mutação. O F1-DOM-03 começa numa janela nova.
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-21)

### F1-DOM-02 concluída (2 commits locais no `feat/api-borda`, sem push)
- **`8cbeedc`, contrato primeiro:**
  - ARS no `CurrencySchema`, `pressao_excessiva` no `RedFlagSignalSchema` e `VerdictSchema` com 5 faixas;
  - `LlmOutputGuard` subiu para `g2`, porque o teto de red flags passou de 6 para 7;
  - golden com caso v2, sem `contractGaps`;
  - `gupy-12` e `gupy-13` com AWS (Google Cloud já estava como `GCP`);
  - S-4 re-medido: o falso "foge" caiu de 4 para **0**.
- **`789d7a2`, o motor:**
  - `ScoringEngine` puro e `ScoringPolicy` `se1`, validada com `RangeError` (ADR-002 §9);
  - 198 testes do motor: unidade, as 14 invariantes como propriedade e as fixtures de estresse do §8.2;
  - API com 719 testes e 100% de linhas e ramos;
  - mutação 68/68 no motor, 10/10 na política e 5/5 no lint.
- **Lint do §5.1:** busca em string, regex e `console` estão proibidos em `domain/scoring`, com fixture negativa.
- **Oscilação conhecida:** o SR-09 do seletor ainda falha de vez em quando no turbo completo (verde em 4 de 6 rodadas). No commit anterior ao motor, o turbo ficou verde em 0 de 4. O SR-09 não foi afrouxado.

### Pendências suas
- **Confirmar no chat o bloco 1 do prompt anterior.** O classificador de permissões barrou as ações porque o pedido veio do arquivo, não de você. Continuam pendentes:
  - fechar o HITL-004 e o HITL-007;
  - apagar `supabase-setup.md` e `upstash-redis.md` do cofre;
  - registrar a decisão da Chrome Web Store.
  - O golden de `gupy-12`/`gupy-13` e o `.env.example` já foram feitos.
- **HITL-020 (opcional):** MCP do Supabase e do Upstash, só leitura e só em desenvolvimento. O passo a passo está em `../base/03-infra-runbook/mcp-supabase-upstash.md`. O MCP serve para inspeção e não substitui os testes.
- **HITL-008:** ligar o 2FA no Supabase e no Upstash.

## Prompt para enviar ao agente

```text
Equipe, sigam com o F1-DOM-03 (ReportComposer).

1. [ORCHESTRATOR]: Leia STATE.md, HITL-QUEUE.md, BACKLOG.md (F1-DOM-03), ADR-002 §3.4, §4.3, §5.3 e §9 e contratos-zod (AnalysisReportSchema). Confirme pnpm 11.4.0, Node ≥ 24 e o branch feat/api-borda.
2. [ARCHITECT]: Desenhe o catálogo de templates pt-BR: um por ScoreReasonCode (ADR-002 §9.3) e um por faixa (D-S9). Inclua strengths, redFlags e missingInfo (máx. 3, 3 e 9), a explanation de 160 caracteres por linha e a versão do catálogo. Registre no ADR-002 ou num ADR-012.
3. [APPSEC]: Audite antes do código. Os templates só interpolam rótulos de enum DOS FATOS DA VAGA, nunca dos critérios (SR-11; "você exige remoto" é proibido). A saída precisa passar no safeText (sem URL, sem <>, sem invisíveis). O composer não tem logger.
4. [DEV] + [QA_EVALS]: Implemente o ReportComposer puro em apps/api/src/domain/report, com 100% de linhas e ramos, propriedades (saída sempre válida no AnalysisReportSchema; nenhum canário do perfil) e mutação.
5. [SCRIBE]: Atualize STATE, BACKLOG e SESSION-LOG, faça commit local sem push e gere o novo ./next-step.md.
```
