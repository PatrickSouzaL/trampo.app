# Próximo passo: trilhas paralelas enquanto a cota do Groq não zera

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie **um** dos prompts abaixo.

## O que acabou de ser entregue (2026-10-27)

### Trilha F: F1-EXT-03 parte 1, o extrator genérico ligado no Service Worker (ADR-024)
- **O que mudou:**
  - o clique no ícone abre o painel e injeta o extrator `ge1` na aba, só no frame principal e no mundo ISOLATED;
  - o Service Worker confere o retorno com Zod estrito;
  - depois tira os surrogates órfãos e, em seguida, os caracteres de controle. Os invisíveis Unicode ficam para o servidor contar;
  - corta em 15.000 code points e guarda a última captura em `storage.session`.
- **O painel nunca recebe o texto da vaga**, só o estado, a contagem de caracteres e se o texto foi cortado.
- **"Colar o texto"** aparece em 3 casos:
  - `sem_acesso`: página restrita ou sem concessão. A mensagem do navegador não é lida, porque pode trazer a URL;
  - `erro`;
  - `texto_insuficiente`.
- **Provas:**
  - unidade: 110 testes, 100% em `src/capture` e `src/messaging`;
  - E2E no **build de produção** com o clique real (`Extensions.triggerAction`): 15/15 em 3 rodadas, e nenhum dos 13 canários chegou ao storage ou ao painel;
  - autocontenção: o extrator com uma referência ao módulo derruba o E2E;
  - mutação: 66 de 66 mortos;
  - `test:browser`: 52/52.
- **O que não mudou:** contratos, manifesto, extrator, versões de prompt e guard. Nada chamou o Groq.
- **Atualizados:** ADR-024 (novo), ADR-023 (nota), BACKLOG, STATE e SESSION-LOG.

### Antes (ainda valendo)
- **Adapter do Groq** (B2, `4220bee` a `797c04b`): pronto, mas ainda não está ligado no `main.ts`.
- **`g4` (`90867d9`) e `p3` (`61474d0`):** estão só locais. O aceite dos dois espera a cota do Groq (Trilha A).
- **`contratos-zod` do cofre:** sincronizado com o `src/` (Trilha E). A Trilha F não mudou contrato.

### Pendências do humano
- **HITL-030 (opcional, sem pressa):** salvar de 3 a 5 vagas do LinkedIn e de 3 a 5 da Gupy.
  - Use uma janela anônima, **sem login**, e salve com Ctrl+S → "Página da Web, completa".
  - Na pasta `_files`, apague tudo o que não for `.css`, e guarde fora do repositório.
  - O HITL-030 libera agora a D2 **e** o F1-EXT-03 parte 2.
- O push continua não autorizado.

---

## Como usar: trilhas

**Regra de ouro:** só a **Trilha A** espera a cota do Groq. As outras andam hoje, em qualquer ordem entre si.

| Trilha | Sessão | Gasta cota do Groq? | Espera |
|---|---|---|---|
| **A** | Aceite do `p3`/`g4` e, se o gate passar, ligar a cadeia no `main.ts` | **sim, um dia inteiro** | a cota zerar |
| **G** | F1-EXT-04 parte 1: UI do painel (consentimento, estágios do stream, relatório só em texto, erros), sem chamar a API | não | nada |
| **D2** | S-2 real e F1-EXT-03 parte 2: anonimizar as fixtures, criar os extratores do LinkedIn e da Gupy, escolher o extrator pelo host e medir o §3 | não | **HITL-030** |

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`. A Trilha A entra entre duas sessões quaisquer, assim que a cota zerar.
2. **Nenhuma sessão G ou D2 muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`.** Se precisar mudar, a sessão para e registra no STATE.
3. **Nenhuma sessão G ou D2 chama o Groq real.**
4. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts` para protocolo e fluxo.
5. **A D2 mexe no extrator:** a regra de descarte é uma só (ADR-023 D4). Qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação. A captura do Service Worker (ADR-024) é reaproveitada: a `platform` do `CapturedJob` ganha `linkedin` e `gupy`.
6. **O texto da vaga não vai ao painel** (ADR-024 D4). A G renderiza só o que vem do contrato público, revalidado.
7. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/`, e a §9 ganha uma linha.
8. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

**Sugestão de ordem:** a G agora. A Trilha A entra quando a cota zerar, e a D2 quando o HITL-030 fechar.

---

## Prompts

### Trilha A: aceite do `p3`/`g4` (só com a cota do Groq zerada)
```text
Equipe, sigam em ciclo estrito. Trilha A do next-step: aceite do p3/g4 (spike-metrics §2.8, ADR-020 §8.4).
1. [ORCHESTRATOR]: leiam STATE.md, spike-metrics §2.7 e §2.8 e ADR-020 §8. Confirmem pnpm, Node, o branch spike/s1-extraction e que os HEADs do p3 e do g4 (61474d0 e 90867d9) e os 6 commits da B2 (4220bee a 797c04b) estão no histórico. Confirmem com o humano que a cota do Groq zerou antes de qualquer chamada.
2. [QA_EVALS]: S1_MODE=plan (sem rede) e um smoke de 1 chamada por provedor. Depois, S1_MODE=run S1_BUDGETS=6000 S1_GROQ_VARIANT=nao_estrito, com saída em out/s1-results.p3-g4.jsonl, e S1_MODE=report.
3. [QA_EVALS] + [APPSEC]: julguem pelo gate (precisão de stack ≥ 0,85, recall ≥ 0,80, JSON válido ≥ 98% no Groq, +400 tokens sobre o p1, gate de segurança do gd2, regressões do previousComparisons e contador do g4). Revisem o T4 à mão e confiram que as linhas gravadas não têm texto de vaga, canário nem saída bruta.
4. [SCRIBE]: spike-metrics §2.8, ADR-020 §8.6, STATE e SESSION-LOG. Se o gate passar, o próximo passo é ligar a cadeia no main.ts com o adapter do Groq (pronto na B2): o smoke de 1 chamada pelo adapter real, a forma da GROQ_API_KEY conferida com a chave real sem exibi-la (ADR-022 D8) e a reserva de 3.000 tokens do ADR-022 D7.2 recalibrada com o p95 medido. Se falhar, abram um HITL com as opções. Reescrevam o next-step mantendo as trilhas que faltam.
```

### Trilha G: F1-EXT-04 parte 1 (UI do painel, sem API)
```text
Equipe, sigam em ciclo estrito. Trilha G do next-step: F1-EXT-04 parte 1 (BACKLOG), a UI do Side Panel sem chamar a API.
1. [ORCHESTRATOR]: leiam STATE.md, ADR-024 (D4 e D5), ADR-001 §5.0 (passos 5 a 7) e §5.8, o contratos-zod (AnalysisStreamEvent, AnalysisReport, ApiError) e apps/extension/src (sidepanel/, messaging/, capture/). Confirmem o commit da Trilha F, os testes de unidade e o test:e2e verdes, e se o @trampo/ui-kit já tem algo utilizável.
2. [ARCHITECT] + [APPSEC]: desenhem as telas:
   - o consentimento antes da 1ª transmissão (passo 7, Limited Use), guardado em storage.session ou decidido com o humano se precisar persistir;
   - o estado da captura e o "colar o texto" (já existem, a reorganizar);
   - os estágios do stream;
   - o relatório só em texto, sem nenhum link;
   - os erros acionáveis por ApiErrorCode;
   - o botão "Reanalisar com IA" desabilitado até a ligação com a API.
   Tudo o que chega pela porta é revalidado com o contrato. O texto da vaga nunca vai ao painel (ADR-024 D4). Proibido innerHTML (SR-03). Decidam como testar o React (jsdom/testing-library só se já estiver no catálogo; senão, E2E no Edge com eventos de stream injetados pelo Service Worker de teste ou por fixture).
3. [DEV] + [QA_EVALS]: implementem com testes (unidade com 100% no que for lógica e E2E no build de produção). Usem eventos de stream e relatórios de fixture do contrato, inclusive os hostis (HTML, URL e texto longo). Rodem a mutação no código novo. Nenhum fetch novo: a CSP de produção continua com connect-src 'none' sem TRAMPO_API_ORIGIN.
4. [SCRIBE]: ADR (emenda ao ADR-024 ou ADR novo), STATE, SESSION-LOG e commit local. Reescrevam o next-step mantendo as trilhas.
```

### Trilha D2: S-2 real e F1-EXT-03 parte 2 (só depois do HITL-030)
```text
Equipe, sigam em ciclo estrito. Trilha D2 do next-step: S-2 com páginas reais (HITL-030 fechado) e F1-EXT-03 parte 2.
1. [ORCHESTRATOR]: leiam STATE.md, ADR-023, ADR-024, o runbook fixtures-dom e o HITL-030. Confirmem com o humano a pasta das páginas brutas e o modo de salvamento. Nenhum arquivo bruto entra no git.
2. [APPSEC] + [DEV]: anonimizem pelo runbook §2 (por script, no scratchpad), gravem as fixtures no formato do §3 e rodem a varredura do §4 inteira antes de qualquer git add.
3. [DEV] + [QA_EVALS]: extratores do LinkedIn e da Gupy (raiz por plataforma, reusando as regras de descarte do ADR-023 D4), extrator genérico também medido nas páginas reais, taxa de sucesso, estabilidade dos seletores e plano de monitoramento. No Service Worker (ADR-024), escolham o extrator pelo host da aba, com fallback para o genérico, e ampliem a platform do CapturedJob. Calibrem o maxNodes de 50.000 com as páginas reais. Mantenham 100% de cobertura e rodem a mutação.
4. [SCRIBE]: spike-metrics §3.3, ADR-023, ADR-024, STATE, SESSION-LOG e commits locais (as fixtures num commit próprio, com a contagem de marcadores na mensagem). Reescrevam o next-step mantendo as trilhas.
```
