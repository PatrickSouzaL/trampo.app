# Próximo passo: trilhas paralelas enquanto a cota do Groq não zera

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie **um** dos prompts abaixo.

## O que acabou de ser entregue (2026-10-27)

### Trilha D: S-2, parte sintética (ADR-023), commit local `9b867b7`
- **Extrator genérico `ge1`** (`apps/extension/src/extraction/generic-extractor.ts`):
  - função autocontida para o `executeScript`, no mundo ISOLATED, que lê só o `data` de nós de texto;
  - descarte por técnica do T2, com 12 contadores;
  - cor normalizada por canvas (o `getComputedStyle` devolve `oklch`/`lab` sem converter);
  - invisíveis Unicode e Base64 preservados para o servidor contar;
  - lint de só-leitura em `src/extraction`;
  - **não está ligado no Service Worker.**
- **Prova:** `pnpm --filter @trampo/extension test:browser` (Edge real, fora do CI):
  - 23 fixtures sintéticas, cada uma com canário e controle visível;
  - 52/52 testes, com 100% de cobertura de bloco do V8;
  - mutação com 97 mutantes em 3 rodadas, sem sobrevivente;
  - turbo 19/19 em série e depcruise sem violações;
  - `[APPSEC]` sem veto.
- **Achados corrigidos antes do commit:**
  - o texto solto direto em `content-visibility:hidden` e em `<details>` fechado vazava;
  - `display:contents` apagava texto legítimo;
  - o transbordo para a esquerda ou para cima de um rolável não era cortado.
- **HITL-030 aberto** (não bloqueia nada abaixo): salvar as páginas reais pelo runbook `fixtures-dom` do cofre.
- Nenhuma versão de prompt ou guard mudou, e nada chamou a rede.

### Antes (ainda valendo)
- Adapter do Groq pronto (B2, `4220bee` a `797c04b`), sem ligar no `main.ts`.
- `g4` (`90867d9`) e `p3` (`61474d0`), locais. O aceite dos dois espera a cota do Groq (Trilha A).

### Pendências do humano
- **HITL-030 (opcional, sem pressa):** de 3 a 5 vagas do LinkedIn e de 3 a 5 da Gupy, em janela anônima, **sem login**, salvas com Ctrl+S → "Página da Web, completa". Na pasta `_files`, apague tudo que não for `.css`, e guarde fora do repositório. Se já salvou como "somente HTML", os arquivos servem para os seletores, mas não para medir o descarte.
- O push continua não autorizado.

---

## Como usar: trilhas

**Regra de ouro:** só a **Trilha A** espera a cota do Groq. As outras andam hoje, em qualquer ordem entre si.

| Trilha | Sessão | Gasta cota do Groq? | Espera |
|---|---|---|---|
| **A** | Aceite do `p3`/`g4` e, se o gate passar, ligar a cadeia no `main.ts` | **sim, um dia inteiro** | a cota zerar |
| **E** | DOC-01 (sincronizar o `contratos-zod` do cofre com o código) | não | nada |
| **F** | F1-EXT-03 parte 1: ligar o extrator genérico no Service Worker e o fallback "colar o texto" | não | nada |
| **D2** | S-2 real: anonimizar as fixtures, extratores do LinkedIn e da Gupy e a medição do §3 | não | **HITL-030** |

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`. A Trilha A entra entre duas sessões quaisquer, assim que a cota zerar.
2. **Nenhuma sessão E, F ou D2 muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`.** Se precisar mudar, ela para e registra no STATE.
3. **Nenhuma sessão E, F ou D2 chama o Groq real.**
4. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts` para protocolo e fluxo.
5. **F e D2 mexem no extrator:** a regra de descarte é uma só (ADR-023 D4). Qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação.
6. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

**Sugestão de ordem:** E → F. A Trilha A entra quando a cota zerar, e a D2 quando o HITL-030 fechar.

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

### Trilha E: DOC-01
```text
Equipe, sigam em ciclo estrito. Trilha E do next-step: DOC-01 (BACKLOG). [SCRIBE] + [ARCHITECT]: sincronizem o contratos-zod do cofre com packages/contracts. A fonte da verdade é o código: veredito de 5 faixas, ARS, pressao_excessiva, summary, reportCatalogVersion, o prefixo @cf/ do model e o teto de 12.288 bytes dos critérios. Nenhum código muda. Atualizem STATE e SESSION-LOG e reescrevam o next-step mantendo as trilhas.
```

### Trilha F: F1-EXT-03 parte 1 (extrator genérico no Service Worker)
```text
Equipe, sigam em ciclo estrito. Trilha F do next-step: F1-EXT-03 parte 1 (BACKLOG), só o extrator genérico.
1. [ORCHESTRATOR]: leiam STATE.md, ADR-023 (§2 e §4), ADR-001 §5.0 passos 1 a 5 e o código de apps/extension/src (background.ts, messaging/). Confirmem o commit 9b867b7 e o test:browser verde.
2. [ARCHITECT] + [APPSEC]: desenhem a ligação. O Service Worker chama scripting.executeScript({ func: extractGenericJobText, args: [limites] }) no frame principal e no mundo ISOLATED. Ele valida o resultado (forma e tamanho, com Zod), remove os caracteres de controle e os surrogates órfãos, trunca em JOB_TEXT_MAX_CHARS por code point e guarda a última extração em storage.session. O fallback "colar o texto" vale para texto_insuficiente, para erro e para a falta de concessão do activeTab. Nenhum texto de vaga vai para log. Provem a autocontenção no bundle de PRODUÇÃO (o extrator minificado roda no E2E do Edge sem referências externas).
3. [DEV] + [QA_EVALS]: implementem com testes de unidade e E2E (build de produção, página local com fixture adversarial, canário ausente no que o Service Worker guardou). Mantenham 100% de cobertura e rodem a mutação no código novo. O extrator não muda; se precisar mudar, o test:browser inteiro roda de novo.
4. [SCRIBE]: ADR (emenda ou ADR novo), STATE, SESSION-LOG e commit local. Reescrevam o next-step mantendo as trilhas.
```

### Trilha D2: S-2 real (só depois do HITL-030)
```text
Equipe, sigam em ciclo estrito. Trilha D2 do next-step: S-2 com páginas reais (HITL-030 fechado).
1. [ORCHESTRATOR]: leiam STATE.md, ADR-023, o runbook fixtures-dom e o HITL-030. Confirmem com o humano a pasta das páginas brutas e o modo de salvamento. Nenhum arquivo bruto entra no git.
2. [APPSEC] + [DEV]: anonimizem pelo runbook §2 (por script, no scratchpad), gravem as fixtures no formato do §3 e rodem a varredura do §4 inteira antes de qualquer git add.
3. [DEV] + [QA_EVALS]: extratores do LinkedIn e da Gupy (raiz por plataforma, reusando as regras de descarte do ADR-023 D4), extrator genérico também medido nas páginas reais, taxa de sucesso, estabilidade dos seletores e plano de monitoramento. Mantenham 100% de cobertura e rodem a mutação.
4. [SCRIBE]: spike-metrics §3.3, ADR-023, STATE, SESSION-LOG e commits locais (as fixtures num commit próprio, com a contagem de marcadores na mensagem). Reescrevam o next-step mantendo as trilhas.
```
