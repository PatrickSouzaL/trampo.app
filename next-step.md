# Próximo passo: Trilha D2a (fixtures reais anonimizadas), numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt da D2a abaixo. Nenhuma trilha espera o humano agora.

## O que acabou de ser entregue (2026-10-30)

### HITLs fechados
- **HITL-032: 1A, 2A.**
  - O `0` no lugar de `null` em `yearsExperienceMin` fica como achado sem efeito na nota.
  - A queda do recall de `benefits` é ruído.
  - A cadeia foi ligada com o `p3`/`g4`.
- **HITL-030:** 7 páginas do LinkedIn, 7 da Gupy e 7 da GeekHunter em `..\trampo-fixtures-brutas`, no modo "completa" ou "somente HTML", conferido arquivo a arquivo na D2a. A GeekHunter veio a mais.

### Trilha L1: cadeia de LLM ligada no `main.ts` (F1-LLM-01 parte 2 e F1-LLM-02; ADR-022 §6)
- **Commit `adb392d`**, local e sem push. O prompt e o guard continuam `p3`/`g4`.
- **Ligação:** `apps/api/src/composition/production-app.ts`, com o `composeProductionApp`, que o `main.ts` chama.
  - Monta um adapter por provedor da `LLM_PROVIDER_CHAIN`, na ordem dela: Groq → Workers AI → determinístico.
  - **Falha fechado no boot** sem a cadeia, com Ollama ou Gemini, ou sem a credencial de um provedor dela. As mensagens citam só o nome da variável.
  - A credencial de provedor fora da cadeia não é lida. Se o modelo da Workers AI estiver vazio, vale o medido no S-1.
  - O `composeApp` continua genérico (os testes de borda sobem sem LLM).
- **Reserva do Groq (ADR-022 D7.2):** continua em 3.000 tokens, mas agora vem da medida no código: 2.509 + 331 = 2.840, arredondado no passo de 500. Ela cobre o total p95 de 2.939.
- **Smoke de 1 chamada real** pelo adapter de produção, com uma vaga sintética:
  - `ok` em 884 ms, com 1.880 tokens;
  - aceito pelo `g4`, com os fatos certos;
  - a forma da `GROQ_API_KEY` e das credenciais da Workers AI foi conferida com os valores reais, sem exibi-los.
- **Prova:** 2.901 testes na API com 100%, mutação 13/13, depcruise sem violação e turbo 21/21 em série. Testes de ponta a ponta com os dois provedores simulados:
  - Groq ok;
  - 429 → Workers AI;
  - os dois recusam → determinístico.
- **`[APPSEC]`:** sem veto. Riscos residuais:
  - a variável do modelo da Workers AI troca o fallback sem gate (herdado do ADR-020 D8);
  - o `rpd` da Workers AI continua conservador;
  - o "0 anos" pode aparecer no relatório (HITL-032 1A).
- **Pendência do próximo prompt:** acrescentar "`null` quando a vaga não declara experiência" na linha de `yearsExperienceMin` (spike-metrics §2.11).
- **Atualizados:**
  - ADR-022 §6, ADR-020 §9 e ADR-017 §3.4;
  - spike-metrics §2.11;
  - BACKLOG (F1-LLM-01 e F1-LLM-02) e HITL-QUEUE (030 e 032);
  - STATE e SESSION-LOG.

### Antes (ainda valendo)
- **Trilha A4** (`56f79cb`): ruído do Groq medido; decidida pelo HITL-032.
- **Trilha A3** (`cc81b9d`): efeito da stack na nota aprovado (2,11%, gate 5%).
- **Trilhas F e G** (`3ec75a5`, `d15ee9b`): captura no Service Worker e UI do Side Panel, ainda sem enviar à API.

### Pendências do humano
- Nenhuma bloqueia trilha.
- O push continua não autorizado. Já são vários commits locais no `spike/s1-extraction`. Quando quiser, autorize o push e o PR.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM. A API agora chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **D2a** | S-2 real, parte 1: anonimizar as 21 páginas pelo runbook fixtures-dom §2 (script no scratchpad), gravar as fixtures no formato do §3 e rodar a varredura do §4 antes do commit próprio delas | não | nada |
| **D2b** | S-2 real, parte 2 (F1-EXT-03 parte 2): extratores do LinkedIn e da Gupy, o genérico medido nas três plataformas, a escolha do extrator pelo host no Service Worker, o `maxNodes` calibrado e o §3.3 do spike-metrics | não | D2a |
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
8. **A D2a mexe com páginas reais:**
   - nenhum arquivo bruto entra no git;
   - a anonimização é por script, no scratchpad (runbook fixtures-dom §2);
   - a varredura do §4 inteira roda antes de qualquer `git add`;
   - as fixtures vão num commit próprio, com a contagem de marcadores na mensagem;
   - o modo de salvamento é conferido página a página. As salvas como "somente HTML" servem para os seletores, mas não para o descarte (runbook §1).
9. **A D2b mexe no extrator:**
   - a regra de descarte é uma só (ADR-023 D4), e qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação;
   - a captura do Service Worker (ADR-024) é reaproveitada: a `platform` do `CapturedJob` ganha `linkedin` e `gupy`;
   - o texto da vaga não vai ao painel (ADR-024 D4), link é proibido por lint, e erro sai do catálogo pelo `code` (ADR-025).
10. **O envio à API (F1-EXT-04 parte 2) ainda não é trilha.** Quando for, o Service Worker só envia com `consent.isGranted()`, e um teste prova isso.
11. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/`, e a §9 ganha uma linha.
12. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

**Sugestão de ordem:** D2a, depois D2b. A W1 entra quando sobrar uma sessão curta.

---

## Prompts

### Trilha D2a: fixtures reais anonimizadas (S-2 real, parte 1)
```text
Equipe, sigam em ciclo estrito. Trilha D2a do next-step: fixtures reais do S-2 (HITL-030 fechado: 7 LinkedIn, 7 Gupy e 7 GeekHunter em ..\trampo-fixtures-brutas).
1. [ORCHESTRATOR]: leiam STATE.md, HITL-030, o runbook fixtures-dom (§1 a §4), ADR-023 e ADR-024. Inventariem as 21 páginas sem abrir o conteúdo no chat: modo de salvamento (completa com _files só de .css, ou somente HTML), tamanho e contagem de nós. Nenhum arquivo bruto entra no git, e nenhum trecho de página bruta vai para o chat ou para o cofre.
2. [APPSEC] + [DEV]: anonimizem pelo runbook §2, por script no scratchpad (scripts num diretório separado dos dados, Python com -I), gravem as fixtures no formato do §3 e rodem a varredura do §4 inteira. Qualquer marcador remanescente bloqueia o commit.
3. [QA_EVALS]: confiram que as fixtures carregam no harness do test:browser e que o extrator genérico atual roda nelas sem erro (só a medição inicial; os extratores novos são da D2b).
4. [SCRIBE]: runbook fixtures-dom (achados), spike-metrics §3.3 (inventário), STATE, SESSION-LOG e o commit próprio das fixtures, com a contagem de marcadores na mensagem. Reescrevam o next-step mantendo as trilhas.
```

### Trilha D2b: extratores reais (S-2 real, parte 2, e F1-EXT-03 parte 2; só depois da D2a)
```text
Equipe, sigam em ciclo estrito. Trilha D2b do next-step: extratores do LinkedIn e da Gupy sobre as fixtures reais da D2a (F1-EXT-03 parte 2).
1. [ORCHESTRATOR]: leiam STATE.md, ADR-023, ADR-024, ADR-025, o runbook fixtures-dom e o spike-metrics §3. Confirmem que as fixtures da D2a estão commitadas e passaram na varredura.
2. [ARCHITECT] + [APPSEC]: desenho dos extratores por plataforma (raiz por plataforma, reusando as regras de descarte do ADR-023 D4), da escolha pelo host da aba no Service Worker com fallback para o genérico, e da platform do CapturedJob ampliada. Sem host_permissions novos (activeTab + scripting sob clique).
3. [DEV] + [QA_EVALS]:
   - extratores do LinkedIn e da Gupy, com teste contra as fixtures reais;
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
