---
tipo: adr
id: ADR-011
titulo: "Porta DeterministicSignals (contrato do consumidor) e FactResolver (E6): fusão Camada 1 × Camada 2, proveniência e confiança efetiva"
status: aceito
aprovacao: "Decisão do humano no HITL-014 (opção A, 2026-10-19). Decisão técnica interna ([ARCHITECT] + [APPSEC]) dentro do ADR-001 §5.3 e §5.6. Não muda contrato público."
data: 2026-10-19
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-DOM-05 (apps/api/src/domain/fusion e apps/api/src/domain/ports/deterministic-signals.ts)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[contratos-zod](../contratos-zod.md)", "[threat-model](../threat-model.md)", "[ADR-005-job-text-normalizer](ADR-005-job-text-normalizer.md)", "[ADR-008-llm-output-guard](ADR-008-llm-output-guard.md)", "*HITL-QUEUE §HITL-014*", "*BACKLOG §F1-DOM-04*", "*BACKLOG §F1-DOM-05*"]
---

# ADR-011: porta `DeterministicSignals` e `FactResolver` (E6)

## 1. Contexto

O `FactResolver` (ADR-001 §5.6) funde os fatos do LLM, já aprovados pela guarda E5 ([ADR-008-llm-output-guard](ADR-008-llm-output-guard.md)), com os sinais da Camada 1. Quem produz esses sinais é o `DeterministicPreFilter` (F1-DOM-04), ⛔ pelo S-4 (HITL-003). No HITL-014 o humano escolheu **adiantar a fusão**: este ADR fixa a porta pelo lado de quem **consome** (o resolver), e o F1-DOM-04 passa a implementá-la. Se o S-4 pedir outro formato, a porta muda por emenda a este ADR.

## 2. Decisões

### D1. A porta é um tipo de dados no domínio, sem zod
- `apps/api/src/domain/ports/deterministic-signals.ts`, só tipos (`import type` dos enums do contrato):
```ts
type SignalStrength = 'explicita' | 'fraca';
interface SetSignal<T> { values: readonly T[]; strength: SignalStrength }
interface DeterministicSignals {
  workModels: SetSignal<WorkModel> | null;
  contractTypes: SetSignal<ContractType> | null;
  seniorityLevels: SetSignal<SeniorityLevel> | null;
  salary: { value: SalaryFacts; strength: SignalStrength } | null;
  stackMentions: readonly { term: string; strength: SignalStrength }[]; // grafia canônica do TechDictionary
  injectionLevel: 'baixa' | 'media' | 'alta';
}
```
- **Independente do usuário** (ADR-001 §5.3): função do texto e da versão do pré-filtro. Os termos marcados pelo usuário entram no resolver por **outro parâmetro** (D5).
- `explicita` segue a tabela do §5.3 (família única de modelo; salário com valor e período; stack não negada, fora de diferencial e não ambígua). **O resolver ignora sinal `fraco`**: ele não preenche campo nem gera conflito. O sinal fraco serve ao roteamento (R3) do F1-DOM-04.
- **Fica de fora, de propósito (YAGNI do consumidor):** trecho de evidência (é do relatório de curto-circuito, F1-DOM-03/04), contagens brutas de injection (o F1-DOM-04 as reduz ao nível), `yearsExperienceMin` e idiomas (a corroboração desses campos entra por emenda quando o S-4 mostrar que vale).

### D2. Entrada e saída do resolver
```ts
new FactResolver({ isSafeTitle, policy? }).resolve({
  llmFacts: JobFacts | null,        // null = curto-circuito ou fallback
  llmOutputInjection: boolean,      // LlmOutputSanitization.injectionSignal (ADR-008)
  signals: DeterministicSignals,
  titleHint: string | null,         // já passado no normalizeTitle (ADR-001 §5.2, item 5)
  markedStackTerms: readonly string[], // só mustHave ∪ dealBreakers do usuário, no máximo 30
}): { facts: ResolvedJobFacts; provenance: Record<FactField, FactProvenance>;
      effectiveConfidence: number; warnings: readonly AnalysisWarning[];
      conflicts: readonly FactField[]; resolverVersion: 'fr1' }
```
- `isSafeTitle` é injetado (o domínio não roda zod): a aplicação passa `safeText(JOB_TITLE_MAX_CHARS).safeParse(...).success`.
- Puro: sem I/O, sem relógio, sem aleatoriedade, sem mutar a entrada. Mesma entrada, mesma saída.
- `resolverVersion` **não** entra no `extractorVersion`: o cache guarda `JobFacts` brutos, e a fusão roda a cada requisição.

### D3. Conjuntos (`workModels`, `contractTypes`, `seniorityLevels`)
Com `D` = valores do sinal **explícito** (vazio se ausente ou fraco) e `L` = valores do LLM:

| Caso | Resultado | Proveniência |
|---|---|---|
| `D` vazio | `L` | `llm` (ou `ausente` se `L` vazio) |
| `L` vazio | `D` | `deterministico` |
| `D ∩ L ≠ ∅` (inclui `L ⊇ D`) | `L`, depois o que só `D` tem | `deterministico_e_llm` |
| `D ∩ L = ∅` | `[]` + conflito | `conflito` |
| união acima do teto do contrato (senioridade: 3) | `[]` + conflito | `conflito` |

- **Refina o §5.6**, que não cobria sobreposição parcial: a união preserva a evidência explícita (omissão do LLM não apaga) e mantém o que o LLM viu além dela, como o caso `L ⊇ D` já fazia.

### D4. Salário
- Comparável quando os dois existem. Moeda e período: se os dois lados têm valor e diferem, **conflito**; se um é `null`, o outro preenche.
- Valores como intervalo `[min ?? max, max ?? min]`. Concordam se cada ponta difere no máximo `salaryTolerance` (5%) da maior das duas.
- Concordância: vale o valor do LLM, com moeda e período completados pelo determinístico (`deterministico_e_llm`). Conflito: `null` + aviso. Um só lado: vale ele.

### D5. Stack e termos marcados (LGPD)
- A classificação do LLM (exigida ou desejável) prevalece.
- Um termo marcado pelo usuário que **aparece como menção explícita** no sinal e que o LLM **omitiu das duas listas** entra no fim de `stackRequired`, com a **grafia do dicionário** (nunca a do usuário) e proveniência `deterministico` (ou `deterministico_e_llm` se o LLM tinha itens). Comparação sem diferenciar maiúsculas.
- Se o teto de 30 estourar, saem itens **não marcados** do fim da lista do LLM; os marcados ficam.
- **Um termo marcado que não está no texto nunca aparece na saída.** O perfil só filtra; não é fonte de fato.
- `markedStackTerms` com mais de 30 itens: `RangeError` (falha fechado).

### D6. Título, red flags e demais campos
- Título: `titleHint` se não for nulo e passar no `isSafeTitle` (`deterministico`); senão, o do LLM (`llm`).
- `redFlagSignals`: os do LLM **sem** `salario_omitido`; o código o acrescenta se e só se o salário final for `null`.
- `yearsExperienceMin`, `location`, `stackNiceToHave`, `benefits`, `languageRequirements`: do LLM (`llm` ou `ausente`).

### D7. Modo só determinístico e injection `alta`
- `llmFacts = null`: os campos de D3 e D4 vêm dos sinais explícitos; a stack exigida são as menções explícitas (sem duplicatas, até 30); o resto é vazio ou `null`. `effectiveConfidence = 0` (nenhuma extração corroborada) e **sem** `baixa_confianca_extracao`: quem avisa a degradação é o `AnalyzeJob` (`analise_degradada`).
- `injectionLevel = 'alta'` com `llmFacts` presente não deveria ocorrer (R2 não chama o LLM). **Defesa em profundidade:** os fatos do LLM são descartados e o resolver segue o modo só determinístico.

### D8. Confiança efetiva e avisos
- `corroboração = 1 − divergências / max(1, comparáveis)`. Comparáveis: cada campo de D3 e D4 com os dois lados presentes, mais a stack quando algum termo marcado tem menção explícita. Divergências: os conflitos, mais a stack quando o LLM omitiu algum desses termos.
- `effectiveConfidence = min(extractionConfidence, corroboração) × (injection ? mediumInjectionFactor : 1)`, onde `injection` = nível `media` **ou** `llmOutputInjection`.
- Avisos: `informacao_contraditoria` se houve conflito; `baixa_confianca_extracao` se a confiança ficou abaixo de `lowConfidenceThreshold` (com LLM); `possivel_prompt_injection` se o nível é `media` ou `alta` ou se a saída do LLM foi saneada.
- `extractionConfidence` fora de [0, 1] ou não finita: `DependencyContractError` (a guarda deveria ter barrado).

### D9. Limiares são hipóteses calibráveis
`FactResolverPolicy` com padrão `{ salaryTolerance: 0.05, lowConfidenceThreshold: 0.4, mediumInjectionFactor: 0.5 }`, injetável. Fora de faixa (`salaryTolerance` em [0; 0,5], os outros em [0; 1]): `RangeError` no construtor. A calibração sai do golden dataset (P0-EVL-01, S-4).

## 3. Auditoria `[APPSEC]`
- **Omissão suspeita não apaga evidência** (D3, D5): prova por propriedade (todo termo marcado com menção explícita está na saída).
- **Conflito vira "não informado" mais aviso** (D3, D4): o `ScoringEngine` trata como must-have violado (ADR-001 §5.7), nunca como aprovação silenciosa.
- **Injection reduz a confiança** (D8) e, em `alta`, a saída do LLM é descartada (D7). Confiança menor que 0,5 também impede o cache (ADR-001 §5.4).
- **LGPD:** o resolver só recebe os termos marcados, nunca o perfil inteiro; a saída usa a grafia do dicionário e nunca contém termo do usuário ausente do texto (prova por propriedade). Nada é registrado em log.
- **Saída validável:** os testes passam toda saída pelo `ResolvedJobFactsSchema` e pelo `FactProvenanceSchema`; o `AnalyzeJob` revalida o relatório inteiro (ADR-001 §5.8).
- **Veto não exercido.**

## 4. Consequências
- O F1-DOM-04 nasce com o alvo definido: produzir `DeterministicSignals`. Retrabalho esperado pequeno se o S-4 mudar a forma.
- O `AnalyzeJob` passa a ter uma única função que monta `ResolvedJobFacts`, nos dois caminhos (LLM e fallback).
