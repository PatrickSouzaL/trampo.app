---
tipo: adr
id: ADR-002
titulo: "ScoringEngine (E7): fórmula completa da nota, regra por dimensão, 'não informado' e 'conflito'"
status: aceito com variações
aprovacao: "HITL-016 respondido em 2026-10-20: aceito. D-S1, D-S2, D-S4 e D-S6 conforme recomendação; D-S3, D-S5, D-S7, D-S8 e D-S9 reescritos por regra do humano (§6). Quatro pontos de interpretação do [ARCHITECT] foram respondidos no HITL-018 (2026-10-20): a 1 foi trocada pelo humano (stack > 80% eleva o r da senioridade para 0,8 e dispensa a penalidade); a 2, a 3 e a 4 foram mantidas. Clearance para o F1-DOM-02."
data: 2026-10-19
aceito_em: 2026-10-20
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)", "Humano (aprovação)"]
escopo: "F1-DOM-02 (apps/api/src/domain/scoring) e entrada do F1-DOM-03 (ReportComposer)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-011-deterministic-signals-and-fact-resolver](ADR-011-deterministic-signals-and-fact-resolver.md)", "[contratos-zod](../contratos-zod.md)", "[threat-model](../threat-model.md)", "*HITL-QUEUE §HITL-015*", "*HITL-QUEUE §HITL-016*", "*BACKLOG §F1-DOM-02*", "*BACKLOG §F1-DOM-03*"]
---

# ADR-002: `ScoringEngine` (E7)

> [!success] Status: **aceito com variações** (HITL-016, 2026-10-20). Nada aqui foi implementado ainda.
> - O humano aceitou o ADR e reescreveu D-S3 (câmbio fixo), D-S5 (adjacência ascendente validada), D-S7 (inglês em vaga internacional), D-S8 (atenuação de risco) e D-S9 (escala de 5 faixas). O texto abaixo **já está com as variações aplicadas**; o registro da decisão está no §6.
> - As variações exigem **3 mudanças de contrato** (§8.1), que entram no primeiro commit do F1-DOM-02, antes do motor (contrato nasce primeiro, AGENTS §1.4).
> - Quatro pontos em que a regra do humano admitia mais de uma leitura receberam uma interpretação do `[ARCHITECT]`. O humano respondeu no *HITL-QUEUE §HITL-018* (2026-10-20), e as marcas ⚖️ viraram ✅:
>   - **interpretação 1 trocada:** com stack > 80% na adjacência ascendente, o `r` da senioridade **sobe para 0,8** e a penalidade do parcial é dispensada (§4.2.2);
>   - **interpretações 2, 3 e 4 mantidas:** rebaixamento = vaga inteira abaixo do menor nível aceito; inglês nulo em vaga internacional = `avancado`; ARS 0,0034 e a lista de sinais de cultura.
> - **Clearance concedido para o F1-DOM-02** (100% de ramos, mutação e propriedade das invariantes).
> - Todas as constantes são **hipóteses versionadas** em `ScoringPolicy` (`engineVersion = se1`), e a calibração sai do golden dataset (P0-EVL-01).

## 1. Contexto

- O ADR-001 §5.7 fixou o essencial:
  - o motor é a **única autoridade da nota**;
  - é puro e determinístico;
  - um deal-breaker leva a "foge" com nota no máximo 20;
  - must-have violado vale −30; não informado ou em conflito vale −5 com alerta;
  - os critérios ponderados somam;
  - faixas de 75 e 45;
  - conflito em dimensão eliminatória não elimina sozinho.
- Ficaram para este ADR:
  - a fórmula da soma;
  - salário entre moeda e período;
  - localização e idiomas;
  - a semântica de cada dimensão;
  - a interação com a proveniência do [ADR-011-deterministic-signals-and-fact-resolver](ADR-011-deterministic-signals-and-fact-resolver.md).
- Insumos fixos (contrato v1, sem mudança):
  - `ResolvedJobFacts`;
  - `provenance: Record<FactField, FactProvenance>`;
  - `UserCriteria`;
  - as 9 `ScoreDimension`;
  - os 6 `DimensionOutcome`;
  - `ScoreBreakdownEntry` (com `points` inteiro em [−100, 100]).

## 2. Assinatura e saída

```ts
// apps/api/src/domain/scoring/scoring-engine.ts (ilustrativo; domínio puro, sem zod)
new ScoringEngine(policy?: ScoringPolicy)          // policy validada no construtor: RangeError se incoerente (§5)
  .score({
    facts: ResolvedJobFacts,
    provenance: Readonly<Record<FactField, FactProvenance>>,
    llmExtracted: boolean,                        // D-S6: derivado do decisionPath pelo AnalyzeJob
  }, criteria: UserCriteria): ScoreResult

interface ScoreResult {
  score: number;                                  // inteiro em [0, 100]
  verdict: Verdict;                               // D-S9: 5 faixas (§3.4); contrato novo (§8.1)
  dealBreakerHit: boolean;
  breakdown: readonly DimensionEvaluation[];      // sempre as 9 dimensões, na ordem do enum
  redFlagHits: readonly { signal: RedFlagSignal; effect: 'alerta' | 'penalidade' | 'eliminatoria' }[];
  engineVersion: 'se1';
}
interface DimensionEvaluation {
  dimension: ScoreDimension;
  outcome: DimensionOutcome;
  importance: AppliedImportance;
  points: number;                                 // inteiro em [−30, 100] (cabe no contrato)
  dealBreakerHit: boolean;
  reason: ScoreReasonCode;                        // enum fechado; NUNCA texto (§4.3)
}
```

- **Desvio do ADR-001 §5.7 (D-S6):** a assinatura ganha `llmExtracted`. O resolver marca `ausente` tanto quando o LLM disse "não há" quanto quando não houve LLM, em benefícios, idiomas e red flags (ADR-011 D6 e D7). Sem o indicador, o motor confundiria "a vaga não exige idioma" com "não sabemos", que é exatamente a confusão "não informado ≠ não atende" que o Blueprint proíbe.
- `ScoringPolicy` é injetada no **construtor** e não por chamada: a política é da versão do motor, não da requisição. O `AnalyzeJob` usa uma instância por processo.
- **Puro:** sem I/O, sem `Date`, sem `Math.random`, sem log e sem mutar a entrada. Mesmas entradas e mesma política dão a mesma saída, bit a bit.
- O motor **não** gera texto. `explanation` (`safeText(160)`) e os itens do relatório são do `ReportComposer` (F1-DOM-03), a partir de `reason` (§4.3).

## 3. A fórmula

### 3.1 Avaliação por dimensão
Cada dimensão com critério ativo produz:
- um `outcome`;
- uma **razão de atendimento** `r ∈ [0, 1]`:
  - `atende` = 1;
  - `nao_atende` = 0;
  - `atende_parcialmente` = a fração da regra da dimensão;
  - `nao_informado` e `conflito` = `unknownRatio`, padrão **0,5**.
- uma penalidade inteira `p ≤ 0` (§3.3).

Critério `null` ou `importance = ignorar` dá `outcome = ignorado`, `points = 0`, e a dimensão fica fora da base.

### 3.2 Base ponderada (D-S1)
```
peso(d) = weight do usuário          se ponderado (1..5)
        = requiredWeight (padrão 5)  se obrigatorio ou eliminatorio
base    = 100 × Σ peso(d)·r(d) / Σ peso(d)     (só dimensões fora de 'ignorado' e de red_flags)
        = emptyBase (padrão 50)                se Σ peso = 0
```
- **Obrigatório e eliminatório também entram na base.** Sem isso, um usuário que marca tudo como obrigatório teria base fixa e veria "recomendado" numa vaga sobre a qual nada se sabe. Com isso, cada must-have não informado puxa a base para 50, além do −5.
- **"Não informado" vale 0,5 e não sai do denominador.** A renormalização (excluir o desconhecido) daria nota alta a vagas vagas: uma vaga que só diz "remoto" teria 100. Com 0,5, a vaga vaga fica neutra, que é a leitura honesta. **Conflito vale o mesmo que omissão**, então um anunciante não ganha nada contradizendo o próprio texto (§4.4).

### 3.3 Penalidades (por dimensão, só com `obrigatorio` ou `eliminatorio`)

| `outcome` | `obrigatorio` | `eliminatorio` |
|---|---|---|
| `atende` | 0 | 0 |
| `atende_parcialmente` | `−round(30 × (1 − r))` | `−round(30 × (1 − r))`, **sem** deal-breaker |
| `nao_atende` | **−30** (`mustHaveViolatedPenalty`) | **deal-breaker** (§3.4) e −30 |
| `nao_informado` | −5 (`mustHaveUnknownPenalty`) + alerta | −5 + alerta |
| `conflito` | −5 + alerta | **−30** (`eliminatoryConflictPenalty`) + red flag "informação contraditória" (ADR-001 §5.7) |

`ponderado` nunca tem penalidade: ele só pesa na base.

### 3.4 Nota, teto e veredito
```
points(d)     = contribuição inteira de d na base + p(d)       (§3.5)
bruto         = Σ points(d)
score         = clamp(bruto, 0, 100)
dealBreakerHit = alguma dimensão com dealBreakerHit
se dealBreakerHit: score = min(score, dealBreakerCap = 20) e verdict = 'foge'
senão: verdict = faixa(score)
```

**Escala granular de 5 faixas (D-S9, regra do humano):**

| Faixa (`verdict`) | Nota | Rótulo no relatório |
|---|---|---|
| `altamente_recomendado` | 90–100 | Altamente recomendado |
| `recomendado` | 75–89 | Recomendado |
| `neutro` | 50–74 | Neutro / oportunidade |
| `baixo_alinhamento` | 21–49 | Baixo alinhamento |
| `foge` | 0–20 | Foge (deal-breaker, ou nota muito baixa) |

- Na política: `bandMins = { altamente_recomendado: 90, recomendado: 75, neutro: 50, baixo_alinhamento: 21 }`. O construtor exige mínimos **estritamente decrescentes** e `dealBreakerCap < bandMins.baixo_alinhamento`; assim, o teto do deal-breaker sempre cai em `foge`, e a invariante 3 vale por construção.
- Uma nota ≤ 20 **sem** deal-breaker também é `foge`. O `ReportComposer` diferencia as duas pela `reason` da linha que disparou o teto.
- O `ReportComposer` (F1-DOM-03) ganha **um template por faixa** que explica a classificação: a faixa, o que a puxou para cima e o que a puxou para baixo, só com rótulos de enum dos fatos da vaga (§5.3).
- **Auditabilidade:** `score = min(teto?, clamp(Σ points, 0, 100))`. A soma dos pontos do breakdown reproduz a nota, exceto pelo piso 0 e pelo teto do deal-breaker, que o `ReportComposer` explica na linha da dimensão que disparou (`reason` = `deal_breaker_*`).
- As faixas comparam **inteiros**, então não há instabilidade de ponto flutuante na fronteira.

### 3.5 Arredondamento (determinístico)
- As contribuições reais `c(d) = 100·peso(d)·r(d)/Σpeso` viram inteiros pelo **maior resto**: `floor` de cada uma, e as unidades que faltam até `Math.round(Σ c)` vão para os maiores restos. Em empate, vale a ordem do enum `ScoreDimension`.
- `p(d)` já é inteiro (`Math.round`, meio para cima).
- Limites: `c ∈ [0, 100]`; `p ≥ −30` por dimensão (red flags com teto, §4.2.9). Logo `points ∈ [−30, 100]`, dentro do contrato.

## 4. Regras por dimensão

### 4.1 Comparação de valores (vale para todas)
- Enums são comparados por igualdade.
- **Strings vindas do LLM** (tags de stack e `location.city`) só entram por **igualdade exata após dobra** contra uma lista fechada do usuário:
  - tags: `toLowerCase()`;
  - cidade: NFKC → NFD sem marcas combinantes → `toLowerCase()` → espaços colapsados.
- **Nunca** por substring, prefixo, regex ou "contém". Detalhe no [§5](#5-auditoria-appsec).
- Sinônimos de tecnologia (ex.: "NodeJS" e "Node.js") **não** são resolvidos no motor. Quem canoniza é o `TechDictionary` (F1-DOM-04). Os termos do usuário devem ser canonizados **ao salvar os critérios** (risco R2, §7).

### 4.2 Tabela de dimensões

**4.2.1 `stack`.** O critério não tem `importance`: cada lista tem semântica própria.
- **Deal-breakers:** um termo de `dealBreakers` em `stackRequired` dá `dealBreakerHit` (`reason = deal_breaker_stack_exigida`). Com `dealBreakerScope = 'qualquer_mencao'`, valem também os termos em `stackNiceToHave` (`deal_breaker_stack_desejavel`).
- **Must-have:** razão `r_m = |mustHave ∩ (stackRequired ∪ stackNiceToHave)| / |mustHave|`. Peso `requiredWeight`; penalidade de `obrigatorio` (§3.3) sobre `r_m`.
  - Se a stack da vaga está **vazia** (as duas listas), o resultado é `nao_informado`. É o caso típico das vagas fora de tecnologia: 11 das 30 do HITL-003 são de outras áreas, pela `area` do cabeçalho.
  - Termo marcado que não aparece numa stack conhecida conta como **não atende**. O ADR-011 D5 já resgata o termo marcado que tem menção explícita no texto e que o LLM omitiu, então a ausência depois da fusão é ausência de fato.
- **Nice-to-have:** `r_n = |niceToHave ∩ stack da vaga| / |niceToHave|`, com peso `niceToHaveWeight` (0 tira da base). Stack vazia dá `unknownRatio`.
- **Uma só linha no breakdown:**
  - `points` é a soma das contribuições e da penalidade;
  - `importance` é a mais severa aplicada (`eliminatorio` se houve deal-breaker, senão `obrigatorio` se há must-have, senão `ponderado` se há nice-to-have com peso, senão `ignorar`);
  - `outcome`: o pior entre deal-breaker (`nao_atende`) e must-have; só nice-to-have, a regra de conjunto.

**4.2.2 Conjuntos: `modelo_trabalho`, `senioridade`, `contrato`.** `F` = valores da vaga, `A` = aceitos pelo usuário.

| Caso | `outcome` | `r` |
|---|---|---|
| `provenance = conflito` | `conflito` | 0,5 |
| `F` vazio | `nao_informado` | 0,5 |
| `F ⊆ A` | `atende` | 1 |
| `F ∩ A ≠ ∅` e `F ⊄ A` (ex.: "Pleno/Sênior" para quem aceita só pleno; "remoto ou híbrido" para quem aceita só remoto) | `atende_parcialmente` | `|F ∩ A| / |F|` |
| `F ∩ A = ∅` | `nao_atende` | 0 |

**Senioridade: adjacência ascendente validada (D-S5, regra do humano).** Vale para `senioridade` quando `F ∩ A = ∅`; os casos da tabela acima com interseção não mudam.
- **Posto ordinal** (`seniorityRank` na política): `estagio` 0, `junior` 1, `pleno` 2, `senior` 3, `especialista` 4, `lideranca` 4. ⚖️ Especialista e liderança dividem o posto 4: são trilhas diferentes (técnica e de gestão), não um degrau acima do outro.
- **Adjacência ascendente:** algum `f ∈ F` com `posto(f) = max posto(A) + 1` (ex.: aceita só "pleno", a vaga é "sênior"). Resultado: `atende_parcialmente`, `r = adjacentUpRatio = 0,5`, `reason = senioridade_adjacente_acima`. Pelo D-S2, o parcial **nunca** é deal-breaker, mesmo em `eliminatorio`: a vaga não é reprovada.
- **Validação pela stack:** se a dimensão `stack` tiver razão `s > adjacencyStackThreshold = 0,8`, o motor reconhece a capacidade. ✅ (HITL-018, regra do humano, 2026-10-20) O reconhecimento técnico é **alavanca de nota**, e não só ausência de castigo:
  - o `r` da senioridade **sobe para `adjacentValidatedRatio = 0,8`** na base (no lugar de 0,5), também em `ponderado`;
  - a penalidade do parcial é **dispensada** (`p = 0` no lugar de `−round(30 × (1 − r))`) em `obrigatorio` e `eliminatorio`;
  - `outcome` continua `atende_parcialmente` (o nível não é o aceito) e `reason = senioridade_adjacente_validada`;
  - o construtor exige `adjacentUpRatio < adjacentValidatedRatio < 1` (o humano escreveu "0,8 ou superior"; o valor de `se1` é 0,8, e 1 confundiria o parcial com `atende`).
  - A interpretação anterior (só dispensar a penalidade, com r = 0,5) foi **rejeitada** pelo humano.
- Detalhe da validação: `s` é `r_m` quando há must-have, senão `r_n` quando há nice-to-have com peso, e a validação **não** acontece com a stack `nao_informado` (vaga sem stack), sem critério de stack ou com deal-breaker de stack.
- **Rebaixamento evidente:** todo `f ∈ F` com `posto(f) < min posto(A)` (ex.: aceita só "sênior", a vaga é "júnior"). Resultado: `nao_atende`, `r = 0`, `reason = senioridade_rebaixamento` e penalidade severa `seniorityDowngradePenalty = −30` **também em `ponderado`**. ✅ (HITL-018, mantida) "Evidente" foi lido como "a vaga inteira está abaixo de tudo o que o usuário aceita", e não "pelo menos dois níveis abaixo". Em `obrigatorio`, a penalidade é a mesma −30 (não soma duas vezes); em `eliminatorio`, continua sendo deal-breaker.
- Os demais casos sem interseção (ex.: dois níveis acima) seguem a tabela: `nao_atende` com as penalidades normais.
- **Acoplamento entre dimensões:** é o único ponto em que uma dimensão lê outra. A ordem de cálculo fica fixa (stack antes de senioridade) e a monotonicidade passa a ser provada também entre as duas (invariante 11).

**4.2.3 `salario` (D-S3, regra do humano: câmbio por tabela fixa).** Critério: `minimum`, `currency` e `period`. Fato: `{min, max, currency, period}`.
1. `provenance = conflito` dá `conflito`. `salary = null` dá `nao_informado`.
2. **Vaga internacional** (`location.countryIso2` presente e ≠ `'BR'`): moeda nula **não** assume BRL. Dá `nao_informado`, `reason = salario_moeda_indeterminada`. Em vaga não internacional, moeda nula assume `defaultCurrency = 'BRL'`. Período nulo assume `defaultPeriod = 'mes'` nos dois casos.
   - **Por quê (`[APPSEC]`):** a regra antiga leria "AR$ 3.800.000" sem moeda como R$ 3,8 milhões, e a vaga argentina viraria a mais bem paga do dataset.
3. **Câmbio por tabela fixa:** `fxToBrl: Readonly<Record<Currency, number>>` na política, com `fxReferenceDate`. Os dois lados (vaga e usuário) vão para **BRL por mês**, e a comparação acontece nessa base. Isso equivale a converter a vaga para a moeda do usuário, porque o fator do usuário se cancela.

   | Moeda | `fxToBrl` (`se1`) | Origem |
   |---|---|---|
   | `BRL` | 1 | identidade |
   | `USD` | 5,5 | valor dado pelo humano no HITL-016 |
   | `EUR` | 6,0 | valor dado pelo humano no HITL-016 |
   | `ARS` | 0,0034 | ✅ referência comercial de jul/2026 (~294 ARS por real), confirmada no HITL-018 como **valor de fallback** (ver nota abaixo) |

   - O construtor recusa a política se faltar taxa para **qualquer** valor do enum `Currency`, ou se alguma taxa não for finita e > 0 (falha fechado; uma moeda nova no contrato sem taxa nunca vira "1").
   - **Trocar uma taxa muda o `engineVersion`.** Notas de versões diferentes não são comparáveis (R4).
   - **Apodrecimento conhecido:** o ARS perdeu cerca de 16% contra o real em 12 meses. A tabela fica velha rápido para ele. O relatório mostra `reason = salario_convertido` na linha, para o usuário saber que a comparação passou por câmbio de tabela.
   - **Tabela como *fallback* (HITL-018, 2026-10-20).** O humano escreveu que a taxa do ARS "servirá estritamente como Fallback do serviço de Redis aprovado na D-S3". O registro do HITL-016 aprovou **só a tabela fixa**: nenhum serviço de câmbio ao vivo foi decidido até aqui. A leitura do `[ARCHITECT]` que preserva os dois textos:
     - o **domínio continua puro**: o motor só recebe `fxToBrl` pela `ScoringPolicy` e não sabe de onde a taxa veio;
     - uma fonte de taxa ao vivo, se vier, é um *adapter* da aplicação (porta `FxRateSource`, cache no Upstash com TTL), que monta a política a cada análise e cai na tabela `se1` quando a fonte falha, expira ou devolve valor fora de faixa;
     - nesse cenário, a taxa usada e a data dela entram no `ScoreResult` (a regra "trocar a taxa muda o `engineVersion`" deixa de servir para taxa ao vivo);
     - nada disso entra no F1-DOM-02. Fica como item novo **F1-FX-01** no BACKLOG, sem prioridade, e a escolha da fonte gratuita de câmbio é decisão humana quando ele entrar.
4. **Período:** tudo vai para **mês**. Hora × `hoursPerMonth` (220, a jornada CLT de 44 h). Ano ÷ `monthsPerYear` (12). Os dois lados são normalizados.
5. Intervalo da vaga `[lo, hi] = [min ?? max, max ?? min]`, a mesma convenção do ADR-011 D4. Com `m` = mínimo do usuário, já em BRL por mês:
   - `lo ≥ m`: `atende`;
   - `hi < m`: `nao_atende`;
   - senão, `atende_parcialmente` com `r = (hi − m) / (hi − lo)`.
- **Limitação conhecida:** "até R$ X" vira o ponto `[X, X]`, ou seja, otimista.
- **Vaga sem salário em `ponderado`** (pedido do HITL-017): sem penalidade. A dimensão entra na base com `r = 0,5` e custa exatamente `100·w·0,5/Σpeso` (±1 do arredondamento) em relação a uma vaga que atende. Em `obrigatorio`, soma −5. O sinal `salario_omitido` continua seguindo a tolerância do usuário (§4.2.7).

**4.2.4 `localizacao`.** Critério: `acceptedUfs` e `acceptedCities` (o contrato diz que só vale para híbrido e presencial).
1. `workModels = ['remoto']` (só remoto): `ignorado`, `reason = localizacao_nao_se_aplica`, fora da base.
2. `location = null`: `nao_informado`.
3. `countryIso2` presente e diferente de `'BR'`: `nao_atende`.
4. Cidade igual (dobra do §4.1) a uma de `acceptedCities`, **ou** `stateUf ∈ acceptedUfs`: `atende`.
5. Só `countryIso2 = 'BR'`, sem UF e sem cidade: `nao_informado`.
6. Caso contrário: `nao_atende`.
- Se a vaga também aceita `remoto` (ex.: "remoto ou híbrido"), um `nao_atende` vira `atende_parcialmente` com `r = 0,5`: a opção remota continua de pé.
- Com `workModels` vazio, a localização é avaliada normalmente.

**4.2.5 `idiomas`.** Critério: o que o usuário **tem** (`language`, `level`). Fato: o que a vaga pede (`language`, `level | null`, `required`).
- Só os requisitos com `required = true` contam.
- Um requisito é atendido se o usuário tem o idioma com nível ≥ o pedido, na ordem `basico < intermediario < avancado < fluente < nativo`. Nível `null` na vaga: basta ter o idioma.
- **`portugues` sem entrada do usuário conta como `nativo`** (D-S7, recomendação original mantida; o produto é pt-BR).
- `outro` nunca casa, porque podem ser idiomas diferentes: vira `nao_informado`.
- **Vaga internacional (D-S7, regra do humano):** `internacional = (countryIso2 presente e ≠ 'BR') ∨ (salary.currency presente e ≠ 'BRL')`. Nela, o inglês é avaliado com rigor:
  - toda entrada `ingles` conta como exigida, **mesmo com `required = false`**;
  - ✅ (HITL-018, mantida, *fail-safe* para vaga estrangeira) nível nulo na vaga é lido como `internationalEnglishMinLevel = 'avancado'`, e não "basta ter o idioma";
  - o usuário sem `ingles` declarado não atende;
  - falha no inglês dá `reason = idioma_ingles_internacional`.
  - O motor **não** cria um requisito de inglês que a vaga não menciona: sem entrada `ingles`, a vaga internacional segue a regra geral. Inventar requisito seria inventar fato.
  - A leitura de vagas escritas em inglês está confirmada pelo humano. O golden dataset ganha a categoria de caso em inglês (P0-EVL-01).
- Resultado:
  - `r = atendidos / exigidos`;
  - nenhum exigido e `llmExtracted`: `atende` (`reason = idioma_nao_exigido`);
  - nenhum exigido e sem LLM: `nao_informado`.

**4.2.6 `beneficios`.**
- `r = |desired ∩ benefits| / |desired|`.
- `benefits` vazio dá `nao_informado`, com ou sem LLM: anúncio sem benefícios listados é omissão, não ausência.
- `outro` casa com `outro`.

**4.2.7 `red_flags`.** Os sinais são enum (do LLM, e `salario_omitido` do código).
- Para cada sinal presente, a tolerância do usuário decide:
  - `ignorar`: nada;
  - `alertar`: entra em `redFlagHits` (`alerta`), com 0 ponto;
  - `penalizar`: `−redFlagPenalty` (10) cada;
  - `eliminatorio`: deal-breaker (`reason = deal_breaker_red_flag`).
- Soma das penalidades limitada a `−redFlagMaxPenalty` (30).
- **Atenuação de risco (D-S8, regra do humano):** se a dimensão `beneficios` foi avaliada (critério ativo, fora de `ignorar`) com `r_b > riskAttenuationBenefitsMinRatio = 0,8`, a penalidade de cada sinal **de cultura** cai pela metade (`riskAttenuationFactor = 0,5`, ou seja, −5 em vez de −10), com `reason = red_flag_atenuada_por_beneficios`. O teto de −30 vale depois da atenuação.
  - ✅ (HITL-018, lista confirmada) **Sinais de cultura** (`cultureRedFlags` na política): `escopo_excessivo`, `multiplas_funcoes`, `linguagem_vaga` e o novo `pressao_excessiva` (§8.1).
  - **Nunca atenuados:** `salario_omitido` (benefício não substitui transparência de salário), `sobreaviso_nao_remunerado` (possível irregularidade trabalhista) e `teste_tecnico_longo` (processo, não cultura).
  - **`eliminatorio` nunca é atenuado:** o deal-breaker continua deal-breaker. Alertas não mudam.
  - Benefícios `nao_informado` (`r = 0,5`) não atenuam nada.
- `outcome`:
  - `nao_atende` se houve penalidade ou eliminação;
  - `atende_parcialmente` se só alertas;
  - `atende` se não há sinal e `llmExtracted`;
  - `nao_informado` se não há LLM (só `salario_omitido` é conhecido nesse caso, e ele continua valendo).
- **Fora da base**, só penalidade. `importance` exibida: `eliminatorio`, depois `obrigatorio` (penalizar), senão `ignorar`.
- **Dupla contagem consciente:** sem salário, a dimensão `salario` fica `nao_informado` **e** o sinal `salario_omitido` aplica a tolerância escolhida. O usuário controla os dois e o portal deve mostrar isso.

**4.2.8 Fora da nota em `se1`.**
- `yearsExperienceMin`: não há dimensão no contrato v1.
- `title`: texto livre.
- `effectiveConfidence` (D-S4).
- `notes` do usuário: o Blueprint §3 proíbe usá-las em regra.

### 4.3 `ScoreReasonCode` (enum fechado, entrada do F1-DOM-03)
- Gerais: `atende`, `atende_parcialmente`, `nao_atende`, `nao_informado`, `conflito`, `ignorado`.
- Específicos:
  - `deal_breaker_stack_exigida`;
  - `deal_breaker_stack_desejavel`;
  - `deal_breaker_red_flag`;
  - `conflito_eliminatorio`;
  - `salario_moeda_diferente`;
  - `localizacao_nao_se_aplica`;
  - `idioma_nao_exigido`;
  - `stack_nao_informada`;
  - HITL-016: `salario_convertido`, `salario_moeda_indeterminada`, `senioridade_adjacente_acima`, `senioridade_adjacente_validada`, `senioridade_rebaixamento`, `idioma_ingles_internacional` e `red_flag_atenuada_por_beneficios`.

A lista final é fechada na implementação, e qualquer código novo exige template novo no catálogo do F1-DOM-03. **O motor não emite nenhuma string livre.**

### 4.4 Invariantes (viram testes de propriedade no F1-DOM-02)
1. **Determinismo e pureza:** mesma entrada, mesma saída; entrada congelada não muda.
2. `score` é inteiro em [0, 100]; todo `points` é inteiro em [−30, 100]; o breakdown tem 9 entradas únicas.
3. `dealBreakerHit ⇒ verdict = 'foge' ∧ score ≤ 20`.
4. **Conflito em dimensão eliminatória, sozinho, nunca dá `dealBreakerHit` e nunca dá `recomendado` nem `altamente_recomendado`.** Isso decorre de `base < 100` (r = 0,5) e de `eliminatoryConflictPenalty > 100 − bandMins.recomendado`, validado no construtor.
5. **Must-have `nao_atende` nunca dá `recomendado` nem `altamente_recomendado`**, pelo mesmo argumento, com `mustHaveViolatedPenalty`.
6. **Monotonicidade entre fatos informados:** com `outcome` fora de `nao_informado` e `conflito`, trocar o fato de uma dimensão para um com `r` maior nunca baixa a nota. Entre "não informado" e informado **não** há monotonicidade, e isso é de propósito: um parcial com r = 0,6 em dimensão obrigatória (−12) pode valer menos que a omissão (−5). Saber que falta pesa mais que não saber, como no Blueprint (must-have não atendido > não informado).
7. **Conflito ≡ omissão** em dimensão `ponderado`: trocar `nao_informado` por `conflito` não muda a nota (§3.2).
8. **Independência de texto livre:** trocar `title`, `notes` ou `location.city` por qualquer valor **fora** das listas do usuário não muda a nota.
9. **SR-11:** o `JSON.stringify(ScoreResult)` não contém nenhum valor do perfil (canários em `minimum`, `acceptedCities`, termos de stack e `notes`).
10. `score = min(teto?, clamp(Σ points, 0, 100))`.
11. **Monotonicidade com acoplamento (D-S5):** aumentar a razão da `stack` nunca baixa a nota, inclusive pelo efeito na senioridade; e, para a mesma vaga, "adjacente acima" nunca vale menos que "rebaixamento"; e "adjacente validada" (r = 0,8, sem penalidade) nunca vale menos que "adjacente acima" (r = 0,5) nem mais que `atende` (HITL-018).
12. **Faixa coerente com a nota (D-S9):** `verdict` é função só de `score` e de `dealBreakerHit`; as 5 faixas cobrem [0, 100] sem buraco e sem sobreposição.
13. **Câmbio (D-S3):** multiplicar o salário da vaga e o mínimo do usuário pela mesma taxa, na mesma moeda, não muda o `outcome` de `salario`; e uma vaga internacional com moeda nula nunca dá `atende` em `salario`.
14. **Atenuação limitada (D-S8):** a atenuação nunca muda `dealBreakerHit`, nunca reduz uma penalidade a menos da metade e nunca toca sinal fora de `cultureRedFlags`.

## 5. Auditoria `[APPSEC]`

1. **A nota não depende de texto livre do LLM.**
   - O motor lê enums, números, booleanos e só duas strings do LLM: as tags de stack (já restritas pelo `TechTagSchema`) e a cidade (`safeText(80)`). As duas entram só como **chave de igualdade contra lista fechada do usuário** (§4.1). Uma string manipulada só consegue "casar ou não casar", nunca instruir, e casar exige acertar o valor exato que o usuário escolheu, que o anunciante não conhece.
   - `title`, `notes` e qualquer texto fora disso **não são lidos** (invariante 8).
   - **Restrição imposta ao `[DEV]`:** proibido `includes`, `startsWith`, `indexOf` ou regex sobre string vinda dos fatos em `domain/scoring`. A regra do ESLint (`no-restricted-syntax` no diretório) entra no F1-DOM-02 com fixture negativa.
2. **Conflito em dimensão eliminatória não elimina sozinho nem aprova em silêncio.**
   - Vale −30, sem `dealBreakerHit`, e gera o red flag "informação contraditória".
   - O construtor recusa política em que `eliminatoryConflictPenalty ≤ 100 − recommendedMin`. Assim, "nunca recomendado" é garantido pela validação e provado por propriedade (invariantes 3 e 4).
   - Em `ponderado`, conflito vale o mesmo que omissão (invariante 7). Contradizer o próprio anúncio **não rende** nota a um anunciante.
3. **A explicação nunca ecoa valor do perfil (SR-11).**
   - O motor só emite `reason` de enum fechado (§4.3) e nenhum valor do perfil (invariante 9).
   - **Restrição imposta ao F1-DOM-03:** os templates só interpolam rótulos de enum **dos fatos da vaga** ("vaga híbrida", "contrato PJ") e nunca dos critérios. O exemplo do comentário do contrato, "você exige remoto", **ecoa o perfil** e fica proibido. A forma permitida é "modelo de trabalho fora do que você aceita".
   - Os pontos de `salario` revelam a posição relativa do mínimo do usuário na faixa da vaga. Isso só é visível ao próprio usuário: o relatório não vai para o cache (ADR-001 §5.4), e a telemetria (ADR-010) só aceita enums e números de lista fechada, sem breakdown.
4. **LGPD:** os critérios só entram em memória, na chamada. Nada é registrado em log (o domínio não tem logger). A saída não contém critério.
5. **Falha fechado:** a política é validada no construtor (`RangeError`). As entradas fora do contrato (ex.: `weight` 0) são barradas antes pelo zod da aplicação, e o motor confia nos tipos, como o resolver.
6. **Custo:** entradas limitadas pelo contrato (≤ 30 tags, ≤ 15 por lista, ≤ 10 cidades, ≤ 8 idiomas), então tudo é O(n·m) com n, m ≤ 30. Sem regex, o SR-09 nem se aplica.
7. **Riscos residuais aceitos (registrados, não bloqueiam):**
   - **Keyword stuffing:** um anunciante que lista toda stack possível atende os must-haves, mas também dispara os deal-breakers de quem os tem. É o mesmo risco do D-H3, medido no S-4.
   - **Omissão estratégica:** omitir um dado vale mais ao anunciante que declará-lo fora do critério, e isso é inerente a "não informado ≠ não atende". O teto é baixo: a dimensão omitida fica em 0,5 na base, um must-have omitido custa −5, e o `ReportComposer` sempre lista a omissão em `missingInfo`. Ou seja, a vaga vaga nunca parece completa.
   - **Alucinação do LLM gerando deal-breaker:** o falso "foge" custa um clique em "Reanalisar com IA". A taxa é medida no golden dataset (falso positivo de deal-breaker, S-4).
8. **Veto não exercido.** As restrições dos itens 1 e 3 são condição de aceite do F1-DOM-02 e do F1-DOM-03.
9. **Reauditoria das variações do HITL-016 (2026-10-20, sem veto):**
   - **D-S3, moeda nula em vaga estrangeira:** a regra antiga (moeda nula vira BRL) transformaria um salário em peso argentino em salário em real, ~294 vezes maior. A §4.2.3 item 2 fecha isso. **Achado para o F1-DOM-04 e o S-4:** um detector de salário que procure `R$` sem fronteira à esquerda casa dentro de `AR$`. O caso `geekhunter-03` do golden dataset é a armadilha que prova isso.
   - **D-S3, tabela de câmbio:** dado fixo, versionado e sem I/O, então o domínio continua puro. O construtor falha fechado se faltar moeda. Risco residual aceito: taxa velha (principalmente ARS), mostrado ao usuário por `salario_convertido`.
   - **D-S8, atenuação:** abre um vetor novo. O anunciante pode listar muitos benefícios para cortar pela metade a penalidade de cultura. O ganho é limitado: só sinais de cultura, só a metade, nunca o eliminatório, e só se os benefícios casarem com a lista **do usuário** (que o anunciante não vê, embora `plano_saude` seja fácil de adivinhar). Ganho máximo: 4 sinais × 5 = 20 pontos, sob o teto de −30. Aceito e registrado; a invariante 14 prova os limites.
   - **D-S5, acoplamento stack → senioridade:** keyword stuffing de stack agora também dispensa a penalidade de senioridade adjacente. O ganho máximo é 15 pontos numa só dimensão, e a stack inflada já dispara os deal-breakers de quem os tem (item 7). Aceito.
   - **D-S5 depois do HITL-018 (r sobe para 0,8):** o ganho do stuffing cresce. Agora soma os 15 pontos da penalidade dispensada e `0,3 × 100·w/Σpeso` na base (com `obrigatorio`, w = 5). Continua limitado a uma dimensão, só vale um nível acima (nunca dois) e nunca muda o `outcome` para `atende`. A invariante 11 continua valendo, porque o salto de 0,5 para 0,8 só acontece quando a stack **sobe**. Aceito e registrado.
   - **D-S7:** nenhuma string nova do LLM entra na regra; tudo é enum (`language`, `level`, `countryIso2`, `currency`).
   - **Contratos (§8.1):** `ARS` e `pressao_excessiva` alargam a **saída do LLM**. O `LlmOutputGuard` continua estrito e o `extractorVersion` muda, para o cache antigo não ser lido com a semântica nova.

## 6. Decisões do humano (HITL-016, respondido em 2026-10-20)

| # | Decisão final | Onde no texto |
|---|---|---|
| **D-S1** | Recomendação: média ponderada; "não informado" e conflito valem 0,5 | §3.2 |
| **D-S2** | Recomendação: penalidade proporcional no parcial, sem deal-breaker | §3.3 |
| **D-S3** | **Variação:** câmbio por tabela fixa na `ScoringPolicy` (USD 5,5; EUR 6,0; ARS 0,0034, confirmado no HITL-018 como fallback), com conversão para a base antes do `r`; hora × 220 e ano ÷ 12 mantidos; moeda nula em vaga internacional não vira BRL | §4.2.3 |
| **D-S4** | Recomendação: confiança efetiva fora da nota | §4.2.8 |
| **D-S5** | **Variação:** adjacência ascendente validada (um nível acima = parcial com r = 0,5; stack > 80% eleva o r para 0,8 e dispensa a penalidade, HITL-018); rebaixamento evidente = `nao_atende` com −30 | §4.2.2 |
| **D-S6** | Recomendação: `llmExtracted` na assinatura | §2 |
| **D-S7** | **Variação:** inglês avaliado com rigor em vaga internacional (moeda estrangeira ou país ≠ BR); português nativo por padrão mantido; leitura de vagas em inglês confirmada | §4.2.5 |
| **D-S8** | **Variação:** −10 por sinal com teto −30 (mantido) e atenuação de 50% nos sinais de cultura quando benefícios têm r > 0,8 | §4.2.7 |
| **D-S9** | **Variação:** 5 faixas (90, 75, 50, 21); teto 20 do deal-breaker, −30 e −5 mantidos | §3.4 |

**Interpretações do `[ARCHITECT]`, respondidas no *HITL-QUEUE §HITL-018* (2026-10-20):**
1. D-S5, validação pela stack: **trocada pelo humano.** A stack > 80% **eleva o `r`** da senioridade para 0,8 (ou mais, pela política) **e** dispensa a penalidade do parcial. A leitura original (só dispensar a penalidade, r = 0,5) foi rejeitada.
2. D-S5, "rebaixamento evidente" = a vaga inteira abaixo do menor nível aceito: **mantida.**
3. D-S7, nível de inglês nulo em vaga internacional = `avancado`: **mantida** (*fail-safe* para vaga estrangeira).
4. D-S3 e D-S8, taxa do ARS (0,0034) e lista de sinais de cultura: **mantidas.** O humano qualificou a taxa como *fallback* (nota da §4.2.3).

### 6.1 Texto original da proposta (2026-10-19, para histórico)

| # | Decisão | Recomendação | Alternativas |
|---|---|---|---|
| **D-S1** | Fórmula da base | **Média ponderada** com obrigatório e eliminatório no peso 5 e "não informado" e conflito valendo 0,5 (§3.2) | (b) renormalizar sem os desconhecidos (vaga vaga ganha nota alta); (c) aditiva a partir de 100 (só penalidades; vaga vaga vira "recomendado") |
| **D-S2** | Atendimento parcial em obrigatório e eliminatório | **Penalidade proporcional** `−round(30·(1−r))`, sem deal-breaker | (b) binária: qualquer falta vale −30, e no eliminatório o parcial elimina |
| **D-S3** | Salário | **Sem câmbio** (moeda diferente = não comparável); hora × 220 e ano ÷ 12; moeda e período nulos assumem BRL e mês | (b) tabela de câmbio fixa em `ScoringPolicy`, revisada a cada versão; (c) ano ÷ 13,33 (13º + ⅓ de férias, típico de CLT) |
| **D-S4** | Confiança efetiva | **Não entra na nota**; aparece só como aviso (`baixa_confianca_extracao`) | (b) puxar a nota para 50 proporcionalmente à desconfiança (esconde fatos sólidos atrás de um número) |
| **D-S5** | Senioridade | **Sem adjacência**: só igualdade de níveis | (b) nível vizinho vale `atende_parcialmente` com r = 0,5 |
| **D-S6** | Assinatura | **Acrescentar `llmExtracted`** ao ADR-001 §5.7 (§2) | (b) o resolver passar a distinguir "LLM disse vazio" de "sem LLM" na proveniência (emenda ao ADR-011 e ao contrato `FactProvenance`) |
| **D-S7** | Português | **Assumido `nativo`** se o usuário não declarar | (b) exigir que o portal sempre declare |
| **D-S8** | Red flags `penalizar` | **−10 cada, teto −30** | (b) −30 cada, como um must-have |
| **D-S9** | Constantes herdadas do ADR-001 | **Manter**: teto 20, −30, −5, faixas 75 e 45 | Ajustar agora, sem dado (não recomendado) |


## 7. Riscos e calibração

- **R1. Golden dataset para salário e contrato (atualizado com o HITL-017, 2026-10-20).** O lote de estresse (33 vagas) levou o total a 63, com 12 salários anunciados, 3 só PJ, 2 "CLT ou PJ", 1 estágio e **1 vaga em ARS**. Pelos cabeçalhos, **não** há vaga em USD ou EUR, nem salário por hora ou anual. Por isso, a tabela de câmbio do D-S3 nessas moedas e as constantes `hoursPerMonth` e `monthsPerYear` são testadas **só em casos sintéticos** (marca `synthetic`) e em unidade.
- **R2. Grafia dos termos do usuário.** Sem canonização ao salvar os critérios, "NodeJS" do usuário não casa com "Node.js" do dicionário e o must-have vira falso "não atende". Mitigação: o portal canoniza pelo `TechDictionary` (F1-DOM-04) ao salvar. Até lá, o risco existe só nos testes.
- **R3. Sem vaga de dupla senioridade no golden.** O HITL-017 também não trouxe nenhuma (pelos cabeçalhos). A regra parcial e a adjacência do D-S5 são testadas em unidade e em casos sintéticos.
- **R5. Câmbio de tabela (D-S3).** Fica velho, principalmente o ARS. Mitigação: `fxReferenceDate` na política, `salario_convertido` no relatório e revisão da tabela a cada versão do motor.
- **R4. Pesos e faixas são hipóteses** (`se1`). Toda mudança de constante muda o `engineVersion`; a nota antiga e a nova não são comparáveis entre versões.

## 8. Consequências

- O F1-DOM-02 implementa este ADR (HITL-018 fechado em 2026-10-20, com clearance). Guardrails:
  - 100% de linhas e ramos;
  - as 14 invariantes como propriedade;
  - mutação;
  - regra de lint do §5.1;
  - **fixtures de estresse** (§8.2).
- O F1-DOM-03 consome `ScoreResult` e `reason`, fecha o catálogo de templates com a restrição do §5.3 e ganha um template por faixa (D-S9).
- O `AnalyzeJob` passa `llmExtracted = decisionPath ∈ {extracao_llm, cache_jobfacts}`.

### 8.1 Mudanças de contrato (primeiro commit do F1-DOM-02, antes do motor)
1. `CurrencySchema`: + `'ARS'` (D-S3). Alarga a saída do LLM, o critério do usuário e o cache. Muda o `extractorVersion`.
2. `RedFlagSignalSchema`: + `'pressao_excessiva'` (D-S8: "alta pressão", "sangue no olho", horas extras habituais tratadas como cultura). Muda o `extractorVersion`. O `redFlagTolerance` do `UserCriteria` é exaustivo, então os critérios já salvos precisam de migração com o padrão `'alertar'` para a chave nova (não há usuário real ainda, mas a regra fica escrita).
3. `VerdictSchema`: `['altamente_recomendado', 'recomendado', 'neutro', 'baixo_alinhamento', 'foge']` (D-S9). O `schemaVersion` do relatório continua 1, porque nada foi publicado (sem push e sem loja); depois da primeira publicação, uma mudança assim exige versão nova.
- O golden dataset já registra o que o contrato v1 não representa (`contractGaps` na *golden-dataset-spec*). Quando o §8.1 entrar, os casos marcados são revistos na mesma tarefa.

### 8.2 Fixtures de estresse (HITL-017, critério de aceite do F1-DOM-02)
- A suíte do motor carrega os `expected` dos casos com a tag `estresse` (lote do HITL-017) e os sintéticos de câmbio e de senioridade de `evals/golden/cases/`, e os avalia contra um conjunto fixo de perfis de teste.
- Provas obrigatórias no Vitest:
  - as 14 invariantes valem em todas as fixtures;
  - a vaga em ARS é convertida pela tabela e nunca lida como BRL;
  - vaga sem salário com `salario` em `ponderado` custa exatamente `100·w·0,5/Σpeso` (±1) e nenhuma penalidade;
  - USD e EUR (sintéticos) convertem pela tabela e respeitam a invariante 13;
  - adjacência ascendente e rebaixamento (sintéticos) dão os `reason` do §4.2.2.

## 9. Desenho de implementação (F1-DOM-02, 2026-10-21)

> `[ARCHITECT]` desenhou e `[APPSEC]` auditou antes do código. Código em `apps/api/src/domain/scoring/` (`scoring-policy.ts` e `scoring-engine.ts`), `engineVersion = se1`.

### 9.1 `ScoringPolicy` (validada no construtor; `RangeError` com a lista das regras que caíram)
| Regra | Por quê |
|---|---|
| `unknownRatio`, `remoteOptionRatio` em (0, 1); `requiredWeight` inteiro em [1, 5]; `emptyBase` inteiro em [0, 100] | D-S1 |
| Toda penalidade inteira em [0, 30] (`MAX_DIMENSION_PENALTY`) | `points ∈ [−30, 100]` (invariante 2) |
| `mustHaveUnknownPenalty ≤ mustHaveViolatedPenalty`; `redFlagPenalty ≤ redFlagMaxPenalty` | "saber que falta pesa mais que não saber" |
| `eliminatoryConflictPenalty > 100 − bandMins.recomendado` **e** `mustHaveViolatedPenalty > 100 − bandMins.recomendado` | invariantes 4 e 5 por construção |
| `bandMins` inteiros em [1, 100] e estritamente decrescentes; `dealBreakerCap < bandMins.baixo_alinhamento` | invariantes 3 e 12 |
| `seniorityRank` inteiro para os 6 níveis | D-S5 |
| `0 < adjacentUpRatio < adjacentValidatedRatio < 1`; `adjacencyStackThreshold ∈ [0, 1)` | HITL-018 |
| `fxToBrl` finito e > 0 para **toda** moeda do enum; `fxToBrl.BRL = 1` | D-S3, falha fechado |
| `riskAttenuationFactor ∈ [0,5, 1]`; `cultureRedFlags` do enum e sem `salario_omitido`, `sobreaviso_nao_remunerado` e `teste_tecnico_longo` | invariante 14 |
| `defaultCurrency`, `defaultPeriod` e `internationalEnglishMinLevel` dentro do enum | — |

As listas de enum do domínio (`SCORE_DIMENSIONS`, `CURRENCIES`, `SENIORITY_LEVELS`, `RED_FLAG_SIGNALS`, `LANGUAGE_LEVELS`, `SALARY_PERIODS`) espelham o contrato; um teste compara cada uma com `Schema.options`, na ordem.

### 9.2 Ordem de cálculo
`stack` (produz a razão de validação `s`) → conjuntos → `senioridade` (lê `s`) → `salario` → `localizacao` → `idiomas` → `beneficios` (produz `r_b`) → `red_flags` (lê `r_b`). A base é montada depois, na ordem do enum, e o maior resto desempata pela ordem do enum.

### 9.3 Decisões de implementação (sem mudar a regra)
- **`neutralBase` no `ScoreResult`:** quando nenhuma dimensão entra na base, a nota parte de `emptyBase` (50). Para a auditoria continuar exata, o resultado ganha `neutralBase` (50 nesse caso, 0 nos outros) e a invariante 10 vira `score = min(teto?, clamp(neutralBase + Σ points, 0, 100))`.
- **`salario_moeda_diferente` saiu do enum de `reason`:** com a tabela completa (D-S3), toda moeda é comparável; a troca de moeda dá `salario_convertido`.
- **Ano ÷ 12 por divisão**, e não × (1/12): o produto é inexato e mudaria o arredondamento de 7,5 (EUR 42–50 mil/ano contra R$ 22 mil dá −8, e não −7).
- **Penalidades com `0 − n`**, nunca `−n`: evita −0.
- **Dobra de cidade:** NFKC → minúsculas → NFD → marcas combinantes fora (U+0300–036F, 1AB0–1AFF, 1DC0–1DFF, 20D0–20FF, FE20–FE2F, por faixa de código, sem regex) → espaços colapsados. As minúsculas vêm antes do NFD ("İ" vira "i" + U+0307, que também sai).
- **Idioma `outro`** fica fora da conta; se for o único exigido, a dimensão é `nao_informado`.
- **Stack só com deal-breakers** (sem must-have nem nice-to-have com peso): fora da base; a linha mostra `atende` ou `nao_informado`, ou `eliminatorio` quando há acerto.
- **Red flags com todas as tolerâncias em `ignorar`:** `ignorado`.
- **`importance` exibida** em stack e red flags segue o que **aconteceu** (deal-breaker → `eliminatorio`; must-have ou penalidade → `obrigatorio`).

### 9.4 Auditoria `[APPSEC]` (sem veto)
- **Regra de lint do §5.1** no bloco `@trampo/api/scoring-equality-only` (`apps/api/eslint.config.js`): proíbe em `src/domain/scoring` os membros `includes`, `startsWith`, `endsWith`, `indexOf`, `lastIndexOf`, `search`, `match`, `matchAll`, `replace`, `replaceAll`, `split`, `localeCompare`, `test` e `exec` (por chamada, por referência e por chave computada literal), regex literal, `RegExp` e `console`. Os seletores de pureza do domínio são repetidos (o `no-restricted-syntax` não acumula; exportados como `domainPuritySyntax`). Pertença só por `Set.has` ou `===`. Fixture negativa permanente: `test/domain/scoring-lint.test.ts` (18 construções recusadas, 1 positiva, e a regra não vaza para fora do diretório).
- **SR-11:** o motor só emite enums e inteiros; a propriedade 9 e a suíte de estresse procuram canários de `minimum`, `acceptedCities`, termos de stack e `notes` na saída, inclusive quando a vaga repete esses valores.
- **Sem logger:** `no-console` no diretório, e o preset de pureza já barra qualquer import de pacote.
