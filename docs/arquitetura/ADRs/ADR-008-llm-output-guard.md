---
tipo: adr
id: ADR-008
titulo: "LlmOutputGuard (E5): teto de 8 KiB antes do parse, parse nativo com rejeição de __proto__/constructor, pré-saneamento contado e JobFactsSchema estrito"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]), dentro do ADR-001 §5.5 e do contratos-zod §5 aprovados no HITL-001. Não muda contrato público."
data: 2026-10-19
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-LLM-01, parte 1 (apps/api/src/application/llm)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[contratos-zod](../contratos-zod.md)", "[threat-model](../threat-model.md)", "[ADR-005-job-text-normalizer](ADR-005-job-text-normalizer.md)", "*BACKLOG*"]
---

# ADR-008: `LlmOutputGuard` (E5)

## 1. Contexto

A saída do LLM é **dado não confiável**, no mesmo nível do texto da vaga: o anunciante controla a entrada do modelo e, por *prompt injection*, influencia a saída (T1, T2, T6). O ADR-001 põe a guarda de saída (E5) entre a Camada 2 e a fusão. O contratos-zod §5.3 já esboçou o pipeline: tamanho → parse seguro → pré-saneamento → `JobFactsSchema`.

Esta tarefa implementa **só** o guard. O adapter do Groq (F1-LLM-01, parte 2) depende do S-1, e o router fica na F1-LLM-03. O SR-01 (o corpo da requisição nunca tem `tools`) é prova do adapter e fica na parte 2.

## 2. Decisões

### D1. Onde o guard mora: `application`, não domínio nem infraestrutura
- **Não pode ser domínio:** o preset de pureza proíbe zod em runtime no domínio (ADR-005 D3), e o portão final é o `JobFactsSchema`.
- **Refinamento do contratos-zod §5.3**, que dizia "infraestrutura": o guard é **política** de segurança, igual para todo provedor, sem I/O. Fica em `apps/api/src/application/llm/llm-output-guard.ts`. Os adapters de infraestrutura (Groq, Cloudflare) chamam o guard, e a dependência continua apontando para dentro.
- **Fronteira nova no dependency-cruiser:** `application` não importa `infrastructure`, `presentation` nem `main.ts`, e os únicos pacotes que importa são `zod` e `@trampo/contracts`. Sem módulos do Node.
- O guard reusa, sem cópia, os padrões **canônicos** do contrato: `INVISIBLE_OR_CONTROL`, `containsUrlLike`, `TECH_TAG_PATTERN` e `truncateCodePoints` (`@trampo/contracts/primitives`). A defesa do saneamento e a do `safeText` usam a mesma lista.

### D2. Porta de entrada e resultado fechado
```ts
new LlmOutputGuard().inspect(raw: string): LlmOutputGuardResult
type LlmOutputGuardResult =
  | { ok: true; facts: JobFacts; sanitization: LlmOutputSanitization }
  | { ok: false; reason: 'resposta_grande_demais' | 'json_invalido' | 'poluicao_de_prototipo' | 'schema_invalido' };
```
- Entrada: **só** a string bruta do provedor. Não há parâmetro para perfil, critérios, `userId` ou token (LGPD, D2 do ADR-001), e o guard não tem dependências injetadas.
- **Nunca lança.** Entrada que não é string vira `json_invalido`. Qualquer exceção do parse vira `json_invalido`.
- **A falha carrega só o motivo.** Sem mensagem, sem *issues* do Zod e sem trecho da resposta. O guard **não tem logger**. Quem registra métrica registra o motivo, que é um enum fechado, e nunca o texto do LLM (SR-12).
- O adapter mapeia qualquer falha para `saida_invalida` do `ExtractionOutcome` (ADR-001 §5.5), e o fluxo segue para o fallback determinístico.
  > **Refinado pelo [ADR-009-llm-provider-router](ADR-009-llm-provider-router.md) D2 (2026-10-19):** quem chama o guard é o **router**, não o adapter. O adapter devolve a resposta bruta, e assim nenhum provedor entrega fatos sem passar pela guarda.
- Versão: `LLM_OUTPUT_GUARD_VERSION = 'g1'`. Ela entra no `extractorVersion` da chave de cache (F1-CACHE-01), porque mudar o saneamento muda os fatos.

### D3. Teto de 8 KiB em bytes UTF-8, antes do parse
- `LLM_OUTPUT_MAX_BYTES = 8_192`, a hipótese do contratos-zod §5.3.
- Atalho sem varrer: se `raw.length > 8.192` unidades UTF-16, os bytes passam do teto, porque cada unidade custa pelo menos 1 byte. Senão, a contagem exata para no primeiro byte acima do teto.
- **Por que não o máximo do schema:** um `JobFacts` válido no limite de todo campo (60 tags de 40 code points de 4 bytes) passa de 12 KB. Isso é inalcançável com o teto de tokens de saída (hipótese de 450, ADR-001 §5.5), que dá cerca de 2 KB. Um teste prova que uma saída realista "cheia" (todos os campos, 30 + 30 tags de tamanho normal, idiomas e benefícios) cabe com folga. A calibração final é do S-1.

### D4. Parse nativo com *reviver*, no lugar do `secure-json-parse`
- `JSON.parse(raw, reviver)`. O *reviver* **lança** ao ver a chave `__proto__` ou `constructor` em qualquer nível. Isso vira `poluicao_de_prototipo`.
- **Por que não o `secure-json-parse`:** ele seria dependência direta nova da API. O *reviver* recebe a chave **já decodificada**, então a forma escapada (`"__proto__"`) também é pega sem regex, e nenhum `JobFacts` legítimo tem essas chaves. É mais estrito que o `constructorAction` do `secure-json-parse`, que só recusa `constructor` com `prototype` dentro.
- O `JSON.parse` do V8 grava `__proto__` como propriedade própria, sem tocar no protótipo. A rejeição é defesa em profundidade, e o motivo separado serve de métrica de ataque.
- Sem `eval`, sem `Function` e sem "conserto" de JSON: cerca de markdown, JSON truncado, BOM e vírgula sobrando dão `json_invalido`.
- `1e400` vira `Infinity` no parse, e o `z.number()` do Zod 4 recusa valor não finito. `1e308` passa do parse e cai no `max` do schema.

### D5. Pré-saneamento: sem conversão de tipo, e toda mudança contada
O prompt da tarefa pede "sem coerção silenciosa", e o contratos-zod §5.3 pede cortar e deduplicar arrays. A conciliação:
- **Nenhuma conversão de tipo:** o saneamento só mexe em valor do tipo esperado. Número no `title`, string em `yearsExperienceMin`, objeto dentro de `stackRequired`: o valor fica como veio, e o Zod reprova.
- **Nada é silencioso:** toda mudança entra em `LlmOutputSanitization`, devolvido com os fatos.

| Campo | Saneamento |
|---|---|
| Texto livre (`title`, até 200; `location.city`, até 80) | `toWellFormed` → NFKC → todo espaço Unicode vira um espaço → remove invisíveis e controles (lista do contrato) → remove `<` e `>` → corta no teto em code points → **remove o token inteiro** (entre espaços) que pareça URL, esquema (`javascript:`, `data:`) ou e-mail → colapsa espaços e apara → **NFKC de novo**. Vazio vira `null`. Se a `city` some e `stateUf` e `countryIso2` são `null`, a `location` inteira vira `null` ("não informado"). |
| Tags (`stackRequired`, `stackNiceToHave`) | Por item: `toWellFormed` → NFKC → apara. Item com URL é **removido**, item com invisível ou `<>` é **removido**, e item fora do `TECH_TAG_PATTERN` é **removido**. Nunca se removem caracteres de dentro de uma tag: `"Node.js<x>"` não vira `"Node.jsx"`. Depois, duplicatas sem diferenciar caixa (fica a primeira) e corte no máximo do schema. |
| Arrays de enum (`seniorityLevels`, `workModels`, `contractTypes`, `benefits`, `redFlagSignals`) | Duplicatas exatas removidas e corte no máximo. O valor fora do enum **não** é removido: o Zod reprova. |
| `languageRequirements` | Só o corte em 5. Idioma repetido continua reprovando no Zod. |
| Números, booleanos, `salary`, `extractionConfidence`, chaves | Intocados. |

- **Ordem do texto livre, e por quê:**
  - `<` e `>` saem antes da busca de URL, porque `javascript<:` viraria `javascript:` depois;
  - o corte vem antes da busca de URL, porque cortar `x.cnz` em `x.cn` cria um domínio;
  - o NFKC final recompõe sequências que a remoção de um invisível separou. Isso deixa a saída idempotente, e um teste de propriedade prova.
- **Uma passada, com o Zod como portão final:** se algum caso escapar do saneamento, o `safeText` reprova (`schema_invalido`) e a falha é fechada.
- **Sinal de injection:** `injectionSignal = urlsRemoved + hiddenOrMarkupRemoved > 0`. Pelo contratos-zod §5.4, essa saída **não vai ao cache** (SR-08, F1-CACHE-01) e gera o aviso `possivel_prompt_injection` (F1-API-04). Duplicatas, cortes, itens malformados e truncamento são contados, mas não são sinal de injection.
- **Sobreposição entre `stackRequired` e `stackNiceToHave` não é resolvida:** escolher um lado é decisão semântica. O Zod reprova, e o S-1 mede a frequência.
- Os tetos de array ficam numa tabela no guard. Um teste compara essa tabela com o `maxItems` e o `maxLength` do `z.toJSONSchema(JobFactsSchema)`: se o contrato mudar, o teste quebra.

> **Emendado pelo `g3` (§5, 2026-10-25, *HITL-QUEUE §HITL-028* 4A):** nos arrays de enum, a string fora do enum **sai**, contada e sem virar outro valor; `null` num campo de array vira `[]`; e `location` com exatamente as três chaves nulas vira `null`. Os três são contados no `sanitization` e ficam fora do `injectionSignal`.

### D6. Validação final
- `JobFactsSchema.safeParse` estrito: chave extra, chave faltando, tipo trocado, enum desconhecido, número fora da faixa e refinamento violado dão `schema_invalido`.
- Sem `z.coerce`, sem `default` e sem `catch`. O objeto devolvido é o que o Zod constrói, com protótipo padrão.

## 3. Consequências
- **Positivas:**
  - um ponto único e provado entre qualquer provedor e o resto do funil;
  - o T6 (URL de phishing) fica fechado em duas camadas, saneamento e `safeText`;
  - o sinal de injection fica disponível para o cache e o relatório;
  - nenhuma dependência nova.
- **Negativas:** o teto de 8 KiB e os cortes podem descartar saídas legítimas extremas, que caem no fallback determinístico. O S-1 calibra o teto.
- **Residual:**
  - chave JSON duplicada: o `JSON.parse` fica com a última. Como o guard é o **único** parser da saída, não há divergência entre parsers a explorar;
  - um fato distorcido que passa no schema (T1 residual) segue para a fusão com a Camada 1 e para a nota determinística.

## 4. Verificação
Prova em `apps/api/test/application/llm-output-guard*.test.ts`:
- **Saídas maliciosas:** JSON gigante e um byte acima do teto; *proto poisoning* em todas as formas; chaves extras; URLs e `javascript:` nos textos e nas tags; invisíveis; `1e308`, `1e400` e `"NaN"`; arrays enormes; tipos trocados; JSON truncado.
- **Propriedades no fast-check:**
  - nunca lança;
  - saída ok passa no `JobFactsSchema`;
  - saída ok nunca contém URL;
  - é idempotente;
  - a falha não ecoa a entrada.
- **Cobertura de 100%** e mutação manual.

## 5. Emenda `g3` ao D5 (2026-10-25, *HITL-QUEUE §HITL-028* 4A)

### 5.1 Contexto
O S-1 (*spike-metrics* §2.2.1) mostrou que as saídas recusadas pelo guard são erro comum de extração, não ataque:
- `benefits` com valor fora do enum (`vale_transporte` 8 vezes, `auxilio_refeicao` e `gympass`);
- `languageRequirements: null` no lugar de `[]`;
- `location` com os três campos nulos, que o refinamento `localizacao_vazia_use_null` reprova.

No `g2`, cada um desses casos derruba a extração inteira, e a análise cai no fallback (6 a 11 s na Workers AI) ou no determinístico. O `g3` resolve os três sem inventar fato. O mapeamento correto (vale-transporte → `outro`) continua sendo tarefa do prompt `p2` ([ADR-020-cloudflare-workers-ai-adapter](ADR-020-cloudflare-workers-ai-adapter.md) §7).

### 5.2 Decisões
**G3-1. Item fora do enum sai do array, sem virar outro valor.**
- Vale para os 5 arrays de enum: `seniorityLevels`, `workModels`, `contractTypes`, `benefits` e `redFlagSignals`.
- Só **string** fora do enum sai. Item de outro tipo (número, objeto, `null`) fica, e o Zod reprova: continua valendo "nenhuma conversão de tipo".
- A comparação é **exata**: sem caixa, sem aparo e sem NFKC. `"CLT"` sai e não vira `"clt"`; `"auxilio_refeicao"` sai e não vira `"vale_refeicao"`. Qualquer normalização seria mapear, e mapear é do prompt.
- A lista de valores vem do próprio contrato (`JobFactsSchema.shape.<campo>.element.options`), sem cópia.
- Ordem no array: fora do enum, depois duplicata exata, depois o corte no máximo. O item removido não ocupa vaga no corte.
- Contado em `offEnumItemsRemoved`.

**G3-2. `null` num campo de array vira `[]`.**
- Vale para os 8 campos de array do contrato (as chaves do `ARRAY_MAX_ITEMS`). O contrato já diz que "array vazio ou `null` = não informado", então a troca não muda o significado.
- Só o `null` explícito. Chave **ausente** continua ausente e o Zod reprova (sem valor padrão, D6). Outro tipo no lugar do array também.
- `null` **dentro** do array não é removido: é item de tipo errado, e o Zod reprova.
- Contado em `absentValuesNormalized`.

**G3-3. `location` sem nenhum campo vira `null`.**
- A condição é um objeto com **exatamente** as chaves `city`, `stateUf` e `countryIso2`, as três `null`, depois do saneamento da cidade. Isso unifica a regra do `g2` (cidade esvaziada pelo saneamento) com o caso que o S-1 achou (o modelo já manda os três nulos).
- **Endurecimento (achado do `[APPSEC]`):** no `g2`, `{ city: "https://x", stateUf: null, countryIso2: null, extra: 1 }` virava `null`, e a chave extra sumia sem o Zod ver. No `g3`, com chave a mais ou a menos, o objeto fica como veio e o Zod reprova (`schema_invalido`), como pede o D6.
- Contado em `absentValuesNormalized`, uma vez por localização, inclusive no caminho do `g2`.

**G3-4. Contagem e sinal de injection.**
- `LlmOutputSanitization` ganha `offEnumItemsRemoved` e `absentValuesNormalized`.
- O `injectionSignal` **não muda**: continua `urlsRemoved + hiddenOrMarkupRemoved > 0`. Valor fora do enum é erro comum do modelo (11 de 14 recusas do Groq no S-1), e não indício de ataque. Se fosse sinal, cortaria a confiança no `FactResolver` e barraria o cache em ~11% das saídas do Groq, sem ganho de segurança.
- **Telemetria:** o evento `llm_extraction` não tem caminho para o `sanitization` (ADR-010 D5). Levar os dois contadores à telemetria pede emenda ao ADR-010 e fica para a ligação do adapter do Groq. No aceite do S-1, o próprio relatório do spike lê os contadores.

**G3-5. Cache, fusão e versão.**
- A política de escrita do SR-08 ([ADR-015-job-facts-cache](ADR-015-job-facts-cache.md) D3) não muda: a saída do `g3` é ponto fixo do guard (idempotente), então o `#isGuardFixedPoint` continua valendo.
- O `FactResolver` não muda: só o `injectionSignal` corta a confiança.
- `LLM_OUTPUT_GUARD_VERSION = "g3"`. O `extractorVersion` muda, e as entradas do `g2` no cache deixam de ser lidas (*miss* natural).

**Fora do `g3`** (o Zod continua reprovando):
- `salary` com `currency` ou `period` fora do enum. É o campo mais sensível (SR-04, e moeda nula com valor seria lida como BRL), e remover o campo seria trocar um fato por "não informado" num dado de alto risco;
- `location.stateUf` ou `countryIso2` fora do formato;
- item de `languageRequirements` com idioma ou nível fora do enum. É um objeto, não um enum, e o S-1 não achou nenhum caso;
- `extractionConfidence` nula ou fora da faixa.

### 5.3 Auditoria do `[APPSEC]` (sem veto)
- **T1 (fato distorcido), monotonicidade:** o `g3` só remove. Cada array de enum da saída é **subsequência** do array da entrada, e nenhum valor é acrescentado ou trocado. Uma propriedade no fast-check prova isso.
- **Nenhuma capacidade nova para o atacante:** remover um item ou trocar `null` por `[]` só produz saídas que o atacante já conseguiria com um array válido menor. No `g2`, um valor fora do enum forçava o fallback (alavanca de custo e de qualidade); no `g3`, essa alavanca some nos arrays de enum.
- **"Não informado ≠ não atende":** `[]` e `location: null` são "não informado". Um contrato removido nunca gera deal-breaker, só a ausência do fato, que é a direção segura.
- **Salário intocado:** fica fora pelo motivo acima.
- **Protótipo:** a pertinência é `Set.has` sobre string. Valores como `"__proto__"`, `"constructor"` e `"toString"` dentro de um array saem como fora do enum, e um teste prova que nada é poluído.
- **SR-12:** o valor removido nunca é registrado nem devolvido; só a contagem sai do guard.
- **SR-09:** continua uma passada linear por array. O teste de custo do título continua valendo.

### 5.4 Critérios de aceite
1. String fora do enum sai dos 5 arrays de enum e é contada em `offEnumItemsRemoved`, sem mapear. Um teste por campo usa um valor válido **em outro enum**, para provar que cada campo usa a lista certa.
2. Item que não é string, dentro de um array de enum, continua dando `schema_invalido`.
3. A remoção vem antes da deduplicação e do corte.
4. `null` em qualquer dos 8 campos de array vira `[]` e é contado em `absentValuesNormalized`; chave ausente continua `schema_invalido`.
5. `location` com exatamente as três chaves nulas (direto do modelo ou depois do saneamento da cidade) vira `null`, contada uma vez. Com chave a mais ou a menos, `schema_invalido`.
6. Os contadores novos nunca mexem no `injectionSignal`.
7. Salário, UF, país, idiomas, confiança e anos continuam intocados.
8. Propriedades: subsequência em cada array de enum, contagem exata de `offEnumItemsRemoved`, idempotência (inclusive dos contadores novos) e o `injectionSignal` sempre igual à fórmula.
9. Os três achados do diagnóstico, reproduzidos com fatos sintéticos (sem texto de vaga), passam no guard.
10. Versão `g3`, cobertura de 100% e mutação manual sem sobrevivente não equivalente.

### 5.5 Implementação (2026-10-25, commit `742ecab`, local, sem push)
- `sanitizeEnumArray` no lugar do `dedupeAndCut`, `emptyIfNull` nos 8 campos de array e `isEmptyLocation` com as três chaves exatas. A tabela de valores de enum é lida do `JobFactsSchema.shape`.
- **Os 10 critérios do §5.4 foram cumpridos.** São 39 testes novos, com 3 propriedades novas: subsequência, contagem exata de `offEnumItemsRemoved` e o `injectionSignal` sempre igual à fórmula. A idempotência inclui os contadores novos. O teste de escrita do cache confirma que os contadores do `g3` não barram o SR-08.
- **API:** 2.648 testes e 100% (3.028 instruções e 1.932 ramos); depcruise sem violações (384 módulos); turbo 19/19 em série.
- **Mutação** (script no scratchpad, um mutante por vez, sha256 conferido): 33 mutantes, 30 mortos e 3 equivalentes:
  - checar a duplicata antes do enum, porque o `seen` só recebe valores do enum;
  - `<=` no tamanho da `location`, porque um objeto com menos de três chaves não tem as três nulas;
  - o laço do `null` no fim do saneamento, porque todo saneador devolve o `null` como veio.
- **Limiar de não vacuidade calibrado:** a propriedade do sinal contava de 45 a 75 saídas "remoção sem injection" em 40 sementes. O limiar ficou em 20, abaixo do mínimo medido.
- **`[APPSEC]`, sem veto.** Os pontos do §5.3 foram conferidos no código: só remoção, comparação exata, nenhum valor removido sai do guard, e o salário fica intocado.

## 6. Emenda `g4` ao D5: sobreposição de stack (2026-10-26, *HITL-QUEUE §HITL-029* 2A)

### 6.1 Contexto
No aceite do `p2` (*spike-metrics* §2.7), as 3 recusas do guard no Groq foram todas o mesmo erro: um termo nas duas listas de stack, que o refinamento `stack_obrigatoria_e_desejavel_sobrepostas` do contrato reprova. O D5 deixava a escolha do lado para o Zod porque ela é semântica. O `p2` já definiu essa semântica ("desejável vence nos dois", [ADR-020-cloudflare-workers-ai-adapter](ADR-020-cloudflare-workers-ai-adapter.md) §7.5), e o HITL-029 (2A) mandou o guard aplicar a mesma regra. Sem o `g4`, cerca de 3,6% das análises do Groq caem no fallback.

### 6.2 Decisões
**G4-1. O termo nas duas listas fica só em `stackNiceToHave`.**
- O guard saneia primeiro o `stackNiceToHave` (com o corte em 30) e depois o `stackRequired`. Um item do `stackRequired` que já passou pelas checagens de URL, invisível, marcação e `TECH_TAG_PATTERN` e cuja forma em minúsculas está no `stackNiceToHave` final **sai** do `stackRequired`.
- A comparação é a mesma do contrato (`toLowerCase` sobre a tag já em NFKC e aparada, como no `stacksAreDisjoint`), então toda saída aceita passa no refinamento. Sem aliases e sem outra normalização: mapear `Node` para `Node.js` seria inventar.
- O conjunto vem do `stackNiceToHave` **depois** do corte. Assim um termo nunca some das duas listas: se ele foi cortado do desejável, fica no exigido.
- Ordem no `stackRequired`: URL → invisível ou marcação → formato → **sobreposição** → duplicata → corte. O item removido não ocupa vaga no corte (a mesma regra do G3-1).
- O `stackNiceToHave` nunca perde item por causa do `g4`.
- Se o `stackNiceToHave` não for array, nada sai do `stackRequired`, e o Zod reprova o tipo como hoje.

**G4-2. Contagem e sinal de injection.**
- `LlmOutputSanitization` ganha `stackOverlapsResolved`, uma unidade por item removido.
- O `injectionSignal` **não muda** (`urlsRemoved + hiddenOrMarkupRemoved > 0`). A sobreposição é erro comum do modelo, que o próprio prompt descreve.
- A telemetria do contador segue o G3-4: entra com a emenda ao ADR-010 na ligação do adapter do Groq. No aceite do S-1, o relatório do spike lê o contador.

**G4-3. Cache, fusão e versão.**
- A saída do `g4` não tem sobreposição, então uma segunda passada não muda nada: o `#isGuardFixedPoint` do cache ([ADR-015-job-facts-cache](ADR-015-job-facts-cache.md) D3) continua valendo.
- O `FactResolver` não muda. Ele já considera conhecida a tecnologia que está em qualquer das duas listas (`llmKnown`), então um termo marcado que foi para o desejável não volta ao exigido.
- `LLM_OUTPUT_GUARD_VERSION = "g4"`. O `extractorVersion` muda, e as entradas do `g3` deixam de ser lidas (*miss* natural).

### 6.3 Auditoria do `[APPSEC]` (sem veto)
- **T1 (fato distorcido):** o `g4` só remove do `stackRequired`, e cada termo removido continua no `stackNiceToHave`. Nenhum termo é criado, trocado ou perdido nas duas listas juntas. Uma propriedade prova que a união das listas (sem diferenciar caixa) é a mesma antes e depois da regra.
- **Direção segura:** "exigido → desejável" é rebaixar. Com `dealBreakerScope: "so_exigida"`, um deal-breaker que estava nas duas listas deixa de disparar. Isso é o "não informado ≠ não atende" do ADR-001: na dúvida, a nota não pune. O `mustHave` não muda, porque o motor compara com a união das listas.
- **Nenhuma capacidade nova para o atacante:** uma injection que faça o modelo repetir um termo nas duas listas consegue o mesmo que já conseguia mandando o termo só no desejável. No `g3`, a sobreposição forçava o fallback (alavanca de custo); no `g4`, essa alavanca some.
- **Protótipo e SR-09:** a pertinência é `Set.has` sobre string em minúsculas, e o custo continua linear nas duas listas (no máximo 30 + N itens).
- **SR-12:** o termo removido nunca é registrado nem devolvido; só a contagem sai do guard.

### 6.4 Critérios de aceite
1. Termo nas duas listas (inclusive com caixa diferente) sai do `stackRequired`, fica no `stackNiceToHave` e é contado em `stackOverlapsResolved`.
2. O conjunto de comparação é o `stackNiceToHave` depois do saneamento e do corte. Termo cortado do desejável continua no exigido.
3. A remoção vem depois das checagens de URL, invisível e formato (essas contam no seu próprio contador) e antes da deduplicação e do corte.
4. `stackNiceToHave` que não é array não remove nada do `stackRequired`.
5. O contador nunca mexe no `injectionSignal`.
6. Propriedades: a união das listas sem diferenciar caixa se conserva, a saída nunca tem sobreposição, a contagem é exata e a saída é idempotente (inclusive o contador novo).
7. As 3 recusas do aceite do `p2`, reproduzidas com fatos sintéticos (sem texto de vaga), passam no guard.
8. Versão `g4`, cobertura de 100% e mutação manual sem sobrevivente não equivalente.

### 6.5 Implementação (2026-10-26, commit `90867d9`, local, sem push)
- `sanitizeTags` recebe o conjunto de sobreposição. O `stackNiceToHave` é saneado com o conjunto vazio, e o `stackRequired` com `foldedTags` do desejável final (só strings, em minúsculas; fora de array, conjunto vazio).
- **Os 8 critérios do §6.4 foram cumpridos.** São 13 testes novos (um removido: a sobreposição deixou de ser `schema_invalido`) e 2 propriedades: a saída nunca tem sobreposição e o desejável é o mesmo com ou sem o exigido; sem corte, o exigido é o de sempre menos o desejável, a união se conserva e `duplicatas + sobreposições` fecha com as listas saneadas sozinhas. A idempotência inclui o contador novo. O teste do cache confirma que o contador não barra o SR-08. O relatório do S-1 lê o contador (`g4.stackOverlapsResolved`).
- **Limiares de não vacuidade** medidos em 25 sementes: de 670 a 907 sobreposições (limiar 300), de 764 a 817 entradas sem corte (limiar 400) e de 36 a 64 remoções silenciosas (o limiar de 20 continua abaixo do mínimo).
- **API:** 2.673 testes e 100% (3.047 instruções e 1.938 ramos); typecheck, lint e depcruise verdes (384 módulos).
- **Mutação** (script no scratchpad, um mutante por vez, sha256 conferido): 15 mutantes, 14 mortos e 1 equivalente. A 1ª rodada deixou 3 sobreviventes:
  - **M11** (sobreposição antes da checagem de URL) **não era equivalente**: `"İOS".toLowerCase()` é `i` + U+0307, que reprova no `TECH_TAG_PATTERN`. Uma tag exigida malformada casaria com o termo válido do desejável e seria contada como sobreposição. Virou teste;
  - **M8** (conjunto montado de `String(value)` fora de array) lançava com `{ toString: 1, valueOf: 1 }`. Virou teste de entrada hostil, que o guard recusa sem lançar;
  - **M10** (sobreposição depois da duplicata) é equivalente: um item do conjunto de sobreposição nunca entra no `seen`, então as duas condições nunca valem juntas.
- **`[APPSEC]`, sem veto.** Os pontos do §6.3 foram conferidos no código: só remoção do exigido, o termo continua no desejável, a comparação é a do contrato, `Set.has` sobre string e só a contagem sai do guard.

### 6.6 Aceite (2026-10-27, *spike-metrics* §2.8)
- **O `g4` cumpriu o papel dele no S-1.** No Groq, 4 saídas cruas tinham termo nas duas listas de stack (no `p2`/`g3`, as 3 recusas do guard eram todas assim). O `g4` resolveu as 4, com `stackOverlapsResolved` contado, e o JSON válido depois do guard foi de 96,4% para **100%**. Na Workers AI, ele resolveu 2.
- **O contador não mexeu na confiança:** 0 sinal de injection nos controles negativos (H10), e o gate de segurança do `gd2` passou nos dois provedores.
- O gate de qualidade do Groq ainda reprova pela precisão de stack, que é do prompt e não do guard ([ADR-020-cloudflare-workers-ai-adapter](ADR-020-cloudflare-workers-ai-adapter.md) §8.6, *HITL-QUEUE §HITL-031*).
