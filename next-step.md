# Próximo passo: Trilha D2b (extratores do LinkedIn e da Gupy), numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt da D2b abaixo. Nenhuma trilha espera o humano agora.

## O que acabou de ser entregue (2026-10-30)

### Trilha D2a: fixtures reais anonimizadas (S-2, parte 1)
- **Commits `994d782`** (só as fixtures, com a contagem de marcadores) **e `f7eac1f`** (bancada), locais e sem push. Nenhum extrator, prompt ou guard mudou.
- **Fixtures:** 21 páginas (7 LinkedIn, 7 Gupy, 7 GeekHunter) em `apps/extension/test/browser/fixtures/`.
  - Cada uma tem o `.html` e o `.json` do runbook §3, este com dois campos novos: `cssDaPlataforma` e `raizDaPlataforma`.
  - São 6 `.css`, deduplicados por plataforma.
- **Anonimização** por script Python (`-I`) no scratchpad. Os brutos não entraram no git.
  - Marcadores: `[PESSOA]` 2, `[EMPRESA]` 8 e `[URL]` 5.
  - Varredura do §4 com 0 ocorrências. O gitleaks não está na estação; o job `secrets` do CI confere no push.
- **Achados** (runbook fixtures-dom §6):
  - **A vaga do LinkedIn fica fora do `main`.** As páginas são a busca em dois painéis: o `main` é a lista de cerca de 60 vagas, e a vaga aberta é a irmã `.details-pane__content`. O `ge1` acerta 0 de 3 trechos nas 7.
  - **O LinkedIn veio sem o CSS da plataforma.** O arquivo não tinha extensão `.css` e foi apagado na limpeza do `_files`. Essas páginas medem os seletores, mas não o descarte. O runbook ganhou a correção para a próxima coleta.
  - **Gupy e GeekHunter:** 14/14 com 3 de 3 trechos e nenhum proibido, só com o `ge1`.
  - **Tamanho:** a maior página tem 1.901 nós (o `maxNodes` é 50.000), e a extração leva de 7 a 39 ms.
  - **Pessoas:** nenhum cartão de recrutador; 1 nome numa citação dentro da descrição e 3 empresas com nome de pessoa na lista do LinkedIn.
- **Prova:** `test:browser` 74/74 (52 sintéticos e 22 reais), com a cobertura de 100% mantida. Lint, typecheck, depcruise e turbo 19/19 em série.
- **`[APPSEC]`:** sem veto.
- **Atualizados:** runbook fixtures-dom (emenda ao §2 e §6 novo), spike-metrics §3.3, STATE e SESSION-LOG.

### Antes (ainda valendo)
- **Trilha L1** (`adb392d`): cadeia Groq → Workers AI → determinístico ligada no `main.ts`.
  - Pendência do próximo prompt (`p4`): "`null` quando a vaga não declara experiência" em `yearsExperienceMin` (spike-metrics §2.11).
- **Trilhas A3/A4** (`cc81b9d`, `56f79cb`): efeito da stack na nota e ruído do Groq.
- **Trilhas F e G** (`3ec75a5`, `d15ee9b`): captura no Service Worker e UI do Side Panel, ainda sem enviar à API.

### Pendências do humano
- Nenhuma bloqueia trilha.
- **Opcional:** salvar de novo de 2 a 3 vagas do LinkedIn mantendo o CSS sem extensão (runbook §6). Isso só serve para medir o "ver mais" fechado.
- O push continua não autorizado, e já são vários commits locais no `spike/s1-extraction`. Quando quiser, autorize o push e o PR.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **D2b** | S-2 real, parte 2 (F1-EXT-03 parte 2): extratores do LinkedIn e da Gupy, o genérico medido nas três plataformas, a escolha do extrator pelo host no Service Worker, o `maxNodes` calibrado e o §3.3 do spike-metrics | não | nada (D2a concluída) |
| **W1** | Calibrar o `rpd` da Workers AI pelos neurônios medidos (74 de média, 101 de p95 → 99 publicado e 84 efetivo; emenda ao ADR-020 D9, com teste da fórmula) | não | nada (sem pressa, do lado seguro) |

**O que vem depois:**
- **D2b concluída:** os extratores reais ficam prontos.
- **O envio à API (F1-EXT-04 parte 2)** depende só do S-3/F1-EXT-05 (autenticação da extensão). Ele vira trilha quando o S-3 for planejado.
- **GeekHunter:** a D2b só mede o extrator genérico nas 7 páginas. Um extrator próprio da GeekHunter só entra com um HITL novo, que a D2b abre se a medida justificar.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`.
2. **Nenhuma sessão muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`** sem um HITL mandar. O próximo prompt (`p4`) carrega a linha do `null` de `yearsExperienceMin` e passa pelo aceite completo (§8.1 por efeito, §8.3 com ruído).
3. **Nenhuma trilha chama provedor.** A D2a e a D2b não sobem a API. Para testar a API à mão, lembre que ela agora gasta cota do Groq.
4. **O avaliador do S-1 tem a equivalência de nome** (`stackKey` no `score.ts`). Ninguém muda a regra sem refazer o relatório de todas as versões e o `s1-effect.json`.
5. **O critério de stack é o efeito na nota** (golden-dataset-spec §8.1), e o **§8.3 tem o ruído**. Cada aceite novo de prompt ou guard roda o `S1_MODE=effect` e, se cair mais de 2 pp, o `S1_MODE=noise`. Hoje este último está preso ao `p3`/`g4`; uma versão nova ajusta a trava na mesma tarefa.
6. **A cadeia de produção passa pelo `composeProductionApp`.** Provedor novo ou troca de modelo exige o gate do golden dataset antes (T28), e o teste do `main.ts` confere que ele não recebe ganchos de teste.
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts` para protocolo e fluxo.
8. **As fixtures reais já estão no git** (`994d782`). Qualquer fixture nova ou alterada passa de novo pelo runbook fixtures-dom §2 a §4 (script no scratchpad, varredura antes do `git add`, commit próprio). Nenhum arquivo bruto entra no git, e o `.json` diz se a página serve para medir o descarte (`cssDaPlataforma`).
9. **A D2b mexe no extrator:**
   - a regra de descarte é uma só (ADR-023 D4), e qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação;
   - a captura do Service Worker (ADR-024) é reaproveitada: a `platform` do `CapturedJob` ganha `linkedin` e `gupy`;
   - o texto da vaga não vai ao painel (ADR-024 D4), link é proibido por lint, e erro sai do catálogo pelo `code` (ADR-025).
10. **O envio à API (F1-EXT-04 parte 2) ainda não é trilha.** Quando for, o Service Worker só envia com `consent.isGranted()`, e um teste prova isso.
11. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/`, e a §9 ganha uma linha.
12. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

**Sugestão de ordem:** a D2b. A W1 entra quando sobrar uma sessão curta.

---

## Prompts

### Trilha D2b: extratores reais (S-2 real, parte 2, e F1-EXT-03 parte 2)
```text
Equipe, sigam em ciclo estrito. Trilha D2b do next-step: extratores do LinkedIn e da Gupy sobre as fixtures reais da D2a (F1-EXT-03 parte 2).
1. [ORCHESTRATOR]: leiam STATE.md, ADR-023, ADR-024, ADR-025, o runbook fixtures-dom (§6, achados da D2a) e o spike-metrics §3.3. As fixtures estão commitadas (994d782) e passaram na varredura; a medição inicial do ge1 está no test/browser/real-fixtures.browser.test.ts.
2. [ARCHITECT] + [APPSEC]: desenho dos extratores por plataforma (raiz por plataforma, reusando as regras de descarte do ADR-023 D4; no LinkedIn a vaga é irmã do main, em .details-pane__content, e o ge1 hoje pega a lista de vagas), da escolha pelo host da aba no Service Worker com fallback para o genérico, e da platform do CapturedJob ampliada. Sem host_permissions novos (activeTab + scripting sob clique).
3. [DEV] + [QA_EVALS]:
   - extratores do LinkedIn e da Gupy, com teste contra as fixtures reais (trechosObrigatorios e trechosProibidos do .json viram gate; descarte só onde cssDaPlataforma é true);
   - o genérico medido nas três plataformas (inclusive a GeekHunter): taxa de sucesso, estabilidade dos seletores e plano de monitoramento;
   - o maxNodes de 50.000 calibrado com as páginas reais;
   - 100% de cobertura mantida, a mutação rodada e o test:browser inteiro.
4. [SCRIBE]: spike-metrics §3.3, ADR-023, ADR-024, STATE, SESSION-LOG e commits locais. Se a GeekHunter justificar um extrator próprio, abram um HITL. Reescrevam o next-step mantendo as trilhas.
```

### Trilha W1: `rpd` da Workers AI pelos neurônios medidos (sem pressa)
```text
Equipe, sigam em ciclo estrito. Trilha W1 do next-step: recalibrar o rpd da Workers AI (emenda ao ADR-020 D9).
1. [ORCHESTRATOR]: leiam STATE.md, ADR-020 D9 e §9, ADR-014 D6 e spike-metrics §2.8 (neurônios: 74 de média, 101 de p95).
2. [ARCHITECT] + [APPSEC]: a fórmula passa a usar o p95 medido (floor(10.000 ÷ 101) = 99 publicado, 84 efetivo), com a medida no código como no GROQ_TOKEN_MEASUREMENT; confiram que o breaker global (400/dia) e o TPD do Groq continuam mandando.
3. [DEV] + [QA_EVALS]: limit-policy.ts e testes (fórmula com medidas sintéticas, 100%, mutação, turbo em série). Nenhuma chamada a provedor.
4. [SCRIBE]: ADR-020 (emenda ao D9), STATE, SESSION-LOG e commit local. Reescrevam o next-step mantendo as trilhas.
```
