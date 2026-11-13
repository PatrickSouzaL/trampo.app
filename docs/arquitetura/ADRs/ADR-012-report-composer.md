---
tipo: adr
id: ADR-012
titulo: "ReportComposer (E8): catálogo de templates pt-BR por ScoreReasonCode e por faixa, ordem dos itens e versão do catálogo"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]) dentro do ADR-001 §5.8 e do ADR-002 §3.4, §4.3 e §5.3 (já aprovados no HITL-016). Muda o contrato do relatório em dois campos (D2); nada publicado, schemaVersion continua 1."
data: 2026-10-21
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-DOM-03 (apps/api/src/domain/report) e AnalysisReportSchema (packages/contracts)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-002-scoring-engine](ADR-002-scoring-engine.md)", "[ADR-011-deterministic-signals-and-fact-resolver](ADR-011-deterministic-signals-and-fact-resolver.md)", "[contratos-zod](../contratos-zod.md)", "[threat-model](../threat-model.md)", "*BACKLOG §F1-DOM-03*"]
---

# ADR-012: `ReportComposer` (E8)

## 1. Contexto

- O ADR-001 §5.8 define o E8: até 3 pontos fortes, até 3 red flags e `missingInfo`, com textos de um **catálogo de templates pt-BR** que nunca ecoa valor do perfil (SR-11). O `AnalyzeJob` valida a saída com `AnalysisReportSchema.parse` e trata falha como bug (500).
- O ADR-002 §4.3 fecha o `ScoreReasonCode` (20 códigos: os 6 `DimensionOutcome` e 14 específicos; `salario_moeda_diferente` saiu no §9.3), e o §3.4 pede **um template por faixa** que explique a classificação.
- O ADR-002 §5.3 restringe: os templates **só interpolam rótulos de enum dos fatos da vaga**. "Você exige remoto" ecoa o perfil e é proibido; a forma permitida é "fora do que você aceita".

## 2. Decisões

### D1. O composer não recebe os critérios do usuário
```ts
// apps/api/src/domain/report/report-composer.ts (domínio puro, sem zod)
new ReportComposer(catalog = DEFAULT_REPORT_CATALOG)   // RangeError se o catálogo for incoerente (D6)
  .compose({
    envelope: { analysisId, requestId, createdAt, platform, decisionPath, extractorVersion, provider, durationMs },
    resolution: { facts, provenance, effectiveConfidence },   // do FactResolver (ADR-011)
    warnings: readonly AnalysisWarning[],                     // do resolver, da borda e do AnalyzeJob
    score: ScoreResult,                                       // do ScoringEngine (ADR-002)
  }): AnalysisReport
```
- **SR-11 por construção:** sem `UserCriteria` na assinatura, o composer não tem como ecoar pretensão, cidades, termos de stack ou observações. Tudo o que ele sabe do usuário já passou pelo motor e virou enum e inteiro (invariante 9 do ADR-002). O lint do diretório proíbe importar `UserCriteria` (D7).
- `analysisId`, `requestId`, `createdAt` e `durationMs` vêm da aplicação: o domínio não tem relógio nem aleatoriedade.
- `warnings` chega pronto (o resolver dá `possivel_prompt_injection`, `informacao_contraditoria` e `baixa_confianca_extracao`; a borda dá `texto_truncado`; o `AnalyzeJob` dá `analise_degradada` e `decisao_sem_ia`). O composer só remove duplicatas e ordena pelo enum.
- O composer não valida a própria saída com zod (o domínio não roda zod). Quem valida é o `AnalyzeJob` (ADR-001 §5.8). Os testes provam que a saída passa sempre.

### D2. Duas mudanças de contrato (primeiro commit, antes do composer)
1. `AnalysisReportSchema.summary: safeText(200)`: o texto da faixa (ADR-002 §3.4). Sem ele, o "template por faixa" não teria onde ir.
2. `meta.reportCatalogVersion: VersionTagSchema`: a versão do catálogo (`rc1`). Mudar texto não muda a nota, então a versão do catálogo é separada do `engineVersion`.
- O `schemaVersion` continua 1: nada foi publicado (mesma regra do ADR-002 §8.1). Depois da primeira publicação, mudança assim exige versão nova.
- **Correção junto:** o comentário do `ScoreBreakdownEntrySchema` trazia o exemplo proibido ("você exige remoto") e o teste do contrato usava "como você exige". Os dois passam para a forma permitida.

### D3. Catálogo `rc1`: só texto fixo e rótulos de enum
O catálogo é um objeto de dados (`ReportCatalog`), sem *placeholder*: o texto é montado por **concatenação** de pedaços fixos, então não há substituição de string.

| Tabela | Chaves | Uso |
|---|---|---|
| `dimensions` | 9 `ScoreDimension` | prefixo de toda linha ("Stack", "Modelo de trabalho", "Sinais de alerta") |
| `outcomes` | 6 `DimensionOutcome` | texto dos 6 códigos gerais ("dentro do que você procura.", "sem informação na vaga.") |
| `reasons` | 14 códigos específicos | frase complementar ("A vaga exige uma tecnologia que você evita.") |
| `verdicts` | 5 `Verdict` | template por faixa (D-S9) |
| `dealBreakerVerdict`, `emptyBaseNote` | — | `foge` por deal-breaker; nota que partiu da base neutra |
| `workModels`, `seniorityLevels`, `contractTypes`, `currencies` | enums dos fatos | rótulos dos fatos da vaga |
| `redFlags`, `redFlagEffects` | 7 sinais e 3 efeitos | itens de red flag |
| `scoreLabel`, `inFavor`, `against`, `eliminatedBy`, `jobValues`, `jobCurrency` | — | conectores |

- **Um template por `ScoreReasonCode`:** `outcomes` (6) e `reasons` (14) cobrem os 20 códigos. O tipo `Record` obriga a completude na compilação, e o construtor confere de novo em runtime.
- Textos (`rc1`): ver `report-catalog.ts`. Nenhum menciona valor do perfil. As frases sobre o usuário são genéricas: "fora do que você aceita", "uma tecnologia que você evita", "que você marcou como eliminatório".

### D4. Composição de cada texto
- **Linha** (item): `<dimensão>: <texto do outcome>` e, se a `reason` for específica, ` <texto da reason>`.
- **`explanation`** do breakdown: a linha e um **detalhe** com os rótulos dos fatos da vaga, só onde o fato é enum:
  - `modelo_trabalho`, `senioridade` e `contrato`: ` Na vaga: <rótulos na ordem do enum>.` quando a lista não está vazia e a dimensão não foi ignorada;
  - `salario` com `salario_convertido`: ` Moeda da vaga: <rótulo da moeda>.`
  - Nenhum outro fato é interpolado: **nem título, nem cidade, nem país, nem tags de stack, nem números de salário.** São strings ou números vindos do LLM, não rótulos de enum.
- **Red flag de sinal:** `<Sinais de alerta>: <rótulo do sinal>, <rótulo do efeito>.`
- **`summary`:** `<template da faixa> Nota <n>.`, depois `emptyBaseNote` se `neutralBase > 0`, e depois:
  - com deal-breaker: ` Eliminada por: <até 3 dimensões>.` (o template é o `dealBreakerVerdict`);
  - sem deal-breaker: ` A favor: <até 2>.` e ` Contra: <até 2>.`, cada parte só se não estiver vazia.
  - Assim, um `foge` sem deal-breaker ("a nota ficou muito baixa") é diferente de um `foge` por deal-breaker, como pede o ADR-002 §3.4.

### D5. Seleção e ordem (determinística)
- **`strengths` (máx. 3):** linhas com `outcome = atende` e `points > 0` (entraram na base). Ordem: `points` decrescente e, no empate, a ordem do enum. `red_flags` nunca tem ponto positivo e fica de fora.
- **`redFlags` (máx. 3)**, nesta prioridade (ADR-001 §5.8):
  1. linhas com deal-breaker, exceto `red_flags` (o sinal entra no passo 2), na ordem do enum;
  2. sinais com efeito `eliminatoria`, na ordem do enum `RedFlagSignal`;
  3. must-have violado: `outcome = nao_atende` com `importance` `obrigatorio` ou `eliminatorio`, ou `reason` `conflito_eliminatorio` ou `senioridade_rebaixamento`, sem deal-breaker e fora de `red_flags`, por `points` crescente e, no empate, a ordem do enum;
  4. sinais com efeito `penalidade` e depois `alerta`.
- **`missingInfo` (máx. 9):** uma linha por dimensão com `outcome` `nao_informado` ou `conflito`, na ordem do enum (único por dimensão, como o contrato exige). Inclui `red_flags` sem LLM: o usuário vê que os sinais não foram avaliados.
- **`breakdown`:** as 9 linhas do motor, na ordem do enum, com `explanation`. A soma dos `points` mais o `neutralBase` reproduz a nota (fora o piso 0 e o teto do deal-breaker, que o `summary` explica).
- **"Contra" do `summary`:** as dimensões únicas da lista completa de candidatos a red flag (sem o corte de 3) e, depois, as linhas `nao_atende` e `atende_parcialmente` restantes por `points` crescente. Ficam as 2 primeiras.

### D6. O catálogo é validado no construtor (`RangeError` com a lista das regras que caíram)
- `version` no formato do `VersionTagSchema`, verificado por laço de caracteres (sem regex).
- Toda chave de todo enum presente; todo texto não vazio, sem espaço nas pontas, sem espaço duplo e só com caracteres de uma **lista fechada**: letras ASCII, as letras acentuadas do português, dígitos, espaço e `. , ; : ( ) -`. Ficam de fora `/`, `@`, `[`, `]`, `<` e `>`, então os padrões de URL que dependem deles (`://`, `dominio.tld/`, e-mail, link markdown) e a marcação HTML são **impossíveis por construção**. Invisíveis e controles também.
- **Limites no pior caso**, calculados a partir do próprio catálogo: linha ≤ 140 (`ReportItem.text`), `explanation` ≤ 160 e `summary` ≤ 200. O pior caso usa os maiores rótulos e as listas no máximo do contrato (3 modelos, 3 senioridades e 5 contratos). Vale para **qualquer** `ScoreResult` bem tipado, não só para os que o motor produz.
  - O `summary` aproveita duas exclusões garantidas pelo código do composer: "A favor" e a nota da base neutra nunca aparecem juntas, e "A favor" e "Contra" nunca repetem dimensão (as duas listas juntas usam os 4 maiores rótulos **distintos**).
  - **Os limites são exatos:** para cada conta, um teste cresce um rótulo até a regra cair e confere que, no limiar, o pior texto montado tem exatamente 140, 160 ou 200 code points. Só o detalhe do salário tem folga conhecida (a conta usa a maior `reason`, mas a moeda só aparece com `salario_convertido`).
- Os padrões de URL que sobram (`www.`, domínio nu com TLD de risco, `mailto:` e afins) são provados pelos testes com o `safeText` real sobre **todo texto alcançável** (D8). Na execução, o `AnalyzeJob` revalida.

### D7. Lint do diretório `domain/report`
- O mesmo bloco do motor (ADR-002 §9.4): sem busca em string, sem regex, sem `RegExp` e sem `console`.
- **Proibido ler texto livre dos fatos e do perfil:** acesso a `title`, `city`, `countryIso2`, `stackRequired`, `stackNiceToHave`, `notes`, `minimum`, `acceptedCities`, `acceptedUfs`, `mustHave`, `niceToHave` e `dealBreakers`, e import de `UserCriteria`. O composer repassa `facts` inteiro para o relatório, mas não lê nenhum desses campos.
- Fixture negativa permanente em `test/domain/report-lint.test.ts`.

### D8. Testes (guardrails do F1-DOM-03)
- 100% de linhas e ramos.
- **Propriedades** com 1.000 execuções sobre os arbitrários do motor, passando pelo `ScoringEngine` real: a saída passa **sempre** no `AnalysisReportSchema`; determinismo e entrada congelada; os itens seguem as regras do D5.
- **SR-11 por canário:** critérios com canários em `minimum`, `acceptedCities`, termos de stack e `notes`, que nunca aparecem no `JSON.stringify` do relatório. **Independência de texto livre:** trocar título, cidade, país e tags de stack por canários muda só o subobjeto `facts`, e nenhum texto.
- **Exaustivo:** toda combinação dimensão × outcome × reason (9 × 6 × 20), com o maior detalhe possível, e todo `summary` de pior caso passam no `safeText` real e nos limites. Os limites do D6 são provados exatos no limiar.
- Mutação manual (script fora do repositório), como no F1-DOM-02.

## 3. Auditoria `[APPSEC]` (antes do código, sem veto)

1. **SR-11:** garantido em três camadas. (a) Assinatura sem `UserCriteria` (D1); (b) lint que proíbe ler os campos livres e importar o tipo (D7); (c) propriedade por canário (D8). A forma "você exige X" não existe no catálogo, e o comentário e a fixture do contrato que a usavam foram corrigidos (D2).
2. **Saída do LLM não chega ao texto:** os únicos fatos interpolados são enums validados pelo zod do contrato (modelo, senioridade, contrato e moeda). Título, cidade e tags de stack são strings do LLM e **não entram em nenhum texto**. Um anunciante não consegue escrever nada no relatório; no máximo escolhe qual rótulo fixo aparece.
3. **`safeText`:** o espaço de saída é **finito** e sai só do catálogo. A lista fechada de caracteres (D6) torna impossíveis `<>`, invisíveis, `://`, `/` e `@`. O resto é provado em todos os textos alcançáveis (D8) e revalidado pelo `AnalyzeJob`.
4. **Sem logger:** `no-console` no diretório, e o preset de pureza barra qualquer import de pacote. O composer não registra nada.
5. **Exposição ao próprio usuário:** os rótulos de efeito ("eliminatório para você", "pesa contra a nota") e o `importance` do breakdown revelam a **configuração** do usuário, não valores. O relatório só vai para o próprio usuário: não vai para o cache (ADR-001 §5.4) nem para a telemetria (ADR-010). Aceito.
6. **Riscos residuais aceitos:**
   - um catálogo novo pode ter `www.` ou um domínio nu: a lista fechada não cobre isso, mas os testes exaustivos e o `parse` do `AnalyzeJob` cobrem;
   - mudar um texto sem mudar a versão `rc1` perde rastreabilidade: um teste fixa o sha256 do catálogo inteiro junto com a versão, então mudar o texto exige mudar o teste e a versão.
7. **Veto não exercido.** D1, D6 e D7 são condição de aceite.

## 4. Consequências
- O `AnalyzeJob` (F1-API-04) monta o envelope, junta os avisos, chama o composer e faz `AnalysisReportSchema.parse`.
- A extensão renderiza `summary` como texto puro (sem `innerHTML`, SR-03).
- Mudar qualquer texto exige versão nova do catálogo (`rc2`). Mudar a nota continua exigindo versão nova do motor (ADR-002 R4).
- O [contratos-zod](../contratos-zod.md) do cofre está desatualizado desde o F1-DOM-02 (ainda mostra o veredito de 3 faixas). A fonte da verdade é `packages/contracts`. A sincronização do documento fica registrada como pendência no BACKLOG.
