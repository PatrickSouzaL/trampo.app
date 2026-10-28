# Próximo passo: duas trilhas sem cota e uma que espera a cota do Groq

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie **um** dos prompts abaixo.

## O que acabou de ser entregue (2026-10-27)

### Trilha A: aceite do S-1 com `p3`/`g4` (spike-metrics §2.8)
- **Sem código novo.** Mudaram só o cofre e este arquivo. As linhas ficam em `evals/spikes/s1-extraction/out/s1-results.p3-g4.jsonl`, que é ignorado pelo git.
- **Rodada:** 83 casos em 6k, com o Groq `nao_estrito` e a Workers AI, e 0 HTTP 429. O Groq gastou 199.712 tokens, a cota do dia inteira. A rodada terminou às 01:51 UTC de 2026-10-28.
- **Groq, o que passa:**
  - JSON válido em **100%** (o `g4` resolveu 4 sobreposições);
  - recall de stack em 0,858;
  - tokens a +323 sobre o `p1` (máx. +343, teto de +400);
  - p95 de 1,29 s;
  - gate de segurança do `gd2`.
- **Groq, o que falha: a precisão de stack, em 0,706** (gate 0,85).
- **Achados:**
  - **o `p3` quase não mudou o `gpt-oss-20b`:** pareado, a precisão foi de 0,700 para 0,720. Na Workers AI, a mesma linha funcionou (0,654 → 0,776);
  - **cerca de 15% dos falsos positivos são o mesmo produto com outro nome** ("AWS ECS" contra "Amazon ECS"). Com uma equivalência de nome, a precisão chega a 0,748;
  - **o §8.3 marcou 3 regressões.** A de `contractTypes` vem do denominador (80 casos contra 83). As de `yearsExperienceMin` (−3 casos) e do recall de `benefits` (−3,4 pp) são reais no pareado, mas estão em linhas do prompt iguais às do `p2`, e 26 casos trocaram nos dois sentidos;
  - **o motor usa a stack da vaga só por igualdade com as listas do usuário** (ADR-002 §4.2.1). Um termo a mais só pesa se o usuário o marcou.
- **HITL-031 fechado: 1A, 2A, 3A.**
  - 1A: medir o efeito da stack na nota, sem cota. Até 5% dos pares mudando de faixa troca o gate de precisão por esse critério;
  - 2A: regressão pareada, valendo só acima de 2 pp e do ruído medido do Groq;
  - 3A: equivalência de nome genérica no avaliador.
- **`[APPSEC]`:**
  - as 166 linhas não têm texto de vaga fora do `facts.title`, nem canário, nem saída bruta;
  - o SR-01 é imposto no script;
  - T4 real 0, pela revisão manual do `linkedin-14`.
- **Atualizados:** spike-metrics §2.8, ADR-020 §8.6, ADR-008 §6.6, HITL-QUEUE (031), STATE, BACKLOG e SESSION-LOG.

### Antes (ainda valendo)
- **Trilhas F e G** (`3ec75a5`, `d15ee9b`): a captura no Service Worker e a UI do Side Panel, sem API. O envio (F1-EXT-04 parte 2) espera a cadeia de LLM ligada e o S-3/F1-EXT-05.
- **Adapter do Groq** (B2, `4220bee` a `797c04b`): pronto, mas não ligado no `main.ts`.
- **`p3` (`61474d0`) e `g4` (`90867d9`):** commits locais, e são as versões no código.

### Pendências do humano
- **HITL-030 (opcional, sem pressa):** salvar de 3 a 5 vagas do LinkedIn e de 3 a 5 da Gupy (runbook fixtures-dom §1).
  - Use uma janela anônima, **sem login**, e salve com Ctrl+S → "Página da Web, completa".
  - Na pasta `_files`, apague tudo o que não for `.css`, e guarde fora do repositório.
  - O HITL-030 libera a D2.
- **Confirmar a cota do Groq** antes da A4. Ela só zera depois de 2026-10-29 01:51 UTC (22:51 de Brasília em 2026-10-28), porque não sabemos se o TPD zera num horário fixo ou numa janela móvel.
- O push continua não autorizado.

---

## Como usar: trilhas

**Regra de ouro:** só a **A4** gasta cota do Groq. A A2 e a A3 rodam a qualquer hora, e a D2 espera só o HITL-030.

| Trilha | Sessão | Gasta cota do Groq? | Espera |
|---|---|---|---|
| **A2** | Avaliador do S-1: equivalência de nome (HITL-031 3A) e regressão pareada (2A), com o relatório refeito para todas as versões | não | nada |
| **A3** | Efeito da stack na nota (1A): `ScoringEngine` real nos 83 casos, com a stack do gabarito e a do `p3`, nas 8 personas do S-4; gate de até 5% dos pares mudando de faixa | não | nada |
| **A4** | Ruído do Groq (2A): o `p3` repetido uma vez nos casos que trocaram (26, ~67K tokens), e o veredito da regressão do §8.3 | **sim, ~1/3 do dia** | a cota zerar **e** a A2 |
| **D2** | S-2 real e F1-EXT-03 parte 2: anonimizar as fixtures, criar os extratores do LinkedIn e da Gupy, escolher o extrator pelo host e medir o §3 | não | **HITL-030** |

**O que vem depois:**
- **A3 e A4 aprovadas:** a ligação da cadeia no `main.ts` vira a próxima trilha (adapter do Groq → Workers AI → determinístico).
- **A3 reprovada** (mais de 5% dos pares mudando de faixa): a próxima trilha é o desenho do `p4` + `g5`, com autoclassificação do tipo de cada termo de stack (HITL-031 1B), e o aceite gasta um dia de TPD.
- **A4 reprovada:** um HITL novo com as opções.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`. A A4 entra entre duas sessões quaisquer, assim que a cota zerar e a A2 estiver feita.
2. **Nenhuma sessão muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`.** Se precisar mudar, a sessão para e registra no STATE.
3. **A A2, a A3 e a D2 não chamam provedor nenhum** (nem o Groq nem a Workers AI). A A4 chama só o Groq.
4. **A A2 mexe só no avaliador e no relatório do spike** (`evals/spikes/s1-extraction`):
   - a equivalência vale nos dois lados e em todas as versões gravadas, e nenhum termo do `gd1` entra na regra;
   - o avaliador continua dando 100% ao gabarito;
   - o relatório anterior é guardado para mostrar o antes e o depois.
5. **A A3 não muda o motor:**
   - usa o `ScoringEngine` real com a `ScoringPolicy` `se1`, como estão;
   - isola a stack (os demais fatos vêm do gabarito);
   - o pior caso é reportado, mas fica fora do gate;
   - a saída tem só ids, enums e números, sem termo do perfil nem texto de vaga.
6. **A A4 grava num arquivo próprio,** sem sobrescrever o `s1-results.p3-g4.jsonl`, e segue o `[APPSEC]` do §2.8: sem texto de vaga, canário nem saída bruta.
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts` para protocolo e fluxo.
8. **A D2 mexe no extrator:**
   - a regra de descarte é uma só (ADR-023 D4), e qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação;
   - a captura do Service Worker (ADR-024) é reaproveitada: a `platform` do `CapturedJob` ganha `linkedin` e `gupy`;
   - o texto da vaga não vai ao painel (ADR-024 D4), link é proibido por lint, e erro sai do catálogo pelo `code` (ADR-025).
9. **O envio à API (F1-EXT-04 parte 2) ainda não é trilha.** Ele depende da cadeia ligada e do S-3/F1-EXT-05 (autenticação). Quando for, o Service Worker só envia com `consent.isGranted()`, e um teste prova isso.
10. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/`, e a §9 ganha uma linha.
11. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

**Sugestão de ordem:** a A2 e depois a A3, as duas sem cota. A A4 entra quando a cota do Groq zerar. A D2 entra quando o HITL-030 fechar.

---

## Prompts

### Trilha A2: avaliador do S-1 com equivalência de nome e regressão pareada (sem cota)
```text
Equipe, sigam em ciclo estrito. Trilha A2 do next-step: avaliador do S-1 com equivalência de nome e regressão pareada (HITL-031 3A e 2A).
1. [ORCHESTRATOR]: leiam STATE.md, spike-metrics §2.7 e §2.8, o HITL-031 e a golden-dataset-spec §8. Confirmem pnpm, Node, o branch spike/s1-extraction e que out/ tem os arquivos s1-results.p1-g2, p2-g3 e p3-g4. Nenhuma chamada a provedor.
2. [QA_EVALS] + [DEV]:
   - No score.ts, a equivalência de nome genérica do HITL-031 3A (prefixo de fornecedor AWS, Amazon, Microsoft, Google Cloud, Apache, Azure, SAP e Oracle; versão no fim; sufixo de implantação), nos dois lados e sem termo do gd1. O modo plan prova a regra e continua dando 100% ao gabarito.
   - No report.ts, o previousComparisons pareado (só os casos com fatos nas duas versões), com os ids dos casos que trocaram em cada campo e um campo de ruído vazio até a A4.
   - Guardem o s1-metrics.json anterior e refaçam o S1_MODE=report para todas as versões.
3. [APPSEC]: confiram que a regra não usa termo do gd1 e que o relatório continua sem texto de vaga nem canário.
4. [SCRIBE]: spike-metrics §2.8 (antes e depois), golden-dataset-spec §8.1 (nota da equivalência) e §8.3 (comparação pareada; o ruído entra na A4), STATE, SESSION-LOG e commit local. Reescrevam o next-step mantendo as trilhas.
```

### Trilha A3: efeito da stack na nota (sem cota)
```text
Equipe, sigam em ciclo estrito. Trilha A3 do next-step: efeito da stack na nota (HITL-031 1A).
1. [ORCHESTRATOR]: leiam STATE.md, spike-metrics §2.8 e §5.4, o HITL-031, o ADR-002 §4.2.1 e as personas do S-4 (evals/spikes/s4-layer1/routing.ts). Nenhuma chamada a provedor.
2. [ARCHITECT] + [QA_EVALS]: script de spike sem rede.
   - Roda o ScoringEngine real (se1) nos 83 casos com os fatos do gabarito e com os mesmos fatos trocando só as duas listas de stack pelas do p3/g4 (out/s1-results.p3-g4.jsonl, Groq nao_estrito).
   - Usa as 8 personas do S-4, mapeadas para UserCriteria.
   - Conta os pares (caso × persona) com a faixa do veredito diferente e os deal-breakers falsos.
   - Reporta à parte, fora do gate, o pior caso: uma persona que marca os termos que mais aparecem como falso positivo.
   - Gate (HITL-031 1A): até 5% dos pares mudando de faixa nas personas do S-4.
3. [APPSEC]: a saída tem só ids, enums e números, sem termo do perfil nem texto de vaga. O motor e a política não mudam.
4. [SCRIBE]: spike-metrics §2.9, golden-dataset-spec §8.1 (se passar, o gate de precisão de stack vira o critério de efeito, com registro), STATE, SESSION-LOG e commit local. Se a A3 e a A4 passarem, a próxima trilha liga a cadeia no main.ts. Se a A3 falhar, a próxima é o desenho do p4 + g5. Reescrevam o next-step mantendo as trilhas.
```

### Trilha A4: ruído do Groq e veredito da regressão (só com a cota zerada e a A2 feita)
```text
Equipe, sigam em ciclo estrito. Trilha A4 do next-step: ruído do Groq e veredito da regressão do §8.3 (HITL-031 2A).
1. [ORCHESTRATOR]: leiam STATE.md, spike-metrics §2.8 e o HITL-031. Confirmem que a A2 está feita (relatório pareado com os ids dos casos que trocaram) e confirmem com o humano que a cota do Groq zerou (a última rodada terminou às 01:51 UTC de 2026-10-28) antes de qualquer chamada.
2. [QA_EVALS]:
   - S1_MODE=plan (sem rede). Depois, o p3/g4 repetido uma vez, só no Groq nao_estrito, nos casos que trocaram em yearsExperienceMin ou benefits entre o p2 e o p3 (26 pela conta de 2026-10-27, ~67K tokens), num arquivo próprio que não sobrescreve o s1-results.p3-g4.jsonl.
   - Meçam a taxa de troca p3 × p3 nesses campos, que é o ruído, e apliquem o §8.3 emendado: regressão só acima de 2 pp e do ruído.
3. [QA_EVALS] + [APPSEC]: deem o veredito e confiram que as linhas novas não têm texto de vaga, canário nem saída bruta.
4. [SCRIBE]: spike-metrics, golden-dataset-spec §8.3 (emenda do ruído), STATE, SESSION-LOG e commit local.
   - Se a A3 e a A4 passarem, a próxima trilha liga a cadeia no main.ts com o adapter do Groq: o smoke de 1 chamada pelo adapter real, a forma da GROQ_API_KEY conferida com a chave real sem exibi-la (ADR-022 D8) e a reserva de 3.000 tokens do ADR-022 D7.2 recalibrada (spike-metrics §2.8: entrada p95 2.509 + saída p50 331 = 2.840; total p95 2.939, máx. 3.683).
   - Se a A4 falhar, abram um HITL com as opções.
   - Reescrevam o next-step mantendo as trilhas.
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
