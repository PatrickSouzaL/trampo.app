# Próximo passo: trilhas paralelas enquanto a cota do Groq não zera

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie **um** dos prompts abaixo.

## O que acabou de ser entregue (2026-10-27)

### Trilha E: DOC-01, contratos-zod sincronizado (só o cofre)
- **O que estava velho:** o `contratos-zod` do cofre estava parado na M3. Depois dela, 4 commits mudaram o pacote:
  - `8cbeedc`: ARS, `pressao_excessiva` e veredito de 5 faixas;
  - `45fbe2f`: `summary` e `meta.reportCatalogVersion`;
  - `a703ed3`: prefixo `@cf/` no `model`;
  - `1cbf825`: teto de 12.288 bytes dos critérios e `CRITERIA_BODY_MAX_BYTES`.
- **O que foi feito:**
  - a §4 foi regerada por script a partir de `packages/contracts/src/`, com 8 de 8 arquivos idênticos byte a byte;
  - a §9 nova traz o histórico desses commits;
  - a §6 ganhou as invariantes 21 a 25, conferidas contra os testes;
  - a §5 agora descreve o Groq `nao_estrito`, a Cloudflare e o schema relaxado, que não tem `salario_omitido`;
  - a §8 registra a regra do `schemaVersion` antes da primeira publicação.
- **Prova:** o pacote segue com 91 testes e 100% de cobertura.
- **Nenhum código mudou.** Nenhuma versão de prompt ou guard mudou, e nada chamou a rede.
- **Atualizados:** BACKLOG (DOC-01 ✅), STATE e SESSION-LOG.

### Antes (ainda valendo)
- **Extrator genérico `ge1`** (Trilha D, `9b867b7`, ADR-023): pronto e provado no `test:browser`, com 52/52, 100% e 97 mutantes mortos. **Ainda não está ligado no Service Worker.**
- **Adapter do Groq** (B2, `4220bee` a `797c04b`): pronto, sem ligar no `main.ts`.
- **`g4` (`90867d9`) e `p3` (`61474d0`):** locais. O aceite dos dois espera a cota do Groq (Trilha A).

### Pendências do humano
- **HITL-030 (opcional, sem pressa):** de 3 a 5 vagas do LinkedIn e de 3 a 5 da Gupy, em janela anônima, **sem login**, salvas com Ctrl+S → "Página da Web, completa". Na pasta `_files`, apague tudo que não for `.css`, e guarde fora do repositório. Se já salvou como "somente HTML", os arquivos servem para os seletores, mas não para medir o descarte.
- O push continua não autorizado.

---

## Como usar: trilhas

**Regra de ouro:** só a **Trilha A** espera a cota do Groq. As outras andam hoje, em qualquer ordem entre si.

| Trilha | Sessão | Gasta cota do Groq? | Espera |
|---|---|---|---|
| **A** | Aceite do `p3`/`g4` e, se o gate passar, ligar a cadeia no `main.ts` | **sim, um dia inteiro** | a cota zerar |
| **F** | F1-EXT-03 parte 1: ligar o extrator genérico no Service Worker e o fallback "colar o texto" | não | nada |
| **D2** | S-2 real: anonimizar as fixtures, extratores do LinkedIn e da Gupy e a medição do §3 | não | **HITL-030** |

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`. A Trilha A entra entre duas sessões quaisquer, assim que a cota zerar.
2. **Nenhuma sessão F ou D2 muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`.** Se precisar mudar, ela para e registra no STATE.
3. **Nenhuma sessão F ou D2 chama o Groq real.**
4. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts` para protocolo e fluxo.
5. **F e D2 mexem no extrator:** a regra de descarte é uma só (ADR-023 D4). Qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação.
6. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/`, e a §9 ganha uma linha.
7. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

**Sugestão de ordem:** a F agora. A Trilha A entra quando a cota zerar, e a D2 quando o HITL-030 fechar.

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

### Trilha F: F1-EXT-03 parte 1 (extrator genérico no Service Worker)
```text
Equipe, sigam em ciclo estrito. Trilha F do next-step: F1-EXT-03 parte 1 (BACKLOG), só o extrator genérico.
1. [ORCHESTRATOR]: leiam STATE.md, ADR-023 (§2 e §4), ADR-001 §5.0 passos 1 a 5 e o código de apps/extension/src (background.ts, messaging/). Confirmem o commit 9b867b7 e o test:browser verde.
2. [ARCHITECT] + [APPSEC]: desenhem a ligação. O Service Worker chama scripting.executeScript({ func: extractGenericJobText, args: [limites] }) no frame principal e no mundo ISOLATED. Ele valida o resultado (forma e tamanho, com Zod), remove os caracteres de controle e os surrogates órfãos, trunca em JOB_TEXT_MAX_CHARS por code point e guarda a última extração em storage.session. O fallback "colar o texto" vale para texto_insuficiente, para erro e para a falta de concessão do activeTab. Nenhum texto de vaga vai para log. Provem a autocontenção no bundle de PRODUÇÃO (o extrator minificado roda no E2E do Edge sem referências externas).
3. [DEV] + [QA_EVALS]: implementem com testes de unidade e E2E (build de produção, página local com fixture adversarial, canário ausente no que o Service Worker guardou). Mantenham 100% de cobertura e rodem a mutação no código novo. O extrator não muda; se precisar mudar, o test:browser inteiro roda de novo. Se algum schema novo entrar em packages/contracts, atualizem o contratos-zod do cofre (§4 regerada do src e linha nova na §9).
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
