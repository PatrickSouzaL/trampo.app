# Próximo passo: a L1 espera o HITL-032, e a D2 espera o HITL-030

> **Nenhuma trilha roda sem o humano agora.** A L1 precisa da sua resposta ao HITL-032, e a D2 precisa do HITL-030. Quando uma delas estiver liberada, abra uma sessão nova do terminal e envie o prompt dela.

## O que acabou de ser entregue (2026-10-29)

### Trilha A4: ruído do Groq e veredito da regressão (spike-metrics §2.10, HITL-031 2A). Reprovada pela regra
- **Commit `56f79cb`**, local e sem push. Só o spike do S-1 mudou:
  - o modo `S1_MODE=noise`;
  - o ruído e o veredito no `report.ts`;
  - o arquivo próprio `out/s1-noise.p3-g4.jsonl`, fora do agregado.

  O prompt, o guard, o motor e a política ficaram como estavam.
- **Rodada:** o `p3` repetido no Groq `nao_estrito` em 6k, nos 27 casos da amostra mais os 4 de stack vazia. Foram 31 chamadas, todas `ok` e aceitas pelo guard, com 0 canário e **79.232 tokens**.
- **Método:** o ruído é medido na unidade da queda. É a métrica pareada com a repetição no lugar do original. Um campo que cai mais de 2 pp vira `regressao` se a queda passar do ruído, e `ruido` se não passar.
- **`yearsExperienceMin`: `regressao`**, com queda de 3,8 pp e ruído 0.
  - Nos 3 casos, o `p3` dá `0` onde o gabarito e o `p2` dão `null`, nas duas rodadas, então o erro é sistemático.
  - O `ScoringEngine` não lê esse campo. O efeito fica no `analysis-report` ("0 anos" em vez de "não informado").
- **Recall de `benefits`: `regressao` na margem.** A queda é de 3,4 pp, contra um ruído de 2,6 pp. Com a repetição no lugar do original, a queda contra o `p2` cai para 0,8 pp.
- **Stack vazia confirmada:** as 4 vagas da A3 voltaram sem stack de novo. Fica registrada como achado de recall, sem mudar o prompt, e o efeito já está dentro dos 2,11% da A3.
- **Prova:**
  - sem o arquivo de ruído, o relatório sai igual ao anterior (a cópia está em `out/s1-metrics.pre-a4.json`);
  - `S1_MODE=plan`, typecheck, lint e `pnpm test` do `@trampo/evals` (38 testes) passam.
- **`[APPSEC]`:** sem veto. As linhas novas não têm texto de vaga, canário nem saída bruta, e o relatório passa no `assertClean`.
- **Atualizados:** spike-metrics §2.10, golden-dataset-spec §8.3 (emenda do ruído), HITL-031 (nota), HITL-032 (novo), STATE, SESSION-LOG e README do spike.

### Antes (ainda valendo)
- **Trilha A3** (`cc81b9d`): o efeito da stack na nota foi aprovado, com 14 de 664 pares mudando de faixa (2,11%, gate 5%). O gate de precisão de stack virou o critério de efeito.
- **Trilha A2** (`b37638c`): o avaliador ganhou a equivalência de nome e o §8.3 pareado.
- **Trilhas F e G** (`3ec75a5`, `d15ee9b`): a captura no Service Worker e a UI do Side Panel, sem API.
- **Adapter do Groq** (B2, `4220bee` a `797c04b`): pronto, mas não ligado no `main.ts`.
- **`p3` (`61474d0`) e `g4` (`90867d9`):** são as versões que estão no código.

### Pendências do humano
- **HITL-032 (bloqueia a L1):** decidir o veredito da A4. Responda com "HITL-032: 1A, 2A" ou com as letras que escolher.
  - **A recomendação é 1A + 2A:**
    - aceitar o `0` no lugar de `null` como achado sem efeito na nota, e corrigir no próximo prompt que mudar por outro motivo;
    - tratar o recall de `benefits` como ruído;
    - ligar a cadeia com o `p3`/`g4`.
  - **As alternativas:**
    - 1B: um `p4` só com a linha do `null`, ao custo de um dia de cota;
    - 1C: o guard `g5` converte `0` em `null`, sem cota, mas apaga o `0` legítimo;
    - 2B: repetir o `p3` e o `p2` mais uma vez (~140K tokens);
    - 2C: tratar como regressão a corrigir no `p4`.
- **HITL-030 (opcional, sem pressa):** salvar de 3 a 5 vagas do LinkedIn e de 3 a 5 da Gupy (runbook fixtures-dom §1).
  - Use uma janela anônima, **sem login**, e salve com Ctrl+S → "Página da Web, completa".
  - Na pasta `_files`, apague tudo o que não for `.css`, e guarde fora do repositório.
  - O HITL-030 libera a D2.
- O push continua não autorizado.

---

## Como usar: trilhas

**Regra de ouro:** só a ligação da cadeia (L1) gasta cota do Groq, e é 1 chamada. A D2 não chama provedor nenhum. Se o HITL-032 sair com 1B ou 2B, nasce uma trilha de cota (o `p4` ou a repetição) antes da L1.

| Trilha | Sessão | Gasta cota do Groq? | Espera |
|---|---|---|---|
| **L1** | Ligar a cadeia no `main.ts`: adapter do Groq → Workers AI → determinístico, com o smoke de 1 chamada pelo adapter real e a reserva de 3.000 tokens do ADR-022 D7.2 recalibrada | 1 chamada | **HITL-032** com 1A (ou 1C) e 2A |
| **D2** | S-2 real e F1-EXT-03 parte 2: anonimizar as fixtures, criar os extratores do LinkedIn e da Gupy, escolher o extrator pelo host e medir o §3 | não | **HITL-030** |

**O que vem depois:**
- **HITL-032 com 1A + 2A:** a L1 roda. Depois dela, o envio à API (F1-EXT-04 parte 2) fica a um passo do S-3/F1-EXT-05.
- **HITL-032 com 1C:** antes da L1 entra uma trilha sem cota: o `g5` no guard, a emenda ao ADR-008 e o repasse das linhas gravadas pelo guard novo.
- **HITL-032 com 1B, 2B ou 2C:** antes da L1 entra uma trilha de cota (o aceite do `p4` ou a repetição), numa sessão com a cota zerada.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`.
2. **Nenhuma sessão muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`** sem o HITL-032 mandar. Se precisar mudar, a sessão para e registra no STATE.
3. **A D2 não chama provedor nenhum** (nem o Groq nem a Workers AI). A L1 faz só o smoke de 1 chamada.
4. **O avaliador do S-1 tem a equivalência de nome** (`stackKey` no `score.ts`), e o `S1_MODE=effect` usa a mesma chave no pior caso. Ninguém muda a regra sem refazer o relatório de todas as versões e o `s1-effect.json`.
5. **O critério de stack agora é o efeito na nota** (golden-dataset-spec §8.1): cada aceite novo de prompt ou guard roda o `S1_MODE=effect`. Mudar o motor, a política, as personas ou o limiar de 5% exige um HITL novo.
6. **O §8.3 agora tem o ruído** (golden-dataset-spec §8.3): cada aceite novo que cair mais de 2 pp num campo roda o `S1_MODE=noise` na amostra, num arquivo próprio. Hoje o modo está preso ao `p3`/`g4`; uma versão nova ajusta essa trava na mesma tarefa.
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts` para protocolo e fluxo.
8. **A D2 mexe no extrator:**
   - a regra de descarte é uma só (ADR-023 D4), e qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação;
   - a captura do Service Worker (ADR-024) é reaproveitada: a `platform` do `CapturedJob` ganha `linkedin` e `gupy`;
   - o texto da vaga não vai ao painel (ADR-024 D4), link é proibido por lint, e erro sai do catálogo pelo `code` (ADR-025).
9. **O envio à API (F1-EXT-04 parte 2) ainda não é trilha.** Ele depende da L1 e do S-3/F1-EXT-05 (autenticação). Quando for, o Service Worker só envia com `consent.isGranted()`, e um teste prova isso.
10. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/`, e a §9 ganha uma linha.
11. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

**Sugestão de ordem:** a L1 assim que o HITL-032 fechar com 1A + 2A. A D2 entra quando o HITL-030 fechar.

---

## Prompts

### Trilha L1: ligar a cadeia de LLM no `main.ts` (só depois do HITL-032)
```text
Equipe, sigam em ciclo estrito. Trilha L1 do next-step: ligar a cadeia de LLM no main.ts (F1-LLM-01 parte 2 e F1-LLM-02), com o p3/g4 aprovado pela A3 e pelo HITL-032.
1. [ORCHESTRATOR]: leiam STATE.md, HITL-032, ADR-009 (§5, teto de 3 s), ADR-020, ADR-022 (D7.2 e D8), ADR-017 §3.3 (composeApp) e spike-metrics §2.8, §2.9 e §2.10. Confirmem que o HITL-032 fechou com 1A (ou 1C já feito) e 2A; se não, parem. Confirmem com o humano que a GROQ_API_KEY e as credenciais da Workers AI estão no .env, sem exibi-las.
2. [ARCHITECT] + [APPSEC]: desenho da ligação no composeApp: Groq nao_estrito → Workers AI → determinístico, falha fechado no boot sem as chaves, forma da GROQ_API_KEY conferida com a chave real sem exibi-la (ADR-022 D8), e a reserva de 3.000 tokens do D7.2 recalibrada (entrada p95 2.509 + saída p50 331 = 2.840; total p95 2.939, máx. 3.683).
3. [DEV] + [QA_EVALS]: a ligação com testes (100% de cobertura, mutação, depcruise e turbo em série), e o smoke de 1 chamada pelo adapter real.
4. [SCRIBE]: ADRs emendados, o achado do yearsExperienceMin (0 no lugar de null) registrado como pendência do próximo prompt, STATE, SESSION-LOG e commit local. Reescrevam o next-step mantendo as trilhas.
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
