# Próximo passo: a A4 espera a cota do Groq, e a D2 espera o HITL-030

> **Nenhuma trilha roda sem o humano agora.** A A4 precisa da sua confirmação de que a cota do Groq zerou, e a D2 precisa do HITL-030. Quando uma delas estiver liberada, abra uma sessão nova do terminal e envie o prompt dela.

## O que acabou de ser entregue (2026-10-28)

### Trilha A3: efeito da stack na nota (spike-metrics §2.9, HITL-031 1A). Gate aprovado
- **Commit `cc81b9d`**, local e sem push. Só o spike do S-1 mudou (`effect.ts` e o modo `S1_MODE=effect`). Nenhuma chamada a provedor, e o motor, a política, o prompt e o guard ficaram como estavam.
- **Método:**
  - o `ScoringEngine` real (`se1`) nos 83 casos, com os fatos do gabarito;
  - depois, os mesmos fatos com só as duas listas de stack trocadas pelas do Groq `p3`/`g4`;
  - as 8 personas do S-4 viram `UserCriteria` validados pelo contrato.
- **Gate (até 5%): 14 de 664 pares mudam de faixa, 2,11%.** Contra as alternativas do gabarito, são 11. Há 2 deal-breakers falsos e 1 perdido.
- **Causa das 14 trocas:**
  - só 6 vêm de termo a mais;
  - as outras 8 vêm do recall: em 4 vagas, o Groq devolveu stack vazia onde o gabarito tem (`linkedin-03`, `linkedin-13`, `linkedin-19` e `99jobs-04`), e em uma faltou termo.
  - O que move a faixa é a fronteira entre stack vazia e não vazia.
- **Pior caso, fora do gate:** quem marca os 5 falsos positivos mais frequentes como deal-breaker vê 14 de 83 vagas caírem de faixa.
- **Consequência:** o gate de precisão de stack do golden-dataset-spec §8.1 virou o critério de efeito na nota, com registro. O recall e a lista certa continuam com gate.
- **Prova:**
  - o gabarito contra ele mesmo dá 0 troca, e um deal-breaker fictício plantado é detectado;
  - typecheck, lint e `pnpm test` do `@trampo/evals` passam com 100%.
- **`[APPSEC]`:** sem veto. O relatório (`out/s1-effect.json`) passa no `assertClean` e numa checagem nova de que nenhuma string é termo de stack.
- **Atualizados:** spike-metrics §2.9, golden-dataset-spec §8.1, HITL-031 (nota), STATE, SESSION-LOG e README do spike.

### Antes (ainda valendo)
- **Trilha A2** (`b37638c`): avaliador do S-1 com equivalência de nome e §8.3 pareado. A precisão de stack do Groq `p3` ficou em 0,742. `yearsExperienceMin` e o recall de `benefits` ficam `provisorio_sem_ruido` até a A4, com **27 casos** na amostra.
- **Trilhas F e G** (`3ec75a5`, `d15ee9b`): a captura no Service Worker e a UI do Side Panel, sem API.
- **Adapter do Groq** (B2, `4220bee` a `797c04b`): pronto, mas não ligado no `main.ts`.
- **`p3` (`61474d0`) e `g4` (`90867d9`):** commits locais, e são as versões no código.

### Pendências do humano
- **Confirmar a cota do Groq** antes da A4. Ela só zera depois de 2026-10-29 01:51 UTC (22:51 de Brasília em 2026-10-28), porque não sabemos se o TPD zera num horário fixo ou numa janela móvel.
- **HITL-030 (opcional, sem pressa):** salvar de 3 a 5 vagas do LinkedIn e de 3 a 5 da Gupy (runbook fixtures-dom §1).
  - Use uma janela anônima, **sem login**, e salve com Ctrl+S → "Página da Web, completa".
  - Na pasta `_files`, apague tudo o que não for `.css`, e guarde fora do repositório.
  - O HITL-030 libera a D2.
- O push continua não autorizado.

---

## Como usar: trilhas

**Regra de ouro:** só a **A4** gasta cota do Groq, e a ligação da cadeia (L1) gasta 1 chamada. A D2 espera só o HITL-030.

| Trilha | Sessão | Gasta cota do Groq? | Espera |
|---|---|---|---|
| **A4** | Ruído do Groq (HITL-031 2A): o `p3` repetido uma vez nos 27 casos do `regressionChangedCases` (~70K tokens) e o veredito da regressão do §8.3. À parte, os 4 casos de stack vazia da A3 (~10K tokens) | **sim, ~40% do dia** | a cota zerar (A2 e A3 feitas) |
| **L1** | Ligar a cadeia no `main.ts`: adapter do Groq → Workers AI → determinístico, com o smoke de 1 chamada pelo adapter real e a reserva de 3.000 tokens do ADR-022 D7.2 recalibrada | 1 chamada | **a A4 aprovada** |
| **D2** | S-2 real e F1-EXT-03 parte 2: anonimizar as fixtures, criar os extratores do LinkedIn e da Gupy, escolher o extrator pelo host e medir o §3 | não | **HITL-030** |

**O que vem depois:**
- **A4 aprovada:** a L1 vira a próxima trilha, e depois dela o envio à API (F1-EXT-04 parte 2) fica a um passo do S-3/F1-EXT-05.
- **A4 reprovada:** um HITL novo com as opções.
- **Stack vazia confirmada na A4** (as 4 vagas de novo sem stack): registrar como achado de recall no spike-metrics, sem mudar prompt nesta trilha. O efeito já está dentro dos 2,11% da A3.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`. A A4 entra entre duas sessões quaisquer, assim que a cota zerar.
2. **Nenhuma sessão muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`.** Se precisar mudar, a sessão para e registra no STATE.
3. **A D2 não chama provedor nenhum** (nem o Groq nem a Workers AI). A A4 chama só o Groq. A L1 faz só o smoke de 1 chamada.
4. **O avaliador do S-1 tem a equivalência de nome** (`stackKey` no `score.ts`), e o `S1_MODE=effect` usa a mesma chave no pior caso. Ninguém muda a regra sem refazer o relatório de todas as versões e o `s1-effect.json`.
5. **O critério de stack agora é o efeito na nota** (golden-dataset-spec §8.1): cada aceite novo de prompt ou guard roda o `S1_MODE=effect`. Mudar o motor, a política, as personas ou o limiar de 5% exige um HITL novo.
6. **A A4 grava num arquivo próprio,** sem sobrescrever o `s1-results.p3-g4.jsonl`, e segue o `[APPSEC]` do §2.8: sem texto de vaga, canário nem saída bruta. O ruído entra no campo `noise` do `previousComparisons`, que hoje está `pendente_A4`. Os 4 casos de stack vazia não entram na conta do ruído do §8.3.
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts` para protocolo e fluxo.
8. **A D2 mexe no extrator:**
   - a regra de descarte é uma só (ADR-023 D4), e qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação;
   - a captura do Service Worker (ADR-024) é reaproveitada: a `platform` do `CapturedJob` ganha `linkedin` e `gupy`;
   - o texto da vaga não vai ao painel (ADR-024 D4), link é proibido por lint, e erro sai do catálogo pelo `code` (ADR-025).
9. **O envio à API (F1-EXT-04 parte 2) ainda não é trilha.** Ele depende da L1 e do S-3/F1-EXT-05 (autenticação). Quando for, o Service Worker só envia com `consent.isGranted()`, e um teste prova isso.
10. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/`, e a §9 ganha uma linha.
11. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

**Sugestão de ordem:** a A4 assim que a cota do Groq zerar, e a L1 logo depois, se ela passar. A D2 entra quando o HITL-030 fechar.

---

## Prompts

### Trilha A4: ruído do Groq e veredito da regressão (só com a cota zerada)
```text
Equipe, sigam em ciclo estrito. Trilha A4 do next-step: ruído do Groq e veredito da regressão do §8.3 (HITL-031 2A).
1. [ORCHESTRATOR]: leiam STATE.md, spike-metrics §2.8, §2.8.1 e §2.9, golden-dataset-spec §8.3 e o HITL-031. A A2 (b37638c) e a A3 (cc81b9d, aprovada) estão feitas. Confirmem com o humano que a cota do Groq zerou (a última rodada terminou às 01:51 UTC de 2026-10-28) antes de qualquer chamada.
2. [QA_EVALS]:
   - S1_MODE=plan (sem rede). Depois, o p3/g4 repetido uma vez, só no Groq nao_estrito, nos 27 casos do regressionChangedCases do previousComparisons p3-g4 × p2-g3 (out/s1-metrics.json; ~70K tokens), num arquivo próprio que não sobrescreve o s1-results.p3-g4.jsonl.
   - À parte, no mesmo arquivo, os 4 casos em que a A3 achou stack vazia (linkedin-03, linkedin-13, linkedin-19 e 99jobs-04; ~10K tokens). Eles não entram na conta do ruído do §8.3.
   - Meçam a taxa de troca p3 × p3 em yearsExperienceMin e no recall de benefits, que é o ruído, gravem no campo noise do relatório e apliquem o §8.3 emendado: regressão só acima de 2 pp e do ruído.
   - Registrem se a stack vazia se repete nas 4 vagas.
3. [QA_EVALS] + [APPSEC]: deem o veredito e confiram que as linhas novas não têm texto de vaga, canário nem saída bruta.
4. [SCRIBE]: spike-metrics, golden-dataset-spec §8.3 (emenda do ruído), STATE, SESSION-LOG e commit local.
   - Se a A4 passar, a próxima trilha é a L1 (ligar a cadeia no main.ts com o adapter do Groq).
   - Se a A4 falhar, abram um HITL com as opções.
   - Reescrevam o next-step mantendo as trilhas.
```

### Trilha L1: ligar a cadeia de LLM no `main.ts` (só depois da A4 aprovada)
```text
Equipe, sigam em ciclo estrito. Trilha L1 do next-step: ligar a cadeia de LLM no main.ts (F1-LLM-01 parte 2 e F1-LLM-02), com o p3/g4 aprovado pela A3 e pela A4.
1. [ORCHESTRATOR]: leiam STATE.md, ADR-009 (§5, teto de 3 s), ADR-020, ADR-022 (D7.2 e D8), ADR-017 §3.3 (composeApp) e spike-metrics §2.8 e §2.9. Confirmem com o humano que a GROQ_API_KEY e as credenciais da Workers AI estão no .env, sem exibi-las.
2. [ARCHITECT] + [APPSEC]: desenho da ligação no composeApp: Groq nao_estrito → Workers AI → determinístico, falha fechado no boot sem as chaves, forma da GROQ_API_KEY conferida com a chave real sem exibi-la (ADR-022 D8), e a reserva de 3.000 tokens do D7.2 recalibrada (entrada p95 2.509 + saída p50 331 = 2.840; total p95 2.939, máx. 3.683).
3. [DEV] + [QA_EVALS]: a ligação com testes (100% de cobertura, mutação, depcruise e turbo em série), e o smoke de 1 chamada pelo adapter real.
4. [SCRIBE]: ADRs emendados, STATE, SESSION-LOG e commit local. Reescrevam o next-step mantendo as trilhas.
```

### Trilha D2: S-2 real e F1-EXT-03 parte 2 (só depois do HITL-030)
```text
Equipe, sigam em ciclo estrito. Trilha D2 do next-step: S-2 com páginas reais (HITL-030 fechado) e F1-EXT-03 parte 2.
1. [ORCHESTRATOR]: leiam STATE.md, ADR-023, ADR-024, o runbook fixtures-dom e o HITL-030. Confirmem com o humano a pasta das páginas brutas e o modo de salvamento. Nenhum arquivo bruto entra no git.
2. [APPSEC] + [DEV]: anonimizem pelo runbook §2 (por script, no scratchpad), gravem as fixtures no formato do §3 e rodem a varredura do §4 inteira antes de qualquer git add.
3. [DEV] + [QA_EVALS]:
   - extratores do LinkedIn e da Gupy (raiz por plataforma, reusando as regras de descarte do ADR-023 D4);
   - o extrator genérico também medido nas páginas reais: taxa de sucesso, estabilidade dos seletores e plano de monitoramento;
   - no Service Worker (ADR-024), o extrator escolhido pelo host da aba, com fallback para o genérico, e a platform do CapturedJob ampliada;
   - o maxNodes de 50.000 calibrado com as páginas reais;
   - 100% de cobertura mantida e a mutação rodada.
4. [SCRIBE]: spike-metrics §3.3, ADR-023, ADR-024, STATE, SESSION-LOG e commits locais (as fixtures num commit próprio, com a contagem de marcadores na mensagem). Reescrevam o next-step mantendo as trilhas.
```
