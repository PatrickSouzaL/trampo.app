# Próximo passo: trilhas paralelas enquanto a cota do Groq não zera

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie **um** dos prompts abaixo.

## O que acabou de ser entregue (2026-10-27)

### Trilha G: F1-EXT-04 parte 1, a UI do Side Panel (ADR-025)
- **Commit:** `d15ee9b`, local, sem push.
- **Consentimento antes da 1ª transmissão:**
  - quem impõe é o Service Worker, e o painel só mostra o aviso;
  - o registro fica só em `storage.session`, com a versão do aviso (`aviso-1`). Se o texto do aviso mudar, a versão muda e o consentimento antigo cai;
  - dá para revogar;
  - o envio da parte 2 precisa consultar o `isGranted()`.
- **Painel:**
  - o estado vem de um redutor puro, e todo evento é revalidado com o contrato;
  - estágios ("Etapa N de 6") e relatório só em texto;
  - erros pelo `code`, com o texto do catálogo; o `message` do servidor não aparece;
  - "Analisar vaga" e "Reanalisar com IA" ficam desabilitados até a API.
- **Nenhum link:** um lint novo proíbe `<a>`, `img`, `iframe` e `href`/`src`/`action` em JSX. A prova negativa barrou 7 de 7.
- **Achado:** o E2E "de produção" usava o React de desenvolvimento, porque o vitest define `NODE_ENV=test`. O `global-setup` agora força `production`.
- **Provas:**
  - unidade: 140 testes, 100%;
  - E2E no build de produção: 32/32 em 3 rodadas, com 10 relatórios hostis (HTML, URL, e-mail, Unicode Tag, texto longo…) que derrubam a porta sem render;
  - mutação: 42 de 43, e o sobrevivente é equivalente;
  - `test:browser`: 52/52, e depcruise sem violações.
- **O que não mudou:** manifesto, CSP (`connect-src 'none'`), contratos, extrator, versões de prompt e guard. Nada chamou a rede.
- **Atualizados:** ADR-025 (novo), ADR-024 (nota), BACKLOG, STATE e SESSION-LOG.

### Trilha F: F1-EXT-03 parte 1 (`3ec75a5`, ADR-024)
- O extrator genérico está ligado no Service Worker, com o fallback "colar o texto". O painel nunca recebe o texto da vaga.

### Antes (ainda valendo)
- **Adapter do Groq** (B2, `4220bee` a `797c04b`): pronto, mas ainda não está ligado no `main.ts`.
- **`g4` (`90867d9`) e `p3` (`61474d0`):** estão só locais. O aceite dos dois espera a cota do Groq (Trilha A).
- **`contratos-zod` do cofre:** sincronizado com o `src/` (Trilha E). As trilhas F e G não mudaram contrato.

### Pendências do humano
- **HITL-030 (opcional, sem pressa):** salvar de 3 a 5 vagas do LinkedIn e de 3 a 5 da Gupy.
  - Use uma janela anônima, **sem login**, e salve com Ctrl+S → "Página da Web, completa".
  - Na pasta `_files`, apague tudo o que não for `.css`, e guarde fora do repositório.
  - O HITL-030 libera agora a D2 **e** o F1-EXT-03 parte 2.
- O push continua não autorizado.

---

## Como usar: trilhas

**Regra de ouro:** só a **Trilha A** espera a cota do Groq. A D2 espera só o HITL-030.

| Trilha | Sessão | Gasta cota do Groq? | Espera |
|---|---|---|---|
| **A** | Aceite do `p3`/`g4` e, se o gate passar, ligar a cadeia no `main.ts` | **sim, um dia inteiro** | a cota zerar |
| **D2** | S-2 real e F1-EXT-03 parte 2: anonimizar as fixtures, criar os extratores do LinkedIn e da Gupy, escolher o extrator pelo host e medir o §3 | não | **HITL-030** |

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`. A Trilha A entra entre duas sessões quaisquer, assim que a cota zerar.
2. **Nenhuma sessão D2 muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`.** Se precisar mudar, a sessão para e registra no STATE.
3. **Nenhuma sessão D2 chama o Groq real.**
4. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts` para protocolo e fluxo.
5. **A D2 mexe no extrator:** a regra de descarte é uma só (ADR-023 D4). Qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação. A captura do Service Worker (ADR-024) é reaproveitada: a `platform` do `CapturedJob` ganha `linkedin` e `gupy`.
6. **O texto da vaga não vai ao painel** (ADR-024 D4). O painel renderiza só o que vem do contrato público, revalidado (ADR-025). Link é proibido por lint, e erro sai do catálogo pelo `code`.
7. **O envio à API (F1-EXT-04 parte 2) ainda não é trilha:** depende da Trilha A e do S-3/F1-EXT-05 (autenticação). Quando for, o Service Worker só envia com `consent.isGranted()`, e um teste prova isso.
8. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/`, e a §9 ganha uma linha.
9. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

**Sugestão de ordem:** a Trilha A assim que a cota do Groq zerar. A D2 entra quando o HITL-030 fechar. Se as duas estiverem bloqueadas, as duas pendências são do humano: confirmar a cota ou salvar as páginas do HITL-030.

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

### Trilha D2: S-2 real e F1-EXT-03 parte 2 (só depois do HITL-030)
```text
Equipe, sigam em ciclo estrito. Trilha D2 do next-step: S-2 com páginas reais (HITL-030 fechado) e F1-EXT-03 parte 2.
1. [ORCHESTRATOR]: leiam STATE.md, ADR-023, ADR-024, o runbook fixtures-dom e o HITL-030. Confirmem com o humano a pasta das páginas brutas e o modo de salvamento. Nenhum arquivo bruto entra no git.
2. [APPSEC] + [DEV]: anonimizem pelo runbook §2 (por script, no scratchpad), gravem as fixtures no formato do §3 e rodem a varredura do §4 inteira antes de qualquer git add.
3. [DEV] + [QA_EVALS]: extratores do LinkedIn e da Gupy (raiz por plataforma, reusando as regras de descarte do ADR-023 D4), extrator genérico também medido nas páginas reais, taxa de sucesso, estabilidade dos seletores e plano de monitoramento. No Service Worker (ADR-024), escolham o extrator pelo host da aba, com fallback para o genérico, e ampliem a platform do CapturedJob. Calibrem o maxNodes de 50.000 com as páginas reais. Mantenham 100% de cobertura e rodem a mutação.
4. [SCRIBE]: spike-metrics §3.3, ADR-023, ADR-024, STATE, SESSION-LOG e commits locais (as fixtures num commit próprio, com a contagem de marcadores na mensagem). Reescrevam o next-step mantendo as trilhas.
```
