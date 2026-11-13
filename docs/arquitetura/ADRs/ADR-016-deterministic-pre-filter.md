---
tipo: adr
id: ADR-016
titulo: "DeterministicPreFilter (E2, Camada 1): sinais de produção, TechDictionary, InjectionHeuristics e roteamento R1–R4 com a guarda de vacuidade"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]) dentro do ADR-001 §5.3, do ADR-011 D1 e da D-H3 (HITL-001). Ordem do humano em 2026-10-22. Não muda contrato público."
data: 2026-10-22
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-DOM-04 (apps/api/src/domain/prefilter; emenda em apps/api/src/domain/normalization)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-002-scoring-engine](ADR-002-scoring-engine.md)", "[ADR-005-job-text-normalizer](ADR-005-job-text-normalizer.md)", "[ADR-006-relevant-section-selector](ADR-006-relevant-section-selector.md)", "[ADR-011-deterministic-signals-and-fact-resolver](ADR-011-deterministic-signals-and-fact-resolver.md)", "*spike-metrics*", "*golden-dataset-spec*", "[threat-model](../threat-model.md)", "*BACKLOG §F1-DOM-04*"]
---

# ADR-016: `DeterministicPreFilter` (E2, Camada 1)

## 1. Contexto

O S-4 (*spike-metrics* §5) mediu um protótipo descartável (`pf-s4`) no `gd1` e mostrou que a porta `DeterministicSignals` ([ADR-011-deterministic-signals-and-fact-resolver](ADR-011-deterministic-signals-and-fact-resolver.md) D1) serve sem mudança de forma:
- falso "foge" de 0,1% na varredura (0 depois do ARS no enum) e 0 nas personas;
- precisão de 100% nos explícitos;
- 7/7 injections em `alta` e 0 controle negativo em `alta`.

O §5.7 lista o que levar para produção: 9 regras, a guarda de vacuidade do R3, a contagem de invisíveis por classe e o `titleHint` obrigatório.

Este ADR fixa a versão de produção no domínio puro: os sinais, o dicionário, a heurística de injection e a tabela de roteamento R1–R4.

## 2. Decisões

### D1. Onde fica e o que entra
- `apps/api/src/domain/prefilter/`, com o preset de pureza (sem rede, relógio, aleatoriedade nem zod) e só `import type` do contrato.
- **Entrada do extrator (`DeterministicPreFilter.extract`):**
  - `text: NormalizedJobText`: o texto **já normalizado** (`n1`). O pré-filtro nunca relê o texto bruto;
  - `title: NormalizedJobTitle | null`: chave **obrigatória**, com `null` explícito (S-4 §5.7, item 3). É a única fonte de senioridade explícita.
- **Saída:** só `DeterministicSignals` (ADR-011 D1, sem emenda de forma). Versão `pf1` (`PRE_FILTER_VERSION`); dicionário `td1`.
- **Fora do `extractorVersion`:** o cache guarda os `JobFacts` do LLM, e a Camada 1 roda a cada requisição (como o `fr1`).

### D2. Dobra e casamento sem regex com backtracking (SR-09)
- **Dobra** só para comparar, nunca para o LLM (ADR-005 D4): NFD, sem marcas combinantes, minúsculas e **confundíveis cirílicos e gregos → latim** (T15, mitigação 3). A dobra guarda as posições que vieram de um confundível.
- **Casamento:** `indexOf` com fronteira de palavra nas duas pontas. Regex só com uma classe e um quantificador (tokens), ou ancorada, sem aninhamento.
- **Fronteira = letra ou dígito (`\p{L}\p{N}`), achado da implementação.** No protótipo, *qualquer* caractere não ASCII contava como letra. Com isso, um ataque colado em aspas curvas, em `«»` ou em `‹›` escapava do detector: o `<` neutralizado vira `‹`, então `<ignore as instruções>` passava. O mesmo valia para um termo de stack entre aspas curvas. Agora a pontuação não ASCII é fronteira. No `gd1` os sinais continuaram idênticos aos do S-4, e os testes passaram a cobrir o caso.
- **Custo linear provado.** O protótipo tinha três pontos quadráticos que o corte de 15.000 escondia; a produção os fecha:
  - **janela limitada** antes de cada ocorrência: 80 caracteres para negação, vizinhos e contrato, no lugar do prefixo da linha inteira;
  - **memo por linha** das pistas (benefício, contratação, produto, disjunção, experiência e qualificador de termo ambíguo);
  - **parágrafo de cada linha** pré-calculado na heurística de injection.

### D3. Contexto da linha
- Mantém o do protótipo:
  - título de seção (linha curta, sem pontuação final, que não é item de lista);
  - item de lista **só com marcador seguido de espaço** (`**Diferenciais:**` em negrito de Markdown é título, não item);
  - diferencial na própria linha ou num bloco em prosa;
  - linha curta desconhecida **não** troca a seção (T4).
- Contextos: `exigida`, `desejavel`, `empresa`, `beneficio` e `desconhecido`.

### D4. Sinais de conjunto
- **Modelo de trabalho:**
  - uma família só é `explicita` (ADR-001 §5.3); famílias diferentes, ou menção negada, dão `fraca`;
  - descarta a linha do auxílio home office (benefício), a etapa do processo ("entrevista presencial") e a menção negada;
  - na linha do híbrido, "presencial" e "remoto" descrevem os dias, **exceto** na disjunção explícita ("remoto ou híbrido").
- **Contrato:**
  - "PJ" só com pista de contratação na linha e sem pista de produto (`gupy-15` e `geekhunter-04`);
  - negação nos 3 tokens antes ("sem possibilidade de CLT");
  - "estágio" numa linha que fala de experiência não é contrato;
  - valores diferentes que nunca aparecem juntos numa linha dão `fraca`.
- **Senioridade:**
  - `explicita` só no título; no corpo é `fraca`;
  - "Senior" perto de "ERP" ou de "Senior Sistemas" não conta (`linkedin-11`);
  - "PL" seguido de "/SQL" não conta.

### D5. Salário
- Varredura manual de caracteres, sem regex:
  - `R$` exige **fronteira à esquerda** (`AR$` ≠ `R$`, `geekhunter-03`; ADR-002 §5.9);
  - herança de moeda numa faixa ("R$ 8.000 a 10.000");
  - **período mais próximo** depois do último valor;
  - linha de benefício descartada;
  - `k` e "mil" multiplicam.
- `explicita` só com **um** candidato distinto, com moeda e com período. ARS sai como `ARS` e nunca vira BRL.
- **Novo na produção:**
  - valor acima de `SALARY_MAX` (`@trampo/contracts/limits`) descarta o candidato;
  - número não finito é descartado;
  - o sinal sempre vale no `SalaryFactsSchema` (`min ≤ max`, não negativo). Isso é provado por propriedade.

### D6. Stack (`TechDictionary` `td1`)
- **Origem:** os 221 termos do `td-s4`, escritos sem olhar o gabarito, mais os 13 ambíguos com qualificador.
- **Garantias de construção, verificadas por teste:**
  - o canônico vale no `TechTagSchema`;
  - o alias já está dobrado;
  - nenhum alias aponta para dois canônicos.
- **Casamento:** aliases mais longos primeiro, sem sobreposição de trechos.
- **Menção `explicita`** exige quatro condições:
  - não negada: 4 tokens antes, na mesma oração e por idioma, ou negação logo depois do termo;
  - fora de diferencial, empresa e benefício;
  - não ambígua sem qualificador;
  - **sem mistura de scripts** (T15, mitigação 4): um confundível dentro do termo rebaixa a menção para `fraca`.
- **O termo de saída é sempre o canônico do dicionário**, um conjunto fechado. Nenhum trecho da vaga sai.

### D7. `InjectionHeuristics`
- Três famílias que **se dirigem ao modelo**: vocativo, sobreposição de instruções e manipulação de nota ou de saída. Mais os marcadores de chat que sobrevivem à neutralização (lembrar que `<>` chegam como `‹›`):
  - **tokens de chat** (`‹|im_start|›`, `‹|system|›`, `[inst]`, `‹‹sys››`…) casam como **substring**, sem fronteira. No protótipo, `‹|im_start|›system` não casava, porque a letra colada no `›` quebrava a fronteira;
  - **cabeçalho de papel em markdown** (`### system`, `### instruction`, `### response`) só conta como **linha inteira**. No protótipo, `### System Design`, um título de vaga legítimo, daria `alta`.
- **`alta`** se valer qualquer uma destas condições:
  1. duas famílias diferentes no **mesmo segmento**;
  2. marcador de chat;
  3. contrabando invisível forte por classe (Tags ≥ 4, *variation selectors* fora de emoji ≥ 8, zero-width ≥ 20 ou bidi ≥ 2);
  4. ponto fixo não alcançado ou expansão NFKC suspeita.
- **`media`** com pontuação ≥ 2:
  - sinal visível isolado ou citado vale 2;
  - invisível fraco vale 1;
  - delimitador neutralizado vale 1.
- **`baixa`** nos demais casos.
- **Segmento (endurecimento do `[APPSEC]`):** no protótipo, um ataque inteiro **entre aspas** caía para `media`. Na produção, uma ocorrência fora de aspas conta no parágrafo. Uma ocorrência entre aspas conta **no próprio trecho citado**. Assim:
  - a citação de **uma** família (o `syn-08`, vaga de AppSec que dá um exemplo) continua `media`;
  - um ataque com duas famílias dentro das mesmas aspas vira `alta`.
- **O título não entra na heurística.** Ele não vai ao LLM (o `FactResolver` só o usa se passar no `safeText`).

### D8. Emenda ao ADR-005: invisíveis por classe
- `JobTextSignals.removedInvisibleByClass: { tags, zeroWidth, bidi, variationSelectors }`, somado nas passadas como o total.
- **Contagem dentro do callback da própria remoção** (etapa 4). O custo é proporcional ao número de invisíveis, e não há segunda passada sobre o texto. Uma passada a mais em JavaScript sobre o texto já expandido pelo NFKC (até 18×, ~393 mil caracteres em 64 KiB de U+FDFA) estourava o SR-09 do normalizador sob cobertura. O contexto de emoji vem do último code point visível antes de cada invisível. Regras:
  - FE0F e ZWJ depois de emoji são legítimos e não contam;
  - **a bandeira de subdivisão** (🏴 seguido de 2 a 6 tags `[a-z0-9]` e do terminador U+E007F) não conta como contrabando. O protótipo contava, e uma vaga com a bandeira da Inglaterra cairia em `alta`.
- O texto de saída não muda: o normalizador continua `n1`, e o `textHash` também.

### D9. Roteamento R1–R4 (`PreFilterRouter`, versão `rt1`)
- **Entrada:** `mode` (`auto` ou `aprofundada`), `signals`, `titleHint` (já normalizado) e `criteria: UserCriteria`. O router recebe por injeção o `FactResolver` e o `ScoringEngine`.
- **Primeiro passo:** monta os fatos **só determinísticos**:
  - `FactResolver` com `llmFacts = null` (ADR-011 D7) e `markedStackTerms = []`. Sem LLM, a stack exigida são as menções explícitas, e os termos marcados não têm uso: nenhum termo do perfil entra na fusão (minimização);
  - pontua esses fatos no **`ScoringEngine` real**, com `llmExtracted = false`.

  O resultado (`deterministic`) volta ao chamador, e o `AnalyzeJob` o reaproveita no relatório de R1 e R2 e no *fallback*.
- **R1 (`curto_circuito_rejeicao`):**
  - só no modo `auto`;
  - dispara se alguma dimensão **com sinal na Camada 1** (`stack`, `modelo_trabalho`, `senioridade`, `contrato` e `salario`) tem `dealBreakerHit` no motor.
  - **Por que pelo motor:** a rejeição sem IA herda as mesmas regras da nota (adjacência ascendente D-S5, câmbio `se1`, hora × 220, `dealBreakerScope`) e **nunca diverge dela**.
  - **Red flags ficam fora do R1:** no modo só determinístico, `salario_omitido` é ausência de evidência, não evidência. Localização, idiomas e benefícios não têm sinal.
- **R2 (`somente_deterministico`):** injection `alta`, em qualquer modo, com o aviso `possivel_prompt_injection`. R1 vem antes: o atacante só prejudica a própria vaga (S-4 §5.4).
- **R3 (`curto_circuito_aceite`):** só se valerem **todas** as condições:
  - modo `auto`;
  - flag ligada. **Padrão `shortCircuitAccept = false`** (D-H3, mantido pelo S-4 §5.6);
  - **guarda de vacuidade:** pelo menos 1 critério eliminatório ou obrigatório (modelo, senioridade, contrato, salário, localização, idiomas, benefícios ou `mustHave` não vazio). Deal-breaker de stack sozinho não conta, porque ausência não é aderência;
  - injection `baixa`;
  - nenhum `redFlagTolerance` em `penalizar` ou `eliminatorio`;
  - toda dimensão eliminatória ou obrigatória com `atende` no motor;
  - nenhum deal-breaker do usuário em **qualquer** menção, inclusive a fraca.

  Aviso `decisao_sem_ia`. A guarda vale **mesmo com a flag desligada**: é verificada antes da flag e tem teste próprio.
- **R4 (`semantica`):** nos demais casos.
- **Evidência do curto-circuito:** só a lista de dimensões (enum) e os fatos determinísticos (enums, números e termos canônicos). **Nenhum trecho da vaga.** Isso refina o ADR-001 §5.3, que falava em "trecho e termo encontrado": o trecho seria texto bruto na saída.

## 3. Auditoria `[APPSEC]` (antes do código)

| Requisito | Critério de aceite |
|---|---|
| **SR-09** (200 ms para 64 KiB, sem afrouxar) | Cada entrada patológica, no melhor de 3, passa pelo pré-filtro **direto** (texto de 64 KiB que não passou pelo corte do normalizador) e pela cadeia normalizador → pré-filtro. São 20 formas: os 8 do S-4 mais linha única com muitas ocorrências de termo, de negação, de modelo, de PJ, de valores, de aspas, de confundíveis, de títulos, de quebras de linha, de dígitos e de ambíguos |
| **SR-04** (controles negativos) | `gupy-19`, `geekhunter-07` e `syn-09` em `baixa`; `syn-08` em `media`; nenhuma vaga benigna do `gd1` em `alta`. Testes unitários com vagas de AppSec que citam a técnica e com o ataque citado de uma família |
| **Nenhum texto de vaga na saída** | A saída tem só enums, números e canônicos do dicionário. Prova por propriedade: texto arbitrário com canário nunca põe o canário na saída serializada; todo `term` pertence ao dicionário; o salário vale no `SalaryFactsSchema`. No `gd1`, nenhuma linha de vaga com 25 caracteres ou mais aparece na saída |
| **T15** | Confundível dentro do termo nunca dá menção explícita; a dobra pega "РНР" como PHP fraco |
| **R1 seguro** | R1 ⊆ deal-breaker do motor nos mesmos fatos; red flag nunca dispara R1; modo `aprofundada` nunca dá R1 nem R3 e sempre respeita o R2 |
| **R3** | Flag desligada nunca dá R3; com a flag ligada, a guarda de vacuidade barra o perfil "só ponderado" (p8) |
| **Pureza** | Preset `domainPurity`; sem logger; nenhum dado do perfil sai além dos termos marcados já presentes no texto (ADR-011 D5) |

- **Risco residual aceito:** um ataque dividido em vários trechos citados, cada um com uma família, fica em `media`. A IA é chamada com confiança × 0,5 e sem cache, e a guarda de saída (ADR-008) segue valendo. Com isso, o R2 continua sendo defesa em profundidade, não a única barreira.
- **Veto não exercido.**

## 4. Consequências
- O `AnalyzeJob` (F1-API-04) chama:
  1. `normalize` e `normalizeTitle`;
  2. `extract`;
  3. `route`.

  Ele usa `decision.deterministic` nos caminhos sem IA.
- **Emendas não adotadas** (YAGNI):
  - `context` na menção de stack (ADR-011, opcional no S-4): o R1 usa só a menção explícita;
  - `yearsExperienceMin` e idiomas: continuam com o LLM.
- **Aceite no `gd1`:** o teste `evals/test/layer1-acceptance.test.ts` roda a produção e o protótipo lado a lado e exige métricas iguais ou melhores que as do S-4.

## 5. Resultado (F1-DOM-04, 2026-10-22)
- **Código:**
  - `apps/api/src/domain/prefilter/` com 9 módulos: dobra e casamento, contexto de linha, `TechDictionary` `td1`, stack, conjuntos, salário, injection, `DeterministicPreFilter` `pf1` e `PreFilterRouter` `rt1`;
  - emenda D8 no `invisible-characters.ts` e no normalizador (`removedInvisibleByClass`; o texto continua `n1`).
- **Aceite no `gd1`** (`evals/test/layer1-acceptance.test.ts`, no `pnpm test` do `@trampo/evals`):
  - os sinais de produção são **idênticos** aos do protótipo do S-4 nos 83 casos (só a ordem da stack muda, sem locale);
  - falso "foge" 0 em 3.191 disparos da varredura e 0 nas 8 personas;
  - precisão de 100% nos explícitos de modelo (72/72), contrato (51/51), senioridade (56/56), salário (19/19) e stack (338/338);
  - injection 7/7 em `alta`; controles negativos `gupy-19`, `geekhunter-07` e `syn-09` em `baixa` e `syn-08` em `media`; nenhuma vaga benigna em `alta`;
  - o R1 de produção (motor real) rejeita exatamente o mesmo número de vagas que o R1 do S-4 em cada persona, com 0 falsa; o R3 nunca dispara com a flag desligada, e com ela ligada a guarda barra o p8.
- **Testes:** API com 1.712 testes (285 novos), 100% de linhas e ramos (1.914/1.914 e 1.577/1.577); 6 propriedades com 1.000 execuções; SR-09 com 24 formas × 2 caminhos, pior caso ~70 ms sem cobertura.
- **Defeitos achados e corrigidos:**
  - a fronteira de palavra (D2) deixava passar ataque colado em pontuação não ASCII;
  - tokens de chat colados não casavam, e `### System Design` daria `alta` (D7);
  - a contagem por classe numa segunda passada estourava o SR-09 do normalizador (D8);
  - `classifyLines` custava 133 ms sob cobertura em 64 KiB de quebras de linha; caiu para 10 ms sem mudar o resultado.
- **Mutação, 1ª rodada (2026-10-22):**
  - 102 dos 131 mutantes rodaram antes de o Claude Code parar o processo por falta de memória na máquina; 99 morreram;
  - os 3 sobreviventes são **equivalentes**: a ordem minúsculas/NFD (o código voltou à ordem do protótipo) e as duas bordas da busca do trecho citado (nenhum padrão começa ou termina em aspa);
  - um mutante (R5) ficou aplicado quando o processo caiu; foi detectado pela conferência do texto original e restaurado antes do gate.
- **Mutação, 2ª rodada (2026-10-22, sessão seguinte):**
  - o script da 1ª rodada estava num diretório temporário que não existia mais. Os IDs R5–R17, P1–P2 e V1–V14 foram **reconstruídos a partir do código**, e a rodada ganhou 13 mutantes extras (R18–R23, P3 e V15–V18). Total: **42 mutantes**;
  - execução: um mutante por vez, em primeiro plano, em lotes de 6 a 9; vitest sem cobertura, com um worker só e apenas os arquivos de teste do alvo; script fora do repositório e de `coverage/`; sha256 do original conferido antes e depois de cada mutante, e `git diff` dos alvos vazio depois de cada lote. A máquina tinha ~1 GB de RAM livre;
  - **3 sobreviventes na primeira passada, e todos viraram teste:**
    - **R5** (`llmOutputInjection: true` no resolver): lacuna real. O resolver punha `possivel_prompt_injection` nos avisos de uma vaga limpa, e o `AnalyzeJob` reaproveitaria esse aviso no relatório. Teste novo: vaga limpa sem aviso, e o aviso só vem do sinal `media`;
    - **R6** (termos `mustHave` do perfil como `markedStackTerms`): não muda a nota, porque com `llmFacts = null` os termos marcados não são lidos, mas fere a minimização do D9. Teste novo: um resolver espião confere a entrada **exata** (`llmFacts: null`, `llmOutputInjection: false`, `markedStackTerms: []`);
    - **R14** (sem o `hasMustCriterion` no R3): equivalente com o motor atual, porque sem critério obrigatório a única dimensão estrita possível é a stack com deal-breaker (que dá `nao_atende`) ou as red flags (barradas antes). A guarda fica no código porque é exigência explícita do D9 e não pode depender de um detalhe do motor. Teste novo, com um motor que promove o modelo ponderado a obrigatório: o perfil só ponderado continua sem aceite;
  - **1 equivalente documentado:** **V18** (o normalizador pegar as classes só da 1ª passada em vez de somar). Prova exaustiva: nenhum code point de U+0000 a U+10FFFF, e nenhum dos 1.481.320 pares base + invisível + marca combinante, deixa invisível para a 2ª passada (o NFKC roda antes da remoção). A soma fica, para espelhar o total do `n1` (D8);
  - **resultado:** 41/42 mortos e 1 equivalente.
- **Mutação total do F1-DOM-04:** 144 mutantes, 140 mortos e 4 equivalentes documentados.
- **Testes depois da 2ª rodada:** API com 1.715 testes (3 novos), 100% de linhas, ramos, funções e statements (1.914/1.914 e 1.577/1.577); `tsc` e `eslint` verdes.
- **Gate:** turbo `build lint typecheck test --concurrency=1 --force` 18/18; depcruise sem violações (307 módulos).
