# Próximo passo: uma trilha sem cota e uma que espera a cota do Groq

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie **um** dos prompts abaixo.

## O que acabou de ser entregue (2026-10-28)

### Trilha A2: avaliador do S-1 com equivalência de nome e §8.3 pareado (spike-metrics §2.8.1)
- **Commit `b37638c`**, local e sem push. Mudaram só o avaliador e o relatório do spike (`evals/spikes/s1-extraction`). Nenhuma chamada a provedor e nenhuma versão de prompt ou guard.
- **Equivalência de nome** (HITL-031 3A), nos dois lados e em todas as versões gravadas:
  - o prefixo de fornecedor sai se sobrarem 4 ou mais caracteres que não formem um nome genérico;
  - AWS e Amazon contam como o mesmo fornecedor;
  - a versão no fim (major de 1 ou 2 dígitos) e o sufixo de implantação saem.
  
  A auditoria das fusões corrigiu a 1ª versão da regra, que juntava "AWS CLI" com "Azure CLI" no `gupy-06` e cortava "ISO 27001".
- **Groq `p3`, precisão de stack: 0,706 → 0,742.** O gate é 0,85, e quem decide é a A3.
- **§8.3 pareado** (HITL-031 2A): cada versão é comparada com a anterior, só nos casos com fatos nas duas, e o relatório traz os ids dos casos que trocaram.
  - No Groq `p3` × `p2` (80 casos), `yearsExperienceMin` (−3,8 pp) e o recall de `benefits` (−3,4 pp) ficam `provisorio_sem_ruido`;
  - o `contractTypes` sai da lista;
  - a amostra da A4 tem **27 casos** (`regressionChangedCases` no `out/s1-metrics.json`), e não 26.
- **Prova:** `S1_MODE=plan` com 5 testes (gabarito a 100%, pares fictícios, nenhum gabarito perde termo e nenhum termo do `gd1` no vocabulário além dos fornecedores). Typecheck, lint e `pnpm test` do `@trampo/evals` passam com 100%.
- **`[APPSEC]`:** sem veto. O relatório passa no `assertClean`, e o anterior ficou em `out/s1-metrics.pre-a2.json`.
- **Atualizados:** spike-metrics §2.8.1, golden-dataset-spec §8.1 e §8.3, STATE e SESSION-LOG.

### Antes (ainda valendo)
- **Trilha A** (2026-10-27): aceite do `p3`/`g4` (spike-metrics §2.8). O gate do Groq reprovou na precisão de stack, e o HITL-031 fechou com 1A, 2A e 3A.
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

**Regra de ouro:** só a **A4** gasta cota do Groq. A A3 roda a qualquer hora, e a D2 espera só o HITL-030.

| Trilha | Sessão | Gasta cota do Groq? | Espera |
|---|---|---|---|
| **A3** | Efeito da stack na nota (1A): `ScoringEngine` real nos 83 casos, com a stack do gabarito e a do `p3`, nas 8 personas do S-4; gate de até 5% dos pares mudando de faixa | não | nada |
| **A4** | Ruído do Groq (2A): o `p3` repetido uma vez nos 27 casos do `regressionChangedCases` (~70K tokens), e o veredito da regressão do §8.3 | **sim, ~1/3 do dia** | a cota zerar (A2 feita) |
| **D2** | S-2 real e F1-EXT-03 parte 2: anonimizar as fixtures, criar os extratores do LinkedIn e da Gupy, escolher o extrator pelo host e medir o §3 | não | **HITL-030** |

**O que vem depois:**
- **A3 e A4 aprovadas:** a ligação da cadeia no `main.ts` vira a próxima trilha (adapter do Groq → Workers AI → determinístico).
- **A3 reprovada** (mais de 5% dos pares mudando de faixa): a próxima trilha é o desenho do `p4` + `g5`, com autoclassificação do tipo de cada termo de stack (HITL-031 1B), e o aceite gasta um dia de TPD.
- **A4 reprovada:** um HITL novo com as opções.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`. A A4 entra entre duas sessões quaisquer, assim que a cota zerar.
2. **Nenhuma sessão muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`.** Se precisar mudar, a sessão para e registra no STATE.
3. **A A3 e a D2 não chamam provedor nenhum** (nem o Groq nem a Workers AI). A A4 chama só o Groq.
4. **O avaliador do S-1 agora tem a equivalência de nome** (`stackKey` no `score.ts`). A A3 usa a mesma chave para comparar a stack do gabarito com a do `p3`, e ninguém muda a regra sem refazer o relatório de todas as versões.
5. **A A3 não muda o motor:**
   - usa o `ScoringEngine` real com a `ScoringPolicy` `se1`, como estão;
   - isola a stack (os demais fatos vêm do gabarito);
   - o pior caso é reportado, mas fica fora do gate;
   - a saída tem só ids, enums e números, sem termo do perfil nem texto de vaga.
6. **A A4 grava num arquivo próprio,** sem sobrescrever o `s1-results.p3-g4.jsonl`, e segue o `[APPSEC]` do §2.8: sem texto de vaga, canário nem saída bruta. O ruído entra no campo `noise` do `previousComparisons`, que hoje está `pendente_A4`.
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts` para protocolo e fluxo.
8. **A D2 mexe no extrator:**
   - a regra de descarte é uma só (ADR-023 D4), e qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação;
   - a captura do Service Worker (ADR-024) é reaproveitada: a `platform` do `CapturedJob` ganha `linkedin` e `gupy`;
   - o texto da vaga não vai ao painel (ADR-024 D4), link é proibido por lint, e erro sai do catálogo pelo `code` (ADR-025).
9. **O envio à API (F1-EXT-04 parte 2) ainda não é trilha.** Ele depende da cadeia ligada e do S-3/F1-EXT-05 (autenticação). Quando for, o Service Worker só envia com `consent.isGranted()`, e um teste prova isso.
10. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/`, e a §9 ganha uma linha.
11. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

**Sugestão de ordem:** a A3 agora, sem cota. A A4 entra quando a cota do Groq zerar. A D2 entra quando o HITL-030 fechar.

---

## Prompts

### Trilha A3: efeito da stack na nota (sem cota)
```text
Equipe, sigam em ciclo estrito. Trilha A3 do next-step: efeito da stack na nota (HITL-031 1A).
1. [ORCHESTRATOR]: leiam STATE.md, spike-metrics §2.8, §2.8.1 e §5.4, o HITL-031, o ADR-002 §4.2.1 e as personas do S-4 (evals/spikes/s4-layer1/routing.ts). Nenhuma chamada a provedor.
2. [ARCHITECT] + [QA_EVALS]: script de spike sem rede.
   - Roda o ScoringEngine real (se1) nos 83 casos com os fatos do gabarito e com os mesmos fatos trocando só as duas listas de stack pelas do p3/g4 (out/s1-results.p3-g4.jsonl, Groq nao_estrito).
   - Usa as 8 personas do S-4, mapeadas para UserCriteria.
   - Conta os pares (caso × persona) com a faixa do veredito diferente e os deal-breakers falsos.
   - Reporta à parte, fora do gate, o pior caso: uma persona que marca os termos que mais aparecem como falso positivo (pela stackKey do avaliador, com a equivalência de nome).
   - Gate (HITL-031 1A): até 5% dos pares mudando de faixa nas personas do S-4.
3. [APPSEC]: a saída tem só ids, enums e números, sem termo do perfil nem texto de vaga. O motor e a política não mudam.
4. [SCRIBE]: spike-metrics §2.9, golden-dataset-spec §8.1 (se passar, o gate de precisão de stack vira o critério de efeito, com registro), STATE, SESSION-LOG e commit local. Se a A3 e a A4 passarem, a próxima trilha liga a cadeia no main.ts. Se a A3 falhar, a próxima é o desenho do p4 + g5. Reescrevam o next-step mantendo as trilhas.
```

### Trilha A4: ruído do Groq e veredito da regressão (só com a cota zerada)
```text
Equipe, sigam em ciclo estrito. Trilha A4 do next-step: ruído do Groq e veredito da regressão do §8.3 (HITL-031 2A).
1. [ORCHESTRATOR]: leiam STATE.md, spike-metrics §2.8 e §2.8.1, golden-dataset-spec §8.3 e o HITL-031. A A2 está feita (b37638c). Confirmem com o humano que a cota do Groq zerou (a última rodada terminou às 01:51 UTC de 2026-10-28) antes de qualquer chamada.
2. [QA_EVALS]:
   - S1_MODE=plan (sem rede). Depois, o p3/g4 repetido uma vez, só no Groq nao_estrito, nos 27 casos do regressionChangedCases do previousComparisons p3-g4 × p2-g3 (out/s1-metrics.json; ~70K tokens), num arquivo próprio que não sobrescreve o s1-results.p3-g4.jsonl.
   - Meçam a taxa de troca p3 × p3 em yearsExperienceMin e no recall de benefits, que é o ruído, gravem no campo noise do relatório e apliquem o §8.3 emendado: regressão só acima de 2 pp e do ruído.
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
