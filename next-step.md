# Próximo passo: responder o HITL-029 e seguir conforme as letras

> **Parada obrigatória (HITL).** A rodada de aceite do S-1 terminou e abriu um marco de decisão. Responda o HITL-029 e envie este next-step.md numa sessão nova.

## O que acabou de ser entregue (2026-10-26)

### Avaliador do S-1 (commit `0a8bb23`, local, sem push)
- A saída agora é separada por versão:
  - um arquivo por prompt e guard, `out/s1-results.p2-g3.jsonl`;
  - `promptVersion` e `guardVersion` em cada linha e na chave de retomada;
  - a rodada do `p1` está arquivada em `out/s1-results.p1-g2.jsonl`, sem apagar nada.
- O gate do `gd2` (golden-dataset-spec §8.2) está implementado:
  - SR-04 sem `benefits`, H10 e moeda nula;
  - o T4 dá `revisar` com os termos, porque o gabarito não lista os termos negados.
- O relatório compara com o `p1` (tokens de entrada pareados por caso) e lê os contadores do `g3`.
- `S1_BUDGETS=6000` limita os orçamentos.

### Rodada de aceite (spike-metrics §2.7)
- **Gate de segurança do `gd2`: passa nos dois provedores.**
  - 0 canário vazado e 0 fato atacável alterado em 7 casos de injection.
  - 0 sinal de injection em controle negativo e 0 moeda nula.
  - T4 real 0: o `linkedin-14` não tem negação; os termos extras são conceitos.
- **Tokens do `p2`:** +307 no Groq e +350 na Workers AI, dentro do teto de +400.
- **O Groq falha em 2 itens do §8.1:**
  - precisão de stack de **0,70** (gate 0,85), uma queda de −6,9 pp contra o `p1`;
  - JSON válido de **96,4%** (gate 98%). As 3 recusas são termos nas duas listas de stack.
- **O que o `p2` melhorou no Groq:**
  - contrato de 0,845 para 0,925;
  - recall de stack de 0,745 para 0,81;
  - recall de `benefits` de 0,77 para 0,897;
  - `salario_omitido` de 41 saídas para 0.
- **Causa da queda na precisão:** a regra de recall de stack puxa conceitos (ETL, MDM, "financial data"). Os falsos positivos de stack foram de 111 para 201.
- **Workers AI:** p95 de 11,3 s, com falhas em senioridade, contrato, `location` e stack.
- **Cota:** a rodada gastou 199K tokens do Groq, o TPD inteiro de um dia.

### Verificação
- Turbo em série com 19 de 19 verdes no início da sessão; `@trampo/evals` com 4 de 4 depois das mudanças.
- `[APPSEC]` sem veto:
  - as 166 linhas gravadas não têm texto de vaga, canário nem saída bruta;
  - nenhum pedido levou `tools` (SR-01).

### Pendências do humano
- **HITL-029** (base/00-orquestracao/HITL-QUEUE.md). A recomendação é 1A, 2A, 3A, 4A:
  - `p3`: stack só com tecnologia nomeada;
  - `g4`: sobreposição de stack fica em `stackNiceToHave`;
  - adapter do Groq em paralelo;
  - Workers AI mantida como fallback.
- O push continua não autorizado.

## Prompt para enviar ao agente (depois de responder o HITL-029)

```text
Equipe, sigam em ciclo estrito. HITL-029: <letras>.

1. [ORCHESTRATOR]: Leiam STATE.md, o HITL-029, spike-metrics §2.7, ADR-020 §7.6, ADR-008 D5 e ADR-009 §5. Confirmem pnpm 11.4.0, o Node conforme o engines e o branch spike/s1-extraction. Fechem o HITL-029 no cofre com as letras escolhidas.
2. [ARCHITECT] + [APPSEC]: desenhem as emendas escolhidas, sem código ainda:
   - se 1A, o p3 no ADR-020 §8: a regra de stack só com tecnologia nomeada (linguagem, framework, banco, ferramenta, plataforma, produto), dentro do teto de +400 tokens sobre o p1;
   - se 2A, o g4 no ADR-008: o termo nas duas listas fica só em stackNiceToHave, contado e fora do injectionSignal.
3. [DEV] + [QA_EVALS]: um commit atômico por vez (g4, depois p3), com testes, cobertura de 100% e mutação. Se 3A, o adapter do Groq (F1-LLM-01 parte 2, teto de 3 s do ADR-009 §5) vem na sessão seguinte, sem ligar no main.ts.
4. [QA_EVALS]: a rodada de aceite do p3 gasta o TPD do Groq de um dia. Façam a rodada só numa sessão com a cota zerada: S1_MODE=run S1_BUDGETS=6000 S1_GROQ_VARIANT=nao_estrito.
5. [SCRIBE]: atualizem STATE.md, SESSION-LOG.md e os ADRs, façam o commit local e gerem o novo ./next-step.md.
```
