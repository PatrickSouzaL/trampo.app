---
tipo: adr
id: ADR-006
titulo: "RelevantSectionSelector: micro-payload do LLM por blocos, com descarte de contato e de diretivas ao modelo"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]), dentro do ADR-001 aprovado no HITL-001. Não muda contrato público."
data: 2026-10-19
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-DOM-01, parte 2 (apps/api/src/domain/selection)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-005-job-text-normalizer](ADR-005-job-text-normalizer.md)", "[threat-model](../threat-model.md)", "[revisao-adversarial-M1](../revisao-adversarial-M1.md)", "*BACKLOG*"]
---

# ADR-006: `RelevantSectionSelector`

## 1. Contexto

O ADR-001 §5.5 define o micro-payload: o seletor reduz o texto normalizado ao orçamento `LLM_INPUT_MAX_CHARS`, que é a principal alavanca de capacidade do free tier (§8). A ordem de prioridade é:

1. cabeçalho (~300);
2. blocos relevantes;
3. blocos não classificados;
4. *boilerplate*.

Blocos com salário ou modelo de trabalho ficam sempre, a ordem original é mantida e as remoções são marcadas com `[…]`. A revisão M1.6 (F-04) acrescenta que **blocos de contato são descartados**, porque nomes de pessoas não são mascaráveis.

## 2. Decisões

### D1. Entrada, saída e invariantes

- **A entrada é um `NormalizedJobText`** (saída do [JobTextNormalizer](ADR-005-job-text-normalizer.md)), e não uma string qualquer. O seletor confia na forma canônica: linhas aparadas, no máximo uma linha em branco seguida, sem invisíveis e com PII já mascarada.
- **A saída é feita só de blocos inteiros da entrada, ou de um prefixo de um bloco, mais o marcador `[…]`.** O seletor **nunca reintroduz** conteúdo removido pelo normalizador nem gera texto próprio.
- **O marcador `[…]` usa U+2026, e a vaga não consegue forjá-lo:** o NFKC da entrada transforma "…" em "...". Assim, o LLM sabe que `[…]` vem de nós.
- **Teto rígido:** a saída nunca passa de `budgetChars` code points. A garantia vem da contabilidade: cada bloco custa o seu tamanho mais 5 (separador ou marcador), e 3 ficam reservados para os marcadores das pontas. Um teste de propriedade prova o teto.
- **Determinismo:** função pura do texto, da versão e do orçamento.

### D2. Segmentação

- O texto é lido por linhas. Um bloco novo começa em:
  - uma **linha em branco**;
  - uma **linha de título**;
  - um **item de lista** (`-`, `*`, `•`, `+`, `›`, `▪`, `◦`, `1.`, `1)`).
- **Título** é uma linha que, depois de tirar marcadores (`#`, `*`, `•`, `›`, `-`) e acentos, **começa** com um termo do dicionário e termina em até 40 caracteres ou num `:`. Exemplos: "Requisitos", "**Requisitos obrigatórios**:" e "Salário: R$ 5.000". Um título inaugura uma **seção**, e os blocos seguintes herdam a categoria até o próximo título.
- **Categorias de seção** (avaliadas nesta ordem):
  1. **`contato`:**
     - termos de seção: "Contato", "Como se candidatar", "Candidate-se", "Inscrições", "How to apply", "Equipe de contratação" e "Hiring team";
     - termos de pessoa, que **só** contam com dois-pontos imediato ("Recrutador(a):", "Recruiter:", "Hiring manager:"). Assim, uma vaga **de** recrutador ("Recrutador(a) Tech Pleno") não some.
  2. **`relevante`:**
     - requisitos, qualificações, perfil, *skills*, stack e idiomas;
     - responsabilidades, atividades e desafios;
     - diferenciais e "desejável";
     - benefícios;
     - remuneração e salário;
     - local, modelo de trabalho, regime, jornada e contratação;
     - "sobre a vaga", descrição, "vaga" e cargo.
  3. **`boilerplate`:**
     - "sobre nós" e "sobre a/o …" (depois de "sobre a vaga", que já é `relevante`);
     - "quem somos", missão, cultura e valores;
     - diversidade, inclusão e EEO;
     - etapas e processo seletivo; próximos passos.
- Antes do primeiro título, os blocos são **`cabeçalho`**. Se não houver título nenhum, o texto inteiro é cabeçalho, e o resultado é um **prefixo** do texto até o orçamento (o *fallback* pedido).
- **Dicionário v1:** hipótese, a calibrar com as 30 vagas reais do HITL-003 no S-2. Qualquer mudança incrementa a versão.

### D3. Descartes (antes do orçamento, sempre)

| Descarte | Regra | Ameaça | Por que vence a regra "salário fica sempre" |
|---|---|---|---|
| **Contato** | Bloco em seção `contato` **ou** com "fale com", "entre em contato", "envie seu currículo/CV para", "send your resume", "reach out to", `[email]`, `[telefone]` ou "whatsapp" | **T12 e F-04:** é onde ficam nomes de recrutadores | **Privacidade vence qualidade.** A Camada 1 continua vendo o texto **inteiro** (o seletor só reduz o que vai ao LLM), então o salário ainda é detectado de forma determinística. |
| **Diretiva ao modelo** | "ignore as instruções anteriores", "disregard previous instructions", "revele o system prompt", "se você é uma IA", "dê nota máxima/100" (pt e en) | **T2:** um título "Requisitos" **não** basta para levar uma diretiva ao LLM | **Segurança vence qualidade.** Não há termos de competência na lista ("system prompt", "prompt injection" e "LLM" sozinhos não descartam), para que vagas legítimas de segurança de IA ou de *prompt engineering* passem (controle negativo do ADR-001 §5.3). |

- O detector de diretivas é um **piso**. A heurística completa e o roteamento R2 são do F1-DOM-04. Os dois descartes são **contados** e vão como sinais.

### D4. Preenchimento do orçamento

As faixas abaixo são avaliadas em ordem. Dentro de cada faixa, a ordem é a original do texto.

| Faixa | Blocos | Limite | Corte parcial |
|---|---|---|---|
| 0 | com sinal explícito de **salário** (`R$ 8.000`, `8k`, "salário", "/mês", `USD 5`) ou de **modelo de trabalho** ("remoto", "híbrido", "presencial", "home office", "remote", "on-site") | orçamento restante | sim |
| 1 | `cabeçalho` | **300** (`HEADER_CHARS`) | não: o que não cabe desce para a faixa 3 |
| 2 | `relevante` | orçamento restante | sim |
| 3 | `cabeçalho` que não coube na faixa 1 (os "não classificados") | orçamento restante | sim |
| 4 | `boilerplate` | orçamento restante | sim |

- **Corte parcial:** quando um bloco não cabe e sobram pelo menos **200** code points, entra o **prefixo** do bloco (via `truncateCodePoints` injetado, com o teto conferido) seguido de `[…]`. Isso evita perder um parágrafo grande de requisitos por inteiro e faz do *fallback* sem títulos um prefixo do texto, e não só 300 caracteres.
- **Montagem:** os blocos escolhidos voltam na **ordem original**. Entre blocos vizinhos fica o separador original (`\n` ou `\n\n`); onde houve omissão, entra `\n[…]\n`. Também há `[…]` no começo, se o primeiro bloco ficou de fora, e no fim, se o último ficou de fora ou foi cortado.

### D5. Orçamento e versão

- `LLM_INPUT_MAX_CHARS = 6.000` (hipótese do ADR-001 §5.5; calibrar no S-1).
- O orçamento é **parâmetro do construtor** porque será calibrado por ambiente. Ele **falha fechado**: um valor fora de `[1.000, JOB_TEXT_MAX_CHARS]` ou não inteiro lança `RangeError` na construção.
- O orçamento **não** entra na versão do seletor, porque já é componente próprio do `extractorVersion` (ADR-001 §5.4).
- `RELEVANT_SECTION_SELECTOR_VERSION = "sel1"`. Qualquer mudança de dicionário, regra ou faixa incrementa a versão.
- **Sinais devolvidos:**
  - `totalBlocks` e `selectedBlocks`;
  - `partialBlock`;
  - `headingsFound`;
  - `droppedContactBlocks` e `droppedDirectiveBlocks`;
  - `omittedForBudgetBlocks`.

### D6. Reaproveitamento da parte 1

- `countCodePoints`, o erro de dependência e o corte com o teto conferido saem do normalizador para `domain/text/code-points.ts`, compartilhado pelos dois.
- O erro passa a se chamar **`DependencyContractError`**. O comportamento do normalizador **não muda**, e a versão `n1` continua.

## 3. Consequências

- **Positivas:**
  - o payload do LLM tem teto rígido e conteúdo priorizado;
  - blocos de contato e diretivas explícitas não chegam ao provedor;
  - o marcador de omissão não pode ser forjado;
  - o *fallback* sem títulos é um prefixo do texto.
- **Negativas:**
  - o dicionário v1 é heurístico: um título fora dele faz a seção herdar a categoria anterior. A calibração vem no S-2 (HITL-003);
  - um bloco de contato com salário perde o salário **só no payload do LLM**; a Camada 1 continua vendo;
  - um nome de pessoa fora de bloco de contato ("a gestora Maria vai liderar…") continua como resíduo de T12.
