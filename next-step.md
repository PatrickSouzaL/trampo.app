# Próximo passo: terminar a mutação do F1-DOM-04 e seguir para o F1-API-04

> **Reciclagem de sessão** (AGENTS §4.4): esta janela fez o ADR-016, o F1-DOM-04 e uma rodada de mutação, que foi interrompida.
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-22)

### Decisões do humano registradas
- **Opção B:** o `c928716` (F1-CACHE-01) fica fora do PR #3. Ele entra, junto com o `ddd148b`, num PR de processamento e domínio depois do merge do #3.
- **`@cf/`:** o contrato do `model` vai aceitar só o prefixo estrito `@cf/`. O ajuste é feito no início do F1-LLM-02 e está registrado no BACKLOG.

### F1-DOM-04 concluída (commit `ddd148b`, **local, sem push**)
Decisões em [[ADR-016-deterministic-pre-filter]]:
- **Onde fica:** `apps/api/src/domain/prefilter`, em domínio puro. A saída tem só enums, números e termos canônicos do `TechDictionary` `td1`, sem nenhum trecho da vaga.
- **R1:** julgado pelo `ScoringEngine` real sobre os fatos só determinísticos. Red flags ficam fora.
- **R2:** vale em qualquer modo.
- **R3:** desligado (D-H3) e com guarda de vacuidade. O `acceptEligible` fica registrado, para medir a D-H3 com dado real.
- **Emenda ao ADR-005:** invisíveis contados por classe. A bandeira de subdivisão e o FE0F de emoji ficam isentos, e o normalizador continua `n1`.
- **Aceite no `gd1`:**
  - os sinais são idênticos aos do S-4 nos 83 casos;
  - falso "foge" 0;
  - precisão de 100% nos explícitos;
  - injection 7/7 em `alta`, e nenhum controle negativo em `alta`.
- **Verificação:**
  - API com 1.712 testes (285 novos) e 100% de linhas e ramos;
  - 6 propriedades;
  - SR-09 com 24 formas de 64 KiB, direto e pela cadeia do normalizador;
  - turbo 18/18 em série; depcruise verde.
- **Achado de segurança corrigido:** ataque colado em pontuação não ASCII (`‹›` do `<` neutralizado, aspas curvas) escapava do detector de injection. O defeito vinha do protótipo do S-4.

### Pendências
- **Mutação incompleta:** 99 mortos dos 102 que rodaram (3 equivalentes). O Claude Code parou o processo por falta de memória na máquina. **Faltam 29 mutantes:** R5–R17 do router, P1–P2 do pré-filtro e V1–V14 da contagem por classe (lista no ADR-016 §5). Um mutante ficou aplicado quando o processo caiu; foi detectado e restaurado antes do gate.
- **QA-01:** fica para o CI (F1-OPS-01).
- **DOC-01:** no backlog.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-DOM-04 e F1-API-04) e o ADR-016 §5. Confirme pnpm 11.4.0, Node >= 24 e o branch feat/api-borda (commits c928716 e ddd148b locais, sem push: opção B).
2. [QA_EVALS]: Terminem a mutação do F1-DOM-04: os 29 mutantes que faltam (R5–R17, P1–P2 e V1–V14, ADR-016 §5). Rodem um mutante por vez, em primeiro plano e em lotes pequenos (a máquina ficou sem memória na rodada anterior), com o script FORA de coverage/ (o vitest apaga essa pasta). Confiram que o texto original voltou depois de cada lote. Sobrevivente real vira teste; equivalente sai do código ou fica documentado.
3. Depois, sigam com o F1-API-04 (AnalyzeJob e POST /v1/analyze):
   - [ARCHITECT]: ADR-017, com o funil E0–E9 (normalize → extract → route → cache → router do LLM → guarda → FactResolver → ScoringEngine → ReportComposer) e os eventos SSE;
   - [APPSEC]: auditem antes do código.
4. [SCRIBE]: Atualizem STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md.
```
